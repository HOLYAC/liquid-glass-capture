import {
  displayP3LinearLuminance,
  linearDisplayP3ToOklab,
  rgbaByteToLinearDisplayP3
} from "../../color-pipeline/src/index.mjs";

export function measureOptics(reference, candidate, options = {}) {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return {
      schema_version: "1.2.0",
      kind: "g3_optics_report",
      gate: "G3",
      status: "fail",
      failures: ["DIMENSION_MISMATCH"],
      dimensions: {
        reference_width: reference.width,
        reference_height: reference.height,
        candidate_width: candidate.width,
        candidate_height: candidate.height
      }
    };
  }

  const width = reference.width;
  const height = reference.height;
  const pixelCount = width * height;
  const refLuma = new Float64Array(pixelCount);
  const candLuma = new Float64Array(pixelCount);
  const residual = new Float64Array(pixelCount);
  const refOklab = new Array(pixelCount);
  const candOklab = new Array(pixelCount);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const refP3 = rgbaByteToLinearDisplayP3(reference.pixels, offset);
    const candP3 = rgbaByteToLinearDisplayP3(candidate.pixels, offset);
    refLuma[pixel] = displayP3LinearLuminance(refP3);
    candLuma[pixel] = displayP3LinearLuminance(candP3);
    residual[pixel] = candLuma[pixel] - refLuma[pixel];
    refOklab[pixel] = linearDisplayP3ToOklab(refP3);
    candOklab[pixel] = linearDisplayP3ToOklab(candP3);
  }

  const edgeBand = Array.isArray(options.edgeBandIndexes) && options.edgeBandIndexes.length > 0
    ? fixedEdgeBand(options.edgeBandIndexes, refLuma, residual, width, height)
    : inferEdgeBand(refLuma, residual, width, height, options);
  const highlightIndexes = Array.isArray(options.highlightIndexes) && options.highlightIndexes.length > 0
    ? uniqueValidIndexes(options.highlightIndexes, pixelCount)
    : edgeBand.indexes;
  const lensing = measureLensing(refLuma, candLuma, edgeBand, width, height, options);
  const blur = measureBlurFalloff(refLuma, candLuma, edgeBand, width, height);
  const fringe = measureChromaticFringe(reference.pixels, candidate.pixels, edgeBand, width, height);
  const highlight = measureHighlightMismatch(refLuma, candLuma, reference.pixels, candidate.pixels, highlightIndexes, width, height, options);
  const highlightResidual = measureSignedResidualBlob(residual, width, height, 1);
  const innerShadow = measureSignedResidualBlob(residual, width, height, -1);
  const alphaTint = measureAlphaTintSeparation(refOklab, candOklab, residual, edgeBand);
  const edgeBandReport = { ...edgeBand };
  delete edgeBandReport.indexes;

  const failures = [];
  const warnings = [];
  if (edgeBand.sample_count === 0) failures.push("G3_EDGE_BAND_EMPTY");
  if (lensing.vector_field.p95_magnitude_px > (options.lensingP95CeilingPx ?? 3.5)) {
    failures.push("G3_EDGE_LENSING_P95_ABOVE_CEILING");
  }
  if (blur.blur_radius_px > (options.blurRadiusCeilingPx ?? 4.0)) {
    failures.push("G3_BLUR_RADIUS_ABOVE_CEILING");
  }
  if (fringe.chromatic_fringe_px > (options.chromaticFringeCeilingPx ?? 1.5)) {
    failures.push("G3_CHROMATIC_FRINGE_ABOVE_CEILING");
  }
  if (highlight.sample_count === 0) failures.push("G3_HIGHLIGHT_MASK_EMPTY");
  if (!highlight.mismatch.centroid_valid) failures.push("G3_HIGHLIGHT_CENTROID_UNIDENTIFIED");
  if (highlight.mismatch.centroid_drift_px > highlight.policy.center_drift_ceiling_px) {
    failures.push("G3_HIGHLIGHT_CENTROID_DRIFT_ABOVE_CEILING");
  }
  if (highlight.mismatch.width_delta_px > highlight.policy.width_delta_ceiling_px) {
    failures.push("G3_HIGHLIGHT_WIDTH_DELTA_ABOVE_CEILING");
  }
  if (highlight.mismatch.intensity_delta_evaluated && highlight.mismatch.intensity_delta > highlight.policy.intensity_delta_ceiling) {
    failures.push("G3_HIGHLIGHT_INTENSITY_DELTA_ABOVE_CEILING");
  }
  if (highlight.policy.sdr_clip_detected && highlight.policy.require_edr_for_clipped_highlight) {
    failures.push("G3_HIGHLIGHT_SDR_CLIP_REQUIRES_EDR");
  }
  if (highlight.policy.sdr_clip_tolerated) {
    warnings.push("G3_HIGHLIGHT_INTENSITY_DELTA_CLIP_TOLERATED");
  }

  return {
    schema_version: "1.2.0",
    kind: "g3_optics_report",
    gate: "G3",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    warnings,
    dimensions: {
      width,
      height
    },
    mask_scope: options.maskScope ?? {
      source: "edge_band_inferred_from_residual_v0",
      sample_count: edgeBand.sample_count
    },
    method_notes: [
      edgeBand.method === "fixed_scene_mask_pack_v1"
        ? "Edge band is read from the fixed scene mask pack."
        : "Edge band is inferred from reference gradient and residual energy because no fixed mask was provided.",
      "Blur radius is a high-frequency falloff proxy, not an optical PSF fit.",
      "Highlight centroid and width stay load-bearing under SDR clip; intensity delta is either EDR-required or explicitly tolerated."
    ],
    edge_band: edgeBandReport,
    metrics: {
      edge_lensing: lensing,
      blur,
      chromatic_fringe: fringe,
      highlight,
      highlight_residual: highlightResidual,
      inner_shadow: innerShadow,
      alpha_tint_separation: alphaTint
    }
  };
}

