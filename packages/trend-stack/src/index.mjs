const trendLimitDefault = 30;

export function buildTrendReport({ reports, generatedAt = new Date().toISOString(), limit = trendLimitDefault } = {}) {
  const observations = (reports ?? [])
    .map((entry, index) => normalizeReport(entry.report ?? entry, {
      path: entry.path,
      index
    }))
    .filter(Boolean)
    .sort(compareRecords);
  const normalized = mergeRunRecords(observations).sort(compareRecords);
  const validRuns = normalized.filter((record) => record.valid_for_trend);
  const lastValidRuns = validRuns.slice(-limit);
  const failures = [];

  if (observations.length === 0) failures.push("TREND_REPORT_INPUT_REQUIRED");
  if (lastValidRuns.length === 0) failures.push("TREND_REPORT_VALID_RUNS_REQUIRED");

  return {
    schema_version: "1.2.0",
    kind: "trend_report",
    status: failures.length === 0 ? "pass" : "fail",
    generated_at: generatedAt,
    failures,
    policy: {
      last_valid_run_limit: limit,
      valid_run_rule: "exclude INVALID verdicts and INFRA_FLAKE runs",
      slope_method: "ordinary_least_squares_over_sequence_index"
    },
    source_counts: countBy(observations, (record) => record.source_kind),
    run_counts: {
      input: observations.length,
      grouped: normalized.length,
      valid: validRuns.length,
      last_valid: lastValidRuns.length
    },
    trends: {
      per_gate: gateTrends(lastValidRuns),
      per_device: bucketStatus(lastValidRuns, (record) => record.device.model_identifier ?? "unknown"),
      per_ios_build: bucketStatus(lastValidRuns, (record) => record.device.os_build ?? "unknown"),
      visual_loss: metricTrend(lastValidRuns, "visual_loss"),
      runtime_cost_ms: metricTrend(lastValidRuns, "runtime_cost_ms"),
      energy_cost: metricTrend(lastValidRuns, "energy_cost"),
      flake_rate: flakeTrend(lastValidRuns)
    },
    last_30_valid_runs: lastValidRuns.map(publicRunRecord)
  };
}

export function normalizeReport(report, { path = "", index = 0 } = {}) {
  if (!report || typeof report !== "object") return null;
  const kind = report.kind ?? "unknown_report";
  const generatedAt = report.generated_at ?? report.generatedAt ?? null;
  const common = {
    source_kind: kind,
    input_path: path,
    input_index: index,
    generated_at: generatedAt,
    sort_key: generatedAt ? Date.parse(generatedAt) : index,
    run_id: report.run_id ?? report.id ?? report.artifact?.id ?? report.candidate?.id ?? report.head_sha ?? `${kind}:${index}`,
    status: report.status ?? "unknown",
    verdict_class: report.verdict_class ?? null,
    technical_class: report.technical_class ?? null,
    flake_class: report.flake_class ?? report.gates?.flake_class ?? "NONE",
    device: deviceFromReport(report),
    gates: gatesFromReport(report),
    metrics: metricsFromReport(report)
  };
  return {
    ...common,
    valid_for_trend: common.verdict_class !== "INVALID" && common.flake_class !== "INFRA_FLAKE"
  };
}

function mergeRunRecords(observations) {
  const byRun = new Map();
  for (const observation of observations) {
    const key = observation.run_id;
    if (!byRun.has(key)) {
      byRun.set(key, {
        ...observation,
        source_kinds: [observation.source_kind],
        input_paths: observation.input_path ? [observation.input_path] : []
      });
      continue;
    }

    const current = byRun.get(key);
    const merged = {
      ...current,
      source_kind: `${current.source_kind}+${observation.source_kind}`,
      source_kinds: [...current.source_kinds, observation.source_kind],
      input_paths: observation.input_path ? [...current.input_paths, observation.input_path] : current.input_paths,
      sort_key: Math.max(current.sort_key, observation.sort_key),
      generated_at: laterTimestamp(current.generated_at, observation.generated_at),
      status: mergeStatus(current.status, observation.status),
      verdict_class: observation.verdict_class ?? current.verdict_class,
      technical_class: observation.technical_class ?? current.technical_class,
      flake_class: mergeFlakeClass(current.flake_class, observation.flake_class),
      device: fillDevice(current.device, observation.device),
      gates: {
        ...current.gates,
        ...observation.gates
      },
      metrics: mergeMetrics(current.metrics, observation.metrics)
    };
    merged.valid_for_trend = merged.verdict_class !== "INVALID" && merged.flake_class !== "INFRA_FLAKE";
    byRun.set(key, merged);
  }
  return [...byRun.values()];
}

function metricsFromReport(report) {
  const trend = report.trend_metrics ?? report.trend ?? {};
  if (report.kind === "solver_pareto_report") {
    const objectives = report.selected_candidate?.objectives ?? {};
    return {
      visual_loss: finiteOrNull(objectives.loss_total ?? trend.visual_loss),
      runtime_cost_ms: finiteOrNull(objectives.runtime_cost_ms ?? trend.runtime_cost_ms),
      energy_cost: finiteOrNull(objectives.energy_cost ?? trend.energy_cost)
    };
  }
  if (report.kind === "g2_metric_report") {
    return {
      visual_loss: finiteOrNull(
        report.metrics?.perception?.flip_style_error_mean ??
        report.metrics?.color?.oklab_delta_e_mean ??
        trend.visual_loss
      ),
      runtime_cost_ms: null,
      energy_cost: null
    };
  }
  if (report.kind === "g5_runtime_report") {
    return {
      visual_loss: null,
      runtime_cost_ms: finiteOrNull(report.metrics?.runtime?.full_frame_ms_p95 ?? trend.runtime_cost_ms),
      energy_cost: null
    };
  }
  if (report.kind === "g6_energy_report") {
    return {
      visual_loss: null,
      runtime_cost_ms: null,
      energy_cost: finiteOrNull(
        report.metrics?.energy?.energy_mj_per_10s ??
        report.metrics?.energy?.average_power_mw ??
        report.metrics?.sustained?.degradation_pct ??
        trend.energy_cost
      )
    };
  }
  return {
    visual_loss: finiteOrNull(trend.visual_loss),
    runtime_cost_ms: finiteOrNull(trend.runtime_cost_ms),
    energy_cost: finiteOrNull(trend.energy_cost)
  };
}

