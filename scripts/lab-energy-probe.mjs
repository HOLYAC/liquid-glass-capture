#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import { measureEnergy } from "../packages/energy-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestArtifact(args.out);
    const report = probeEnergy(fixture.artifact, {
      out: fixture.out,
      allowInvalid: true,
      allowLayerSnapshot: true,
      sustained: true
    });
    console.log(`${report.status.toUpperCase()} ${fixture.out}`);
    if (report.status !== "pass") process.exit(1);
    return;
  }

  if (!args.artifact) {
    console.error("usage: node scripts/lab-energy-probe.mjs --artifact <capture.json> [--sustained] [--require-energy-trace] [--out report.json]");
    console.error("       node scripts/lab-energy-probe.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = probeEnergy(args.artifact, args);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

export function probeEnergy(artifactPath, options = {}) {
  const record = readCaptureArtifact(artifactPath, options);
  const energyReport = measureEnergy(record, options);
  const report = {
    ...energyReport,
    artifact: artifactIdentity(record),
    preflight: {
      failures: record.preflight_failures
    }
  };

  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function writeSelfTestArtifact(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "energy-probe");
  mkdirSync(dir, { recursive: true });
  const pngPath = join(dir, "energy.png");
  writePng(pngPath, 8, 8, makePixels(8, 8));
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const artifact = join(dir, "energy.capture.json");
  writeFileSync(artifact, `${JSON.stringify(makeArtifact(pngPath, maskPath), null, 2)}\n`);
  return {
    artifact,
    out: outPath ? resolve(outPath) : join(dir, "g6-energy.report.json")
  };
}

function makePixels(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 36 + x;
      pixels[offset + 1] = 84 + y;
      pixels[offset + 2] = 124;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function makeArtifact(pngPath, maskPath) {
  return {
    schema_version: "1.2.0",
    id: "self-test-c1-g6-energy",
    rig_id: "C1",
    scene_id: "S03_PRESS",
    state_id: "sustained",
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
      thermal_state_end: "nominal",
      low_power_mode: false
    },
    environment: {
      appearance: "dark",
      reduce_transparency: false,
      reduce_motion: false,
      content_seed: "g6-energy-self-test",
      viewport_px: { width: 8, height: 8 },
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
      touch_phase: "sustained",
      animation_t: 1,
      sustained_duration_ms: 60_000
    },
    shader: {
      pipeline: "baked_verdict",
      baked_shader_hash: "self-test"
    },
    perf: {
      measurement_source: "self_test_sustained_runtime",
      full_frame_ms_p95: 14.2,
      frame_interval_ms_p95: 16.67,
      dropped_frames: 0,
      sustained_degradation_pct: 1.2
    },
    energy: {
      trace_available: false
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-energy-probe.self-test"
    }
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--artifact") parsed.artifact = args[++index];
    else if (arg === "--sustained") parsed.sustained = true;
    else if (arg === "--require-energy-trace") parsed.requireEnergyTrace = true;
    else if (arg === "--out") parsed.out = args[++index];
    else if (arg === "--allow-invalid") parsed.allowInvalid = true;
    else if (arg === "--allow-layer-snapshot") parsed.allowLayerSnapshot = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
