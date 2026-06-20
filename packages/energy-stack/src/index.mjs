export function measureEnergy(artifactOrRecord, options = {}) {
  const artifact = artifactOrRecord.artifact ?? artifactOrRecord;
  const energy = artifact.energy ?? {};
  const perf = artifact.perf ?? {};
  const device = artifact.device_info ?? {};
  const framePack = artifact.frame_pack ?? {};
  const failures = [];
  const warnings = [];
  const durationMs = finiteOrNull(framePack.sustained_duration_ms);
  const sustained = Boolean(options.sustained) || framePack.touch_phase === "sustained" || (durationMs ?? 0) >= (options.sustainedDurationMs ?? 60_000);
  const shortStressMs = options.shortStressMs ?? 10_000;
  const sustainedStressMs = options.sustainedDurationMs ?? 60_000;
  const traceAvailable = energy.trace_available === true;
  const traceStatus = traceAvailable ? "available" : "trace_unavailable";

  if (looksLikeSimulator(device.model_identifier)) failures.push("G6_PHYSICAL_DEVICE_REQUIRED");
  if (device.thermal_state_start !== "nominal") failures.push("G6_THERMAL_START_NOT_NOMINAL");
  if (!Number.isFinite(durationMs) || durationMs < shortStressMs) {
    failures.push("G6_SHORT_STRESS_DURATION_MISSING");
  }
  if (sustained && (!Number.isFinite(durationMs) || durationMs < sustainedStressMs)) {
    failures.push("G6_SUSTAINED_STRESS_DURATION_MISSING");
  }
  if (device.thermal_state_end === "critical") {
    failures.push("G6_THERMAL_CRITICAL");
  }
  if (sustained && device.thermal_state_end === "serious") {
    failures.push("G6_THERMAL_SERIOUS_IN_SUSTAINED_WINDOW");
  }
  if (energy.thermal_onset_ms !== undefined && energy.thermal_onset_ms !== null) {
    const onset = Number(energy.thermal_onset_ms);
    if (Number.isFinite(onset) && onset >= 0 && sustained) {
      failures.push("G6_THERMAL_ONSET_RECORDED_IN_SUSTAINED_WINDOW");
    }
  }
  if (!traceAvailable) {
    if (options.requireEnergyTrace) {
      failures.push("G6_ENERGY_TRACE_UNAVAILABLE_REQUIRED");
    } else {
      warnings.push("G6_ENERGY_TRACE_UNAVAILABLE");
    }
  }

  const degradation = finiteOrNull(perf.sustained_degradation_pct);
  if (Number.isFinite(degradation) && degradation > (options.sustainedDegradationCeilingPct ?? 8)) {
    failures.push("G6_SUSTAINED_DEGRADATION_ABOVE_CEILING");
  }
  const intervalP95 = finiteOrNull(perf.frame_interval_ms_p95);
  if (Number.isFinite(intervalP95) && intervalP95 > (options.sustainedFrameIntervalP95CeilingMs ?? 25)) {
    failures.push("G6_SUSTAINED_FRAME_INTERVAL_P95_ABOVE_CEILING");
  }

  return {
    schema_version: "1.2.0",
    kind: "g6_energy_report",
    gate: "G6",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    warnings,
    policy: {
      short_stress_ms: shortStressMs,
      sustained_stress_ms: sustainedStressMs,
      require_energy_trace: Boolean(options.requireEnergyTrace),
      sustained_degradation_ceiling_pct: options.sustainedDegradationCeilingPct ?? 8,
      sustained_frame_interval_p95_ceiling_ms: options.sustainedFrameIntervalP95CeilingMs ?? 25
    },
    metrics: {
      energy: {
        trace_status: traceStatus,
        trace_tool: energy.trace_tool ?? null,
        energy_mj_per_10s: finiteOrNull(energy.energy_mj_per_10s),
        average_power_mw: finiteOrNull(energy.average_power_mw)
      },
      thermal: {
        start_state: device.thermal_state_start ?? null,
        end_state: device.thermal_state_end ?? device.thermal_state_start ?? null,
        thermal_onset_ms: finiteOrNull(energy.thermal_onset_ms)
      },
      sustained: {
        duration_ms: durationMs,
        degradation_pct: degradation,
        frame_interval_ms_p95: intervalP95
      }
    }
  };
}

export function flattenEnergyReport(report) {
  const energy = report.metrics?.energy ?? {};
  const thermal = report.metrics?.thermal ?? {};
  const sustained = report.metrics?.sustained ?? {};
  return {
    trace_status: energy.trace_status,
    energy_mj_per_10s: energy.energy_mj_per_10s,
    average_power_mw: energy.average_power_mw,
    thermal_start_state: thermal.start_state,
    thermal_end_state: thermal.end_state,
    sustained_duration_ms: sustained.duration_ms,
    sustained_degradation_pct: sustained.degradation_pct,
    sustained_frame_interval_ms_p95: sustained.frame_interval_ms_p95
  };
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function looksLikeSimulator(modelIdentifier) {
  return typeof modelIdentifier === "string" && /simulator|x86|arm64-sim/i.test(modelIdentifier);
}