function fixedEdgeBand(indexes, refLuma, residual, width, height) {
  let residualAbsSum = 0;
  let gradientSum = 0;
  const active = uniqueValidIndexes(indexes, width * height);
  for (const index of active) {
    const x = index % width;
    const y = Math.floor(index / width);
    let gradient = 0;
    if (x > 0 && y > 0 && x < width - 1 && y < height - 1) {
      const gx = refLuma[index + 1] - refLuma[index - 1];
      const gy = refLuma[index + width] - refLuma[index - width];
      gradient = Math.hypot(gx, gy);
    }
    residualAbsSum += Math.abs(residual[index]);
    gradientSum += gradient;
  }
  return {
    method: "fixed_scene_mask_pack_v1",
    sample_count: active.length,
    coverage_ratio: active.length / (width * height),
    threshold: null,
    mean_reference_gradient: active.length === 0 ? 0 : gradientSum / active.length,
    mean_abs_residual: active.length === 0 ? 0 : residualAbsSum / active.length,
    indexes: active
  };
}

function uniqueValidIndexes(indexes, pixelCount) {
  return [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < pixelCount)
    .sort((left, right) => left - right);
}

export function flattenOpticsReport(report) {
  if (!report.metrics) return {};
  return {
    edge_lensing_mean_dx_px: report.metrics.edge_lensing.vector_field.mean_dx_px,
    edge_lensing_mean_dy_px: report.metrics.edge_lensing.vector_field.mean_dy_px,
    edge_lensing_p95_magnitude_px: report.metrics.edge_lensing.vector_field.p95_magnitude_px,
    blur_radius_px: report.metrics.blur.blur_radius_px,
    high_frequency_ratio: report.metrics.blur.high_frequency_ratio,
    chromatic_fringe_px: report.metrics.chromatic_fringe.chromatic_fringe_px,
    chromatic_delta_mean: report.metrics.chromatic_fringe.chromatic_delta_mean,
    highlight_centroid_drift_px: report.metrics.highlight.mismatch.centroid_drift_px,
    highlight_width_delta_px: report.metrics.highlight.mismatch.width_delta_px,
    highlight_intensity_delta: report.metrics.highlight.mismatch.intensity_delta,
    highlight_intensity_delta_evaluated: report.metrics.highlight.mismatch.intensity_delta_evaluated,
    highlight_reference_intensity_max: report.metrics.highlight.reference.intensity_max,
    highlight_candidate_intensity_max: report.metrics.highlight.candidate.intensity_max,
    highlight_candidate_sdr_clip_fraction: report.metrics.highlight.candidate.sdr_clip_fraction,
    inner_shadow_intensity_max: report.metrics.inner_shadow.intensity_max,
    inner_shadow_width_px: report.metrics.inner_shadow.width_px,
    alpha_proxy_mean: report.metrics.alpha_tint_separation.alpha_proxy_mean,
    tint_chroma_mean: report.metrics.alpha_tint_separation.tint_chroma_mean
  };
}

