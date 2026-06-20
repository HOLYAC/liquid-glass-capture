#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { resolveArtifactInput } from "./lib/lab-artifact-viewer.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import { sha256TracePath } from "./lib/lab-trace-hash.mjs";
import { finalizeCaptureArtifactIntegrity } from "../packages/capture-schema/src/integrity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = inspectInstruments(fixture.artifact, { out: fixture.out });
    const negative = inspectInstruments(fixture.badArtifact, { out: fixture.badOut });
    const emptyNegative = inspectInstruments(fixture.emptyArtifact, { out: fixture.emptyOut });
    if (report.status !== "pass") {
      throw new Error(`glass:instruments self-test expected pass, got ${report.failures.join(", ")}`);
    }
    if (negative.status !== "fail" || !negative.failures.includes("G6_INSTRUMENTS_TRACE_SHA256_MISMATCH")) {
      throw new Error("glass:instruments self-test failed to reject trace hash mismatch");
    }
    if (emptyNegative.status !== "fail" || !emptyNegative.failures.includes("G6_INSTRUMENTS_TRACE_TOO_SHORT")) {
      throw new Error("glass:instruments self-test failed to reject empty power trace");
    }
    console.log(`PASS ${fixture.out}`);
    return;
  }

  if (!args.input) {
    console.error("usage: node scripts/lab-glass-instruments.mjs <capture.json|artifact-id> [--out instruments.json]");
    console.error("       node scripts/lab-glass-instruments.mjs --artifact <capture.json|artifact-id> [--out instruments.json]");
    console.error("       node scripts/lab-glass-instruments.mjs --self-test [--out instruments.json]");
    process.exit(2);
  }

  const out = args.out ?? join(repoRoot, "artifacts", "viewer", `${safeName(args.input)}.instruments.json`);
  const report = inspectInstruments(args.input, { out });
  console.log(`${report.status.toUpperCase()} ${out}`);
  if (report.status !== "pass") process.exit(1);
}

export function inspectInstruments(input, options = {}) {
  const artifactPath = resolveArtifactInput(input);
  const record = readCaptureArtifact(artifactPath, {
    allowInvalid: true,
    allowLayerSnapshot: true
  });
  const artifact = record.artifact;
  const trace = inspectTrace(record);
  const report = {
    schema_version: "1.2.0",
    kind: "glass_instruments_report",
    gate: "G6",
    status: trace.failures.length === 0 ? "pass" : "fail",
    failures: trace.failures,
    warnings: record.preflight_failures.map((failure) => `ARTIFACT_PREFLIGHT_${failure}`),
    artifact: artifactIdentity(record),
    trace: trace.summary,
    energy: {
      energy_mj_per_10s: artifact.energy?.energy_mj_per_10s ?? null,
      average_power_mw: artifact.energy?.average_power_mw ?? null,
      thermal_onset_ms: artifact.energy?.thermal_onset_ms ?? null
    }
  };

  if (options.out) writeJson(options.out, report);
  return report;
}

function inspectTrace(record) {
  const artifactPath = record.artifact_path;
  const energy = record.artifact.energy ?? {};
  const failures = [];
  const tracePath = resolveTracePath(artifactPath, energy.trace_path);
  let actualSha256 = null;
  let parsedTrace = {
    kind: "not_available",
    status: "not_parsed",
    failures: [],
    metrics: {}
  };

  if (!record.artifact.energy) failures.push("G6_INSTRUMENTS_ENERGY_BLOCK_MISSING");
  if (energy.trace_available !== true) failures.push("G6_INSTRUMENTS_TRACE_UNAVAILABLE");
  if (energy.trace_status !== "available") failures.push("G6_INSTRUMENTS_TRACE_STATUS_NOT_AVAILABLE");
  if (typeof energy.trace_tool !== "string" || energy.trace_tool.length === 0) {
    failures.push("G6_INSTRUMENTS_TRACE_TOOL_MISSING");
  }
  if (!tracePath) failures.push("G6_INSTRUMENTS_TRACE_PATH_MISSING");
  if (typeof energy.trace_hash_method !== "string" || energy.trace_hash_method.length === 0) {
    failures.push("G6_INSTRUMENTS_TRACE_HASH_METHOD_MISSING");
  }
  if (typeof energy.trace_sha256 !== "string" || energy.trace_sha256.length === 0) {
    failures.push("G6_INSTRUMENTS_TRACE_SHA256_MISSING");
  }

  if (tracePath && energy.trace_hash_method && energy.trace_sha256) {
    try {
      actualSha256 = sha256TracePath(tracePath, energy.trace_hash_method);
      if (actualSha256.toLowerCase() !== energy.trace_sha256.toLowerCase()) {
        failures.push("G6_INSTRUMENTS_TRACE_SHA256_MISMATCH");
      }
    } catch (error) {
      failures.push(`G6_INSTRUMENTS_TRACE_UNREADABLE:${error.message}`);
    }
  }
  if (tracePath && existsSync(tracePath) && typeof energy.trace_tool === "string") {
    parsedTrace = parseTracePayload(tracePath, energy.trace_tool);
    failures.push(...parsedTrace.failures);
  }

  return {
    failures,
    summary: {
      available: energy.trace_available === true,
      status: energy.trace_status ?? "not_recorded",
      tool: energy.trace_tool ?? null,
      path: tracePath,
      path_exists: tracePath ? existsSync(tracePath) : false,
      artifact_relative_path: energy.trace_path ?? null,
      repo_relative_path: tracePath ? relative(repoRoot, tracePath).replace(/\\/g, "/") : null,
      hash_method: energy.trace_hash_method ?? null,
      expected_sha256: energy.trace_sha256 ?? null,
      actual_sha256: actualSha256,
      parsed: parsedTrace,
      open_hint: tracePath
        ? {
          macos: `open "${tracePath}"`,
          windows: `start "" "${tracePath}"`
        }
        : null
    }
  };
}