function gatesFromReport(report) {
  if (report.gates && typeof report.gates === "object") return { ...report.gates };
  if (typeof report.gate === "string") return { [report.gate]: report.status ?? "unknown" };
  return {};
}

function deviceFromReport(report) {
  const device = report.device ?? report.artifact?.device ?? report.candidate?.device ?? {};
  return {
    model_name: device.model_name ?? null,
    model_identifier: device.model_identifier ?? null,
    os_build: device.os_build ?? null,
    sdk_build: device.sdk_build ?? null
  };
}

function gateTrends(records) {
  const gateIds = new Set();
  for (const record of records) {
    for (const gate of Object.keys(record.gates)) gateIds.add(gate);
  }
  const result = {};
  for (const gate of [...gateIds].sort()) {
    const values = records
      .map((record) => record.gates[gate])
      .filter((value) => value !== undefined);
    result[gate] = statusSummary(values);
  }
  return result;
}

function bucketStatus(records, keyFn) {
  const buckets = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record.status);
  }
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [
    key,
    statusSummary(values)
  ]));
}

function metricTrend(records, metric) {
  const points = records
    .map((record, index) => ({ index, value: record.metrics[metric] }))
    .filter((point) => Number.isFinite(point.value));
  return {
    count: points.length,
    latest: points.length > 0 ? points[points.length - 1].value : null,
    min: points.length > 0 ? Math.min(...points.map((point) => point.value)) : null,
    max: points.length > 0 ? Math.max(...points.map((point) => point.value)) : null,
    slope_per_run: slope(points),
    direction: direction(slope(points))
  };
}

function flakeTrend(records) {
  const points = records.map((record, index) => ({
    index,
    value: record.flake_class === "NONE" ? 0 : 1
  }));
  const rate = points.length === 0 ? null : points.reduce((total, point) => total + point.value, 0) / points.length;
  const trendSlope = slope(points);
  return {
    count: points.length,
    rate,
    slope_per_run: trendSlope,
    direction: direction(trendSlope)
  };
}

function statusSummary(values) {
  const counts = countBy(values, (value) => String(value ?? "unknown"));
  const failCount = Object.entries(counts)
    .filter(([status]) => status !== "pass" && status !== "NONE" && status !== "not_required")
    .reduce((total, [, count]) => total + count, 0);
  return {
    count: values.length,
    pass_count: counts.pass ?? 0,
    fail_count: failCount,
    statuses: counts
  };
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function mergeMetrics(left, right) {
  return {
    visual_loss: firstFinite(left.visual_loss, right.visual_loss),
    runtime_cost_ms: firstFinite(left.runtime_cost_ms, right.runtime_cost_ms),
    energy_cost: firstFinite(left.energy_cost, right.energy_cost)
  };
}

function firstFinite(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function fillDevice(left, right) {
  return {
    model_name: left.model_name ?? right.model_name ?? null,
    model_identifier: left.model_identifier ?? right.model_identifier ?? null,
    os_build: left.os_build ?? right.os_build ?? null,
    sdk_build: left.sdk_build ?? right.sdk_build ?? null
  };
}

function mergeStatus(left, right) {
  if (left === "fail" || right === "fail") return "fail";
  if (left === "pass" || right === "pass") return "pass";
  return right ?? left ?? "unknown";
}

function mergeFlakeClass(left, right) {
  const order = ["NONE", "UNKNOWN", "METRIC_NOISE", "PRODUCT_REGRESSION", "INFRA_FLAKE"];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  return order[Math.max(leftIndex, rightIndex, 0)];
}

function laterTimestamp(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function slope(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((total, point) => total + point.index, 0) / n;
  const meanY = points.reduce((total, point) => total + point.value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.index - meanX) * (point.value - meanY);
    denominator += (point.index - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function direction(value) {
  if (value === null) return "insufficient_data";
  if (Math.abs(value) < 1e-9) return "flat";
  return value > 0 ? "up" : "down";
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareRecords(left, right) {
  const leftKey = Number.isFinite(left.sort_key) ? left.sort_key : left.input_index;
  const rightKey = Number.isFinite(right.sort_key) ? right.sort_key : right.input_index;
  return leftKey - rightKey || left.input_index - right.input_index;
}

function publicRunRecord(record) {
  return {
    run_id: record.run_id,
    source_kind: record.source_kind,
    source_kinds: record.source_kinds ?? [record.source_kind],
    input_paths: record.input_paths ?? [record.input_path].filter(Boolean),
    generated_at: record.generated_at,
    status: record.status,
    verdict_class: record.verdict_class,
    technical_class: record.technical_class,
    flake_class: record.flake_class,
    device: record.device,
    gates: record.gates,
    metrics: record.metrics
  };
}
