#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  glassSceneDefaults,
  metadataForGlassSceneState,
  validateGlassSceneState
} from "../packages/material-glass/src/index.mjs";
import {
  canonicalArtifactHashMethod,
  finalizeCaptureArtifactIntegrity,
  validateCaptureArtifactIntegrity
} from "../packages/capture-schema/src/integrity.mjs";

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
    assertRawManifestVerification();
    assertCaptureRootDiscovery();
    assertAppProofDefaults();
    console.log(`${report.status.toUpperCase()} ${report.jsonPath ?? ""}`.trim());
    if (report.status !== "pass") process.exit(1);
    return;
  }

  const request = normalizeRequest(args);
  const report = request.manifest ? verifyManifest(request) : writeCapturePlan(request);
  console.log(`${report.status.toUpperCase()} ${report.jsonPath ?? report.manifest_path ?? ""}`.trim());
  if (report.status === "pass" && report.next?.inspect_command) {
    console.log(`INSPECT ${report.next.inspect_command}`);
  }
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
      set_max_fidelity: request.maxFidelity,
      set_device_matrix_role: request.deviceRole,
      set_repeat: request.repeat,
      press_button: "B"
    },
    artifact_transfer: {
      app_documents_root: "Liquid Glass Capture/Documents",
      capture_root: "LiquidGlassCaptures",
      repeat_manifests: "LiquidGlassCaptures/Series/*.repeat-manifest.json",
      session_artifacts: "LiquidGlassCaptures/Sessions/<capture-id>/",
      access_note: "app.json enables UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace, so copy the LiquidGlassCaptures folder from the app Documents container via Files/iTunes/Sideloadly file browser"
    },
    metadata,
    output_contract: {
      manifest_kind: "repeat_capture_manifest",
      raw_required: rawFramesEnabled,
      display_raw_required: rawPixelsEnabled,
      proof: [
        "repeat manifest status must be complete",
        "repeat manifest must point to every capture artifact JSON",
        "each capture artifact must carry frame_pack.frame_manifest_path + frame_manifest_sha256",
        "each frame_manifest frame must carry raw.path + raw.sha256",
        rawPixelsEnabled
          ? "each frame_manifest frame must also carry raw.display.path + raw.display.sha256"
          : "display raw is not required for this request"
      ],
      use_after_capture: `npm run ios:capture -- --rig ${request.rig} --scene ${request.scene} --state ${request.state} --device physical --capture compositor --repeat ${request.repeat} --device-role ${request.deviceRole} --max-frames ${maxFrames}${outputPathSuffix} --manifest <repeat-manifest.json>`,
      use_after_copy_latest: `npm run ios:capture -- --rig ${request.rig} --scene ${request.scene} --state ${request.state} --device physical --capture compositor --repeat ${request.repeat} --device-role ${request.deviceRole} --max-frames ${maxFrames}${outputPathSuffix} --capture-root ./artifacts/iphone/LiquidGlassCaptures --out ./artifacts/ios-max-fidelity-proof.verify.json`,
      inspect_after_pass: "npm run glass:inspect -- <first-or-last-capture.json> --out ./artifacts/viewer/max-fidelity.inspect.html",
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
  const manifestDir = dirname(manifestPath);
  const artifactJsonPaths = Array.isArray(manifest.artifact_json_paths) ? manifest.artifact_json_paths : [];
  const resolvedArtifactJsonPaths = artifactJsonPaths
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => resolveMaybe(manifestDir, value));
  const latestArtifactJsonPath = resolvedArtifactJsonPaths.at(-1) ?? null;
  const minStartedAtNs = request.minStartedAtNs ?? null;
  const retryEvents = Array.isArray(manifest.retry_events) ? manifest.retry_events : [];
  const manifestFailures = Array.isArray(manifest.failures)
    ? manifest.failures.filter((failure) => typeof failure === "string" && failure.length > 0)
    : [];
  const failures = [];
  if (manifest.kind !== "repeat_capture_manifest") failures.push("MANIFEST_KIND_NOT_REPEAT_CAPTURE");
  if (manifest.status !== "complete") failures.push(`MANIFEST_STATUS_NOT_COMPLETE:${String(manifest.status ?? "missing")}`);
  if (manifestFailures.length > 0) failures.push("MANIFEST_RECORDED_FAILURES");
  if (manifest.rig_id !== request.rig) failures.push("RIG_MISMATCH");
  if (manifest.scene_id !== request.scene) failures.push("SCENE_MISMATCH");
  if (manifest.state_id !== request.state) failures.push("STATE_MISMATCH");
  if (manifest.capture_kind !== request.capture) failures.push("CAPTURE_KIND_MISMATCH");
  if (manifest.device_matrix_role !== request.deviceRole) failures.push("DEVICE_MATRIX_ROLE_MISMATCH");
  if ((manifest.repeat_count_observed ?? 0) < request.repeat) failures.push("REPEAT_COUNT_INCOMPLETE");
  if (!Array.isArray(manifest.artifact_json_paths) || manifest.artifact_json_paths.length < request.repeat) {
    failures.push("ARTIFACT_PATHS_INCOMPLETE");
  }
  if (minStartedAtNs !== null) {
    const manifestTime = manifestFreshnessKey(manifest);
    if (manifestTime === null) {
      failures.push("MANIFEST_FRESHNESS_TIMESTAMP_MISSING");
    } else if (manifestTime < minStartedAtNs) {
      failures.push("MANIFEST_NOT_FRESH_FOR_PROOF_RUN");
    }
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
  if (requestedRawFrames && Array.isArray(manifest.artifact_json_paths)) {
    for (const [index, artifactJsonPath] of manifest.artifact_json_paths.entries()) {
      verifyArtifactRawManifest(failures, manifestDir, artifactJsonPath, index, {
        requiresRawDisplay: requestedRawPixels
      });
    }
  }
  const status = failures.length > 0
    ? "fail"
    : retryEvents.length > 0
      ? "pass_with_retries"
      : "pass";

  const report = {
    schema_version: "1.2.0",
    kind: "ios_capture_verification",
    status,
    manifest_path: manifestPath,
    capture_root: request.captureRoot ?? null,
    capture_count: resolvedArtifactJsonPaths.length,
    request: {
      rig_id: request.rig,
      scene_id: request.scene,
      state_id: request.state,
      capture_kind: request.capture,
      device_matrix_role: request.deviceRole,
      repeat_count_requested: request.repeat,
      min_started_at_ns: minStartedAtNs === null ? null : minStartedAtNs.toString()
    },
    observed: {
      repeat_count_observed: manifest.repeat_count_observed ?? 0,
      artifact_json_paths: manifest.artifact_json_paths ?? [],
      artifact_json_paths_resolved: resolvedArtifactJsonPaths,
      latest_artifact_json_path: latestArtifactJsonPath,
      manifest_status: manifest.status ?? null,
      manifest_failures: manifestFailures,
      retry_event_count: retryEvents.length,
      retry_events: retryEvents,
      retry_policy: manifest.policy
        ? {
          retry_replaykit_no_frame: manifest.policy.retry_replaykit_no_frame ?? false,
          max_no_frame_retries: manifest.policy.max_no_frame_retries ?? null
        }
        : null,
      clean_capture_path: retryEvents.length === 0
    },
    next: latestArtifactJsonPath
      ? {
        inspect_command: `npm run glass:inspect -- ${shellQuote(latestArtifactJsonPath)} --out ./artifacts/viewer/max-fidelity.inspect.html`
      }
      : {},
    failures
  };

  if (request.out) {
    mkdirSync(dirname(resolve(request.out)), { recursive: true });
    writeFileSync(resolve(request.out), `${JSON.stringify(report, null, 2)}\n`);
    report.jsonPath = resolve(request.out);
  }
  return report;
}

