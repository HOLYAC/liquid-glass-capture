#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMaterialProbe } from "../packages/material-core/src/index.mjs";
import {
  glassMaskPack,
  glassMaterialProbe,
  glassNullLadderManifest,
  glassSceneStateMatrix,
  metadataForGlassSceneState
} from "../packages/material-glass/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.selfTest) {
    console.error("usage: node scripts/lab-material-probe.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = runSelfTest();
  const out = args.out ?? join(repoRoot, "artifacts", "lab-self-test", "material-probe", "material-probe.report.json");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} ${resolve(out)}`);
  if (report.status !== "pass") process.exit(1);
}

function runSelfTest() {
  const failures = [];
  failures.push(...validateMaterialProbe(glassMaterialProbe));

  const fixtureMaskPack = JSON.parse(readFileSync(join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json"), "utf8"));
  const fixtureNullLadder = JSON.parse(readFileSync(join(repoRoot, "fixtures", "backgrounds", "S00_NULL.manifest.json"), "utf8"));
  failures.push(...compareMaskPack(fixtureMaskPack, glassMaskPack));
  failures.push(...compareNullLadder(fixtureNullLadder, glassNullLadderManifest));

  for (const [sceneId, states] of Object.entries(glassSceneStateMatrix)) {
    for (const stateId of states) {
      const metadata = metadataForGlassSceneState(sceneId, stateId);
      if (metadata.sceneId !== sceneId || metadata.stateId !== stateId) {
        failures.push(`${sceneId}/${stateId}:METADATA_ID_MISMATCH`);
      }
      if (!metadata.contentSeed && !metadata.backgroundAssetHash) {
        failures.push(`${sceneId}/${stateId}:METADATA_CONTENT_KEY_MISSING`);
      }
    }
  }

  return {
    schema_version: "1.2.0",
    kind: "material_probe_self_test_report",
    material_id: glassMaterialProbe.material_id,
    status: failures.length === 0 ? "pass" : "fail",
    scene_count: glassMaterialProbe.scenes.length,
    scene_state_matrix: glassSceneStateMatrix,
    mask_pack_id: glassMaskPack.mask_pack_id,
    null_ladder_rungs: glassNullLadderManifest.rungs.map((rung) => rung.id),
    failures: [...new Set(failures)]
  };
}

function compareMaskPack(fixture, expected) {
  const failures = [];
  if (fixture.schema_version !== expected.schema_version) failures.push("MASK_FIXTURE_SCHEMA_VERSION_MISMATCH");
  if (fixture.mask_pack_id !== expected.mask_pack_id) failures.push("MASK_FIXTURE_ID_MISMATCH");
  if (JSON.stringify(fixture.scene_coverage ?? []) !== JSON.stringify(expected.scene_coverage)) {
    failures.push("MASK_FIXTURE_SCENE_COVERAGE_MISMATCH");
  }
  const fixtureIds = (fixture.masks ?? []).map((mask) => mask.id).sort();
  const expectedIds = expected.masks.map((mask) => mask.id).sort();
  if (JSON.stringify(fixtureIds) !== JSON.stringify(expectedIds)) failures.push("MASK_FIXTURE_IDS_MISMATCH");
  return failures;
}

function compareNullLadder(fixture, expected) {
  const failures = [];
  if (fixture.schema_version !== expected.schema_version) failures.push("NULL_FIXTURE_SCHEMA_VERSION_MISMATCH");
  if (fixture.scene_id !== expected.scene_id) failures.push("NULL_FIXTURE_SCENE_MISMATCH");
  const fixtureRungs = (fixture.rungs ?? []).map((rung) => `${rung.id}:${rung.content_seed}`).sort();
  const expectedRungs = expected.rungs.map((rung) => `${rung.id}:${rung.content_seed}`).sort();
  if (JSON.stringify(fixtureRungs) !== JSON.stringify(expectedRungs)) failures.push("NULL_FIXTURE_RUNG_MISMATCH");
  return failures;
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
