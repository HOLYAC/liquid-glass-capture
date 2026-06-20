export function measureRuntime(recordOrArtifact, options = {}) {
  const artifact = recordOrArtifact.artifact ?? recordOrArtifact;
  const perf = artifact.perf ?? {};
  const failures = [];
  const physical = !looksLikeSimulator(artifact.device_info?.model_identifier);
  const fullFrameP95 = firstFinite(perf.full_frame_ms_p95, perf.frame_interval_ms_p95);
  const frameIntervalP95 = finiteOrNull(perf.frame_interval_ms_p95);
  const droppedFrames = finiteOrNull(perf.dropped_frames);
  const refreshHz = finiteOrNull(artifact.device_info?.refresh_hz);
  const defaultCeiling = refreshHz ? (1000 / refreshHz) * (options.frameBudgetSlack ?? 1.5) : 25;
  const fullFrameCeiling = options.fullFrameP95CeilingMs ?? defaultCeiling;

  if (!physical) failures.push("G5_PHYSICAL_DEVICE_REQUIRED");
  if (artifact.capture_kind !== "compositor" && artifact.capture_kind !== "framebuffer") {
    failures.push("G5_CAPTURE_PATH_NOT_COMPOSITOR_OR_FRAMEBUFFER");
  }
  if (!Number.isFinite(fullFrameP95)) {
    failures.push("G5_FULL_FRAME_P95_MISSING");
  } else if (fullFrameP95 > fullFrameCeiling) {
    failures.push("G5_FULL_FRAME_P95_ABOVE_CEILING");
  }
  if (!Number.isFinite(droppedFrames)) {
    failures.push("G5_DROPPED_FRAMES_MISSING");
  } else if (droppedFrames > (options.droppedFrameCeiling ?? 0)) {
    failures.push("G5_DROPPED_FRAMES_ABOVE_CEILING");
  }
  if (artifact.rig_id === "C1" && artifact.shader?.pipeline !== "baked_verdict") {
    failures.push("G5_C1_REQUIRES_BAKED_VERDICT_SHADER");
  }
  if (artifact.rig_id === "DOM_C" && !Number.isFinite(perf.compositor_frame_ms_p95)) {
    failures.push("G5_DOM_C_COMPOSITOR_COST_MISSING");
  }

  return {
    schema_version: "1.2.0",
    kind: "g5_runtime_report",
    gate: "G5",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    policy: {
      full_frame_p95_ceiling_ms: fullFrameCeiling,
      dropped_frame_ceiling: options.droppedFrameCeiling ?? 0,
      source_note: perf.measurement_source ?? "artifact_perf_block"
    },
    metrics: {
      runtime: {
        full_frame_ms_p95: Number.isFinite(fullFrameP95) ? fullFrameP95 : null,
        frame_interval_ms_p95: frameIntervalP95,
        compositor_frame_ms_p95: finiteOrNull(perf.compositor_frame_ms_p95),
        cpu_frame_ms_p95: finiteOrNull(perf.cpu_frame_ms_p95),
        gpu_frame_ms_p95: finiteOrNull(perf.gpu_frame_ms_p95),
        memory_mb_p95: finiteOrNull(perf.memory_mb_p95),
        dropped_frames: droppedFrames,
        sustained_degradation_pct: finiteOrNull(perf.sustained_degradation_pct)
      }
    }
  };
}

export function flattenRuntimeReport(report) {
  const runtime = report.metrics?.runtime ?? {};
  return {
    full_frame_ms_p95: runtime.full_frame_ms_p95,
    frame_interval_ms_p95: runtime.frame_interval_ms_p95,
    compositor_frame_ms_p95: runtime.compositor_frame_ms_p95,
    dropped_frames: runtime.dropped_frames,
    sustained_degradation_pct: runtime.sustained_degradation_pct
  };
}

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return NaN;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function looksLikeSimulator(modelIdentifier) {
  return typeof modelIdentifier === "string" && /simulator|x86|arm64-sim/i.test(modelIdentifier);
}
