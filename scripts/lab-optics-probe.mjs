#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import { measureOptics } from "../packages/metric-stack/src/optics.mjs";
import { maskIndexesFor, maskScopeBlock } from "../packages/mask-core/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const pair = writeSelfTestPair(args.out);
    const report = probeOptics(pair.reference, pair.candidate, {
      out: pair.out,
      allowInvalid: true,
      allowLayerSnapshot: true
    });
    console.log(`${report.status.toUpperCase()} ${pair.out}`);
    if (report.status !== "pass") process.exit(1);
    return;
  }

  if (!args.reference || !args.candidate) {
    console.error("usage: node scripts/lab-optics-probe.mjs --reference <capture.json> --candidate <capture.json> [--out report.json]");
    console.error("       node scripts/lab-optics-probe.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = probeOptics(args.reference, args.candidate, args);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

export function probeOptics(referencePath, candidatePath, options = {}) {
  const reference = readCaptureArtifact(referencePath, options);
  const candidate = readCaptureArtifact(candidatePath, options);
  const edgeBandIndexes = maskIndexesFor(reference.mask_pack, {
    sceneId: reference.artifact.scene_id,
    stateId: reference.artifact.state_id,
    maskId: "edge_band",
    width: reference.png.width,
    height: reference.png.height
  });
  const opticsReport = measureOptics(reference.png, candidate.png, {
    ...options,
    edgeBandIndexes,
    maskScope: maskScopeBlock(reference.mask_pack, {
      sceneId: reference.artifact.scene_id,
      stateId: reference.artifact.state_id,
      maskId: "edge_band",
      sampleCount: edgeBandIndexes.length
    })
  });
  const report = {
    ...opticsReport,
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
  const dir = join(repoRoot, "artifacts", "lab-self-test", "optics-probe");
  mkdirSync(dir, { recursive: true });

  const width = 36;
  const height = 24;
  const referencePixels = Buffer.alloc(width * height * 4);
  const candidatePixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const edge = x < width * 0.5 ? 52 : 188;
      const stripe = y % 4 < 2 ? 8 : 0;
      const value = edge + stripe;
      referencePixels[offset] = value;
      referencePixels[offset + 1] = value;
      referencePixels[offset + 2] = value;
      referencePixels[offset + 3] = 255;

      const highlight = x > 20 && x < 25 && y > 8 && y < 13 ? 8 : 0;
      candidatePixels[offset] = Math.min(255, value + highlight);
      candidatePixels[offset + 1] = Math.min(255, value + highlight);
      candidatePixels[offset + 2] = Math.min(255, value + highlight);
      candidatePixels[offset + 3] = 255;
    }
  }

  const referencePng = join(dir, "reference.png");
  const candidatePng = join(dir, "candidate.png");
  writePng(referencePng, width, height, referencePixels);
  writePng(candidatePng, width, height, candidatePixels);

  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const reference = join(dir, "reference.capture.json");
  const candidate = join(dir, "candidate.capture.json");
  writeFileSync(reference, `${JSON.stringify(makeArtifact("R0", referencePng, maskPath), null, 2)}\n`);
  writeFileSync(candidate, `${JSON.stringify(makeArtifact("R1", candidatePng, maskPath), null, 2)}\n`);

  return {
    reference,
    candidate,
    out: outPath ? resolve(outPath) : join(dir, "g3-optics.report.json")
  };
}

function makeArtifact(rigId, pngPath, maskPath) {
  return {
    schema_version: "1.2.0",
    id: `self-test-${rigId}-g3-optics`,
    rig_id: rigId,
    scene_id: "S03_PRESS",
    state_id: "press",
    git_commit: "self-test",
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
      content_seed: "g3-optics-self-test",
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
      base_png_sha256: sha256File(pngPath),
      base_png_path: pngPath,
      mask_pack_sha256: sha256File(maskPath),
      mask_pack_path: maskPath,
      touch_phase: "press",
      animation_t: 1
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-optics-probe.self-test"
    }
  };
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
