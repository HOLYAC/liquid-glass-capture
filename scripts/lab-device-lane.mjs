#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhysicalDeviceLanePlan, verifyPhysicalDeviceLane } from "../packages/device-lane/src/index.mjs";
import {
  glassCaptureTimelineBySceneState,
  glassGeometryBySceneState
} from "../packages/material-glass/src/index.mjs";
import { sceneStateKey } from "../packages/scene-contract/src/index.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    assertDeviceLaneGuardRails(fixture);
    console.log(`PASS ${fixture.out}`);
    return;
  }

  if (args.plan && args.manifests.length > 0) {
    const plan = JSON.parse(readFileSync(resolve(args.plan), "utf8"));
    const manifests = args.manifests.map((path) => ({
      path: resolve(path),
      manifest: JSON.parse(readFileSync(resolve(path), "utf8"))
    }));
    const gateReports = args.gates.map((path) => ({
      path: resolve(path),
      report: JSON.parse(readFileSync(resolve(path), "utf8"))
    }));
    const report = verifyPhysicalDeviceLane({ plan, manifests, gateReports });
    if (args.out) writeJson(args.out, report);
    console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
    if (report.status !== "pass") process.exit(1);
    return;
  }

  const plan = buildPhysicalDeviceLanePlan({
    laneClass: args.laneClass,
    gitCommit: args.gitCommit,
    reason: args.reason
  });
  const out = args.out ?? join(repoRoot, "artifacts", "device-lane", `${plan.lane_class}.plan.json`);
  writeJson(out, plan);
  console.log(`${plan.status.toUpperCase()} ${resolve(out)}`);
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "device-lane");
  mkdirSync(dir, { recursive: true });

  const plan = buildPhysicalDeviceLanePlan({
    laneClass: "smoke",
    tasks: [{ rig_id: "R0", scene_id: "S01_SEARCH", state_id: "rest" }],
    generatedAt: "2026-01-01T00:00:00.000Z",
    gitCommit: "self-test",
    reason: "device-lane-self-test"
  });
  const planPath = join(dir, "physical-device-lane.plan.json");
  writeJson(planPath, plan);

  const manifestPath = writeRepeatManifest({
    dir,
    name: "r0-s01-rest.repeat-manifest.json",
    artifactPaths: [0, 1, 2].map((index) => writeCaptureArtifact(dir, index, "iPhone16,2", "compositor", "pass"))
  });
  const report = verifyPhysicalDeviceLane({
    plan,
    manifests: [{ path: manifestPath, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) }]
  });

  const badManifestPath = writeRepeatManifest({
    dir,
    name: "bad-simulator.repeat-manifest.json",
    artifactPaths: [writeCaptureArtifact(dir, "bad-sim", "iPhone Simulator", "compositor", "pass")]
  });
  const badReport = verifyPhysicalDeviceLane({
    plan,
    manifests: [{ path: badManifestPath, manifest: JSON.parse(readFileSync(badManifestPath, "utf8")) }]
  });

  const layerSnapshotManifestPath = writeRepeatManifest({
    dir,
    name: "bad-layer-snapshot.repeat-manifest.json",
    artifactPaths: [writeCaptureArtifact(dir, "bad-layer", "iPhone16,2", "layer_snapshot", "pass")]
  });
  const layerSnapshotReport = verifyPhysicalDeviceLane({
    plan,
    manifests: [{ path: layerSnapshotManifestPath, manifest: JSON.parse(readFileSync(layerSnapshotManifestPath, "utf8")) }]
  });

  const badSceneContractArtifact = writeCaptureArtifact(dir, "bad-contract", "iPhone16,2", "compositor", "pass");
  const badSceneContract = JSON.parse(readFileSync(badSceneContractArtifact, "utf8"));
  delete badSceneContract.environment.geometry_pack_id;
  delete badSceneContract.frame_pack.capture_timeline_id;
  writeJson(badSceneContractArtifact, badSceneContract);
  const badSceneContractManifestPath = writeRepeatManifest({
    dir,
    name: "bad-scene-contract.repeat-manifest.json",
    artifactPaths: [badSceneContractArtifact]
  });
  const badSceneContractReport = verifyPhysicalDeviceLane({
    plan,
    manifests: [{ path: badSceneContractManifestPath, manifest: JSON.parse(readFileSync(badSceneContractManifestPath, "utf8")) }]
  });

  const out = outPath ? resolve(outPath) : join(dir, "physical-device-lane.report.json");
  const selfTestReport = {
    schema_version: "1.2.0",
    kind: "physical_device_lane_self_test_report",
    status: report.status === "pass" &&
      badReport.status !== "pass" &&
      layerSnapshotReport.status !== "pass" &&
      badSceneContractReport.status !== "pass" ? "pass" : "fail",
    plan_path: planPath,
    positive_report: report,
    simulator_negative_report: badReport,
    layer_snapshot_negative_report: layerSnapshotReport,
    scene_contract_negative_report: badSceneContractReport
  };
  writeJson(out, selfTestReport);

  return {
    out,
    report,
    badReport,
    layerSnapshotReport,
    badSceneContractReport,
    selfTestReport
  };
}

