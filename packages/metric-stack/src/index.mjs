import {
  colorPipelineContract,
  displayP3LinearLuminance,
  linearDisplayP3ToOklab,
  oklabDelta,
  rgbaByteToLinearDisplayP3
} from "../../color-pipeline/src/index.mjs";

const ssimConstants = Object.freeze({
  c1: 0.01 ** 2,
  c2: 0.03 ** 2
});

const msSsimWeights = Object.freeze([0.0448, 0.2856, 0.3001, 0.2363, 0.1333]);

export function compareMetricImages(reference, candidate, options = {}) {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return {
      schema_version: "1.2.0",
      kind: "g2_metric_report",
      gate: "G2",
      status: "fail",
      failures: ["DIMENSION_MISMATCH"],
      dimensions: {
        reference_width: reference.width,
        reference_height: reference.height,
        candidate_width: candidate.width,
        candidate_height: candidate.height
      },
      color_pipeline: makeColorPipelineBlock(options)
    };
  }

  const width = reference.width;
  const height = reference.height;
  const pixelCount = width * height;
  const activeIndexes = normalizeMaskIndexes(options.maskIndexes, pixelCount);
  const activeCount = activeIndexes.length;
  const refLuma = new Float64Array(pixelCount);
  const candLuma = new Float64Array(pixelCount);
  const oklabDeltas = new Float64Array(pixelCount);
  const activeOklabDeltas = new Float64Array(activeCount);
  const activeFlipErrors = new Float64Array(activeCount);

  let maxAbsChannelDelta = 0;
  let sumAbsChannelDelta = 0;
  let sumOklabDelta = 0;
  let maxOklabDelta = 0;

  const activeSet = new Set(activeIndexes);
  let activeCursor = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const dr = Math.abs(reference.pixels[offset] - candidate.pixels[offset]);
    const dg = Math.abs(reference.pixels[offset + 1] - candidate.pixels[offset + 1]);
    const db = Math.abs(reference.pixels[offset + 2] - candidate.pixels[offset + 2]);

    const refP3 = rgbaByteToLinearDisplayP3(reference.pixels, offset);
    const candP3 = rgbaByteToLinearDisplayP3(candidate.pixels, offset);
    refLuma[pixel] = displayP3LinearLuminance(refP3);
    candLuma[pixel] = displayP3LinearLuminance(candP3);

    const delta = oklabDelta(linearDisplayP3ToOklab(refP3), linearDisplayP3ToOklab(candP3));
    oklabDeltas[pixel] = delta;
    if (!activeSet.has(pixel)) continue;
    maxAbsChannelDelta = Math.max(maxAbsChannelDelta, dr, dg, db);
    sumAbsChannelDelta += dr + dg + db;
    sumOklabDelta += delta;
    maxOklabDelta = Math.max(maxOklabDelta, delta);
    activeOklabDeltas[activeCursor] = delta;
    activeCursor += 1;
  }

  let gradientResidualSum = 0;
  let gradientResidualCount = 0;
  let flipSum = 0;
  let flipMax = 0;

  for (let index = 0; index < activeIndexes.length; index += 1) {
    const pixel = activeIndexes[index];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const gradientResidual = localGradientResidual(refLuma, candLuma, width, height, x, y);
    const flipError = oklabDeltas[pixel] + 0.25 * gradientResidual;
    activeFlipErrors[index] = flipError;
    flipSum += flipError;
    flipMax = Math.max(flipMax, flipError);

    if (x + 1 < width && activeSet.has(pixel + 1)) {
      gradientResidualSum += Math.abs(
        Math.abs(refLuma[pixel] - refLuma[pixel + 1]) -
          Math.abs(candLuma[pixel] - candLuma[pixel + 1])
      );
      gradientResidualCount += 1;
    }
    if (y + 1 < height && activeSet.has(pixel + width)) {
      gradientResidualSum += Math.abs(
        Math.abs(refLuma[pixel] - refLuma[pixel + width]) -
          Math.abs(candLuma[pixel] - candLuma[pixel + width])
      );
      gradientResidualCount += 1;
    }
  }

  const ssim = computeSsim(refLuma, candLuma, activeIndexes);
  const msSsim = options.maskIndexes ? ssim : computeMsSsim(refLuma, candLuma, width, height);
  const failures = [];
  if (ssim < (options.ssimFloor ?? 0.995)) failures.push("G2_SSIM_BELOW_FLOOR");
  if (msSsim < (options.msSsimFloor ?? 0.995)) failures.push("G2_MS_SSIM_BELOW_FLOOR");
  if (sumOklabDelta / activeCount > (options.oklabMeanCeiling ?? 0.003)) {
    failures.push("G2_OKLAB_MEAN_ABOVE_CEILING");
  }
  if (flipSum / activeCount > (options.flipMeanCeiling ?? 0.004)) {
    failures.push("G2_FLIP_STYLE_MEAN_ABOVE_CEILING");
  }

  return {
    schema_version: "1.2.0",
    kind: "g2_metric_report",
    gate: "G2",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    dimensions: {
      width,
      height
    },
    color_pipeline: makeColorPipelineBlock(options),
    mask_scope: options.maskScope ?? {
      source: "whole_frame_fallback",
      sample_count: activeCount
    },
    metrics: {
      pixel_debug: {
        max_abs_channel_delta: maxAbsChannelDelta,
        mean_abs_channel_delta: sumAbsChannelDelta / (activeCount * 3)
      },
      color: {
        oklab_delta_e_mean: sumOklabDelta / activeCount,
        oklab_delta_e_p95: percentile(activeOklabDeltas, 0.95),
        oklab_delta_e_p99: percentile(activeOklabDeltas, 0.99),
        oklab_delta_e_max: maxOklabDelta
      },
      structure: {
        ssim,
        ms_ssim: msSsim
      },
      perception: {
        metric_id: "flip_style_linear_p3_v0",
        flip_style_error_mean: flipSum / activeCount,
        flip_style_error_p95: percentile(activeFlipErrors, 0.95),
        flip_style_error_p99: percentile(activeFlipErrors, 0.99),
        flip_style_error_max: flipMax
      },
      gradient: {
        smoothness_mean_abs_delta:
          gradientResidualCount === 0 ? 0 : gradientResidualSum / gradientResidualCount
      }
    }
  };
}

