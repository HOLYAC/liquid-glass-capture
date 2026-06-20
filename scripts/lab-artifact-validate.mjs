#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import { validateMaskPack } from "../packages/mask-core/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const valid = {
  rig_id: ["R0", "R1", "C0", "C1", "DOM_C", "DX_REPLAY"],
  scene_id: [
    "S00_NULL",
    "S01_SEARCH",
    "S02_LOUPE",
    "S03_PRESS",
    "S04_MORPH",
    "S05_FLOATING_BAR",
    "S06_TINY_GLASS",
    "S07_BUSY_PHOTO",
    "S08_P3_GRADIENT",
    "S09_NEAR_WHITE",
    "S10_NEAR_BLACK",
    "S11_VIDEO_FRAME",
    "S12_SYSTEM_MATERIAL_ADJACENCY"
  ],
  capture_kind: ["compositor", "framebuffer", "layer_snapshot"],
  touch_phase: ["rest", "press", "drag", "release", "morph", "sustained"],
  device_matrix_role: ["mvl_primary", "weakest_supported", "target", "latest_pro"]
};

main();

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    const artifact = writeSelfTestArtifact();
    validateFile(artifact);
    assertGenericModelIdentifierRejected(artifact);
    console.log(`PASS ${artifact}`);
    return;
  }

  if (args.length === 0) {
    console.error("usage: node scripts/lab-artifact-validate.mjs <capture.json> [...]");
    console.error("       node scripts/lab-artifact-validate.mjs --self-test");
    process.exit(2);
  }

  let failures = 0;
  for (const file of args) {
    try {
      validateFile(file);
      console.log(`PASS ${file}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${file}`);
      console.error(String(error.message ?? error));
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

function validateFile(file) {
  const absolute = resolve(file);
  const artifact = JSON.parse(readFileSync(absolute, "utf8"));
  const errors = validateArtifact(artifact, dirname(absolute));
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join("\n"));
  }
}

function validateArtifact(artifact, artifactDir) {
  const errors = [];
  requireValue(errors, artifact.schema_version === "1.2.0", "schema_version must be 1.2.0");
  requireEnum(errors, "rig_id", artifact.rig_id, valid.rig_id);
  requireEnum(errors, "scene_id", artifact.scene_id, valid.scene_id);
  requireEnum(errors, "capture_kind", artifact.capture_kind, valid.capture_kind);
  requireString(errors, "id", artifact.id);
  requireString(errors, "state_id", artifact.state_id);
  requireString(errors, "git_commit", artifact.git_commit);

  if (artifact.rig_id === "R0" && artifact.scene_id !== "S00_NULL" && artifact.capture_kind === "layer_snapshot") {
    errors.push("R0 glass reference cannot use layer_snapshot; compositor or framebuffer capture is required");
  }

  if (artifact.rig_id !== "DX_REPLAY" && looksLikeSimulator(artifact.device_info?.model_identifier)) {
    errors.push("physical-device artifact required; simulator model_identifier is invalid");
  }

  validateDevice(errors, artifact.device_info);
  validateEnvironment(errors, artifact.environment);
  validateColor(errors, artifact.color);
  validateFramePack(errors, artifact.frame_pack, artifactDir, artifact);
  validatePerf(errors, artifact.perf);
  validateEnergy(errors, artifact.energy);
  validateReview(errors, artifact.review);
  validateIntegrity(errors, artifact.integrity);
  return errors;
}

function validateDevice(errors, device) {
  if (!device || typeof device !== "object") {
    errors.push("device_info is required");
    return;
  }

  for (const key of ["model_name", "model_identifier", "os_version", "os_build", "sdk_build"]) {
    requireString(errors, `device_info.${key}`, device[key]);
  }
  if (looksLikeGenericAppleFamilyIdentifier(device.model_identifier)) {
    errors.push("device_info.model_identifier must be hardware identifier, not UIDevice.current.model family");
  }
  if (device.device_matrix_role !== undefined) {
    requireEnum(errors, "device_info.device_matrix_role", device.device_matrix_role, valid.device_matrix_role);
  }
  requireValue(errors, device.os_name === "iOS", "device_info.os_name must be iOS");
  requireNumber(errors, "device_info.screen_scale", device.screen_scale);
  requireNumber(errors, "device_info.refresh_hz", device.refresh_hz);
  requireEnum(errors, "device_info.thermal_state_start", device.thermal_state_start, ["nominal", "fair", "serious", "critical"]);
  requireValue(errors, typeof device.low_power_mode === "boolean", "device_info.low_power_mode must be boolean");
}

