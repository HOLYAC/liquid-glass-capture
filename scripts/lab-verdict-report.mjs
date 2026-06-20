#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { sha256File, writePng } from "./lib/lab-png.mjs";
import { evaluateReviewPacket } from "../packages/review-stack/src/index.mjs";
import { buildSolverReport } from "../packages/solver/src/index.mjs";
import { readArtifactStoreIndex, writeArtifactStore } from "../packages/artifact-store/src/index.mjs";
import { buildPhysicalDeviceLanePlan, verifyPhysicalDeviceLane } from "../packages/device-lane/src/index.mjs";
import { buildVerdictReport } from "../packages/verdict-stack/src/index.mjs";
import { makePassingPacket } from "./lab-review-packet.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const s03PressTrajectorySha256 = "56148be556260e9f1647bf9ab09ddf12c7ae129b3194722b2ed54bb8ad2fbcdd";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = buildReportFromFiles(fixture);
    assertVerdictGuardRails(fixture, report);
    writeReport(fixture.out, report);
    console.log(`${report.status.toUpperCase()} ${fixture.out}`);
    if (report.status !== "pass" || report.verdict_class !== "PROD_PASS") process.exit(1);
    return;
  }

  if (!args.candidate || args.gates.length === 0) {
    console.error("usage: node scripts/lab-verdict-report.mjs --candidate <capture.json> --gate <g2.json> ... [--solver <solver.json>] [--store-index <index.json>] [--device-lane <lane.json>] [--review <g7.json>] [--baseline <baseline.json>] [--out report.json]");
    console.error("       node scripts/lab-verdict-report.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const report = buildReportFromFiles(args);
  if (args.out) writeReport(args.out, report);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

function buildReportFromFiles(args) {
  const candidateRecord = readCaptureArtifact(args.candidate, {
    allowInvalid: true,
    allowLayerSnapshot: true
  });
  const gateReports = args.gates.map((path) => JSON.parse(readFileSync(resolve(path), "utf8")));
  const solverReport = args.solver ? JSON.parse(readFileSync(resolve(args.solver), "utf8")) : undefined;
  const artifactStoreIndex = args.storeIndex ? readArtifactStoreIndex(args.storeIndex) : undefined;
  const physicalDeviceLaneReport = args.deviceLane ? JSON.parse(readFileSync(resolve(args.deviceLane), "utf8")) : undefined;
  const reviewReport = args.review ? JSON.parse(readFileSync(resolve(args.review), "utf8")) : undefined;
  const baselineReport = args.baseline ? JSON.parse(readFileSync(resolve(args.baseline), "utf8")) : undefined;
  return buildVerdictReport({
    candidateRecord,
    gateReports,
    solverReport,
    artifactStoreIndex,
    physicalDeviceLaneReport,
    reviewReport,
    baselineReport,
    preflightFailures: candidateRecord.preflight_failures
  });
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "verdict-report");
  mkdirSync(dir, { recursive: true });
  const pngPath = join(dir, "candidate.png");
  writePng(pngPath, 10, 10, makePixels(10, 10));
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const candidate = join(dir, "candidate.capture.json");
  writeFileSync(candidate, `${JSON.stringify(makeCandidateArtifact(pngPath, maskPath), null, 2)}\n`);

  const gates = ["G2", "G3", "G4", "G5", "G6"].map((gate) => {
    const path = join(dir, `${gate.toLowerCase()}.report.json`);
    const report = makeGateReport(gate);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
  });

  const reviewPacket = makePassingPacket();
  const reviewReport = evaluateReviewPacket(reviewPacket);
  const review = join(dir, "g7-review.report.json");
  writeFileSync(review, `${JSON.stringify(reviewReport, null, 2)}\n`);
  const solver = join(dir, "solver.pareto.report.json");
  writeFileSync(solver, `${JSON.stringify(makeSolverReport(), null, 2)}\n`);
  const storeWrite = writeArtifactStore({
    files: [pngPath],
    storeRoot: join(dir, "store"),
    retentionClass: "raw_png_frame",
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const deviceLane = join(dir, "physical-device-lane.report.json");
  writeFileSync(deviceLane, `${JSON.stringify(makePhysicalDeviceLaneReport(candidate), null, 2)}\n`);

  return {
    candidate,
    gates,
    solver,
    storeIndex: storeWrite.index_path,
    deviceLane,
    review,
    out: outPath ? resolve(outPath) : join(dir, "g8-verdict.report.json")
  };
}

function makePixels(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 48 + x;
      pixels[offset + 1] = 96 + y;
      pixels[offset + 2] = 144;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function makeCandidateArtifact(pngPath, maskPath) {
  return {
    schema_version: "1.2.0",
    id: "self-test-c1-g8-verdict",
    rig_id: "C1",
    scene_id: "S03_PRESS",
    state_id: "press",
    git_commit: "self-test",
    capture_kind: "compositor",
    null_qualification: "pass",
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
      content_seed: "g8-verdict-self-test",
      viewport_px: { width: 10, height: 10 },
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
      animation_t: 1,
      sustained_duration_ms: 60_000,
      trajectory_source_sha256: s03PressTrajectorySha256
    },
    shader: {
      pipeline: "baked_verdict",
      solver_candidate_id: "self-test-c1-g8-verdict",
      baked_shader_hash: "self-test",
      identifiability: {
        blur_radius: "MEASURED",
        tint: "MEASURED"
      }
    },
    perf: {
      measurement_source: "g8-self-test",
      full_frame_ms_p95: 14.2,
      frame_interval_ms_p95: 16.67,
      dropped_frames: 0,
      sustained_degradation_pct: 1.2
    },
    energy: {
      trace_available: false,
      trace_status: "trace_unavailable"
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-verdict-report.self-test"
    }
  };
}

function makePhysicalDeviceLaneReport(candidatePath) {
  const plan = buildPhysicalDeviceLanePlan({
    laneClass: "smoke",
    tasks: [
      {
        rig_id: "C1",
        scene_id: "S03_PRESS",
        state_id: "press",
        repeat_count_requested: 1
      }
    ],
    generatedAt: "2026-01-01T00:00:00.000Z",
    gitCommit: "self-test",
    reason: "g8-verdict-self-test"
  });
  const manifest = {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "C1",
    scene_id: "S03_PRESS",
    state_id: "press",
    capture_kind: "compositor",
    repeat_count_requested: 1,
    repeat_count_observed: 1,
    artifact_json_paths: [candidatePath]
  };
  return verifyPhysicalDeviceLane({
    plan,
    manifests: [{ path: join(dirname(candidatePath), "g8-device-lane.repeat-manifest.json"), manifest }]
  });
}

function makeSolverReport() {
  return buildSolverReport({
    candidates: [
      {
        schema_version: "1.2.0",
        kind: "solver_candidate",
        id: "self-test-c1-g8-verdict",
        rig_id: "C1",
        parameters: {
          blur_radius: 18,
          tint: 0.12
        },
        parameter_evidence: {
          blur_radius: {
            local_sensitivity: 0.12,
            confidence: 0.95,
            normalized_interval_width: 0.08
          },
          tint: {
            local_sensitivity: 0.04,
            confidence: 0.72,
            normalized_interval_width: 0.32
          }
        },
        objectives: {
          runtime_cost_ms: 12.1,
          energy_cost: 1.9
        },
        background_sweep: ["S07_BUSY_PHOTO", "S08_P3_GRADIENT", "S09_NEAR_WHITE", "S10_NEAR_BLACK", "S11_VIDEO_HF"].map((sceneId, index) => ({
          scene_id: sceneId,
          background_id: `${sceneId.toLowerCase()}_g8_self_test`,
          metrics: {
            static_loss: 0.008 + index * 0.0005,
            optics_loss: 0.010 + index * 0.0005,
            temporal_loss: 0.003
          }
        }))
      }
    ]
  });
}

function makeGateReport(gate) {
  return {
    schema_version: "1.2.0",
    kind: `${gate.toLowerCase()}_self_test_report`,
    gate,
    status: "pass",
    failures: [],
    warnings: gate === "G6" ? ["G6_ENERGY_TRACE_UNAVAILABLE"] : []
  };
}

function assertVerdictGuardRails(fixture, passReport) {
  if (passReport.technical_class !== "SHADER_PASS" || passReport.verdict_class !== "PROD_PASS") {
    throw new Error("G8 guardrail failed: positive self-test did not produce SHADER_PASS + PROD_PASS");
  }
  if (passReport.solver?.selected_candidate_id !== "self-test-c1-g8-verdict") {
    throw new Error("G8 guardrail failed: solver selected candidate missing from verdict");
  }
  if (!passReport.claim_constraints.some((constraint) => constraint.parameter === "tint" && constraint.parameter_level_match_claim === "forbidden")) {
    throw new Error("G8 guardrail failed: solver claim constraints missing from verdict");
  }
  if (passReport.retention?.status !== "indexed" || passReport.retention.raw_artifacts_retained !== true) {
    throw new Error("G8 guardrail failed: artifact-store retention entry missing from verdict");
  }
  if (passReport.physical_device_lane?.status !== "pass" || passReport.physical_device_lane.hashes_verified !== true) {
    throw new Error("G8 guardrail failed: physical-device lane evidence missing from verdict");
  }

  const gateReports = fixture.gates.map((path) => JSON.parse(readFileSync(resolve(path), "utf8")));
  const reviewReport = JSON.parse(readFileSync(resolve(fixture.review), "utf8"));
  const baseRecord = readCaptureArtifact(fixture.candidate, {
    allowInvalid: true,
    allowLayerSnapshot: true
  });

  const calibrationRecord = {
    ...baseRecord,
    artifact: {
      ...baseRecord.artifact,
      shader: {
        ...baseRecord.artifact.shader,
        pipeline: "uniform_calibration"
      }
    }
  };
  const calibrationReport = buildVerdictReport({
    candidateRecord: calibrationRecord,
    gateReports,
    reviewReport,
    preflightFailures: []
  });
  if (calibrationReport.verdict_class !== "INVALID" || !calibrationReport.blockers.includes("G8_C1_REQUIRES_BAKED_VERDICT_SHADER")) {
    throw new Error("G8 guardrail failed: C1 calibration shader received verdict");
  }

  const domRecord = {
    ...baseRecord,
    artifact: {
      ...baseRecord.artifact,
      rig_id: "DOM_C",
      shader: {
        pipeline: "dom_css"
      }
    }
  };
  const domReport = buildVerdictReport({
    candidateRecord: domRecord,
    gateReports,
    reviewReport,
    preflightFailures: []
  });
  if (domReport.technical_class !== "WEBKIT_PASS" || domReport.technical_class === "SWIFTUI_PASS") {
    throw new Error("G8 guardrail failed: DOM_C escaped WEBKIT_PASS class");
  }
}

function writeReport(out, report) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = { gates: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--candidate") parsed.candidate = args[++index];
    else if (arg === "--gate") parsed.gates.push(args[++index]);
    else if (arg === "--solver") parsed.solver = args[++index];
    else if (arg === "--store-index") parsed.storeIndex = args[++index];
    else if (arg === "--device-lane") parsed.deviceLane = args[++index];
    else if (arg === "--review") parsed.review = args[++index];
    else if (arg === "--baseline") parsed.baseline = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
