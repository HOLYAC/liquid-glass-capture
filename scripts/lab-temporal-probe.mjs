#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { finalizeCaptureArtifactIntegrity } from "../packages/capture-schema/src/integrity.mjs";
import { readArtifactFrameSequence } from "./lib/lab-sequence.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import { measureTemporal } from "../packages/metric-stack/src/temporal.mjs";
import { glassTrajectoryShaByScene } from "../packages/material-glass/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const s03PressTrajectorySha256 = glassTrajectoryShaByScene.S03_PRESS;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const pair = writeSelfTestPair(args.out);
    const report = probeTemporal(pair.reference, pair.candidate, {
      out: pair.out,
      allowInvalid: true,
      allowLayerSnapshot: true
    });
    console.log(`${report.status.toUpperCase()} ${pair.out}`);
    if (report.status !== "pass") process.exit(1);
    return;
  }

  if (!args.reference || !args.candidate) {
    console.error("usage: node scripts/lab-temporal-probe.mjs --reference <capture.json> --candidate <capture.json> [--out report.json]");
    console.error("       node scripts/lab-temporal-probe.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = probeTemporal(args.reference, args.candidate, args);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

export function probeTemporal(referencePath, candidatePath, options = {}) {
  const reference = readCaptureArtifact(referencePath, options);
  const candidate = readCaptureArtifact(candidatePath, options);
  const temporalReport = measureTemporal(
    readArtifactFrameSequence(reference),
    readArtifactFrameSequence(candidate),
    options
  );
  const report = {
    ...temporalReport,
    reference: artifactIdentity(reference),
    candidate: artifactIdentity(candidate),
    preflight: {
      reference_failures: reference.preflight_failures,
      candidate_failures: candidate.preflight_failures
    }
  };

  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function writeSelfTestPair(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "temporal-probe");
  mkdirSync(dir, { recursive: true });

  const width = 36;
  const height = 24;
  const referenceSequence = writeMotionSequence(dir, "reference", width, height, 0);
  const candidateSequence = writeMotionSequence(dir, "candidate", width, height, 2);
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const reference = join(dir, "reference.capture.json");
  const candidate = join(dir, "candidate.capture.json");
  writeFileSync(reference, `${JSON.stringify(makeArtifact("R0", referenceSequence, maskPath), null, 2)}\n`);
  writeFileSync(candidate, `${JSON.stringify(makeArtifact("R1", candidateSequence, maskPath), null, 2)}\n`);

  return {
    reference,
    candidate,
    out: outPath ? resolve(outPath) : join(dir, "g4-temporal.report.json")
  };
}

function writeMotionSequence(dir, prefix, width, height, staticBias) {
  const positions = [4, 16, 16, 16, 16, 16];
  const paths = [];
  for (let index = 0; index < positions.length; index += 1) {
    const pixels = Buffer.alloc(width * height * 4);
    const centerX = positions[index];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const background = 34 + staticBias + x + y;
        const insidePressBlob = Math.abs(x - centerX) <= 3 && Math.abs(y - 12) <= 3;
        const value = insidePressBlob ? 220 + staticBias : background;
        pixels[offset] = Math.min(255, value);
        pixels[offset + 1] = insidePressBlob ? 230 : Math.min(255, background + 22);
        pixels[offset + 2] = insidePressBlob ? 236 : Math.min(255, background + 48);
        pixels[offset + 3] = 255;
      }
    }
    const path = join(dir, `${prefix}-${String(index).padStart(2, "0")}.png`);
    writePng(path, width, height, pixels);
    paths.push(path);
  }

  return {
    paths,
    timestamps_ms: [0, 16.67, 33.33, 50, 66.67, 83.33]
  };
}

function makeArtifact(rigId, sequence, maskPath) {
  return finalizeCaptureArtifactIntegrity({
    schema_version: "1.2.0",
    id: `self-test-${rigId}-g4-temporal`,
    rig_id: rigId,
    scene_id: "S03_PRESS",
    state_id: "press",
    git_commit: "self-test",
    technical_class: "INVALID",
    verdict_class: "INVALID",
    invalid_reason: "NON_PHYSICAL_PATH",
    capture_kind: "compositor",
    device_info: {
      model_name: "Self Test Device",
      model_identifier: "iPhone-self-test",
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
      content_seed: "g4-temporal-self-test",
      viewport_px: { width: 36, height: 24 },
      capture_timestamp_ns: "0"
    },
    color: {
      embedded_icc_profile: "Display P3",
      icc_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      working_space: "display-p3-linear",
      stored_transfer: "srgb-transfer",
      white_point: "D65"
    },
    frame_pack: {
      base_png_sha256: sha256File(sequence.paths[0]),
      base_png_path: sequence.paths[0],
      sequence_paths: sequence.paths,
      sequence_timestamps_ms: sequence.timestamps_ms,
      trajectory_source_sha256: s03PressTrajectorySha256,
      mask_pack_sha256: sha256File(maskPath),
      mask_pack_path: maskPath,
      touch_phase: "press",
      animation_t: 1
    },
    integrity: {
      artifact_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      producer_version: "lab-temporal-probe.self-test"
    }
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--reference") parsed.reference = args[++index];
    else if (arg === "--candidate") parsed.candidate = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else if (arg === "--allow-invalid") parsed.allowInvalid = true;
    else if (arg === "--allow-layer-snapshot") parsed.allowLayerSnapshot = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