function validateEnvironment(errors, environment) {
  if (!environment || typeof environment !== "object") {
    errors.push("environment is required");
    return;
  }

  requireEnum(errors, "environment.appearance", environment.appearance, ["light", "dark"]);
  requireValue(errors, typeof environment.reduce_transparency === "boolean", "environment.reduce_transparency must be boolean");
  requireValue(errors, typeof environment.reduce_motion === "boolean", "environment.reduce_motion must be boolean");
  requireString(errors, "environment.capture_timestamp_ns", environment.capture_timestamp_ns);
  requireNumber(errors, "environment.viewport_px.width", environment.viewport_px?.width);
  requireNumber(errors, "environment.viewport_px.height", environment.viewport_px?.height);

  if (!environment.content_seed && !environment.background_asset_hash) {
    errors.push("environment requires content_seed or background_asset_hash");
  }
  for (const key of ["geometry_pack_id", "geometry_id"]) {
    if (environment[key] !== undefined) requireString(errors, `environment.${key}`, environment[key]);
  }
  for (const key of ["background_pack_id", "background_id"]) {
    if (environment[key] !== undefined) requireString(errors, `environment.${key}`, environment[key]);
  }
  if (environment.background_pack_sha256 !== undefined) {
    requireSha256(errors, "environment.background_pack_sha256", environment.background_pack_sha256);
  }
  if (environment.geometry_pack_sha256 !== undefined) {
    requireSha256(errors, "environment.geometry_pack_sha256", environment.geometry_pack_sha256);
  }
}

function validateColor(errors, color) {
  if (!color || typeof color !== "object") {
    errors.push("color is required");
    return;
  }

  requireValue(errors, color.embedded_icc_profile === "Display P3", "color.embedded_icc_profile must be Display P3");
  requireString(errors, "color.icc_sha256", color.icc_sha256);
  requireValue(errors, color.working_space === "display-p3-linear", "color.working_space must be display-p3-linear");
  requireValue(errors, color.stored_transfer === "srgb-transfer", "color.stored_transfer must be srgb-transfer");
  requireValue(errors, color.white_point === "D65", "color.white_point must be D65");
}

function validateFramePack(errors, framePack, artifactDir, artifact) {
  if (!framePack || typeof framePack !== "object") {
    errors.push("frame_pack is required");
    return;
  }

  requireEnum(errors, "frame_pack.touch_phase", framePack.touch_phase, valid.touch_phase);
  requireNumber(errors, "frame_pack.animation_t", framePack.animation_t);
  verifyPathHash(errors, artifactDir, "frame_pack.base_png", framePack.base_png_path, framePack.base_png_sha256);
  verifyPathHash(errors, artifactDir, "frame_pack.mask_pack", framePack.mask_pack_path, framePack.mask_pack_sha256);
  validateFrameMaskPack(errors, artifactDir, framePack, artifact);

  if (framePack.sequence_timestamps_ms !== undefined) {
    if (!Array.isArray(framePack.sequence_timestamps_ms)) {
      errors.push("frame_pack.sequence_timestamps_ms must be an array when present");
    } else if (!framePack.sequence_timestamps_ms.every((value) => typeof value === "number" && Number.isFinite(value))) {
      errors.push("frame_pack.sequence_timestamps_ms must contain only finite numbers");
    }
  }

  if (Array.isArray(framePack.sequence_paths) && Array.isArray(framePack.sequence_timestamps_ms)) {
    requireValue(
      errors,
      framePack.sequence_paths.length === framePack.sequence_timestamps_ms.length,
      "frame_pack.sequence_paths and frame_pack.sequence_timestamps_ms must have the same length"
    );
  }
  for (const key of ["capture_timeline_pack_id", "capture_timeline_id"]) {
    if (framePack[key] !== undefined) requireString(errors, `frame_pack.${key}`, framePack[key]);
  }
  if (framePack.capture_timeline_sha256 !== undefined) {
    requireSha256(errors, "frame_pack.capture_timeline_sha256", framePack.capture_timeline_sha256);
  }
}

