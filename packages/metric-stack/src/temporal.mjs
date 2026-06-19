import {
  displayP3LinearLuminance,
  rgbaByteToLinearDisplayP3
} from "../../color-pipeline/src/index.mjs";

export function measureTemporal(referenceSequence, candidateSequence, options = {}) {
  const failures = [];
  if (referenceSequence.frames.length < 3 || candidateSequence.frames.length < 3) {
    failures.push("G4_SEQUENCE_TOO_SHORT");
  }
  if (referenceSequence.frames.length !== candidateSequence.frames.length) {
    failures.push("G4_SEQUENCE_LENGTH_MISMATCH");
  }
  if (!hasUsableTimestamps(referenceSequence) || !hasUsableTimestamps(candidateSequence)) {
    failures.push("G4_SEQUENCE_TIMESTAMPS_MISSING");
  }
  if (!referenceSequence.trajectory_source_sha256 || !candidateSequence.trajectory_source_sha256) {
    failures.push("G4_TRAJECTORY_SOURCE_MISSING");
  } else if (referenceSequence.trajectory_source_sha256 !== candidateSequence.trajectory_source_sha256) {
    failures.push("G4_TRAJECTORY_SOURCE_MISMATCH");
  }

  const dimensionFailure = firstDimensionFailure(referenceSequence, candidateSequence);
  if (dimensionFailure) failures.push(dimensionFailure);

  const referenceMotion = extractMotionSeries(referenceSequence);
  const candidateMotion = extractMotionSeries(candidateSequence);
  const referencePacing = measureFramePacing(referenceSequence.timestamps_ms);
  const candidatePacing = measureFramePacing(candidateSequence.timestamps_ms);
  const phase = measurePhase(referenceMotion, candidateMotion);
  const press = measurePressDynamics(candidateMotion);
  const referenceMotionPeak = maxValue(referenceMotion.energy);
  const candidateMotionPeak = maxValue(candidateMotion.energy);

  if (referenceMotionPeak < (options.motionEnergyFloor ?? 0.0005)) {
    failures.push("G4_REFERENCE_MOTION_ENERGY_TOO_LOW");
  }
  if (candidateMotionPeak < (options.motionEnergyFloor ?? 0.0005)) {
    failures.push("G4_CANDIDATE_MOTION_ENERGY_TOO_LOW");
  }
  if (Math.abs(phase.peak_phase_error_ms) > (options.phaseErrorCeilingMs ?? 50)) {
    failures.push("G4_PHASE_ERROR_ABOVE_CEILING");
  }
  if (press.overshoot_ratio > (options.overshootCeiling ?? 0.35)) {
    failures.push("G4_PRESS_OVERSHOOT_ABOVE_CEILING");
  }
  if (candidatePacing.frame_interval_p95_ms > (options.frameIntervalP95CeilingMs ?? 25)) {
    failures.push("G4_FRAME_PACING_P95_ABOVE_CEILING");
  }
  if (candidatePacing.dropped_frame_estimate > 0) {
    failures.push("G4_DROPPED_FRAME_ESTIMATE_NONZERO");
  }

  return {
    schema_version: "1.2.0",
    kind: "g4_temporal_report",
    gate: "G4",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    trajectory: {
      reference_sha256: referenceSequence.trajectory_source_sha256 ?? null,
      candidate_sha256: candidateSequence.trajectory_source_sha256 ?? null,
      byte_identical_source: Boolean(
        referenceSequence.trajectory_source_sha256 &&
          referenceSequence.trajectory_source_sha256 === candidateSequence.trajectory_source_sha256
      )
    },
    frame_counts: {
      reference: referenceSequence.frames.length,
      candidate: candidateSequence.frames.length
    },
    metrics: {
      optical_flow_phase: phase,
      press_dynamics: press,
      reference_motion: summarizeMotion(referenceMotion),
      candidate_motion: summarizeMotion(candidateMotion),
      frame_pacing: {
        reference: referencePacing,
        candidate: candidatePacing
      }
    }
  };
}

