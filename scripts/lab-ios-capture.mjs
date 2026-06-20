#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  glassSceneDefaults,
  metadataForGlassSceneState,
  validateGlassSceneState
} from "../packages/material-glass/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validRigs = new Set(["R0", "R1", "C0", "C1", "DOM_C"]);
const validScenes = new Set(Object.keys(glassSceneDefaults));
const validCaptureKinds = new Set(["compositor"]);
const validDeviceMatrixRoles = new Set(["mvl_primary", "weakest_supported", "target", "latest_pro"]);

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const manifest = writeSelfTestManifest();
    const report = verifyManifest({
      rig: "R0",
      scene: "S01_SEARCH",
      state: "rest",
      capture: "compositor",
      repeat: 3,
      deviceRole: "mvl_primary",
      manifest,
      out: args.out
    });
    assertRawFlagSemantics();
    console.log(`${report.status.toUpperCase()} ${report.jsonPath ?? ""}`.trim());
    if (report.status !== "pass") process.exit(1);
    return;
  }

  const request = normalizeRequest(args);
  const report = args.manifest ? verifyManifest(request) : writeCapturePlan(request);
  console.log(`${report.status.toUpperCase()} ${report.jsonPath ?? ""}`.trim());
  if (report.status === "fail") process.exit(1);
}

function writeCapturePlan(request) {
  const baselineClass = request.repeat >= 300 ? "prod_p99" : request.repeat === 24 ? "sustained" : "mvl";
  const captureDurationMs = baselineClass === "sustained" ? 60_000 : 900;
  const cooldownMs = baselineClass === "sustained" ? 60_000 : 750;
  const rawFramesEnabled = request.maxFidelity || request.captureRawFrames || request.captureRawPixels;
  const rawPixelsEnabled = request.maxFidelity || request.captureRawPixels;
  const maxFrames = request.maxFrames ?? (rawFramesEnabled ? 900 : 180);
  const sceneMetadata = metadataForGlassSceneState(request.scene, request.state);
  const metadata = {
    schemaVersion: "1.2.0",
    labPlan: "apple_glass_parity_execution_plan_v1_2",
    ...sceneMetadata,
    rigId: request.rig,
    captureKind: request.capture,
    deviceMatrixRole: request.deviceRole,
    baselineClass,
    requiresNominalThermal: true,
    captureDurationMs,
    cooldownMs,
    maxFrames,
    maxFidelity: request.maxFidelity,
    captureRawFrames: rawFramesEnabled,
    captureRawPixels: rawPixelsEnabled
  };

  const outputFlags = [];
  if (request.maxFidelity) outputFlags.push("--max-fidelity");
  if (rawFramesEnabled) outputFlags.push("--capture-raw-frames");
  if (rawPixelsEnabled) outputFlags.push("--capture-raw-pixels");
  const outputPathSuffix = outputFlags.length > 0 ? ` ${outputFlags.join(" ")}` : "";

  const plan = {
    schema_version: "1.2.0",
    kind: "ios_capture_plan",
    status: "awaiting_on_device_repeat_capture",
    device: request.device,
    rig_id: request.rig,
    scene_id: request.scene,
    state_id: request.state,
    capture_kind: request.capture,
    repeat_count_requested: request.repeat,
    baseline_class: baselineClass,
    device_matrix_role: request.deviceRole,
    capture_duration_ms: captureDurationMs,
    cooldown_ms: cooldownMs,
    on_device_app_action: {
      open_controls: true,
      set_rig: request.rig,
      set_scene_state: `${request.scene}/${request.state}`,
      set_device_matrix_role: request.deviceRole,
      set_repeat: request.repeat,
      press_button: "B"
    },
    metadata,
    output_contract: {
      manifest_kind: "repeat_capture_manifest",
      use_after_capture: `npm run ios:capture -- --rig ${request.rig} --scene ${request.scene} --state ${request.state} --device physical --capture compositor --repeat ${request.repeat} --device-role ${request.deviceRole} --max-frames ${maxFrames}${outputPathSuffix} --manifest <repeat-manifest.json>`,
      baseline_command: `npm run metrics:baseline -- --ref-manifest <r0-repeat-manifest.json> --probe-manifest <r1-repeat-manifest.json> --class ${baselineClass} --repeat ${request.repeat} --out ./baselines/current.json`
    }
  };

  const destination = request.out ?? join(repoRoot, "artifacts", "ios-capture-plan.json");
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  writeFileSync(resolve(destination), `${JSON.stringify(plan, null, 2)}\n`);
  return {
    ...plan,
    jsonPath: resolve(destination)
  };
}

