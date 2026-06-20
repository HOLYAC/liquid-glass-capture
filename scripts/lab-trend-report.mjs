#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrendReport } from "../packages/trend-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = buildReportFromPaths(fixture.inputs, {
      out: fixture.out,
      limit: 30,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });
    assertTrendGuardRails(report);
    console.log(`PASS ${fixture.out}`);
    return;
  }

  const inputs = [...args.inputs, ...args.dirs.flatMap(walkJson)];
  if (inputs.length === 0) {
    console.error("usage: node scripts/lab-trend-report.mjs --input <report.json> [--input ...] [--dir reports] [--limit 30] [--out trend.json]");
    console.error("       node scripts/lab-trend-report.mjs --self-test [--out trend.json]");
    process.exit(2);
  }

  const report = buildReportFromPaths(inputs, args);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

function buildReportFromPaths(paths, options = {}) {
  const reports = paths.map((path) => ({
    path: resolve(path),
    report: JSON.parse(readFileSync(resolve(path), "utf8"))
  }));
  const report = buildTrendReport({
    reports,
    generatedAt: options.generatedAt,
    limit: options.limit ?? 30
  });
  if (options.out) writeJson(options.out, report);
  return report;
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "trend-report");
  mkdirSync(dir, { recursive: true });
  const inputs = [];
  for (let index = 0; index < 35; index += 1) {
    const report = makeVerdictRun(index);
    const path = join(dir, `run-${String(index).padStart(2, "0")}.g8-verdict.report.json`);
    writeJson(path, report);
    inputs.push(path);
  }
  return {
    inputs,
    out: outPath ? resolve(outPath) : join(dir, "trend.report.json")
  };
}

function makeVerdictRun(index) {
  const invalid = index === 2;
  const infraFlake = index === 4;
  const metricNoise = index >= 23 && index % 3 === 0;
  const status = invalid ? "fail" : "pass";
  return {
    schema_version: "1.2.0",
    kind: "g8_verdict_report",
    run_id: `trend-self-test-${String(index).padStart(2, "0")}`,
    generated_at: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
    status,
    verdict_class: invalid ? "INVALID" : "PROD_PASS",
    technical_class: invalid ? "INVALID" : "SHADER_PASS",
    design_class: invalid ? "NOT_RUN" : "PASS",
    flake_class: infraFlake ? "INFRA_FLAKE" : metricNoise ? "METRIC_NOISE" : "NONE",
    device: {
      model_name: index % 2 === 0 ? "iPhone Pro" : "iPhone",
      model_identifier: index % 2 === 0 ? "iPhone16,2" : "iPhone15,4",
      os_build: index < 18 ? "26A100" : "26A200",
      sdk_build: "26.0"
    },
    gates: {
      color: "pass",
      static: index === 31 ? "fail" : "pass",
      optics: "pass",
      temporal: "pass",
      runtime: "pass",
      energy: index % 7 === 0 ? "trace_unavailable" : "pass",
      design: "pass"
    },
    trend_metrics: {
      visual_loss: 0.010 + index * 0.0005,
      runtime_cost_ms: 18 - index * 0.05,
      energy_cost: 1.4 + index * 0.02
    }
  };
}

function assertTrendGuardRails(report) {
  if (report.status !== "pass") {
    throw new Error(`trend report self-test failed: ${report.failures.join(", ")}`);
  }
  if (report.run_counts.input !== 35 || report.run_counts.valid !== 33 || report.run_counts.last_valid !== 30) {
    throw new Error("trend report self-test failed last-30 valid run accounting");
  }
  if (report.last_30_valid_runs[0]?.run_id !== "trend-self-test-05") {
    throw new Error("trend report self-test failed to drop invalid/infra and keep last 30 valid runs");
  }
  if (report.trends.visual_loss.direction !== "up") {
    throw new Error("trend report self-test failed visual loss slope");
  }
  if (report.trends.runtime_cost_ms.direction !== "down") {
    throw new Error("trend report self-test failed runtime slope");
  }
  if (report.trends.energy_cost.direction !== "up") {
    throw new Error("trend report self-test failed energy slope");
  }
  if (report.trends.flake_rate.direction !== "up") {
    throw new Error("trend report self-test failed flake-rate slope");
  }
  if (!report.trends.per_gate.static || report.trends.per_gate.static.fail_count !== 1) {
    throw new Error("trend report self-test failed per-gate status summary");
  }
  if (!report.trends.per_device["iPhone16,2"] || !report.trends.per_ios_build["26A200"]) {
    throw new Error("trend report self-test failed device/iOS build buckets");
  }
}

function parseArgs(args) {
  const parsed = {
    inputs: [],
    dirs: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--input") parsed.inputs.push(args[++index]);
    else if (arg === "--dir") parsed.dirs.push(args[++index]);
    else if (arg === "--limit") parsed.limit = Number(args[++index]);
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function walkJson(root) {
  const absolute = resolve(root);
  const files = [];
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...walkJson(path));
    } else if (entry.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}
