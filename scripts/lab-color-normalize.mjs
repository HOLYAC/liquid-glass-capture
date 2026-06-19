#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  displayP3LinearLuminance,
  rgbaByteToLinearDisplayP3
} from "../packages/color-pipeline/src/index.mjs";
import { readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestArtifact(args.out);
    const report = normalizeArtifact(fixture.artifact, {
      out: fixture.out
    });
    console.log(`${report.status.toUpperCase()} ${fixture.out}`);
    return;
  }

  if (args.artifacts.length === 0) {
    console.error("usage: node scripts/lab-color-normalize.mjs <capture.json> [...] [--out report.json]");
    console.error("       node scripts/lab-color-normalize.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const reports = args.artifacts.map((artifact) => normalizeArtifact(artifact));
  const output = {
    schema_version: "1.2.0",
    kind: "color_normalization_batch",
    reports
  };

  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), `${JSON.stringify(output, null, 2)}\n`);
  }
  console.log(`PASS ${reports.length}`);
}

function normalizeArtifact(path, options = {}) {
  const record = readCaptureArtifact(path, options);
  const pixels = record.png.pixels;
  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  let meanY = 0;
  const pixelCount = record.png.width * record.png.height;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const p3 = rgbaByteToLinearDisplayP3(pixels, pixel * 4);
    meanR += p3.r;
    meanG += p3.g;
    meanB += p3.b;
    meanY += displayP3LinearLuminance(p3);
  }

  const report = {
    schema_version: "1.2.0",
    kind: "color_normalization_report",
    status: "pass",
    artifact_id: record.artifact.id,
    artifact_path: record.artifact_path,
    png_path: record.png_path,
    png_sha256: record.png.sha256,
    dimensions: {
      width: record.png.width,
      height: record.png.height
    },
    color_pipeline: {
      input_icc_profile: record.artifact.color.embedded_icc_profile,
      stored_transfer: record.artifact.color.stored_transfer,
      output_working_space: "display-p3-linear",
      comparison_white_point: "D65"
    },
    linear_display_p3_summary: {
      mean_r: meanR / pixelCount,
      mean_g: meanG / pixelCount,
      mean_b: meanB / pixelCount,
      mean_luminance_y: meanY / pixelCount
    }
  };

  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function writeSelfTestArtifact(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "color-normalize");
  mkdirSync(dir, { recursive: true });
  const width = 4;
  const height = 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 128;
    pixels[index + 1] = 96;
    pixels[index + 2] = 64;
    pixels[index + 3] = 255;
  }

  const pngPath = join(dir, "sample.png");
  writePng(pngPath, width, height, pixels);
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const artifactPath = join(dir, "sample.capture.json");
  writeFileSync(artifactPath, `${JSON.stringify(makeArtifact(pngPath, maskPath), null, 2)}\n`);

  return {
    artifact: artifactPath,
    out: outPath ? resolve(outPath) : join(dir, "color-normalization.report.json")
  };
}

function makeArtifact(pngPath, maskPath) {
  return {
    schema_version: "1.2.0",
    id: "self-test-color-normalize",
    rig_id: "R0",
    scene_id: "S00_NULL",
    state_id: "flat_p3_grey",
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
      content_seed: "color-normalize-self-test",
      viewport_px: { width: 4, height: 4 },
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
      touch_phase: "rest",
      animation_t: 0
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-color-normalize.self-test"
    }
  };
}

function parseArgs(args) {
  const parsed = {
    artifacts: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--out") parsed.out = args[++index];
    else parsed.artifacts.push(arg);
  }
  return parsed;
}