function verifyManifest(request) {
  const manifestPath = resolve(request.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures = [];
  if (manifest.kind !== "repeat_capture_manifest") failures.push("MANIFEST_KIND_NOT_REPEAT_CAPTURE");
  if (manifest.rig_id !== request.rig) failures.push("RIG_MISMATCH");
  if (manifest.scene_id !== request.scene) failures.push("SCENE_MISMATCH");
  if (manifest.state_id !== request.state) failures.push("STATE_MISMATCH");
  if (manifest.capture_kind !== request.capture) failures.push("CAPTURE_KIND_MISMATCH");
  if (manifest.device_matrix_role !== request.deviceRole) failures.push("DEVICE_MATRIX_ROLE_MISMATCH");
  if ((manifest.repeat_count_observed ?? 0) < request.repeat) failures.push("REPEAT_COUNT_INCOMPLETE");
  if (!Array.isArray(manifest.artifact_json_paths) || manifest.artifact_json_paths.length < request.repeat) {
    failures.push("ARTIFACT_PATHS_INCOMPLETE");
  }
  const requestedRawFrames = request.maxFidelity || request.captureRawFrames || request.captureRawPixels;
  const requestedRawPixels = request.maxFidelity || request.captureRawPixels;
  if (request.maxFidelity && manifest.max_fidelity !== true) failures.push("MANIFEST_MAX_FIDELITY_MISSING");
  if (requestedRawFrames) {
    if (manifest.capture_raw_frames !== true) failures.push("MANIFEST_CAPTURE_RAW_FRAMES_MISSING");
  }
  if (requestedRawPixels) {
    if (manifest.capture_raw_pixels !== true) failures.push("MANIFEST_CAPTURE_RAW_PIXELS_MISSING");
  }
  if (requestedRawFrames || requestedRawPixels) {
    if (typeof manifest.max_frames !== "number" || manifest.max_frames <= 0) failures.push("MANIFEST_MAX_FRAMES_MISSING");
  }

  const report = {
    schema_version: "1.2.0",
    kind: "ios_capture_verification",
    status: failures.length === 0 ? "pass" : "fail",
    manifest_path: manifestPath,
    request: {
      rig_id: request.rig,
      scene_id: request.scene,
      state_id: request.state,
      capture_kind: request.capture,
      device_matrix_role: request.deviceRole,
      repeat_count_requested: request.repeat
    },
    observed: {
      repeat_count_observed: manifest.repeat_count_observed ?? 0,
      artifact_json_paths: manifest.artifact_json_paths ?? []
    },
    failures
  };

  if (request.out) {
    mkdirSync(dirname(resolve(request.out)), { recursive: true });
    writeFileSync(resolve(request.out), `${JSON.stringify(report, null, 2)}\n`);
    report.jsonPath = resolve(request.out);
  }
  return report;
}

function normalizeRequest(args) {
  const request = {
    rig: args.rig ?? "R0",
    scene: args.scene ?? "S01_SEARCH",
    state: args.state ?? "rest",
    device: args.device ?? "physical",
    capture: args.capture ?? "compositor",
    deviceRole: args.deviceRole ?? "mvl_primary",
    repeat: args.repeat ?? 50,
    maxFidelity: Boolean(args.maxFidelity),
    captureRawFrames: Boolean(args.captureRawFrames),
    captureRawPixels: Boolean(args.captureRawPixels),
    maxFrames: args.maxFrames ?? null,
    manifest: args.manifest,
    out: args.out
  };

  if (!validRigs.has(request.rig)) throw new Error(`Unsupported rig: ${request.rig}`);
  if (!validScenes.has(request.scene)) throw new Error(`Unsupported scene: ${request.scene}`);
  const sceneFailures = validateGlassSceneState(request.scene, request.state);
  if (sceneFailures.length > 0) throw new Error(sceneFailures.join(", "));
  if (request.device !== "physical") throw new Error("Only --device physical is valid for parity capture");
  if (!validCaptureKinds.has(request.capture)) throw new Error("Only --capture compositor is implemented");
  if (!validDeviceMatrixRoles.has(request.deviceRole)) throw new Error(`Unsupported --device-role: ${request.deviceRole}`);
  if (!Number.isFinite(request.repeat) || request.repeat < 1) throw new Error("--repeat must be a positive number");
  if (request.maxFrames !== null) {
    if (!Number.isFinite(request.maxFrames) || request.maxFrames < 1) {
      throw new Error("--max-frames must be a positive number");
    }
  }
  return request;
}

function writeSelfTestManifest() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "ios-capture");
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "repeat-manifest.json");
  const manifest = {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    capture_kind: "compositor",
    device_matrix_role: "mvl_primary",
    repeat_count_requested: 3,
    repeat_count_observed: 3,
    artifact_json_paths: [
      join(dir, "a.capture.json"),
      join(dir, "b.capture.json"),
      join(dir, "c.capture.json")
    ]
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function assertRawFlagSemantics() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "ios-capture");
  const base = {
    rig: "R0",
    scene: "S01_SEARCH",
    state: "rest",
    device: "physical",
    capture: "compositor",
    deviceRole: "mvl_primary",
    repeat: 3,
    manifest: undefined
  };

  const rawFramesPlan = writeCapturePlan({
    ...base,
    maxFidelity: false,
    captureRawFrames: true,
    captureRawPixels: false,
    maxFrames: null,
    out: join(dir, "raw-frames.plan.json")
  });
  assertPlan(rawFramesPlan, {
    maxFidelity: false,
    captureRawFrames: true,
    captureRawPixels: false,
    includes: ["--capture-raw-frames"],
    excludes: ["--max-fidelity", "--capture-raw-pixels"]
  });

  const rawPixelsPlan = writeCapturePlan({
    ...base,
    maxFidelity: false,
    captureRawFrames: false,
    captureRawPixels: true,
    maxFrames: null,
    out: join(dir, "raw-pixels.plan.json")
  });
  assertPlan(rawPixelsPlan, {
    maxFidelity: false,
    captureRawFrames: true,
    captureRawPixels: true,
    includes: ["--capture-raw-frames", "--capture-raw-pixels"],
    excludes: ["--max-fidelity"]
  });

  const maxFidelityPlan = writeCapturePlan({
    ...base,
    maxFidelity: true,
    captureRawFrames: false,
    captureRawPixels: false,
    maxFrames: null,
    out: join(dir, "max-fidelity.plan.json")
  });
  assertPlan(maxFidelityPlan, {
    maxFidelity: true,
    captureRawFrames: true,
    captureRawPixels: true,
    includes: ["--max-fidelity", "--capture-raw-frames", "--capture-raw-pixels"],
    excludes: []
  });
}