function assertDeviceLaneGuardRails({ report, badReport, layerSnapshotReport, badSceneContractReport, selfTestReport }) {
  if (selfTestReport.status !== "pass") {
    throw new Error("device-lane self-test report did not pass");
  }
  if (report.status !== "pass" || report.task_reports[0]?.artifacts?.length !== 3) {
    throw new Error("device-lane positive self-test did not verify repeat artifacts");
  }
  if (!report.evidence.hashes_verified) {
    throw new Error("device-lane positive self-test did not verify hashes");
  }
  if (!badReport.failures.some((failure) => failure.includes("SIMULATOR_FORBIDDEN"))) {
    throw new Error("device-lane self-test failed to reject simulator artifact");
  }
  if (!layerSnapshotReport.failures.some((failure) => failure.includes("CAPTURE_PATH_INVALID"))) {
    throw new Error("device-lane self-test failed to reject layer_snapshot artifact");
  }
  if (!badSceneContractReport.failures.some((failure) => failure.includes("GEOMETRY_PACK_ID_MISMATCH"))) {
    throw new Error("device-lane self-test failed to reject missing geometry contract");
  }
  if (!badSceneContractReport.failures.some((failure) => failure.includes("CAPTURE_TIMELINE_ID_MISMATCH"))) {
    throw new Error("device-lane self-test failed to reject missing capture timeline contract");
  }
}

function writeCaptureArtifact(dir, index, modelIdentifier, captureKind, nullQualification) {
  const contractKey = sceneStateKey("S01_SEARCH", "rest");
  const geometry = glassGeometryBySceneState[contractKey];
  const timeline = glassCaptureTimelineBySceneState[contractKey];
  const pngPath = join(dir, `frame-${index}.png`);
  writePng(pngPath, 6, 6, makePixels(6, 6, Number.isFinite(Number(index)) ? Number(index) : 0));
  const maskPath = join(dir, "mask-pack.json");
  writeJson(maskPath, {
    schema_version: "1.2.0",
    mask_pack_id: "device_lane_self_test_masks",
    masks: [{ id: "core" }]
  });
  const artifactPath = join(dir, `r0-s01-rest-${index}.capture.json`);
  writeJson(artifactPath, {
    schema_version: "1.2.0",
    id: `device-lane-self-test-${index}`,
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    git_commit: "self-test",
    capture_kind: captureKind,
    null_qualification: nullQualification,
    device_info: {
      model_name: "iPhone",
      model_identifier: modelIdentifier,
      os_name: "iOS",
      os_version: "26.0",
      os_build: "23A-self-test",
      sdk_build: "26.0-self-test",
      screen_scale: 3,
      refresh_hz: 120,
      thermal_state_start: "nominal",
      thermal_state_end: "nominal",
      low_power_mode: false
    },
    environment: {
      appearance: "dark",
      reduce_transparency: false,
      reduce_motion: false,
      content_seed: "device-lane-self-test",
      geometry_pack_id: geometry.geometry_pack_id,
      geometry_id: geometry.geometry_id,
      geometry_pack_sha256: geometry.geometry_pack_sha256,
      viewport_px: { width: 6, height: 6 },
      capture_timestamp_ns: String(index)
    },
    color: {
      embedded_icc_profile: "Display P3",
      icc_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      working_space: "display-p3-linear",
      stored_transfer: "srgb-transfer",
      white_point: "D65"
    },
    frame_pack: {
      base_png_sha256: sha256File(pngPath),
      base_png_path: pngPath,
      sequence_paths: [pngPath],
      sequence_timestamps_ms: [0],
      mask_pack_sha256: sha256File(maskPath),
      mask_pack_path: maskPath,
      touch_phase: "rest",
      animation_t: 0,
      sustained_duration_ms: 10_000,
      capture_timeline_pack_id: timeline.capture_timeline_pack_id,
      capture_timeline_id: timeline.capture_timeline_id,
      capture_timeline_sha256: timeline.capture_timeline_sha256
    },
    shader: {
      pipeline: "passthrough"
    },
    perf: {
      measurement_source: "device-lane-self-test",
      full_frame_ms_p95: 8.2,
      frame_interval_ms_p95: 8.2,
      compositor_frame_ms_p95: 8.2,
      dropped_frames: 0,
      sustained_degradation_pct: 0.1
    },
    energy: {
      trace_available: false,
      trace_status: "trace_unavailable"
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-device-lane.self-test"
    }
  });
  return artifactPath;
}

function writeRepeatManifest({ dir, name, artifactPaths }) {
  const manifestPath = join(dir, name);
  writeJson(manifestPath, {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    capture_kind: "compositor",
    repeat_count_requested: 3,
    repeat_count_observed: artifactPaths.length,
    artifact_json_paths: artifactPaths
  });
  return manifestPath;
}

function makePixels(width, height, delta) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 42 + x + delta;
      pixels[offset + 1] = 84 + y;
      pixels[offset + 2] = 132;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function parseArgs(args) {
  const parsed = {
    laneClass: "mvl",
    gitCommit: process.env.GITHUB_SHA ?? "local",
    reason: "manual_physical_device_lane_plan",
    manifests: [],
    gates: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--lane") parsed.laneClass = args[++index];
    else if (arg === "--git-commit") parsed.gitCommit = args[++index];
    else if (arg === "--reason") parsed.reason = args[++index];
    else if (arg === "--plan") parsed.plan = args[++index];
    else if (arg === "--manifest") parsed.manifests.push(args[++index]);
    else if (arg === "--gate") parsed.gates.push(args[++index]);
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}