function parseTracePayload(tracePath, tool) {
  const normalizedTool = String(tool ?? "").toLowerCase();
  if (normalizedTool.includes("instruments") || normalizedTool.includes("power_profiler")) {
    return parseInstrumentsPowerTrace(tracePath);
  }
  if (normalizedTool.includes("metrickit") || normalizedTool.includes("metric_kit")) {
    return parseMetricKitTrace(tracePath);
  }
  return {
    kind: "unsupported_trace_tool",
    status: "fail",
    failures: [`G6_INSTRUMENTS_TRACE_TOOL_UNSUPPORTED:${tool}`],
    metrics: {}
  };
}

function parseInstrumentsPowerTrace(tracePath) {
  const samplesPath = samplesJsonlPath(tracePath);
  if (!samplesPath) {
    return {
      kind: "instruments_power_profiler",
      status: "fail",
      failures: ["G6_INSTRUMENTS_TRACE_SAMPLES_MISSING"],
      metrics: {}
    };
  }

  const failures = [];
  const samples = [];
  const lines = readFileSync(samplesPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      const sample = JSON.parse(line);
      const tMs = numberOrNull(sample.t_ms ?? sample.timestamp_ms ?? sample.time_ms);
      const powerMw = numberOrNull(sample.power_mw ?? sample.powerMilliwatts ?? sample.average_power_mw);
      if (!Number.isFinite(tMs) || !Number.isFinite(powerMw)) {
        failures.push(`G6_INSTRUMENTS_TRACE_SAMPLE_INVALID:${index}`);
        continue;
      }
      samples.push({ t_ms: tMs, power_mw: powerMw });
    } catch (error) {
      failures.push(`G6_INSTRUMENTS_TRACE_SAMPLE_JSON_INVALID:${index}:${error.message}`);
    }
  }

  samples.sort((left, right) => left.t_ms - right.t_ms);
  if (samples.length < 2) failures.push("G6_INSTRUMENTS_TRACE_TOO_SHORT");
  if (samples.some((sample, index) => index > 0 && sample.t_ms === samples[index - 1].t_ms)) {
    failures.push("G6_INSTRUMENTS_TRACE_DUPLICATE_TIMESTAMPS");
  }

  const durationMs = samples.length >= 2 ? samples[samples.length - 1].t_ms - samples[0].t_ms : 0;
  if (durationMs <= 0) failures.push("G6_INSTRUMENTS_TRACE_NON_POSITIVE_DURATION");
  const energyMj = integratePowerMilliwatts(samples);
  const powers = samples.map((sample) => sample.power_mw);

  return {
    kind: "instruments_power_profiler",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    source_file: samplesPath,
    metrics: {
      sample_count: samples.length,
      duration_ms: durationMs,
      average_power_mw: mean(powers),
      max_power_mw: powers.length > 0 ? Math.max(...powers) : null,
      energy_mj: energyMj,
      first_t_ms: samples[0]?.t_ms ?? null,
      last_t_ms: samples[samples.length - 1]?.t_ms ?? null
    }
  };
}

function parseMetricKitTrace(tracePath) {
  const files = metricKitJsonFiles(tracePath);
  const failures = [];
  let payloadCount = 0;
  for (const file of files) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8"));
      payloadCount += metricKitPayloadCount(json);
    } catch (error) {
      failures.push(`G6_METRICKIT_TRACE_JSON_INVALID:${relative(repoRoot, file).replace(/\\/g, "/")}:${error.message}`);
    }
  }
  if (files.length === 0) failures.push("G6_METRICKIT_TRACE_JSON_MISSING");
  if (payloadCount === 0) failures.push("G6_METRICKIT_TRACE_PAYLOADS_MISSING");

  return {
    kind: "metrickit",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    metrics: {
      file_count: files.length,
      payload_count: payloadCount
    }
  };
}