function validateFrameMaskPack(errors, artifactDir, framePack, artifact) {
  if (!framePack?.mask_pack_path) return;
  const maskPath = isAbsolute(framePack.mask_pack_path)
    ? framePack.mask_pack_path
    : resolve(artifactDir, framePack.mask_pack_path);
  try {
    const maskPack = JSON.parse(readFileSync(maskPath, "utf8"));
    for (const failure of validateMaskPack(maskPack, {
      sceneId: artifact.scene_id,
      stateId: artifact.state_id
    })) {
      errors.push(`frame_pack.mask_pack.${failure}`);
    }
  } catch (error) {
    errors.push(`frame_pack.mask_pack JSON invalid: ${error.message}`);
  }
}

function validateIntegrity(errors, integrity) {
  if (!integrity || typeof integrity !== "object") {
    errors.push("integrity is required");
    return;
  }
  requireString(errors, "integrity.artifact_sha256", integrity.artifact_sha256);
  requireString(errors, "integrity.producer_version", integrity.producer_version);
}

function validatePerf(errors, perf) {
  if (perf === undefined) return;
  if (!perf || typeof perf !== "object") {
    errors.push("perf must be an object when present");
    return;
  }

  for (const key of [
    "cpu_frame_ms_p95",
    "gpu_frame_ms_p95",
    "compositor_frame_ms_p95",
    "full_frame_ms_p95",
    "frame_interval_ms_p95",
    "sustained_degradation_pct",
    "memory_mb_p95",
    "refresh_budget_ms"
  ]) {
    if (perf[key] !== undefined) {
      requireNumber(errors, `perf.${key}`, perf[key]);
    }
  }
  if (perf.dropped_frames !== undefined) {
    requireNumber(errors, "perf.dropped_frames", perf.dropped_frames);
  }
}

function validateEnergy(errors, energy) {
  if (energy === undefined) return;
  if (!energy || typeof energy !== "object") {
    errors.push("energy must be an object when present");
    return;
  }

  requireValue(errors, typeof energy.trace_available === "boolean", "energy.trace_available must be boolean");
  if (energy.trace_status !== undefined) {
    requireEnum(errors, "energy.trace_status", energy.trace_status, ["available", "trace_unavailable"]);
  }
  if (energy.trace_tool !== undefined) {
    requireEnum(errors, "energy.trace_tool", energy.trace_tool, [
      "instruments_power_profiler",
      "metrickit",
      "validated_powermetrics_aux"
    ]);
  }
  for (const key of ["energy_mj_per_10s", "average_power_mw", "thermal_onset_ms"]) {
    if (energy[key] !== undefined) {
      requireNumber(errors, `energy.${key}`, energy[key]);
    }
  }
}

function validateReview(errors, review) {
  if (review === undefined) return;
  if (!review || typeof review !== "object") {
    errors.push("review must be an object when present");
    return;
  }

  if (review.g7_status !== undefined) {
    requireEnum(errors, "review.g7_status", review.g7_status, [
      "not_run",
      "passed",
      "pass_with_review",
      "blocked_for_design",
      "legibility_block"
    ]);
  }
  if (review.design_class !== undefined) {
    requireEnum(errors, "review.design_class", review.design_class, [
      "NOT_RUN",
      "PASS",
      "PASS_WITH_REVIEW",
      "BLOCKED_FOR_DESIGN",
      "LEGIBILITY_BLOCK"
    ]);
  }
  if (review.owner_decision !== undefined) {
    requireEnum(errors, "review.owner_decision", review.owner_decision, [
      "prod_pass",
      "pass_with_review",
      "blocked_for_design",
      "legibility_block"
    ]);
  }
  for (const key of [
    "design_reviewer",
    "product_reviewer",
    "review_packet_sha256",
    "g7_report_sha256",
    "g8_report_sha256",
    "comments_sha256"
  ]) {
    if (review[key] !== undefined) {
      requireString(errors, `review.${key}`, review[key]);
    }
  }
}

function verifyPathHash(errors, artifactDir, label, rawPath, expectedHash) {
  requireString(errors, `${label}_path`, rawPath);
  requireString(errors, `${label}_sha256`, expectedHash);
  if (!rawPath || !expectedHash) return;

  const path = isAbsolute(rawPath) ? rawPath : resolve(artifactDir, rawPath);
  try {
    const actual = sha256File(path);
    if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) {
      errors.push(`${label}_sha256 mismatch: expected ${expectedHash}, got ${actual}`);
    }
  } catch (error) {
    errors.push(`${label}_path cannot be read: ${path} (${error.message})`);
  }
}

