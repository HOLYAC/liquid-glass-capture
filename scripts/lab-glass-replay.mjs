#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { finalizeCaptureArtifactIntegrity } from "../packages/capture-schema/src/integrity.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = replayArtifact({
      artifactInput: fixture.artifact,
      candidateInput: fixture.candidate,
      out: fixture.out
    });
    assertReplayGuardRails(report);
    console.log(`PASS ${fixture.out}`);
    return;
  }

  if (!args.artifact || !args.candidate) {
    console.error("usage: node scripts/lab-glass-replay.mjs --artifact <capture.json|artifact-id> --candidate <solver-candidate.json|param-hash|candidate-id> [--out replay.report.json] [--artifact-out replay.capture.json]");
    console.error("       node scripts/lab-glass-replay.mjs --self-test [--out replay.report.json]");
    process.exit(2);
  }

  const report = replayArtifact({
    artifactInput: args.artifact,
    candidateInput: args.candidate,
    out: args.out,
    artifactOut: args.artifactOut
  });
  console.log(`${report.status.toUpperCase()} ${report.replay_artifact_path}`);
}

export function replayArtifact({ artifactInput, candidateInput, out, artifactOut } = {}) {
  const sourcePath = resolveArtifactInput(artifactInput);
  const source = readCaptureArtifact(sourcePath, {
    allowInvalid: true,
    allowLayerSnapshot: true
  });
  const candidate = resolveSolverCandidate(candidateInput);
  const paramHash = candidate.parameter_hash;
  const destinationReport = out ? resolve(out) : defaultReportPath(source.artifact, candidate);
  const destinationArtifact = artifactOut ? resolve(artifactOut) : destinationReport.replace(/\.report\.json$/, ".capture.json");
  const replay = buildReplayArtifact({ source, candidate, paramHash });

  writeJson(destinationArtifact, replay);
  const report = {
    schema_version: "1.2.0",
    kind: "glass_replay_report",
    status: "pass",
    replay_mode: "DX_REPLAY",
    invalid_for_verdict: true,
    invalid_reason: "NON_PHYSICAL_PATH",
    source_artifact_path: source.artifact_path,
    source_artifact_id: source.artifact.id,
    source_png_sha256: source.png?.sha256 ?? source.artifact.frame_pack?.base_png_sha256 ?? null,
    solver_candidate_path: candidate.source_path,
    solver_candidate_id: candidate.id,
    parameter_hash: paramHash,
    replay_artifact_path: destinationArtifact,
    replay_artifact_id: replay.id,
    output_contract: {
      technical_class: "INVALID",
      verdict_class: "INVALID",
      rig_id: "DX_REPLAY",
      can_feed_verdict: false
    }
  };
  writeJson(destinationReport, report);
  return report;
}

function buildReplayArtifact({ source, candidate, paramHash }) {
  const artifact = source.artifact;
  return finalizeCaptureArtifactIntegrity({
    schema_version: "1.2.0",
    id: `dx-replay-${safePart(artifact.id)}-${paramHash.slice(0, 12)}`,
    rig_id: "DX_REPLAY",
    scene_id: artifact.scene_id,
    state_id: artifact.state_id,
    git_commit: artifact.git_commit,
    technical_class: "INVALID",
    verdict_class: "INVALID",
    invalid_reason: "NON_PHYSICAL_PATH",
    null_qualification: artifact.null_qualification ?? "fail",
    capture_kind: "framebuffer",
    device_info: {
      ...(artifact.device_info ?? {}),
      model_name: artifact.device_info?.model_name ?? "DX Replay Host",
      model_identifier: artifact.device_info?.model_identifier ?? "DX_REPLAY",
      os_name: "iOS",
      os_version: artifact.device_info?.os_version ?? "replay",
      os_build: artifact.device_info?.os_build ?? "replay",
      sdk_build: artifact.device_info?.sdk_build ?? "replay",
      screen_scale: artifact.device_info?.screen_scale ?? 1,
      refresh_hz: artifact.device_info?.refresh_hz ?? 60,
      thermal_state_start: artifact.device_info?.thermal_state_start ?? "nominal",
      low_power_mode: artifact.device_info?.low_power_mode ?? false
    },
    environment: {
      ...(artifact.environment ?? {})
    },
    color: artifact.color,
    frame_pack: {
      ...(artifact.frame_pack ?? {}),
      base_png_path: source.png_path,
      base_png_sha256: source.png?.sha256 ?? artifact.frame_pack?.base_png_sha256,
      mask_pack_path: source.mask_pack_path,
      mask_pack_sha256: source.mask_pack_path ? sha256File(source.mask_pack_path) : artifact.frame_pack?.mask_pack_sha256,
      sequence_paths: replaySequencePaths(source),
      sequence_timestamps_ms: source.artifact.frame_pack?.sequence_timestamps_ms ?? [0]
    },
    shader: {
      pipeline: "dx_replay",
      solver_candidate_id: candidate.id,
      param_hash: paramHash,
      parameters: candidate.parameters,
      source_candidate_path: candidate.source_path,
      replay_source_artifact_id: artifact.id
    },
    perf: {
      measurement_source: "dx_replay_no_physical_runtime"
    },
    energy: {
      trace_available: false,
      trace_status: "trace_unavailable",
      measurement_source: "dx_replay_no_physical_energy"
    },
    integrity: {
      artifact_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      producer_version: "lab-glass-replay.v1"
    }
  });
}

