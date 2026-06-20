#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFlakiness } from "../packages/flakiness-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    assertFlakeGuardRails(fixture);
    console.log(`PASS ${fixture.out}`);
    return;
  }

  const reports = args.reports.map((path) => ({
    path: resolve(path),
    report: JSON.parse(readFileSync(resolve(path), "utf8"))
  }));
  const report = classifyFlakiness({
    reports,
    blockers: args.blockers
  });
  if (args.out) writeJson(args.out, report);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "flake-classify");
  mkdirSync(dir, { recursive: true });

  const infra = writeReport(dir, "infra.json", makeGateReport("G5", ["G5_PHYSICAL_DEVICE_REQUIRED"]));
  const product = writeReport(dir, "product.json", makeGateReport("G2", ["G2_SSIM_BELOW_FLOOR"]));
  const noise = writeReport(dir, "noise.json", makeGateReport("G2", ["METRIC_NOISE_CI95_OVERLAP"]));
  const unknown = writeReport(dir, "unknown.json", makeGateReport("G7", ["SOME_NEW_UNCLASSIFIED_CODE"]));
  const mixed = writeReport(dir, "mixed.json", makeGateReport("G6", [
    "G6_ENERGY_TRACE_UNAVAILABLE_REQUIRED",
    "G6_SUSTAINED_DEGRADATION_ABOVE_CEILING"
  ]));

  const out = outPath ? resolve(outPath) : join(dir, "flake-classification.report.json");
  const report = classifyFlakiness({
    reports: [
      { path: infra, report: JSON.parse(readFileSync(infra, "utf8")) },
      { path: product, report: JSON.parse(readFileSync(product, "utf8")) },
      { path: noise, report: JSON.parse(readFileSync(noise, "utf8")) }
    ],
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  writeJson(out, report);

  return { infra, product, noise, unknown, mixed, out };
}

function assertFlakeGuardRails(fixture) {
  const infra = classifyOne(fixture.infra);
  if (infra.flake_class !== "INFRA_FLAKE" || !infra.action.includes("rerun_once")) {
    throw new Error("flake classifier self-test failed INFRA_FLAKE classification");
  }
  const product = classifyOne(fixture.product);
  if (product.flake_class !== "PRODUCT_REGRESSION" || product.action !== "block_as_product_red") {
    throw new Error("flake classifier self-test failed PRODUCT_REGRESSION classification");
  }
  const noise = classifyOne(fixture.noise);
  if (noise.flake_class !== "METRIC_NOISE" || !noise.action.includes("do_not_block")) {
    throw new Error("flake classifier self-test failed METRIC_NOISE classification");
  }
  const unknown = classifyOne(fixture.unknown);
  if (unknown.flake_class !== "UNKNOWN" || unknown.status !== "fail") {
    throw new Error("flake classifier self-test failed UNKNOWN classification");
  }
  const mixed = classifyOne(fixture.mixed);
  if (mixed.flake_class !== "PRODUCT_REGRESSION") {
    throw new Error("flake classifier self-test failed mixed priority classification");
  }
}

function classifyOne(path) {
  return classifyFlakiness({
    reports: [{ path, report: JSON.parse(readFileSync(path, "utf8")) }],
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
}

function makeGateReport(gate, failures) {
  return {
    schema_version: "1.2.0",
    kind: `${gate.toLowerCase()}_self_test_report`,
    gate,
    status: failures.length === 0 ? "pass" : "fail",
    failures
  };
}

function writeReport(dir, name, report) {
  const path = join(dir, name);
  writeJson(path, report);
  return path;
}

function parseArgs(args) {
  const parsed = {
    reports: [],
    blockers: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--report") parsed.reports.push(args[++index]);
    else if (arg === "--blocker") parsed.blockers.push(args[++index]);
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}