function samplesJsonlPath(tracePath) {
  const stats = statSync(tracePath);
  if (stats.isFile()) return tracePath;
  const direct = join(tracePath, "samples.jsonl");
  return existsSync(direct) ? direct : null;
}

function metricKitJsonFiles(tracePath) {
  const stats = statSync(tracePath);
  if (stats.isFile() && tracePath.toLowerCase().endsWith(".json")) return [tracePath];
  if (!stats.isDirectory()) return [];
  return readdirSync(tracePath)
    .filter((entry) => entry.toLowerCase().endsWith(".json"))
    .map((entry) => join(tracePath, entry));
}

function metricKitPayloadCount(json) {
  if (Array.isArray(json)) return json.reduce((sum, entry) => sum + metricKitPayloadCount(entry), 0);
  if (!json || typeof json !== "object") return 0;
  if (Array.isArray(json.metricPayloads)) return json.metricPayloads.length;
  if (Array.isArray(json.payloads)) return json.payloads.length;
  if (json.applicationTimeMetrics || json.cpuMetrics || json.gpuMetrics || json.memoryMetrics) return 1;
  return 0;
}

function integratePowerMilliwatts(samples) {
  if (samples.length < 2) return null;
  let energy = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const durationSeconds = (current.t_ms - previous.t_ms) / 1000;
    if (durationSeconds > 0) {
      energy += ((previous.power_mw + current.power_mw) * 0.5) * durationSeconds;
    }
  }
  return energy;
}

function resolveTracePath(artifactPath, rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  return isAbsolute(rawPath) ? rawPath : resolve(dirname(artifactPath), rawPath);
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "glass-instruments");
  mkdirSync(dir, { recursive: true });
  const pngPath = join(dir, "candidate.png");
  writePng(pngPath, 8, 8, makePixels(8, 8));
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const traceDir = join(dir, "power.trace");
  mkdirSync(traceDir, { recursive: true });
  writeJson(join(traceDir, "metadata.json"), {
    tool: "instruments_power_profiler",
    device: "iPhone16,2",
    sample_rate_hz: 10
  });
  writeFileSync(join(traceDir, "samples.jsonl"), [
    JSON.stringify({ t_ms: 0, power_mw: 118.2 }),
    JSON.stringify({ t_ms: 100, power_mw: 119.1 })
  ].join("\n") + "\n");
  const emptyTraceDir = join(dir, "empty-power.trace");
  mkdirSync(emptyTraceDir, { recursive: true });
  writeJson(join(emptyTraceDir, "metadata.json"), {
    tool: "instruments_power_profiler",
    device: "iPhone16,2",
    sample_rate_hz: 10
  });
  writeFileSync(join(emptyTraceDir, "samples.jsonl"), "\n");

  const artifact = join(dir, "candidate.capture.json");
  const badArtifact = join(dir, "candidate.bad-trace.capture.json");
  const emptyArtifact = join(dir, "candidate.empty-trace.capture.json");
  const good = makeArtifact(pngPath, maskPath, traceDir, "self-test-c1-instruments");
  writeJson(artifact, good);

  const bad = makeArtifact(pngPath, maskPath, traceDir, "self-test-c1-instruments-bad");
  bad.energy.trace_sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
  finalizeCaptureArtifactIntegrity(bad);
  writeJson(badArtifact, bad);

  const empty = makeArtifact(pngPath, maskPath, emptyTraceDir, "self-test-c1-instruments-empty");
  writeJson(emptyArtifact, empty);

  return {
    artifact,
    badArtifact,
    emptyArtifact,
    out: outPath ? resolve(outPath) : join(dir, "instruments.report.json"),
    badOut: join(dir, "instruments.bad.report.json"),
    emptyOut: join(dir, "instruments.empty.report.json")
  };
}

function makeArtifact(pngPath, maskPath, traceDir, id) {
  return finalizeCaptureArtifactIntegrity({
    schema_version: "1.2.0",
    id,
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
      model_identifier: "iPhone16,2",
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
      content_seed: "glass-instruments-self-test",
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
      trace_available: true,
      trace_status: "available",
      measurement_source: "self_test_power_trace",
      trace_tool: "instruments_power_profiler",
      trace_path: relative(dirname(pngPath), traceDir).replace(/\\/g, "/"),
      trace_hash_method: "sha256_tree_v1",
      trace_sha256: sha256TracePath(traceDir, "sha256_tree_v1"),
      energy_mj_per_10s: 1.19,
      average_power_mw: 118.65
    },
    integrity: {
      artifact_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      producer_version: "lab-glass-instruments.self-test"
    }
  });
}

function makePixels(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 28 + x * 3;
      pixels[offset + 1] = 78 + y * 3;
      pixels[offset + 2] = 122;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--artifact") parsed.input = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else if (!parsed.input) parsed.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "artifact";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}