function verifyArtifactRawManifest(failures, manifestDir, artifactJsonPath, index, options) {
  const artifactLabel = `ARTIFACT_${index}`;
  if (typeof artifactJsonPath !== "string" || artifactJsonPath.length === 0) {
    failures.push(`${artifactLabel}_PATH_INVALID`);
    return;
  }

  const artifactPath = resolveMaybe(manifestDir, artifactJsonPath);
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (error) {
    failures.push(`${artifactLabel}_JSON_INVALID:${error.message}`);
    return;
  }

  for (const integrityFailure of validateCaptureArtifactIntegrity(artifact)) {
    failures.push(`${artifactLabel}_${integrityFailure}`);
  }
  if (artifact.integrity?.artifact_hash_method !== canonicalArtifactHashMethod) {
    failures.push(`${artifactLabel}_INTEGRITY_CANONICAL_HASH_METHOD_MISSING`);
  }

  const framePack = artifact.frame_pack ?? {};
  const frameManifestPath = framePack.frame_manifest_path;
  const frameManifestSHA256 = framePack.frame_manifest_sha256;
  if (typeof frameManifestPath !== "string" || frameManifestPath.length === 0) {
    failures.push(`${artifactLabel}_RAW_MANIFEST_PATH_MISSING`);
    return;
  }
  if (typeof frameManifestSHA256 !== "string" || frameManifestSHA256.length === 0) {
    failures.push(`${artifactLabel}_RAW_MANIFEST_SHA_MISSING`);
    return;
  }

  const artifactDir = dirname(artifactPath);
  const absoluteFrameManifestPath = resolveMaybe(artifactDir, frameManifestPath);
  verifyFileHash(failures, artifactLabel, absoluteFrameManifestPath, frameManifestSHA256);

  let frameManifest;
  try {
    frameManifest = JSON.parse(readFileSync(absoluteFrameManifestPath, "utf8"));
  } catch (error) {
    failures.push(`${artifactLabel}_RAW_MANIFEST_JSON_INVALID:${error.message}`);
    return;
  }
  if (!Array.isArray(frameManifest.frames)) {
    failures.push(`${artifactLabel}_RAW_MANIFEST_FRAMES_NOT_ARRAY`);
    return;
  }
  if (frameManifest.frames.length === 0) {
    failures.push(`${artifactLabel}_RAW_MANIFEST_EMPTY`);
  }
  if (typeof frameManifest.frame_count === "number" && frameManifest.frame_count !== frameManifest.frames.length) {
    failures.push(`${artifactLabel}_RAW_MANIFEST_COUNT_MISMATCH`);
  }

  for (const [frameIndex, frame] of frameManifest.frames.entries()) {
    const frameLabel = `${artifactLabel}_FRAME_${frameIndex}`;
    if (!frame || typeof frame !== "object") {
      failures.push(`${frameLabel}_NOT_OBJECT`);
      continue;
    }
    if (!frame.raw || typeof frame.raw !== "object") {
      failures.push(`${frameLabel}_RAW_MISSING`);
      continue;
    }
    verifyRawFileRef(failures, artifactDir, `${frameLabel}_RAW`, frame.raw);
    if (options.requiresRawDisplay) {
      if (!frame.raw.display || typeof frame.raw.display !== "object") {
        failures.push(`${frameLabel}_RAW_DISPLAY_MISSING`);
      } else {
        verifyRawFileRef(failures, artifactDir, `${frameLabel}_RAW_DISPLAY`, frame.raw.display);
      }
    }
  }
}

