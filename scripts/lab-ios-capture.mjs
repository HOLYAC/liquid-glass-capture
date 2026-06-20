#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validRigs = new Set(["R0", "R1", "C0", "C1", "DOM_C"]);
const sceneDefaults = Object.freeze({
  S00_NULL: Object.freeze({ states: ["s00_flat_grey", "s00_hard_edge", "s00_p3_ramp", "s00_smooth_gradient"], touchPhase: "rest", contentSeed: "s00-flat-p3-grey-v1" }),
  S01_SEARCH: Object.freeze({ states: ["rest"], touchPhase: "rest", contentSeed: "s01-search-selection-v1" }),
  S02_LOUPE: Object.freeze({ states: ["drag"], touchPhase: "drag", contentSeed: "s02-loupe-text-drag-v1" }),
  S03_PRESS: Object.freeze({ states: ["press"], touchPhase: "press", contentSeed: "s03-press-control-v1", trajectorySourceSha256: "56148be556260e9f1647bf9ab09ddf12c7ae129b3194722b2ed54bb8ad2fbcdd" }),
  S04_MORPH: Object.freeze({ states: ["morph"], touchPhase: "morph", contentSeed: "s04-twin-capsule-morph-v1" }),
  S05_FLOATING_BAR: Object.freeze({ states: ["floating_rest"], touchPhase: "rest", contentSeed: "s05-floating-bar-v1" }),
  S06_TINY_GLASS: Object.freeze({ states: ["tiny_rest"], touchPhase: "rest", contentSeed: "s06-tiny-control-v1" }),
  S07_BUSY_PHOTO: Object.freeze({ states: ["busy_photo_rest"], touchPhase: "rest", contentSeed: "s07-busy-photo-procedural-v1", backgroundAssetHash: "77238364440e942b31adefec365389a6f2c25a9b0a5561945db9468f8337f148" }),
  S08_P3_GRADIENT: Object.freeze({ states: ["p3_gradient_rest"], touchPhase: "rest", contentSeed: "s08-p3-saturated-gradient-v1" }),
  S09_NEAR_WHITE: Object.freeze({ states: ["near_white_rest"], touchPhase: "rest", contentSeed: "s09-near-white-v1" }),
  S10_NEAR_BLACK: Object.freeze({ states: ["near_black_rest"], touchPhase: "rest", contentSeed: "s10-near-black-v1" }),
  S11_VIDEO_FRAME: Object.freeze({ states: ["video_frame_rest"], touchPhase: "rest", contentSeed: "s11-video-high-frequency-procedural-v1", backgroundAssetHash: "e976e690f06f8b955a86ab8e49d2fcef51f942c220e975a03c30d414702998a5" }),
  S12_SYSTEM_MATERIAL_ADJACENCY: Object.freeze({ states: ["system_material_rest"], touchPhase: "morph", contentSeed: "s12-system-material-adjacency-procedural-v1", backgroundAssetHash: "15cc42e8ad24fd0179d917962281292ea97ea735ceb12796f8eb681e92049fe6" })
});
const validScenes = new Set(Object.keys(sceneDefaults));
const validCaptureKinds = new Set(["compositor"]);

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
      manifest,
      out: args.out
    });
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
  const sceneDefault = sceneDefaults[request.scene];
  const metadata = {
    schemaVersion: "1.2.0",
    labPlan: "apple_glass_parity_execution_plan_v1_2",
    sceneId: request.scene,
    stateId: request.state,
    rigId: request.rig,
    captureKind: request.capture,
    baselineClass,
    touchPhase: sceneDefault.touchPhase,
    contentSeed: contentSeedFor(request, sceneDefault),
    requiresNominalThermal: true,
    captureDurationMs,
    cooldownMs
  };
  if (sceneDefault.backgroundAssetHash) metadata.backgroundAssetHash = sceneDefault.backgroundAssetHash;
  if (sceneDefault.trajectorySourceSha256) metadata.trajectorySourceSha256 = sceneDefault.trajectorySourceSha256;

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
    capture_duration_ms: captureDurationMs,
    cooldown_ms: cooldownMs,
    on_device_app_action: {
      open_controls: true,
      set_rig: request.rig,
      set_scene_state: `${request.scene}/${request.state}`,
      set_repeat: request.repeat,
      press_button: "B"
    },
    metadata,
    output_contract: {
      manifest_kind: "repeat_capture_manifest",
      use_after_capture: `npm run ios:capture -- --rig ${request.rig} --scene ${request.scene} --state ${request.state} --device physical --capture compositor --repeat ${request.repeat} --manifest <repeat-manifest.json>`,
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

function contentSeedFor(request, sceneDefault) {
  if (request.scene !== "S00_NULL") return sceneDefault.contentSeed;
  return ({
    s00_flat_grey: "s00-flat-p3-grey-v1",
    s00_hard_edge: "s00-hard-edge-v1",
    s00_p3_ramp: "s00-p3-ramp-v1",
    s00_smooth_gradient: "s00-smooth-gradient-v1"
  })[request.state] ?? sceneDefault.contentSeed;
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
  if ((manifest.repeat_count_observed ?? 0) < request.repeat) failures.push("REPEAT_COUNT_INCOMPLETE");
  if (!Array.isArray(manifest.artifact_json_paths) || manifest.artifact_json_paths.length < request.repeat) {
    failures.push("ARTIFACT_PATHS_INCOMPLETE");
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
    repeat: args.repeat ?? 50,
    manifest: args.manifest,
    out: args.out
  };

  if (!validRigs.has(request.rig)) throw new Error(`Unsupported rig: ${request.rig}`);
  if (!validScenes.has(request.scene)) throw new Error(`Unsupported scene: ${request.scene}`);
  if (!sceneDefaults[request.scene].states.includes(request.state)) {
    throw new Error(`State ${request.state} is not valid for ${request.scene}`);
  }
  if (request.device !== "physical") throw new Error("Only --device physical is valid for parity capture");
  if (!validCaptureKinds.has(request.capture)) throw new Error("Only --capture compositor is implemented");
  if (!Number.isFinite(request.repeat) || request.repeat < 1) throw new Error("--repeat must be a positive number");
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
    else if (arg === "--repeat") parsed.repeat = Number(args[++index]);
    else if (arg === "--manifest") parsed.manifest = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