function inferEdgeBand(refLuma, residual, width, height, options) {
  const gradient = new Float64Array(width * height);
  const energy = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx = refLuma[index + 1] - refLuma[index - 1];
      const gy = refLuma[index + width] - refLuma[index - width];
      const value = Math.hypot(gx, gy);
      gradient[index] = value;
      energy.push(value + Math.abs(residual[index]) * 0.5);
    }
  }

  const threshold = Math.max(
    options.edgeEnergyFloor ?? 0.002,
    quantile(energy, options.edgeQuantile ?? 0.84)
  );
  const indexes = [];
  let residualAbsSum = 0;
  let gradientSum = 0;
  for (let index = 0; index < gradient.length; index += 1) {
    if (gradient[index] + Math.abs(residual[index]) * 0.5 >= threshold) {
      indexes.push(index);
      residualAbsSum += Math.abs(residual[index]);
      gradientSum += gradient[index];
    }
  }

  return {
    method: "reference_gradient_plus_residual_energy",
    sample_count: indexes.length,
    coverage_ratio: indexes.length / (width * height),
    threshold,
    mean_reference_gradient: indexes.length === 0 ? 0 : gradientSum / indexes.length,
    mean_abs_residual: indexes.length === 0 ? 0 : residualAbsSum / indexes.length,
    indexes
  };
}

function measureLensing(refLuma, candLuma, edgeBand, width, height, options) {
  const radius = options.searchRadiusPx ?? 2;
  const vectors = [];
  const step = Math.max(1, Math.floor(edgeBand.indexes.length / 800));
  for (let cursor = 0; cursor < edgeBand.indexes.length; cursor += step) {
    const index = edgeBand.indexes[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < radius || y < radius || x >= width - radius || y >= height - radius) continue;

    let bestDx = 0;
    let bestDy = 0;
    let bestError = Infinity;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const error = patchError(refLuma, candLuma, width, height, x, y, dx, dy);
        if (error < bestError) {
          bestError = error;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    vectors.push({ dx: bestDx, dy: bestDy, magnitude: Math.hypot(bestDx, bestDy), error: bestError });
  }

  return {
    method: "local_luma_patch_search",
    search_radius_px: radius,
    vector_field: summarizeVectors(vectors)
  };
}

function patchError(refLuma, candLuma, width, height, x, y, dx, dy) {
  let error = 0;
  let count = 0;
  for (let py = -1; py <= 1; py += 1) {
    for (let px = -1; px <= 1; px += 1) {
      const refIndex = (y + py) * width + (x + px);
      const cx = Math.max(0, Math.min(width - 1, x + px + dx));
      const cy = Math.max(0, Math.min(height - 1, y + py + dy));
      const candIndex = cy * width + cx;
      error += Math.abs(refLuma[refIndex] - candLuma[candIndex]);
      count += 1;
    }
  }
  return error / count;
}

function summarizeVectors(vectors) {
  if (vectors.length === 0) {
    return {
      sample_count: 0,
      mean_dx_px: 0,
      mean_dy_px: 0,
      mean_magnitude_px: 0,
      p95_magnitude_px: 0,
      max_magnitude_px: 0
    };
  }

  let dxSum = 0;
  let dySum = 0;
  let magnitudeSum = 0;
  const magnitudes = [];
  for (const vector of vectors) {
    dxSum += vector.dx;
    dySum += vector.dy;
    magnitudeSum += vector.magnitude;
    magnitudes.push(vector.magnitude);
  }

  return {
    sample_count: vectors.length,
    mean_dx_px: dxSum / vectors.length,
    mean_dy_px: dySum / vectors.length,
    mean_magnitude_px: magnitudeSum / vectors.length,
    p95_magnitude_px: quantile(magnitudes, 0.95),
    max_magnitude_px: Math.max(...magnitudes)
  };
}

function measureBlurFalloff(refLuma, candLuma, edgeBand, width, height) {
  let refHigh = 0;
  let candHigh = 0;
  let count = 0;
  for (const index of edgeBand.indexes) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
    refHigh += laplacianAbs(refLuma, width, x, y);
    candHigh += laplacianAbs(candLuma, width, x, y);
    count += 1;
  }

  const ratio = refHigh <= 0 ? 1 : candHigh / refHigh;
  return {
    method: "edge_band_laplacian_frequency_falloff",
    sample_count: count,
    reference_high_frequency_energy: count === 0 ? 0 : refHigh / count,
    candidate_high_frequency_energy: count === 0 ? 0 : candHigh / count,
    high_frequency_ratio: ratio,
    blur_radius_px: Math.max(0, 1 - ratio) * 4
  };
}