function verifyRawFileRef(failures, artifactDir, label, raw) {
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    failures.push(`${label}_PATH_MISSING`);
    return;
  }
  if (typeof raw.sha256 !== "string" || raw.sha256.length === 0) {
    failures.push(`${label}_SHA_MISSING`);
    return;
  }
  if (typeof raw.byteCount !== "number" || !Number.isFinite(raw.byteCount) || raw.byteCount <= 0) {
    failures.push(`${label}_BYTE_COUNT_INVALID`);
    return;
  }
  verifyFileHash(failures, label, resolveMaybe(artifactDir, raw.path), raw.sha256, raw.byteCount);
}

function verifyFileHash(failures, label, path, expectedSHA256, expectedByteCount = null) {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      failures.push(`${label}_NOT_FILE`);
      return;
    }
    if (expectedByteCount !== null && stats.size !== expectedByteCount) {
      failures.push(`${label}_BYTE_COUNT_MISMATCH`);
    }
    const actualSHA256 = sha256File(path);
    if (actualSHA256.toLowerCase() !== String(expectedSHA256).toLowerCase()) {
      failures.push(`${label}_SHA_MISMATCH`);
    }
  } catch (error) {
    failures.push(`${label}_FILE_UNREADABLE:${error.message}`);
  }
}