export function flattenTemporalReport(report) {
  if (!report.metrics) return {};
  return {
    optical_flow_phase_error_ms: report.metrics.optical_flow_phase.peak_phase_error_ms,
    optical_flow_correlation_lag_frames: report.metrics.optical_flow_phase.correlation_lag_frames,
    press_overshoot_ratio: report.metrics.press_dynamics.overshoot_ratio,
    damping_ratio_proxy: report.metrics.press_dynamics.damping_ratio_proxy,
    settle_time_ms: report.metrics.press_dynamics.settle_time_ms,
    candidate_frame_interval_p95_ms: report.metrics.frame_pacing.candidate.frame_interval_p95_ms,
    candidate_frame_interval_jitter_ms: report.metrics.frame_pacing.candidate.frame_interval_jitter_ms,
    candidate_dropped_frame_estimate: report.metrics.frame_pacing.candidate.dropped_frame_estimate,
    candidate_motion_peak: report.metrics.candidate_motion.energy_peak
  };
}

function extractMotionSeries(sequence) {
  const frames = sequence.frames;
  const timestamps = sequence.timestamps_ms;
  const energy = [];
  const centerX = [];
  const centerY = [];
  const timeMs = [];

  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1].png;
    const current = frames[index].png;
    const width = Math.min(previous.width, current.width);
    const height = Math.min(previous.height, current.height);
    let energySum = 0;
    let xSum = 0;
    let ySum = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * previous.width + x) * 4;
        const currentOffset = (y * current.width + x) * 4;
        const prevLuma = displayP3LinearLuminance(rgbaByteToLinearDisplayP3(previous.pixels, offset));
        const currLuma = displayP3LinearLuminance(rgbaByteToLinearDisplayP3(current.pixels, currentOffset));
        const delta = Math.abs(currLuma - prevLuma);
        energySum += delta;
        xSum += x * delta;
        ySum += y * delta;
      }
    }

    const samples = width * height;
    const normalizedEnergy = samples === 0 ? 0 : energySum / samples;
    energy.push(normalizedEnergy);
    centerX.push(energySum === 0 ? 0 : xSum / energySum);
    centerY.push(energySum === 0 ? 0 : ySum / energySum);
    timeMs.push(timestamps ? (timestamps[index] + timestamps[index - 1]) * 0.5 : index);
  }

  return {
    time_ms: timeMs,
    energy,
    center_x: centerX,
    center_y: centerY
  };
}

function measurePhase(referenceMotion, candidateMotion) {
  const referencePeak = peak(referenceMotion.energy);
  const candidatePeak = peak(candidateMotion.energy);
  const referencePeakTime = referenceMotion.time_ms[referencePeak.index] ?? 0;
  const candidatePeakTime = candidateMotion.time_ms[candidatePeak.index] ?? 0;
  const lag = bestCorrelationLag(referenceMotion.energy, candidateMotion.energy, 8);
  const medianInterval = medianIntervalMs(candidateMotion.time_ms);

  return {
    method: "motion_energy_peak_and_cross_correlation",
    reference_peak_time_ms: referencePeakTime,
    candidate_peak_time_ms: candidatePeakTime,
    peak_phase_error_ms: candidatePeakTime - referencePeakTime,
    correlation_lag_frames: lag.lag,
    correlation_lag_ms: lag.lag * medianInterval,
    normalized_correlation: lag.correlation
  };
}

function measurePressDynamics(motion) {
  const peakInfo = peak(motion.energy);
  const peakEnergy = peakInfo.value;
  if (peakEnergy <= 0) {
    return {
      method: "motion_energy_envelope",
      peak_time_ms: 0,
      overshoot_ratio: 0,
      damping_ratio_proxy: 1,
      settle_time_ms: 0,
      settle_threshold: 0
    };
  }

  const afterPeak = motion.energy.slice(peakInfo.index + 1);
  const rebound = afterPeak.length === 0 ? 0 : Math.max(...afterPeak);
  const threshold = peakEnergy * 0.05;
  let settleIndex = motion.energy.length - 1;
  for (let index = peakInfo.index; index < motion.energy.length; index += 1) {
    const tail = motion.energy.slice(index);
    if (tail.every((value) => value <= threshold)) {
      settleIndex = index;
      break;
    }
  }

  return {
    method: "motion_energy_envelope",
    peak_time_ms: motion.time_ms[peakInfo.index] ?? 0,
    overshoot_ratio: rebound / peakEnergy,
    damping_ratio_proxy: 1 - rebound / peakEnergy,
    settle_time_ms: motion.time_ms[settleIndex] ?? 0,
    settle_threshold: threshold
  };
}

