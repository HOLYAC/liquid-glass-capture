#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneContract } from "../packages/scene-contract/src/index.mjs";
import {
  glassBackgroundPackSha256,
  glassCaptureTimelinePackSha256,
  glassGeometryPackSha256,
  glassMaterialProbe
} from "../packages/material-glass/src/index.mjs";
import { sha256File } from "./lib/lab-png.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backgroundPackPath = join(repoRoot, "fixtures", "backgrounds", "glass_background_pack_v1.json");
const geometryPackPath = join(repoRoot, "fixtures", "scenes", "glass_geometry_pack_v1.json");
const timelinePackPath = join(repoRoot, "fixtures", "scenes", "glass_capture_timeline_pack_v1.json");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.selfTest) {
    console.error("usage: node scripts/lab-scene-contract.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = runSelfTest();
  const out = args.out ?? join(repoRoot, "artifacts", "lab-self-test", "scene-contract", "scene-contract.report.json");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} ${resolve(out)}`);
  if (report.status !== "pass") process.exit(1);
}

function runSelfTest() {
  const backgroundPack = JSON.parse(readFileSync(backgroundPackPath, "utf8"));
  const geometryPack = JSON.parse(readFileSync(geometryPackPath, "utf8"));
  const timelinePack = JSON.parse(readFileSync(timelinePackPath, "utf8"));
  const backgroundSha256 = sha256File(backgroundPackPath);
  const geometrySha256 = sha256File(geometryPackPath);
  const timelineSha256 = sha256File(timelinePackPath);
  const failures = [];
  if (glassBackgroundPackSha256 !== backgroundSha256) failures.push("MATERIAL_BACKGROUND_PACK_SHA_MISMATCH");
  if (glassGeometryPackSha256 !== geometrySha256) failures.push("MATERIAL_GEOMETRY_PACK_SHA_MISMATCH");
  if (glassCaptureTimelinePackSha256 !== timelineSha256) failures.push("MATERIAL_CAPTURE_TIMELINE_PACK_SHA_MISMATCH");
  failures.push(...validateSceneContract({
    probe: glassMaterialProbe,
    backgroundPack,
    geometryPack,
    timelinePack,
    expectedBackgroundSha256: backgroundSha256,
    expectedGeometrySha256: geometrySha256,
    expectedTimelineSha256: timelineSha256
  }));

  return {
    schema_version: "1.2.0",
    kind: "scene_contract_self_test_report",
    status: failures.length === 0 ? "pass" : "fail",
    background_pack: {
      path: "fixtures/backgrounds/glass_background_pack_v1.json",
      sha256: backgroundSha256,
      entry_count: backgroundPack.backgrounds?.length ?? 0
    },
    geometry_pack: {
      path: "fixtures/scenes/glass_geometry_pack_v1.json",
      sha256: geometrySha256,
      entry_count: geometryPack.scene_geometry?.length ?? 0
    },
    capture_timeline_pack: {
      path: "fixtures/scenes/glass_capture_timeline_pack_v1.json",
      sha256: timelineSha256,
      entry_count: timelinePack.timelines?.length ?? 0
    },
    failures: [...new Set(failures)]
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
