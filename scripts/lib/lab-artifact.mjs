import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { readPng, sha256File } from "./lab-png.mjs";
import { validateCaptureArtifactIntegrity } from "../../packages/capture-schema/src/integrity.mjs";
import { validateArtifactColorContract } from "../../packages/color-pipeline/src/index.mjs";
import { validateMaskPack } from "../../packages/mask-core/src/index.mjs";

export function readCaptureArtifact(path, options = {}) {
  const absolute = resolve(path);
  if (extname(absolute).toLowerCase() !== ".json") {
    throw new Error(`${path}: G0/G1-aware lab commands require capture artifact JSON, not raw PNG`);
  }

  const artifact = JSON.parse(readFileSync(absolute, "utf8"));
  const failures = [];
  if (artifact.schema_version !== "1.2.0") failures.push("SCHEMA_VERSION_NOT_1_2_0");
  failures.push(...validateArtifactColorContract(artifact));
  failures.push(...validateCaptureArtifactIntegrity(artifact));

  if (artifact.capture_kind === "layer_snapshot" && !options.allowLayerSnapshot) {
    failures.push("LAYER_SNAPSHOT_FORBIDDEN_FOR_G2");
  }

  const framePack = artifact.frame_pack ?? {};
  const basePngPath = framePack.base_png_path;
  if (typeof basePngPath !== "string" || basePngPath.length === 0) {
    failures.push("FRAME_PACK_BASE_PNG_PATH_MISSING");
  }

  if (looksLikeSimulator(artifact.device_info?.model_identifier)) {
    failures.push("SIMULATOR_ARTIFACT_FORBIDDEN");
  }

  const pngPath = basePngPath
    ? isAbsolute(basePngPath)
      ? basePngPath
      : resolve(dirname(absolute), basePngPath)
    : undefined;
  if (pngPath) {
    verifyHash(failures, "BASE_PNG_SHA256_MISMATCH", pngPath, framePack.base_png_sha256);
  }

  const maskPath = framePack.mask_pack_path
    ? isAbsolute(framePack.mask_pack_path)
      ? framePack.mask_pack_path
      : resolve(dirname(absolute), framePack.mask_pack_path)
    : undefined;
  let maskPack;
  if (!maskPath) {
    failures.push("MASK_PACK_PATH_MISSING");
  } else {
    verifyHash(failures, "MASK_PACK_SHA256_MISMATCH", maskPath, framePack.mask_pack_sha256);
    try {
      maskPack = JSON.parse(readFileSync(maskPath, "utf8"));
      failures.push(...validateMaskPack(maskPack, {
        sceneId: artifact.scene_id,
        stateId: artifact.state_id
      }));
    } catch (error) {
      failures.push(`MASK_PACK_JSON_INVALID:${error.message}`);
    }
  }

  if (failures.length > 0 && !options.allowInvalid) {
    throw new Error(`${path}: ${failures.join(", ")}`);
  }

  return {
    artifact_path: absolute,
    artifact,
    png_path: pngPath,
    mask_pack_path: maskPath,
    mask_pack: maskPack,
    png: pngPath ? readPng(pngPath) : undefined,
    preflight_failures: failures
  };
}

export function artifactIdentity(record) {
  const artifact = record.artifact;
  return {
    id: artifact.id,
    rig_id: artifact.rig_id,
    scene_id: artifact.scene_id,
    state_id: artifact.state_id,
    capture_kind: artifact.capture_kind,
    artifact_path: record.artifact_path,
    png_path: record.png_path,
    png_sha256: record.png?.sha256,
    device: artifact.device_info
        ? {
          model_name: artifact.device_info.model_name,
          model_identifier: artifact.device_info.model_identifier,
          os_version: artifact.device_info.os_version,
          os_build: artifact.device_info.os_build,
          sdk_build: artifact.device_info.sdk_build,
          webkit_build: artifact.device_info.webkit_build ?? artifact.environment?.webkit_build,
          screen_scale: artifact.device_info.screen_scale,
          refresh_hz: artifact.device_info.refresh_hz,
          thermal_state_start: artifact.device_info.thermal_state_start,
          thermal_state_end: artifact.device_info.thermal_state_end,
          low_power_mode: artifact.device_info.low_power_mode
        }
      : undefined
  };
}

function verifyHash(failures, label, path, expected) {
  if (typeof expected !== "string" || expected.length === 0) {
    failures.push(`${label}_MISSING_EXPECTED`);
    return;
  }

  try {
    const actual = sha256File(path);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      failures.push(label);
    }
  } catch (error) {
    failures.push(`${label}_UNREADABLE:${error.message}`);
  }
}

function looksLikeSimulator(modelIdentifier) {
  return typeof modelIdentifier === "string" && /simulator|x86|arm64-sim/i.test(modelIdentifier);
}