function measureFramePacing(timestampsMs) {
  if (!timestampsMs || timestampsMs.length < 2) {
    return {
      frame_count: timestampsMs?.length ?? 0,
      frame_interval_mean_ms: 0,
      frame_interval_p95_ms: 0,
      frame_interval_max_ms: 0,
      frame_interval_jitter_ms: 0,
      dropped_frame_estimate: 0
    };
  }

  const intervals = [];
  for (let index = 1; index < timestampsMs.length; index += 1) {
    intervals.push(timestampsMs[index] - timestampsMs[index - 1]);
  }
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const jitter = Math.sqrt(intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length);
  const ideal = quantile(intervals, 0.5);
  const dropped = intervals.filter((value) => value > ideal * 1.5).length;

  return {
    frame_count: timestampsMs.length,
    frame_interval_mean_ms: mean,
    frame_interval_p95_ms: quantile(intervals, 0.95),
    frame_interval_max_ms: Math.max(...intervals),
    frame_interval_jitter_ms: jitter,
    dropped_frame_estimate: dropped
  };
}

function summarizeMotion(motion) {
  return {
    sample_count: motion.energy.length,
    energy_mean: mean(motion.energy),
    energy_peak: maxValue(motion.energy),
    center_x_mean: mean(motion.center_x),
    center_y_mean: mean(motion.center_y)
  };
}

function firstDimensionFailure(referenceSequence, candidateSequence) {
  const count = Math.min(referenceSequence.frames.length, candidateSequence.frames.length);
  for (let index = 0; index < count; index += 1) {
    const reference = referenceSequence.frames[index].png;
    const candidate = candidateSequence.frames[index].png;
    if (reference.width !== candidate.width || reference.height !== candidate.height) {
      return `G4_DIMENSION_MISMATCH_FRAME_${index}`;
    }
  }
  return null;
}

function hasUsableTimestamps(sequence) {
  return (
    Array.isArray(sequence.timestamps_ms) &&
    sequence.timestamps_ms.length === sequence.frames.length &&
    sequence.timestamps_ms.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function bestCorrelationLag(reference, candidate, maxLag) {
  let best = { lag: 0, correlation: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const left = [];
    const right = [];
    for (let index = 0; index < reference.length; index += 1) {
      const candidateIndex = index + lag;
      if (candidateIndex < 0 || candidateIndex >= candidate.length) continue;
      left.push(reference[index]);
      right.push(candidate[candidateIndex]);
    }
    if (left.length < 2) continue;
    const correlation = pearson(left, right);
    if (correlation > best.correlation) {
      best = { lag, correlation };
    }
  }
  return best;
}

function pearson(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const dl = left[index] - leftMean;
    const dr = right[index] - rightMean;
    numerator += dl * dr;
    leftVariance += dl * dl;
    rightVariance += dr * dr;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? 0 : numerator / denominator;
}

function peak(values) {
  let index = 0;
  let value = -Infinity;
  for (let cursor = 0; cursor < values.length; cursor += 1) {
    if (values[cursor] > value) {
      value = values[cursor];
      index = cursor;
    }
  }
  return { index, value: value === -Infinity ? 0 : value };
}

function medianIntervalMs(timeMs) {
  if (timeMs.length < 2) return 0;
  const intervals = [];
  for (let index = 1; index < timeMs.length; index += 1) {
    intervals.push(timeMs[index] - timeMs[index - 1]);
  }
  return quantile(intervals, 0.5);
}

function maxValue(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
