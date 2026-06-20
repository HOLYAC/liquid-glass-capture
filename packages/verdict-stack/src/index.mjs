import { retentionSummaryForHash } from "../../artifact-store/src/index.mjs";
import { createHash } from "node:crypto";

const requiredTechnicalGates = ["G2", "G3", "G4", "G5", "G6"];

export function buildVerdictReport({ candidateRecord, gateReports = [], reviewReport, baselineReport, solverReport, artifactStoreIndex, physicalDeviceLaneReport, preflightFailures = [] }) {
  const artifact = candidateRecord.artifact ?? candidateRecord;
  const failures = [...preflightFailures];
  const blockers = [];

  if (looksLikeSimulator(artifact.device_info?.model_identifier)) failures.push("G8_PHYSICAL_DEVICE_REQUIRED");
  if (artifact.capture_kind !== "compositor" && artifact.capture_kind !== "framebuffer") {
    failures.push("G8_CAPTURE_PATH_INVALID");
  }
  if (artifact.rig_id === "C1" && artifact.shader?.pipeline !== "baked_verdict") {
    failures.push("G8_C1_REQUIRES_BAKED_VERDICT_SHADER");
  }
  if (artifact.rig_id === "C0" || artifact.rig_id === "DX_REPLAY") {
    failures.push("G8_CALIBRATION_OR_REPLAY_RIG_INVALID_FOR_VERDICT");
  }

  const gateMap = new Map(gateReports.map((report) => [report.gate, report]));
  for (const gate of requiredTechnicalGates) {
    if (!gateMap.has(gate)) failures.push(`G8_${gate}_REPORT_MISSING`);
  }
  for (const report of gateReports) {
    if (report.status !== "pass") {
      blockers.push(...(report.failures ?? [`${report.gate}_FAILED`]));
    }
  }
  if (solverReport) {
    if (solverReport.kind !== "solver_pareto_report") {
      failures.push("G8_SOLVER_REPORT_KIND_INVALID");
    } else if (solverReport.status !== "pass") {
      blockers.push("G8_SOLVER_REPORT_FAILED", ...(solverReport.failures ?? []));
    }
    const selectedCandidateId = solverReport.selected_candidate?.id;
    const artifactSolverCandidateId = artifact.shader?.solver_candidate_id ?? artifact.solver_candidate_id ?? artifact.id;
    if (artifact.rig_id === "C1" && selectedCandidateId && artifactSolverCandidateId !== selectedCandidateId) {
      failures.push("G8_C1_NOT_SELECTED_SOLVER_CANDIDATE");
    }
  }
  if (physicalDeviceLaneReport) {
    if (physicalDeviceLaneReport.kind !== "physical_device_lane_report") {
      failures.push("G8_PHYSICAL_DEVICE_LANE_REPORT_KIND_INVALID");
    } else if (physicalDeviceLaneReport.status !== "pass") {
      blockers.push(`G8_PHYSICAL_DEVICE_LANE_${String(physicalDeviceLaneReport.status).toUpperCase()}`);
      blockers.push(...(physicalDeviceLaneReport.failures ?? []));
    }
  }
  const baselineValidation = validateBaselineReport(baselineReport);
  failures.push(...baselineValidation.failures);
  blockers.push(...baselineValidation.blockers);

  const invalid = failures.length > 0;
  const hardFailed = blockers.length > 0;
  const technicalClass = invalid ? "INVALID" : hardFailed ? "FAIL" : deriveTechnicalClass(artifact);
  const designClass = designClassFromReview(reviewReport, invalid || hardFailed);
  const verdictClass = verdictClassFromState({ invalid, hardFailed, reviewReport, designClass });
  const energyGate = gateMap.get("G6");
  const solverIdentifiability = solverReport?.parameter_identifiability ?? {};

  return {
    schema_version: "1.2.0",
    kind: "g8_verdict_report",
    verdict_class: verdictClass,
    technical_class: technicalClass,
    design_class: designClass,
    flake_class: "NONE",
    status: verdictClass === "FAIL" || verdictClass === "INVALID" ? "fail" : "pass",
    null_qualification: artifact.null_qualification ?? "not_recorded",
    device: deviceSummary(artifact),
    capture_kind: artifact.capture_kind,
    scene: {
      scene_id: artifact.scene_id,
      state_id: artifact.state_id
    },
    gates: {
      color: "assumed_from_G0_G1_artifact_contract",
      static: gateStatus(gateMap, "G2"),
      optics: gateStatus(gateMap, "G3"),
      temporal: gateStatus(gateMap, "G4"),
      runtime: gateStatus(gateMap, "G5"),
      energy: energyStatus(energyGate),
      design: designStatus(designClass)
    },
    solver: solverReport ? solverSummary(solverReport) : { status: "not_recorded" },
    physical_device_lane: physicalDeviceLaneReport ? physicalDeviceLaneSummary(physicalDeviceLaneReport) : { status: "not_recorded" },
    identifiability: Object.keys(solverIdentifiability).length > 0
      ? solverIdentifiability
      : artifact.shader?.identifiability ?? {},
    claim_constraints: solverReport?.claim_constraints ?? [],
    baseline: baselineReport
      ? {
          namespace: baselineReport.baseline_namespace,
          status: baselineReport.baseline_status,
          repeat_n_observed: baselineReport.repeat_n_observed,
          approval_status: baselineReport.baseline_approval?.approval_status ?? "not_recorded",
          freeze_sha256: baselineReport.baseline_freeze?.content_sha256 ?? null,
          freeze_verified: baselineValidation.freeze_verified,
          threshold_policy: baselineReport.statistics?.threshold_policy?.policy_id ?? null,
          final_p99_allowed: baselineReport.repeat_policy?.final_p99_allowed === true
        }
      : { status: "missing", freeze_verified: false },
    artifacts: {
      candidate: {
        id: artifact.id,
        rig_id: artifact.rig_id,
        png_sha256: candidateRecord.png?.sha256 ?? artifact.frame_pack?.base_png_sha256 ?? null,
        artifact_path: candidateRecord.artifact_path ?? null
      }
    },
    traces: {
      energy_trace: energyGate?.metrics?.energy?.trace_status ?? artifact.energy?.trace_status ?? "not_recorded"
    },
    blockers: [...failures, ...blockers, ...(reviewReport?.failures ?? [])],
    retention: buildRetentionBlock({ artifactStoreIndex, candidateRecord, artifact }),
    reports: Object.fromEntries(gateReports.map((report) => [report.gate, report.kind ?? "gate_report"]))
  };
}

