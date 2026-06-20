#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePointerEvents,
  compileXCUITest,
  listTrajectorySources,
  sourceFileNameForScene,
  validateCompiledConsumer,
  validateTrajectorySource
} from "../packages/trajectory-core/src/index.mjs";
import {
  glassGestureSceneIds,
  glassTrajectoryShaByScene
} from "../packages/material-glass/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gestureDir = join(repoRoot, "fixtures", "gestures");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = args.selfTest ? runSelfTest() : writeCompiledConsumers();
  const defaultFile = args.selfTest ? "trajectory-build.report.json" : "trajectory-build.write.report.json";
  const out = args.out ?? join(repoRoot, "artifacts", "lab-self-test", "trajectory-build", defaultFile);

  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} ${resolve(out)}`);
  if (report.status !== "pass") process.exit(1);
}

function runSelfTest() {
  const failures = [];
  const records = listTrajectorySources(gestureDir);
  const recordsByScene = new Map(records.map((record) => [record.source.scene_id, record]));

  for (const sceneId of glassGestureSceneIds) {
    const record = recordsByScene.get(sceneId);
    if (!record) {
      failures.push(`${sceneId}:TRAJECTORY_SOURCE_MISSING`);
      continue;
    }
    const expectedSourceFile = sourceFileNameForScene(sceneId);
    if (!record.path.endsWith(expectedSourceFile)) failures.push(`${sceneId}:TRAJECTORY_SOURCE_FILENAME`);
  }

  for (const record of records) {
    failures.push(...validateTrajectorySource(record.source));
    if (!glassGestureSceneIds.includes(record.source.scene_id)) {
      failures.push(`${record.source.scene_id}:TRAJECTORY_SCENE_NOT_DECLARED_IN_MATERIAL_PROBE`);
    }
    if (glassTrajectoryShaByScene[record.source.scene_id] !== record.source_sha256) {
      failures.push(`${record.source.scene_id}:MATERIAL_TRAJECTORY_SHA_MISMATCH`);
    }

    for (const [consumerKind, relativePath] of Object.entries(record.source.compiled_consumers ?? {})) {
      const consumerPath = join(repoRoot, relativePath);
      let compiled = {};
      try {
        compiled = JSON.parse(readFileSync(consumerPath, "utf8"));
      } catch (error) {
        failures.push(`${record.source.scene_id}:${consumerKind}:CONSUMER_JSON_INVALID:${error.message}`);
      }
      failures.push(...validateCompiledConsumer(record, consumerKind, compiled, consumerPath));
    }
  }

  const compiledPreviews = Object.fromEntries(records.map((record) => [
    record.source.scene_id,
    {
      source_sha256: record.source_sha256,
      pointer_events: compilePointerEvents(record.source, record.source_sha256).events.length,
      xcuitest: compileXCUITest(record.source, record.source_sha256).events.length
    }
  ]));

  return {
    schema_version: "1.2.0",
    kind: "trajectory_build_self_test_report",
    status: failures.length === 0 ? "pass" : "fail",
    required_gesture_scene_ids: glassGestureSceneIds,
    trajectory_source_count: records.length,
    compiled_previews: compiledPreviews,
    failures: [...new Set(failures)]
  };
}

function writeCompiledConsumers() {
  const failures = [];
  const writes = [];
  for (const record of listTrajectorySources(gestureDir)) {
    const sourceFailures = validateTrajectorySource(record.source);
    failures.push(...sourceFailures);
    if (sourceFailures.length > 0) continue;

    const outputs = {
      pointer_events: compilePointerEvents(record.source, record.source_sha256),
      xcuitest: compileXCUITest(record.source, record.source_sha256)
    };
    for (const [consumerKind, json] of Object.entries(outputs)) {
      const relativePath = record.source.compiled_consumers?.[consumerKind];
      const absolutePath = join(repoRoot, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, `${JSON.stringify(json, null, 2)}\n`);
      writes.push({
        scene_id: record.source.scene_id,
        consumer: consumerKind,
        path: relativePath,
        source_sha256: record.source_sha256
      });
    }
  }

  const postWriteReport = runSelfTest();
  failures.push(...postWriteReport.failures);
  return {
    schema_version: "1.2.0",
    kind: "trajectory_build_write_report",
    status: failures.length === 0 ? "pass" : "fail",
    writes,
    post_write_status: postWriteReport.status,
    failures: [...new Set(failures)]
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
