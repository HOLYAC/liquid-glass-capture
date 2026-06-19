#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import {
  compareMetricImages,
  flattenMetricReport,
  summarizeMetricSeries
} from "../packages/metric-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedRepeat = Object.freeze({
  mvl: 50,
  prod_p99: 300,
  sustained: 24
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = buildBaselineReport({
      refs: readRepeatManifestPaths(fixture.refManifest),
      probes: readRepeatManifestPaths(fixture.probeManifest),
      out: fixture.out,
      baselineClass: "mvl",
      repeatOverride: 50
    });
    console.log(`${report.baseline_status.toUpperCase()} ${fixture.out}`);
    return;
  }

  if (args.refs.length < 2) {
    console.error("usage: node scripts/lab-metrics-baseline.mjs --ref <capture.json> --ref <capture.json> [--probe <capture.json> ...] [--class mvl|prod_p99|sustained] [--out baseline.json]");
    console.error("       node scripts/lab-metrics-baseline.mjs --self-test [--out baseline.json]");
    process.exit(2);
  }

  const report = buildBaselineReport(args);
  console.log(`${report.baseline_status.toUpperCase()} ${args.out ?? ""}`.trim());
}

export function buildBaselineReport({ refs, probes, out, baselineClass = "mvl", repeatOverride }) {
  const referenceRecords = refs.map((path) => readCaptureArtifact(path));
  const probeRecords = probes.map((path) => readCaptureArtifact(path));
  const referenceReports = [];
  const candidateReports = [];

  for (let left = 0; left < referenceRecords.length; left += 1) {
    for (let right = left + 1; right < referenceRecords.length; right += 1) {
      referenceReports.push(compareRecords(referenceRecords[left], referenceRecords[right]));
    }
  }

  for (const reference of referenceRecords) {
    for (const probe of probeRecords) {
      candidateReports.push(compareRecords(reference, probe));
    }
  }

  const requested = repeatOverride ?? requestedRepeat[baselineClass] ?? requestedRepeat.mvl;
  const namespace = makeBaselineNamespace(referenceRecords[0], baselineClass);
  const report = {
    schema_version: "1.2.0",
    kind: "baseline_metric_report",
    baseline_namespace: namespace,
    baseline_class: baselineClass,
    baseline_status: referenceRecords.length >= requested ? "complete" : "partial",
    repeat_n_requested: requested,
    repeat_n_observed: referenceRecords.length,
    repeat_policy: {
      repeat_n_mvl: requestedRepeat.mvl,
      repeat_n_prod_p99: requestedRepeat.prod_p99,
      repeat_n_sustained: requestedRepeat.sustained,
      final_p99_allowed: baselineClass === "prod_p99" && referenceRecords.length >= requestedRepeat.prod_p99
    },
    gates: {
      G0_G1: "assumed_from_valid_capture_artifacts",
      G2: "computed_static_perception_metrics",
      G3_G8: "not_run"
    },
    reference_artifacts: referenceRecords.map(artifactIdentity),
    probe_artifacts: probeRecords.map(artifactIdentity),
    instrument_noise: summarizeReports(referenceReports),
    candidate_gap: summarizeReports(candidateReports),
    raw_report_counts: {
      reference_pair_count: referenceReports.length,
      candidate_pair_count: candidateReports.length
    },
    immutability: {
      raw_artifacts_retained: true,
      outlier_rejection: "not_applied",
      baseline_owner: "unassigned"
    }
  };

  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function compareRecords(reference, candidate) {
  const report = compareMetricImages(reference.png, candidate.png);
  return flattenMetricReport(report);
}

function summarizeReports(reports) {
  if (reports.length === 0) {
    return {
      count: 0,
      metrics: {}
    };
  }

  const keys = Object.keys(reports[0]);
  const metrics = {};
  for (const key of keys) {
    metrics[key] = summarizeMetricSeries(reports.map((report) => report[key]));
  }

  return {
    count: reports.length,
    metrics
  };
}

function makeBaselineNamespace(record, baselineClass) {
  const artifact = record.artifact;
  const device = artifact.device_info ?? {};
  const integrity = artifact.integrity ?? {};
  return [
    "baseline",
    baselineClass,
    artifact.scene_id,
    artifact.state_id,
    artifact.rig_id,
    safePart(device.model_identifier),
    safePart(device.os_build),
    safePart(device.sdk_build),
    safePart(integrity.producer_version)
  ].join("__");
}

function safePart(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_.-]+/gi, "-");
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "metrics-baseline");
  mkdirSync(dir, { recursive: true });

  const refs = [];
  const probes = [];
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  for (let index = 0; index < 3; index += 1) {
    const refPng = join(dir, `reference-${index}.png`);
    const probePng = join(dir, `probe-${index}.png`);
    writePng(refPng, 12, 12, makePixels(12, 12, 0));
    writePng(probePng, 12, 12, makePixels(12, 12, index === 2 ? 1 : 0));

    const refArtifact = join(dir, `reference-${index}.capture.json`);
    const probeArtifact = join(dir, `probe-${index}.capture.json`);
    writeFileSync(refArtifact, `${JSON.stringify(makeArtifact("R0", refPng, maskPath, index), null, 2)}\n`);
    writeFileSync(probeArtifact, `${JSON.stringify(makeArtifact("R1", probePng, maskPath, index), null, 2)}\n`);
    refs.push(refArtifact);
    probes.push(probeArtifact);
  }

  return {
    refs,
    probes,
    refManifest: writeRepeatManifest(dir, "reference.repeat-manifest.json", refs),
    probeManifest: writeRepeatManifest(dir, "probe.repeat-manifest.json", probes),
    out: outPath ? resolve(outPath) : join(dir, "baseline.metric.report.json")
  };
}