function validateBaselineReport(report) {
  const failures = [];
  const blockers = [];
  if (!report) {
    blockers.push("G8_BASELINE_REPORT_MISSING");
    return { failures, blockers, freeze_verified: false };
  }
  if (report.kind !== "baseline_metric_report") failures.push("G8_BASELINE_REPORT_KIND_INVALID");
  if (report.baseline_status !== "complete") blockers.push("G8_BASELINE_NOT_COMPLETE");
  if (report.baseline_approval?.approval_status !== "approved") {
    blockers.push("G8_BASELINE_OWNER_APPROVAL_MISSING");
  }
  if (!report.baseline_identity) blockers.push("G8_BASELINE_IDENTITY_MISSING");
  if (!report.threshold_derivation?.metric_thresholds) blockers.push("G8_BASELINE_THRESHOLDS_MISSING");
  if (report.repeat_policy?.final_p99_allowed !== true) blockers.push("G8_BASELINE_FINAL_P99_NOT_ALLOWED");
  if (report.immutability?.frozen_by_hash !== true) blockers.push("G8_BASELINE_NOT_FROZEN");
  if (typeof report.baseline_freeze?.content_sha256 !== "string") {
    blockers.push("G8_BASELINE_FREEZE_HASH_MISSING");
    return { failures, blockers, freeze_verified: false };
  }

  const actualFreezeHash = baselineContentSha256(report);
  const freezeVerified = actualFreezeHash === report.baseline_freeze.content_sha256;
  if (!freezeVerified) blockers.push("G8_BASELINE_FREEZE_HASH_MISMATCH");
  blockers.push(...(report.failures ?? []).map((failure) => `G8_BASELINE_FAILURE:${failure}`));
  return {
    failures,
    blockers,
    freeze_verified: freezeVerified
  };
}

function baselineContentSha256(report) {
  return createHash("sha256")
    .update(canonicalJson(baselineFreezePayload(report)))
    .digest("hex");
}