function resolveMaybe(baseDir, path) {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeRequest(args) {
  const captureRoot = args.captureRoot ? resolve(args.captureRoot) : null;
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
    minStartedAtNs: args.minStartedAtNs ?? null,
    manifest: args.manifest ?? (captureRoot ? findLatestRepeatManifest(captureRoot) : undefined),
    captureRoot,
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
  if (request.minStartedAtNs !== null && request.minStartedAtNs < 0n) {
    throw new Error("--min-started-at-ns must be a non-negative integer");
  }
  return request;
}

function findLatestRepeatManifest(captureRoot) {
  const seriesDir = join(resolve(captureRoot), "Series");
  const candidates = readdirSync(seriesDir)
    .filter((name) => name.endsWith(".repeat-manifest.json"))
    .map((name) => {
      const path = join(seriesDir, name);
      return {
        path,
        orderKey: repeatManifestOrderKey(path)
      };
    })
    .sort((left, right) => {
      if (left.orderKey === right.orderKey) return right.path.localeCompare(left.path);
      return left.orderKey > right.orderKey ? -1 : 1;
    });

  if (candidates.length === 0) {
    throw new Error(`No *.repeat-manifest.json found in ${seriesDir}`);
  }
  return candidates[0].path;
}

function repeatManifestOrderKey(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const key = manifestFreshnessKey(manifest);
    if (key !== null) return key;
  } catch {
    // Fall back to filesystem mtime below.
  }
  return BigInt(Math.round(statSync(path).mtimeMs * 1_000_000));
}

