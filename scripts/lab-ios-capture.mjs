#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validRigs = new Set(["R0", "R1", "C0", "C1", "DOM_C"]);
const validScenes = new Set(["S00_NULL", "S01_SEARCH", "S03_PRESS"]);
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
    baseline_class: request.repeat >= 300 ? "prod_p99" : request.repeat === 24 ? "sustained" : "mvl",
    on_device_app_action: {
      open_controls: true,
      set_rig: request.rig,
      set_scene_state: `${request.scene}/${request.state}`,
      set_repeat: request.repeat,
      press_button: "B"
    },
    metadata: {
      schemaVersion: "1.2.0",
      labPlan: "apple_glass_parity_execution_plan_v1_2",
      sceneId: request.scene,
      stateId: request.state,
      rigId: request.rig,
      captureKind: request.capture,
      baselineClass: request.repeat >= 300 ? "prod_p99" : request.repeat === 24 ? "sustained" : "mvl",
      requiresNominalThermal: true
    },
    output_contract: {
      manifest_kind: "repeat_capture_manifest",
      use_after_capture: `npm run ios:capture -- --rig ${request.rig} --scene ${request.scene} --state ${request.state} --device physical --capture compositor --repeat ${request.repeat} --manifest <repeat-manifest.json>`,
      baseline_command: `npm run metrics:baseline -- --ref-manifest <r0-repeat-manifest.json> --probe-manifest <r1-repeat-manifest.json> --class ${request.repeat >= 300 ? "prod_p99" : "mvl"} --repeat ${request.repeat} --out ./baselines/current.json`
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
  if (!validScenes.has(request.scene)) throw new Error(`Unsupported bootstrap scene: ${request.scene}`);
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
