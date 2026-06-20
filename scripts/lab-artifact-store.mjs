#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRetentionPlan,
  readArtifactStoreIndex,
  verifyArtifactStoreIndex,
  writeArtifactStore
} from "../packages/artifact-store/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    assertArtifactStoreGuardRails(fixture);
    console.log(`PASS ${fixture.out}`);
    return;
  }

  if (args.verifyIndex) {
    const report = verifyArtifactStoreIndex(readArtifactStoreIndex(args.verifyIndex));
    if (args.out) writeJson(args.out, report);
    console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
    if (report.status !== "pass") process.exit(1);
    return;
  }

  if (args.planRetention) {
    const plan = buildRetentionPlan({
      index: readArtifactStoreIndex(args.planRetention),
      now: args.now
    });
    if (args.out) writeJson(args.out, plan);
    console.log(`${plan.status.toUpperCase()} ${args.out ?? ""}`.trim());
    return;
  }

  if (args.files.length === 0 || !args.retentionClass) {
    console.error("usage: node scripts/lab-artifact-store.mjs --put <file> [--put ...] --class <retention_class> [--store artifacts/store] [--out report.json]");
    console.error("       node scripts/lab-artifact-store.mjs --verify-index <index.json> [--out verify.json]");
    console.error("       node scripts/lab-artifact-store.mjs --plan-retention <index.json> [--now iso] [--out prune-plan.json]");
    console.error("       node scripts/lab-artifact-store.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = writeArtifactStore({
    files: args.files,
    storeRoot: args.store,
    retentionClass: args.retentionClass,
    generatedAt: args.now
  });
  if (args.out) writeJson(args.out, report);
  console.log(`${report.status.toUpperCase()} ${args.out ?? report.index_path}`);
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "artifact-store");
  const storeRoot = join(dir, "store");
  mkdirSync(dir, { recursive: true });

  const metricPath = join(dir, "g2.report.json");
  writeJson(metricPath, {
    schema_version: "1.2.0",
    kind: "g2_metric_report",
    gate: "G2",
    id: "artifact-store-self-test-g2",
    status: "pass",
    generated_at: "2026-01-01T00:00:00.000Z"
  });
  const rawPath = join(dir, "raw-frame.png");
  writeFileSync(rawPath, Buffer.from("not-a-real-png-but-a-retained-raw-frame"));
  const baselinePath = join(dir, "baseline.metric.report.json");
  writeJson(baselinePath, {
    schema_version: "1.2.0",
    kind: "baseline_metric_report",
    baseline_namespace: "baseline__artifact_store_self_test",
    generated_at: "2026-01-01T00:00:00.000Z"
  });

  const metricWrite = writeArtifactStore({
    files: [metricPath],
    storeRoot,
    retentionClass: "metric_json",
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const rawWrite = writeArtifactStore({
    files: [rawPath],
    storeRoot,
    retentionClass: "raw_png_frame",
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const baselineWrite = writeArtifactStore({
    files: [baselinePath],
    storeRoot,
    retentionClass: "baseline",
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const repeatMetricWrite = writeArtifactStore({
    files: [metricPath],
    storeRoot,
    retentionClass: "metric_json",
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const index = readArtifactStoreIndex(baselineWrite.index_path);
  const verify = verifyArtifactStoreIndex(index);
  const retentionPlan = buildRetentionPlan({
    index,
    now: "2026-05-01T00:00:00.000Z"
  });

  const out = outPath ? resolve(outPath) : join(dir, "artifact-store.report.json");
  const report = {
    schema_version: "1.2.0",
    kind: "artifact_store_self_test_report",
    status: verify.status === "pass" ? "pass" : "fail",
    failures: verify.failures,
    writes: [metricWrite, rawWrite, baselineWrite, repeatMetricWrite].map((write) => ({
      status: write.status,
      existing_count: write.existing_count,
      written_count: write.written_count,
      entries: write.entries.map((entry) => ({
        logical_id: entry.logical_id,
        retention_class: entry.retention_class,
        sha256: entry.sha256,
        expires_at: entry.expires_at
      }))
    })),
    verify,
    retention_plan: retentionPlan
  };
  writeJson(out, report);

  return {
    out,
    index,
    verify,
    retentionPlan,
    repeatMetricWrite,
    report
  };
}

function assertArtifactStoreGuardRails({ verify, retentionPlan, index, repeatMetricWrite }) {
  if (verify.status !== "pass") {
    throw new Error(`artifact-store self-test verify failed: ${verify.failures.join(", ")}`);
  }
  const rawExpired = retentionPlan.delete_candidates.some((entry) =>
    entry.retention_class === "raw_png_frame" &&
    entry.tombstone?.hash_manifest_preserved === true
  );
  if (!rawExpired) {
    throw new Error("artifact-store self-test failed to plan expired raw frame deletion with hash manifest preserved");
  }
  const baselineRetained = retentionPlan.retained.some((entry) =>
    entry.retention_class === "baseline" &&
    entry.retention_decision === "retain_indefinitely"
  );
  if (!baselineRetained) {
    throw new Error("artifact-store self-test failed to retain baseline indefinitely");
  }
  if (index.immutability?.deletion_never_removes_hash_manifest !== true) {
    throw new Error("artifact-store self-test lost deletion_never_removes_hash_manifest invariant");
  }
  if (repeatMetricWrite.written_count !== 0 || repeatMetricWrite.existing_count !== 1) {
    throw new Error("artifact-store self-test failed idempotent repeat write guard");
  }
}

function parseArgs(args) {
  const parsed = {
    files: [],
    store: join(repoRoot, "artifacts", "store"),
    now: new Date().toISOString()
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--put") parsed.files.push(args[++index]);
    else if (arg === "--class") parsed.retentionClass = args[++index];
    else if (arg === "--store") parsed.store = args[++index];
    else if (arg === "--verify-index") parsed.verifyIndex = args[++index];
    else if (arg === "--plan-retention") parsed.planRetention = args[++index];
    else if (arg === "--now") parsed.now = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}