function manifestFreshnessKey(manifest) {
  const raw = manifest?.finished_at_ns ?? manifest?.started_at_ns;
  if (typeof raw === "bigint" && raw >= 0n) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return BigInt(Math.round(raw));
  return null;
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
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

function assertRawManifestVerification() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "ios-capture-raw");
  mkdirSync(dir, { recursive: true });

  const rawPath = join(dir, "000000.source.raw");
  const displayPath = join(dir, "000000.display.rgba");
  writeFileSync(rawPath, Buffer.from([1, 2, 3, 4]));
  writeFileSync(displayPath, Buffer.from([5, 6, 7, 8]));

  const frame = {
    index: 0,
    png: "000000.png",
    sha256: "0".repeat(64),
    raw: {
      path: "000000.source.raw",
      format: "32BGRA",
      width: 1,
      height: 1,
      bytesPerRow: 4,
      byteCount: 4,
      sha256: sha256File(rawPath),
      display: {
        path: "000000.display.rgba",
        format: "32RGBA",
        width: 1,
        height: 1,
        bytesPerRow: 4,
        byteCount: 4,
        sha256: sha256File(displayPath)
      }
    }
  };
  const frameManifestPath = join(dir, "frame_manifest.json");
  writeJson(frameManifestPath, {
    schema_version: "1.0.0",
    frame_count: 1,
    frames: [frame]
  });
  const artifactPath = join(dir, "a.capture.json");
  writeArtifactJson(artifactPath, {
    schema_version: "1.2.0",
    frame_pack: {
      frame_manifest_path: "frame_manifest.json",
      frame_manifest_sha256: sha256File(frameManifestPath)
    }
  });
  const repeatManifestPath = join(dir, "repeat-manifest.json");
  const repeatManifest = {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    capture_kind: "compositor",
    device_matrix_role: "mvl_primary",
    repeat_count_requested: 1,
    repeat_count_observed: 1,
    artifact_json_paths: ["a.capture.json"],
    started_at_ns: "100",
    finished_at_ns: "200",
    max_fidelity: false,
    capture_raw_frames: true,
    capture_raw_pixels: true,
    max_frames: 1
  };
  writeJson(repeatManifestPath, repeatManifest);

  const baseRequest = {
    rig: "R0",
    scene: "S01_SEARCH",
    state: "rest",
    capture: "compositor",
    deviceRole: "mvl_primary",
    repeat: 1,
    maxFidelity: false,
    captureRawFrames: false,
    captureRawPixels: true,
    maxFrames: 1,
    minStartedAtNs: null,
    manifest: repeatManifestPath
  };
  const passReport = verifyManifest(baseRequest);
  if (passReport.status !== "pass") {
    throw new Error(`ios-capture raw manifest self-test should pass: ${passReport.failures.join(", ")}`);
  }
  if (passReport.capture_count !== 1) {
    throw new Error("ios-capture raw manifest self-test failed to report capture_count");
  }
  const freshReport = verifyManifest({
    ...baseRequest,
    minStartedAtNs: 150n
  });
  if (freshReport.status !== "pass") {
    throw new Error(`ios-capture raw manifest freshness self-test should pass: ${freshReport.failures.join(", ")}`);
  }
  const taintedManifestPath = join(dir, "retry-tainted.repeat-manifest.json");
  writeJson(taintedManifestPath, {
    ...repeatManifest,
    retry_events: [{
      index: 0,
      attempt: 0,
      next_attempt: 1,
      error: "ReplayKit compositor capture produced no video frames",
      retry_delay_ms: 2500
    }],
    policy: {
      retry_replaykit_no_frame: true,
      max_no_frame_retries: 3
    }
  });
  const retryReport = verifyManifest({
    ...baseRequest,
    manifest: taintedManifestPath
  });
  if (retryReport.status !== "pass_with_retries" ||
      retryReport.observed.retry_event_count !== 1 ||
      retryReport.observed.clean_capture_path !== false) {
    throw new Error("ios-capture retry provenance self-test failed to taint report status");
  }
  const abortedManifestPath = join(dir, "aborted.repeat-manifest.json");
  writeJson(abortedManifestPath, {
    ...repeatManifest,
    status: "aborted",
    failures: ["STOP_FAILED_0: ReplayKit compositor capture produced no video frames"]
  });
  const abortedReport = verifyManifest({
    ...baseRequest,
    manifest: abortedManifestPath
  });
  if (abortedReport.status !== "fail" ||
      !abortedReport.failures.includes("MANIFEST_RECORDED_FAILURES") ||
      !abortedReport.failures.some((failure) => failure.startsWith("MANIFEST_STATUS_NOT_COMPLETE"))) {
    throw new Error("ios-capture aborted manifest self-test failed to reject recorded failure");
  }
  const staleReport = verifyManifest({
    ...baseRequest,
    minStartedAtNs: 201n
  });
  if (staleReport.status !== "fail" || !staleReport.failures.includes("MANIFEST_NOT_FRESH_FOR_PROOF_RUN")) {
    throw new Error("ios-capture raw manifest self-test failed to reject stale proof-run manifest");
  }

  const badFrameManifestPath = join(dir, "frame_manifest_missing_display.json");
  const badFrame = JSON.parse(JSON.stringify(frame));
  delete badFrame.raw.display;
  writeJson(badFrameManifestPath, {
    schema_version: "1.0.0",
    frame_count: 1,
    frames: [badFrame]
  });
  writeArtifactJson(artifactPath, {
    schema_version: "1.2.0",
    frame_pack: {
      frame_manifest_path: "frame_manifest_missing_display.json",
      frame_manifest_sha256: sha256File(badFrameManifestPath)
    }
  });
  const failReport = verifyManifest(baseRequest);
  if (failReport.status !== "fail" || !failReport.failures.includes("ARTIFACT_0_FRAME_0_RAW_DISPLAY_MISSING")) {
    throw new Error("ios-capture raw manifest self-test failed to catch missing display raw");
  }

  const badSizeFrameManifestPath = join(dir, "frame_manifest_bad_raw_size.json");
  const badSizeFrame = JSON.parse(JSON.stringify(frame));
  badSizeFrame.raw.byteCount = 999;
  writeJson(badSizeFrameManifestPath, {
    schema_version: "1.0.0",
    frame_count: 1,
    frames: [badSizeFrame]
  });
  writeArtifactJson(artifactPath, {
    schema_version: "1.2.0",
    frame_pack: {
      frame_manifest_path: "frame_manifest_bad_raw_size.json",
      frame_manifest_sha256: sha256File(badSizeFrameManifestPath)
    }
  });
  const badSizeReport = verifyManifest(baseRequest);
  if (badSizeReport.status !== "fail" || !badSizeReport.failures.includes("ARTIFACT_0_FRAME_0_RAW_BYTE_COUNT_MISMATCH")) {
    throw new Error("ios-capture raw manifest self-test failed to catch raw byteCount mismatch");
  }
}