function makePixels(width, height, delta) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 48 + x + delta;
      pixels[offset + 1] = 88 + y;
      pixels[offset + 2] = 128;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function makeArtifact(rigId, pngPath, maskPath, index) {
  return {
    schema_version: "1.2.0",
    id: `self-test-${rigId}-baseline-${index}`,
    rig_id: rigId,
    scene_id: "S01_SEARCH",
    state_id: "rest",
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
      content_seed: `g2-baseline-self-test-${index}`,
      viewport_px: { width: 12, height: 12 },
      capture_timestamp_ns: String(index)
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
      producer_version: "lab-metrics-baseline.self-test"
    }
  };
}

function writeRepeatManifest(dir, name, artifactPaths) {
  const manifestPath = join(dir, name);
  const manifest = {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    id: name.replace(/\.json$/, ""),
    status: "partial",
    repeat_count_requested: 50,
    repeat_count_observed: artifactPaths.length,
    artifact_json_paths: artifactPaths
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function parseArgs(args) {
  const parsed = {
    refs: [],
    probes: [],
    baselineClass: "mvl"
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--ref") parsed.refs.push(args[++index]);
    else if (arg === "--probe") parsed.probes.push(args[++index]);
    else if (arg === "--ref-manifest") parsed.refs.push(...readRepeatManifestPaths(args[++index]));
    else if (arg === "--probe-manifest") parsed.probes.push(...readRepeatManifestPaths(args[++index]));
    else if (arg === "--class") parsed.baselineClass = args[++index];
    else if (arg === "--repeat") {
      parsed.repeatOverride = Number(args[++index]);
      if (!Number.isFinite(parsed.repeatOverride) || parsed.repeatOverride < 1) {
        throw new Error("--repeat must be a positive number");
      }
    }
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function readRepeatManifestPaths(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (manifest.kind !== "repeat_capture_manifest") {
    throw new Error(`${path}: expected repeat_capture_manifest`);
  }
  if (!Array.isArray(manifest.artifact_json_paths)) {
    throw new Error(`${path}: missing artifact_json_paths`);
  }
  return manifest.artifact_json_paths.map((artifactPath) => {
    if (typeof artifactPath !== "string" || artifactPath.length === 0) {
      throw new Error(`${path}: artifact_json_paths must contain non-empty strings`);
    }
    return artifactPath;
  });
}