function baselineFreezePayload(report) {
  const payload = { ...report };
  delete payload.baseline_freeze;
  if (payload.immutability && typeof payload.immutability === "object") {
    payload.immutability = { ...payload.immutability };
    delete payload.immutability.frozen_by_hash;
    delete payload.immutability.baseline_content_sha256;
    delete payload.immutability.baseline_retention_class;
  }
  return payload;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function deriveTechnicalClass(artifact) {
  if (artifact.rig_id === "R0") return "SWIFTUI_PASS";
  if (artifact.rig_id === "R1" || artifact.rig_id === "DOM_C") return "WEBKIT_PASS";
  if (artifact.rig_id === "C1") return "SHADER_PASS";
  return "INVALID";
}

function solverSummary(report) {
  return {
    status: report.status,
    selected_candidate_id: report.selected_candidate?.id ?? null,
    pareto_count: report.pareto_front?.length ?? 0,
    candidate_count: report.candidate_count ?? 0,
    required_degeneracy_scene_ids: report.background_sweep?.required_scene_ids ?? [],
    observed_scene_ids: report.background_sweep?.observed_scene_ids ?? [],
    claim_constraint_count: report.claim_constraints?.length ?? 0
  };
}

function physicalDeviceLaneSummary(report) {
  return {
    status: report.status,
    lane_class: report.lane_class ?? null,
    task_count: report.task_count ?? 0,
    gate_status: report.gates?.status ?? "not_recorded",
    simulator_forbidden: report.evidence?.simulator_forbidden === true,
    layer_snapshot_forbidden: report.evidence?.layer_snapshot_forbidden === true,
    scene_contract_verified: report.evidence?.scene_contract_verified === true,
    hashes_verified: report.evidence?.hashes_verified === true,
    sustained_contract_verified: report.lane_class === "sustained"
      ? report.evidence?.sustained_contract_verified === true
      : true,
    production_device_matrix_verified: report.lane_class === "prod_p99"
      ? report.evidence?.production_device_matrix_verified === true
      : true,
    failure_count: report.failures?.length ?? 0
  };
}

function buildRetentionBlock({ artifactStoreIndex, candidateRecord, artifact }) {
  const candidateHash = candidateRecord.png?.sha256 ?? artifact.frame_pack?.base_png_sha256 ?? null;
  if (!artifactStoreIndex || !candidateHash) {
    return {
      status: "not_recorded",
      class: "not_recorded",
      raw_artifacts_retained: "unknown",
      deletion_never_removes_hash_manifest: true
    };
  }
  const summary = retentionSummaryForHash(artifactStoreIndex, candidateHash);
  return {
    ...summary,
    raw_artifacts_retained: summary.status === "indexed",
    deletion_never_removes_hash_manifest: true
  };
}

function verdictClassFromState({ invalid, hardFailed, reviewReport, designClass }) {
  if (invalid) return "INVALID";
  if (hardFailed) return "FAIL";
  if (!reviewReport) return "TECH_PASS_PENDING_SIGNOFF";
  if (reviewReport.status !== "pass") return "FAIL";
  return {
    PASS: "PROD_PASS",
    PASS_WITH_REVIEW: "PASS_WITH_REVIEW",
    BLOCKED_FOR_DESIGN: "BLOCKED_FOR_DESIGN",
    LEGIBILITY_BLOCK: "LEGIBILITY_BLOCK"
  }[designClass] ?? "FAIL";
}

function designClassFromReview(reviewReport, technicalStopped) {
  if (technicalStopped) return "NOT_RUN";
  if (!reviewReport) return "NOT_RUN";
  if (reviewReport.status !== "pass") return "NOT_RUN";
  return reviewReport.design_class ?? "NOT_RUN";
}

function gateStatus(gateMap, gate) {
  return gateMap.get(gate)?.status ?? "missing";
}

function energyStatus(report) {
  if (!report) return "missing";
  if (report.status !== "pass") return "fail";
  if ((report.warnings ?? []).includes("G6_ENERGY_TRACE_UNAVAILABLE")) return "trace_unavailable";
  return "pass";
}

function designStatus(designClass) {
  return {
    NOT_RUN: "not_run",
    PASS: "pass",
    PASS_WITH_REVIEW: "review",
    BLOCKED_FOR_DESIGN: "block",
    LEGIBILITY_BLOCK: "block"
  }[designClass] ?? "not_run";
}

function deviceSummary(artifact) {
  const device = artifact.device_info ?? {};
  return {
    model_name: device.model_name ?? null,
    model_identifier: device.model_identifier ?? null,
    os_build: device.os_build ?? null,
    sdk_build: device.sdk_build ?? null
  };
}

function looksLikeSimulator(modelIdentifier) {
  return typeof modelIdentifier === "string" && /simulator|x86|arm64-sim/i.test(modelIdentifier);
}