function assertCaptureRootDiscovery() {
  const root = join(
    repoRoot,
    "artifacts",
    "lab-self-test",
    "ios-capture-latest",
    `${Date.now()}-${process.pid}`,
    "LiquidGlassCaptures"
  );
  const seriesDir = join(root, "Series");
  const sessionDir = join(root, "Sessions", "latest-capture");
  mkdirSync(seriesDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  writeJson(join(seriesDir, "z-old.repeat-manifest.json"), {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    capture_kind: "compositor",
    device_matrix_role: "mvl_primary",
    repeat_count_requested: 1,
    repeat_count_observed: 0,
    finished_at_ns: "1",
    artifact_json_paths: []
  });

  const rawPath = join(sessionDir, "000000.source.raw");
  const displayPath = join(sessionDir, "000000.display.rgba");
  writeFileSync(rawPath, Buffer.from([9, 10, 11, 12]));
  writeFileSync(displayPath, Buffer.from([13, 14, 15, 16]));
  const frameManifestPath = join(sessionDir, "frame_manifest.json");
  writeJson(frameManifestPath, {
    schema_version: "1.0.0",
    frame_count: 1,
    frames: [
      {
        index: 0,
        png: "000000.png",
        sha256: "0".repeat(64),
        raw: {
          path: "000000.source.raw",
          format: "32BGRA",
          width: 1,
          height: 1,
          bytesPerRow: 4,
          byteCount: 4,
          sha256: sha256File(rawPath),
          display: {
            path: "000000.display.rgba",
            format: "32RGBA",
            width: 1,
            height: 1,
            bytesPerRow: 4,
            byteCount: 4,
            sha256: sha256File(displayPath)
          }
        }
      }
    ]
  });
  const artifactPath = join(sessionDir, "latest.capture.json");
  writeArtifactJson(artifactPath, {
    schema_version: "1.2.0",
    frame_pack: {
      frame_manifest_path: "frame_manifest.json",
      frame_manifest_sha256: sha256File(frameManifestPath)
    }
  });
  const latestManifestPath = join(seriesDir, "a-latest.repeat-manifest.json");
  writeJson(latestManifestPath, {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    capture_kind: "compositor",
    device_matrix_role: "mvl_primary",
    repeat_count_requested: 1,
    repeat_count_observed: 1,
    finished_at_ns: "2",
    artifact_json_paths: ["../Sessions/latest-capture/latest.capture.json"],
    max_fidelity: true,
    capture_raw_frames: true,
    capture_raw_pixels: true,
    max_frames: 1
  });

  const request = normalizeRequest({
    rig: "R0",
    scene: "S01_SEARCH",
    state: "rest",
    device: "physical",
    capture: "compositor",
    deviceRole: "mvl_primary",
    repeat: 1,
    maxFidelity: true,
    captureRawFrames: false,
    captureRawPixels: false,
    maxFrames: 1,
    minStartedAtNs: null,
    captureRoot: root
  });
  if (request.manifest !== latestManifestPath) {
    throw new Error("ios-capture latest manifest discovery picked the wrong manifest");
  }
  const report = verifyManifest(request);
  if (report.status !== "pass" || !report.next?.inspect_command) {
    throw new Error(`ios-capture latest manifest self-test failed: ${report.failures.join(", ")}`);
  }
}

function assertAppProofDefaults() {
  const appSource = readFileSync(join(repoRoot, "App.tsx"), "utf8");
  const invariants = [
    [/const repeatCounts = \[1, 3, 10, 24, 50, 300\] as const;/, "repeatCounts must expose one-repeat proof first"],
    [/const \[sceneId, setSceneId\] = useState<SceneId>\("S01_SEARCH"\);/, "default scene must be S01_SEARCH"],
    [/const \[rig, setRig\] = useState<LiquidGlassCaptureRig>\("R0"\);/, "default rig must be R0"],
    [/const \[repeatCount, setRepeatCount\] = useState<\(typeof repeatCounts\)\[number\]>\(1\);/, "default repeat must be 1"],
    [/const \[deviceMatrixRole, setDeviceMatrixRole\] = useState<DeviceMatrixRole>\("mvl_primary"\);/, "default device role must be mvl_primary"],
    [/const \[maxFidelityCapture, setMaxFidelityCapture\] = useState\(true\);/, "default max-fidelity capture must be true"]
  ];
  for (const [pattern, message] of invariants) {
    if (!pattern.test(appSource)) {
      throw new Error(`ios-capture app proof default self-test failed: ${message}`);
    }
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeArtifactJson(path, value) {
  finalizeCaptureArtifactIntegrity(value);
  writeJson(path, value);
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
    else if (arg === "--min-started-at-ns") parsed.minStartedAtNs = BigInt(args[++index]);
    else if (arg === "--manifest") parsed.manifest = args[++index];
    else if (arg === "--capture-root") parsed.captureRoot = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
