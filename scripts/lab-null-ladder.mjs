#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comparePng, sha256File, writePng } from "./lib/lab-png.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = {
  flat_p3_grey: { maxAbsChannelDelta: 0, meanAbsChannelDelta: 0, gradientMeanAbsDelta: Infinity },
  hard_edge: { maxAbsChannelDelta: 0, meanAbsChannelDelta: 0, gradientMeanAbsDelta: Infinity },
  p3_ramp: { maxAbsChannelDelta: 1, meanAbsChannelDelta: 0.25, gradientMeanAbsDelta: Infinity },
  smooth_gradient: { maxAbsChannelDelta: 2, meanAbsChannelDelta: 0.5, gradientMeanAbsDelta: 0.25 }
};

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const { nativeArtifact, candidateArtifact, reportPath } = writeSelfTestPair(args.out);
    const report = runNullLadder({
      nativePath: nativeArtifact,
      candidatePath: candidateArtifact,
      rung: "flat_p3_grey",
      reportPath
    });
    console.log(`${report.null_qualification.toUpperCase()} ${reportPath}`);
    return;
  }

  if (!args.nativePath || !args.candidatePath) {
    console.error("usage: node scripts/lab-null-ladder.mjs --native <png|capture.json> --candidate <png|capture.json> --rung <rung> [--out report.json]");
    console.error("       node scripts/lab-null-ladder.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = runNullLadder(args);
  console.log(`${report.null_qualification.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.null_qualification !== "pass") {
    process.exit(1);
  }
}

function runNullLadder({ nativePath, candidatePath, rung, reportPath, out }) {
  const rungId = rung ?? "flat_p3_grey";
  const threshold = policy[rungId];
  if (!threshold) {
    throw new Error(`Unknown null ladder rung: ${rungId}`);
  }

  const nativePng = resolveInputPng(nativePath);
  const candidatePng = resolveInputPng(candidatePath);
  const metrics = comparePng(nativePng, candidatePng);
  const failures = [];

  if (metrics.dimensionMismatch) {
    failures.push("DIMENSION_MISMATCH");
  }
  if (metrics.maxAbsChannelDelta > threshold.maxAbsChannelDelta) {
    failures.push(`MAX_ABS_CHANNEL_DELTA>${threshold.maxAbsChannelDelta}`);
  }
  if (metrics.meanAbsChannelDelta > threshold.meanAbsChannelDelta) {
    failures.push(`MEAN_ABS_CHANNEL_DELTA>${threshold.meanAbsChannelDelta}`);
  }
  if (metrics.gradientMeanAbsDelta > threshold.gradientMeanAbsDelta) {
    failures.push(`GRADIENT_MEAN_ABS_DELTA>${threshold.gradientMeanAbsDelta}`);
  }

  const report = {
    schema_version: "1.2.0",
    kind: "null_ladder_report",
    scene_id: "S00_NULL",
    rung_id: rungId,
    native_png: nativePng,
    candidate_png: candidatePng,
    threshold,
    metrics,
    null_qualification: failures.length === 0 ? "pass" : "fail",
    failures
  };

  const destination = reportPath ?? out;
  if (destination) {
    mkdirSync(dirname(resolve(destination)), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function resolveInputPng(inputPath) {
  const absolute = resolve(inputPath);
  if (extname(absolute).toLowerCase() === ".json") {
    const artifact = JSON.parse(readFileSync(absolute, "utf8"));
    const pngPath = artifact.frame_pack?.base_png_path;
    if (!pngPath) {
      throw new Error(`${inputPath}: missing frame_pack.base_png_path`);
    }
    return isAbsolute(pngPath) ? pngPath : resolve(dirname(absolute), pngPath);
  }
  return absolute;
}

function writeSelfTestPair(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "null-ladder");
  mkdirSync(dir, { recursive: true });

  const width = 8;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 128;
    pixels[index + 1] = 128;
    pixels[index + 2] = 128;
    pixels[index + 3] = 255;
  }

  const nativePng = join(dir, "native-flat.png");
  const candidatePng = join(dir, "candidate-flat.png");
  writePng(nativePng, width, height, pixels);
  writePng(candidatePng, width, height, pixels);

  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const nativeArtifact = join(dir, "native.capture.json");
  const candidateArtifact = join(dir, "candidate.capture.json");
  writeFileSync(nativeArtifact, `${JSON.stringify(makeArtifact("R0", nativePng, maskPath), null, 2)}\n`);
  writeFileSync(candidateArtifact, `${JSON.stringify(makeArtifact("C0", candidatePng, maskPath), null, 2)}\n`);

  return {
    nativeArtifact,
    candidateArtifact,
    reportPath: outPath ? resolve(outPath) : join(dir, "null-ladder.report.json")
  };
}

function makeArtifact(rigId, pngPath, maskPath) {
  return {
    schema_version: "1.2.0",
    id: `self-test-${rigId}-s00-flat`,
    rig_id: rigId,
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
      content_seed: "s00-flat-p3-grey-v1",
      viewport_px: { width: 8, height: 8 },
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
      animation_t: 0
    },
    shader: rigId === "C0" ? { pipeline: "passthrough" } : undefined,
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-null-ladder.self-test"
    }
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--native") parsed.nativePath = args[++index];
    else if (arg === "--candidate") parsed.candidatePath = args[++index];
    else if (arg === "--rung") parsed.rung = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