export function flattenMetricReport(report) {
  if (!report.metrics) return {};
  return {
    oklab_delta_e_mean: report.metrics.color.oklab_delta_e_mean,
    oklab_delta_e_p95: report.metrics.color.oklab_delta_e_p95,
    oklab_delta_e_p99: report.metrics.color.oklab_delta_e_p99,
    oklab_delta_e_max: report.metrics.color.oklab_delta_e_max,
    ssim: report.metrics.structure.ssim,
    ms_ssim: report.metrics.structure.ms_ssim,
    flip_style_error_mean: report.metrics.perception.flip_style_error_mean,
    flip_style_error_p95: report.metrics.perception.flip_style_error_p95,
    flip_style_error_p99: report.metrics.perception.flip_style_error_p99,
    flip_style_error_max: report.metrics.perception.flip_style_error_max,
    gradient_smoothness_mean_abs_delta: report.metrics.gradient.smoothness_mean_abs_delta,
    max_abs_channel_delta: report.metrics.pixel_debug.max_abs_channel_delta,
    mean_abs_channel_delta: report.metrics.pixel_debug.mean_abs_channel_delta
  };
}

export function summarizeMetricSeries(values) {
  if (values.length === 0) {
    return {
      count: 0
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    mean: sum / sorted.length,
    p50: quantileSorted(sorted, 0.5),
    p95: quantileSorted(sorted, 0.95),
    p99: quantileSorted(sorted, 0.99),
    max: sorted[sorted.length - 1]
  };
}

function makeColorPipelineBlock(options) {
  return {
    stored_transfer: colorPipelineContract.storedTransfer,
    working_space: colorPipelineContract.workingSpace,
    comparison_space: "OKLab over Display P3 D65",
    perceptual_metric_space: "linear Display P3",
    icc_policy: options.iccPolicy ?? "artifact Display P3 ICC required before G2 trust"
  };
}

function localGradientResidual(refLuma, candLuma, width, height, x, y) {
  const left = Math.max(x - 1, 0);
  const right = Math.min(x + 1, width - 1);
  const up = Math.max(y - 1, 0);
  const down = Math.min(y + 1, height - 1);
  const horizontalRef = refLuma[y * width + right] - refLuma[y * width + left];
  const verticalRef = refLuma[down * width + x] - refLuma[up * width + x];
  const horizontalCand = candLuma[y * width + right] - candLuma[y * width + left];
  const verticalCand = candLuma[down * width + x] - candLuma[up * width + x];
  const refMagnitude = Math.hypot(horizontalRef, verticalRef);
  const candMagnitude = Math.hypot(horizontalCand, verticalCand);
  return Math.abs(refMagnitude - candMagnitude);
}

function computeSsim(left, right, indexes = undefined) {
  const active = indexes ?? [...left.keys()];
  let meanLeft = 0;
  let meanRight = 0;
  for (const index of active) {
    meanLeft += left[index];
    meanRight += right[index];
  }
  meanLeft /= active.length;
  meanRight /= active.length;

  let varianceLeft = 0;
  let varianceRight = 0;
  let covariance = 0;
  const denominator = Math.max(active.length - 1, 1);
  for (const index of active) {
    const dl = left[index] - meanLeft;
    const dr = right[index] - meanRight;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
    covariance += dl * dr;
  }

  varianceLeft /= denominator;
  varianceRight /= denominator;
  covariance /= denominator;

  const luminance = (2 * meanLeft * meanRight + ssimConstants.c1) /
    (meanLeft * meanLeft + meanRight * meanRight + ssimConstants.c1);
  const contrastStructure = (2 * covariance + ssimConstants.c2) /
    (varianceLeft + varianceRight + ssimConstants.c2);
  return clamp01(luminance * contrastStructure);
}

function normalizeMaskIndexes(maskIndexes, pixelCount) {
  if (!Array.isArray(maskIndexes) || maskIndexes.length === 0) {
    return Array.from({ length: pixelCount }, (_, index) => index);
  }
  const normalized = [...new Set(maskIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < pixelCount)
    .sort((left, right) => left - right);
  return normalized.length > 0
    ? normalized
    : Array.from({ length: pixelCount }, (_, index) => index);
}

function computeMsSsim(left, right, width, height) {
  let currentLeft = left;
  let currentRight = right;
  let currentWidth = width;
  let currentHeight = height;
  let product = 1;

  for (let level = 0; level < msSsimWeights.length; level += 1) {
    product *= Math.max(computeSsim(currentLeft, currentRight), 0.000001) ** msSsimWeights[level];
    if (currentWidth < 2 || currentHeight < 2) break;
    const downLeft = downsample2x(currentLeft, currentWidth, currentHeight);
    const downRight = downsample2x(currentRight, currentWidth, currentHeight);
    currentWidth = downLeft.width;
    currentHeight = downLeft.height;
    currentLeft = downLeft.values;
    currentRight = downRight.values;
  }
  return clamp01(product);
}

function downsample2x(values, width, height) {
  const nextWidth = Math.max(1, Math.floor(width / 2));
  const nextHeight = Math.max(1, Math.floor(height / 2));
  const next = new Float64Array(nextWidth * nextHeight);

  for (let y = 0; y < nextHeight; y += 1) {
    for (let x = 0; x < nextWidth; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const sx = Math.min(x0 + dx, width - 1);
          const sy = Math.min(y0 + dy, height - 1);
          sum += values[sy * width + sx];
          count += 1;
        }
      }
      next[y * nextWidth + x] = sum / count;
    }
  }

  return {
    width: nextWidth,
    height: nextHeight,
    values: next
  };
}

function percentile(values, q) {
  const sorted = Float64Array.from(values);
  sorted.sort();
  return quantileSorted(sorted, q);
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return NaN;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