function resolveArtifactInput(input) {
  const direct = resolve(input);
  if (existsSync(direct)) return direct;
  const matches = [];
  for (const path of walkJson(join(repoRoot, "artifacts"))) {
    try {
      const json = JSON.parse(readFileSync(path, "utf8"));
      if (json.schema_version === "1.2.0" && json.id === input) matches.push(path);
    } catch {
      // Artifact search ignores unrelated JSON.
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Artifact id is ambiguous: ${input}\n${matches.join("\n")}`);
  throw new Error(`Artifact not found by path or id: ${input}`);
}

function resolveSolverCandidate(input) {
  const direct = resolve(input);
  if (existsSync(direct)) return normalizeCandidate(JSON.parse(readFileSync(direct, "utf8")), direct);

  const matches = [];
  const artifactsRoot = join(repoRoot, "artifacts");
  if (existsSync(artifactsRoot)) {
    for (const path of walkJson(artifactsRoot)) {
      try {
        const json = JSON.parse(readFileSync(path, "utf8"));
        if (json.kind !== "solver_candidate") continue;
        const candidate = normalizeCandidate(json, path);
        if (candidate.id === input || candidate.parameter_hash === input || basename(path) === input) {
          matches.push(candidate);
        }
      } catch {
        // Candidate search ignores unrelated JSON.
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Solver candidate is ambiguous: ${input}`);
  throw new Error(`Solver candidate not found by path, id, or parameter hash: ${input}`);
}

function normalizeCandidate(candidate, sourcePath) {
  if (candidate.kind !== "solver_candidate") {
    throw new Error(`${sourcePath}: expected kind=solver_candidate`);
  }
  if (!candidate.parameters || typeof candidate.parameters !== "object" || Array.isArray(candidate.parameters)) {
    throw new Error(`${sourcePath}: solver candidate parameters are required for replay`);
  }
  const actualHash = parameterHash(candidate.parameters);
  const recordedHash = candidate.parameter_hash ?? candidate.param_hash;
  if (recordedHash && recordedHash !== actualHash) {
    throw new Error(`${sourcePath}: solver candidate parameter_hash does not match parameters`);
  }
  return {
    ...candidate,
    source_path: sourcePath,
    parameter_hash: actualHash
  };
}

function replaySequencePaths(source) {
  const rawPaths = source.artifact.frame_pack?.sequence_paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return [source.png_path];
  return rawPaths.map((path) => {
    const text = String(path);
    return resolve(dirname(source.artifact_path), text);
  });
}

function parameterHash(parameters) {
  return createHash("sha256").update(canonicalJson(parameters)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultReportPath(artifact, candidate) {
  return join(
    repoRoot,
    "artifacts",
    "replay",
    `${safePart(artifact.id)}__${safePart(candidate.id)}.replay.report.json`
  );
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "glass-replay");
  mkdirSync(dir, { recursive: true });
  const pngPath = join(dir, "source.png");
  writePng(pngPath, 8, 8, makePixels(8, 8));
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const artifact = join(dir, "source.capture.json");
  const candidate = join(dir, "candidate.solver.json");
  writeJson(artifact, makeSourceArtifact({ pngPath, maskPath }));
  writeJson(candidate, {
    schema_version: "1.2.0",
    kind: "solver_candidate",
    id: "dx-replay-self-test-candidate",
    parameters: {
      blur_radius: 18.5,
      edge_lensing: 0.72,
      specular_gain: 1.12
    }
  });
  return {
    artifact,
    candidate,
    out: outPath ? resolve(outPath) : join(dir, "glass-replay.report.json")
  };
}

function makeSourceArtifact({ pngPath, maskPath }) {
  return finalizeCaptureArtifactIntegrity({
    schema_version: "1.2.0",
    id: "dx-replay-source-artifact",
    rig_id: "C1",
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
      content_seed: "dx-replay-self-test",
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
      touch_phase: "press",
      animation_t: 1
    },
    shader: {
      pipeline: "baked_verdict",
      solver_candidate_id: "source"
    },
    integrity: {
      artifact_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      producer_version: "lab-glass-replay.self-test"
    }
  });
}

function assertReplayGuardRails(report) {
  const replay = JSON.parse(readFileSync(report.replay_artifact_path, "utf8"));
  if (report.invalid_for_verdict !== true || replay.rig_id !== "DX_REPLAY") {
    throw new Error("glass replay self-test failed to mark output as DX_REPLAY");
  }
  if (replay.technical_class !== "INVALID" || replay.verdict_class !== "INVALID" || replay.invalid_reason !== "NON_PHYSICAL_PATH") {
    throw new Error("glass replay self-test produced verdict-eligible replay artifact");
  }
  if (replay.shader?.pipeline !== "dx_replay" || replay.shader?.param_hash !== report.parameter_hash) {
    throw new Error("glass replay self-test did not attach solver parameters/hash");
  }
  if (report.output_contract.can_feed_verdict !== false) {
    throw new Error("glass replay self-test did not block verdict ingestion");
  }
}

function makePixels(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 42 + x;
      pixels[offset + 1] = 92 + y;
      pixels[offset + 2] = 144;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function walkJson(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...walkJson(path));
    else if (entry.endsWith(".json")) files.push(path);
  }
  return files;
}

function writeJson(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function safePart(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 80);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--artifact") parsed.artifact = args[++index];
    else if (arg === "--candidate") parsed.candidate = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else if (arg === "--artifact-out") parsed.artifactOut = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