function laplacianAbs(values, width, x, y) {
  const center = values[y * width + x] * 4;
  const neighbors = values[y * width + x - 1] + values[y * width + x + 1] +
    values[(y - 1) * width + x] + values[(y + 1) * width + x];
  return Math.abs(center - neighbors);
}

function measureChromaticFringe(referencePixels, candidatePixels, edgeBand, width, height) {
  let redWeightedX = 0;
  let blueWeightedX = 0;
  let redWeight = 0;
  let blueWeight = 0;
  let channelDeltaSum = 0;
  let count = 0;

  for (const index of edgeBand.indexes) {
    const offset = index * 4;
    const x = index % width;
    const redDelta = Math.abs(candidatePixels[offset] - referencePixels[offset]) / 255;
    const greenDelta = Math.abs(candidatePixels[offset + 1] - referencePixels[offset + 1]) / 255;
    const blueDelta = Math.abs(candidatePixels[offset + 2] - referencePixels[offset + 2]) / 255;
    redWeightedX += x * redDelta;
    blueWeightedX += x * blueDelta;
    redWeight += redDelta;
    blueWeight += blueDelta;
    channelDeltaSum += Math.max(redDelta, blueDelta) - greenDelta;
    count += 1;
  }

  const validFringeOffset = redWeight > 0 && blueWeight > 0;
  const redCenter = redWeight === 0 ? 0 : redWeightedX / redWeight;
  const blueCenter = blueWeight === 0 ? 0 : blueWeightedX / blueWeight;
  return {
    method: "edge_band_channel_residual_centroid",
    sample_count: count,
    positional_offset_valid: validFringeOffset,
    red_residual_center_x_px: redCenter,
    blue_residual_center_x_px: blueCenter,
    chromatic_fringe_px: validFringeOffset ? Math.abs(redCenter - blueCenter) : 0,
    chromatic_delta_mean: count === 0 ? 0 : channelDeltaSum / count
  };
}

function measureHighlightMismatch(refLuma, candLuma, referencePixels, candidatePixels, indexes, width, height, options) {
  const reference = measureHighlightStats(refLuma, referencePixels, indexes, width, height);
  const candidate = measureHighlightStats(candLuma, candidatePixels, indexes, width, height);
  const clipTolerance = options.highlightSdrClipTolerance ?? 0.01;
  const sdrClipDetected = Math.max(reference.sdr_clip_fraction, candidate.sdr_clip_fraction) > clipTolerance;
  const requireEdr = options.requireEdrForClippedHighlight === true;
  const intensityDeltaEvaluated = !sdrClipDetected || requireEdr;
  const intensityDelta = Math.abs(candidate.intensity_max - reference.intensity_max);
  const centroidValid = reference.active_sample_count > 0 && candidate.active_sample_count > 0;

  return {
    method: "fixed_highlight_mask_luma_distribution_v1",
    sample_count: indexes.length,
    mask_scope: options.highlightMaskScope ?? null,
    policy: {
      center_drift_ceiling_px: options.highlightCenterDriftCeilingPx ?? 8,
      width_delta_ceiling_px: options.highlightWidthDeltaCeilingPx ?? 8,
      intensity_delta_ceiling: options.highlightIntensityDeltaCeiling ?? 0.35,
      sdr_clip_fraction_tolerance: clipTolerance,
      sdr_clip_detected: sdrClipDetected,
      sdr_clip_tolerated: sdrClipDetected && !requireEdr,
      require_edr_for_clipped_highlight: requireEdr
    },
    reference,
    candidate,
    mismatch: {
      centroid_valid: centroidValid,
      centroid_drift_px: centroidValid ? Math.hypot(candidate.center_x_px - reference.center_x_px, candidate.center_y_px - reference.center_y_px) : 0,
      width_delta_px: Math.abs(candidate.width_px - reference.width_px),
      intensity_delta: intensityDelta,
      intensity_delta_evaluated: intensityDeltaEvaluated,
      intensity_delta_status: intensityDeltaEvaluated ? "evaluated" : "sdr_clip_tolerated"
    }
  };
}