function writeSelfTestArtifact() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "validate");
  mkdirSync(dir, { recursive: true });

  const width = 4;
  const height = 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 128;
    pixels[index + 1] = 128;
    pixels[index + 2] = 128;
    pixels[index + 3] = 255;
  }

  const pngPath = join(dir, "native.png");
  writePng(pngPath, width, height, pixels);
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const artifactPath = join(dir, "native.capture.json");
  const artifact = makeSelfTestArtifact(pngPath, maskPath);
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifactPath;
}

function makeSelfTestArtifact(pngPath, maskPath) {
  return {
    schema_version: "1.2.0",
    id: "self-test-native-s00",
    rig_id: "R0",
    scene_id: "S00_NULL",
    state_id: "s00_flat_grey",
    git_commit: "self-test",
    technical_class: "INVALID",
    verdict_class: "INVALID",
    invalid_reason: "NON_PHYSICAL_PATH",
    null_qualification: "pass",
    capture_kind: "layer_snapshot",
    device_info: {
      model_name: "Self Test Device",
      model_identifier: "iPhone16,2",
      os_name: "iOS",
      os_version: "26.0",
      os_build: "self-test",
      sdk_build: "self-test",
      screen_scale: 3,
      refresh_hz: 60,
      thermal_state_start: "nominal",
      low_power_mode: false
    },
    environment: {
      appearance: "dark",
      reduce_transparency: false,
      reduce_motion: false,
      content_seed: "s00-flat-p3-grey-v1",
      background_pack_id: "glass_background_pack_v1",
      background_id: "S00_NULL__s00_flat_grey__s00_flat_grey__background_v1",
      background_pack_sha256: "5c305dcadc6d32b7ca9366c5b82793345e791a3e7c5c58b46c3da5557450d877",
      geometry_pack_id: "glass_geometry_pack_v1",
      geometry_id: "S00_NULL__s00_flat_grey__capsule__rest__geometry_v1",
      geometry_pack_sha256: "a7fa221f4cef5ee74492be403aa2dbe7a153f18cf0d41f84dbb43703d64c3425",
      viewport_px: { width: 4, height: 4 },
      capture_timestamp_ns: "0"
    },
    color: {
      embedded_icc_profile: "Display P3",
      icc_sha256: "self-test-display-p3",
      working_space: "display-p3-linear",
      stored_transfer: "srgb-transfer",
      white_point: "D65"
    },
    frame_pack: {
      base_png_sha256: sha256File(pngPath),
      base_png_path: pngPath,
      mask_pack_sha256: sha256File(maskPath),
      mask_pack_path: maskPath,
      touch_phase: "rest",
      animation_t: 0,
      capture_timeline_pack_id: "glass_capture_timeline_pack_v1",
      capture_timeline_id: "S00_NULL__s00_flat_grey__rest__timeline_v1",
      capture_timeline_sha256: "61c15338f00fce2349bcbcc05103643664fd248e28d7411772131e1796babd13"
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-artifact-validate.self-test"
    }
  };
}

function assertGenericModelIdentifierRejected(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  artifact.device_info.model_identifier = "iPhone";
  const errors = validateArtifact(artifact, dirname(resolve(artifactPath)));
  if (!errors.some((error) => error.includes("model_identifier must be hardware identifier"))) {
    throw new Error("artifact validator self-test failed to reject generic UIDevice.current.model identifier");
  }
}

function requireString(errors, label, value) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function looksLikeGenericAppleFamilyIdentifier(value) {
  return ["iPhone", "iPad", "iPod"].includes(String(value));
}

function requireSha256(errors, label, value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    errors.push(`${label} must be a 64-character SHA-256 hex string`);
  }
}

function requireNumber(errors, label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`);
  }
}

function requireEnum(errors, label, value, allowed) {
  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
  }
}

function requireValue(errors, condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function looksLikeSimulator(modelIdentifier) {
  return typeof modelIdentifier === "string" && /simulator|x86|arm64-sim/i.test(modelIdentifier);
}