function assertPlan(plan, expected) {
  const metadata = plan.metadata ?? {};
  if (metadata.maxFidelity !== expected.maxFidelity) {
    throw new Error("ios-capture raw flag self-test failed maxFidelity semantics");
  }
  if (metadata.captureRawFrames !== expected.captureRawFrames) {
    throw new Error("ios-capture raw flag self-test failed captureRawFrames semantics");
  }
  if (metadata.captureRawPixels !== expected.captureRawPixels) {
    throw new Error("ios-capture raw flag self-test failed captureRawPixels semantics");
  }
  const command = plan.output_contract?.use_after_capture ?? "";
  for (const flag of expected.includes) {
    if (!command.includes(flag)) throw new Error(`ios-capture plan command missing ${flag}`);
  }
  for (const flag of expected.excludes) {
    if (command.includes(flag)) throw new Error(`ios-capture plan command should not include ${flag}`);
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--rig") parsed.rig = args[++index];
    else if (arg === "--scene") parsed.scene = args[++index];
    else if (arg === "--state") parsed.state = args[++index];
    else if (arg === "--device") parsed.device = args[++index];
    else if (arg === "--capture") parsed.capture = args[++index];
    else if (arg === "--device-role") parsed.deviceRole = args[++index];
    else if (arg === "--repeat") parsed.repeat = Number(args[++index]);
    else if (arg === "--max-fidelity") parsed.maxFidelity = true;
    else if (arg === "--capture-raw-frames") parsed.captureRawFrames = true;
    else if (arg === "--capture-raw-pixels") parsed.captureRawPixels = true;
    else if (arg === "--max-frames") {
      parsed.maxFrames = Number(args[++index]);
    }
    else if (arg === "--manifest") parsed.manifest = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