function measureHighlightStats(luma, pixels, indexes, width, height) {
  const values = indexes.map((index) => luma[index]);
  const baseline = quantile(values, 0.5);
  let weightSum = 0;
  let xSum = 0;
  let ySum = 0;
  let intensitySum = 0;
  let intensityMax = 0;
  let activeSampleCount = 0;
  let clipCount = 0;

  for (const index of indexes) {
    const value = luma[index];
    const weight = Math.max(0, value - baseline);
    const offset = index * 4;
    const clipped = pixels[offset] >= 254 || pixels[offset + 1] >= 254 || pixels[offset + 2] >= 254;
    const x = index % width;
    const y = Math.floor(index / width);
    intensitySum += value;
    intensityMax = Math.max(intensityMax, value);
    if (clipped) clipCount += 1;
    if (weight <= 0) continue;
    activeSampleCount += 1;
    weightSum += weight;
    xSum += x * weight;
    ySum += y * weight;
  }

  if (indexes.length === 0 || weightSum === 0) {
    return {
      sample_count: indexes.length,
      active_sample_count: activeSampleCount,
      center_x_px: 0,
      center_y_px: 0,
      width_px: 0,
      intensity_mean: indexes.length === 0 ? 0 : intensitySum / indexes.length,
      intensity_max: intensityMax,
      sdr_clip_fraction: indexes.length === 0 ? 0 : clipCount / indexes.length,
      baseline_luma: baseline
    };
  }

  const centerX = xSum / weightSum;
  const centerY = ySum / weightSum;
  let variance = 0;
  for (const index of indexes) {
    const value = luma[index];
    const weight = Math.max(0, value - baseline);
    if (weight <= 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    variance += weight * ((x - centerX) ** 2 + (y - centerY) ** 2);
  }

  return {
    sample_count: indexes.length,
    active_sample_count: activeSampleCount,
    center_x_px: centerX,
    center_y_px: centerY,
    width_px: Math.sqrt(variance / weightSum),
    intensity_mean: intensitySum / indexes.length,
    intensity_max: intensityMax,
    sdr_clip_fraction: clipCount / indexes.length,
    baseline_luma: baseline
  };
}

function measureSignedResidualBlob(residual, width, height, sign) {
  const values = [];
  let weightSum = 0;
  let xSum = 0;
  let ySum = 0;
  let max = 0;
  let clipCount = 0;
  for (let index = 0; index < residual.length; index += 1) {
    const value = residual[index] * sign;
    if (value <= 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    values.push({ x, y, value });
    weightSum += value;
    xSum += x * value;
    ySum += y * value;
    max = Math.max(max, value);
    if (value > 0.98) clipCount += 1;
  }

  if (weightSum === 0) {
    return {
      method: sign > 0 ? "positive_luma_residual_blob" : "negative_luma_residual_blob",
      sample_count: 0,
      center_x_px: 0,
      center_y_px: 0,
      width_px: 0,
      intensity_mean: 0,
      intensity_max: 0,
      sdr_clip_fraction: 0
    };
  }

  const centerX = xSum / weightSum;
  const centerY = ySum / weightSum;
  let variance = 0;
  for (const value of values) {
    variance += value.value * ((value.x - centerX) ** 2 + (value.y - centerY) ** 2);
  }

  return {
    method: sign > 0 ? "positive_luma_residual_blob" : "negative_luma_residual_blob",
    sample_count: values.length,
    center_x_px: centerX,
    center_y_px: centerY,
    width_px: Math.sqrt(variance / weightSum),
    intensity_mean: weightSum / values.length,
    intensity_max: max,
    sdr_clip_fraction: values.length === 0 ? 0 : clipCount / values.length
  };
}

function measureAlphaTintSeparation(refOklab, candOklab, residual, edgeBand) {
  let alphaProxySum = 0;
  let chromaSum = 0;
  let count = 0;
  for (const index of edgeBand.indexes) {
    const ref = refOklab[index];
    const cand = candOklab[index];
    alphaProxySum += Math.abs(residual[index]);
    chromaSum += Math.hypot(cand.a - ref.a, cand.b - ref.b);
    count += 1;
  }

  return {
    method: "oklab_luma_chroma_residual_split",
    sample_count: count,
    alpha_proxy_mean: count === 0 ? 0 : alphaProxySum / count,
    tint_chroma_mean: count === 0 ? 0 : chromaSum / count,
    tint_to_alpha_ratio: alphaProxySum === 0 ? 0 : chromaSum / alphaProxySum
  };
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
