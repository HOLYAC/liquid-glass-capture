#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lib/lab-artifact.mjs";
import { finalizeCaptureArtifactIntegrity } from "../packages/capture-schema/src/integrity.mjs";
import { sha256Buffer, sha256File, writePng } from "./lib/lab-png.mjs";
import {
  compareMetricImages,
  flattenMetricReport,
  summarizeMetricSeries
} from "../packages/metric-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedRepeat = Object.freeze({
  mvl: 50,
  prod_p99: 300,
  sustained: 24
});
const outlierPolicy = Object.freeze({
  policy_id: "baseline_iqr_mad_outlier_policy_v2",
  method: "iqr_and_modified_z_score",
  minimum_sample_count: 8,
  iqr_multiplier: 1.5,
  normal_consistency_scale: 1.4826,
  max_modified_z: 6,
  zero_spread_behavior: "flag_distinct_values_as_unknown_outliers",
  max_outlier_candidate_rate: 0.05,
  infrastructure_owner: "lab-infra",
  outlier_rate_derivation: "A baseline with more than one statistical outlier candidate per 20 pair-comparisons is measuring rig instability before it is measuring glass.",
  raw_samples_retained: true,
  outlier_candidates_retained: true,
  rejected_samples_retained: true
});
const bootstrapPolicy = Object.freeze({
  policy_id: "baseline_p99_bootstrap_ci_v1",
  statistic: "p99",
  statistic_quantile: 0.99,
  confidence: 0.95,
  iterations: 400,
  seed_namespace: "apple_glass_baseline_metric_report_v1"
});
const thresholdPolicy = Object.freeze({
  policy_id: "baseline_threshold_policy_v1",
  shader_formula: "shader_threshold = instrument_noise_loss_ci95_upper + SHADER_SLACK(metric)",
  webkit_formula: "webkit_threshold = instrument_noise_loss_ci95_upper + WEBKIT_SLACK(metric) * webkit_gap_loss_ci95_upper",
  no_worse_than_webkit_formula: "candidate_loss(R0,C1) <= webkit_gap_loss_ci95_upper",
  webkit_gap_role: "report_only_floor_not_shader_slack",
  shader_threshold_never_borrows_webkit_gap: true,
  owner: "lab-metrics",
  derivation: "v1.2 baseline math: C1 shader gates against R0 instrument noise only; WebKit gap remains observable but cannot loosen shader thresholds."
});
const baselineApprovalPolicy = Object.freeze({
  policy_id: "baseline_owner_approval_policy_v1",
  complete_baseline_requires_owner_approval: true,
  threshold_drift_requires_owner_approval: true,
  approval_id_required_for_complete_baseline: true,
  owner_placeholder: "unassigned",
  derivation: "A complete baseline can change thresholds; plan v1.2 requires baseline owner approval before it becomes final evidence."
});
const baselineFreezePolicy = Object.freeze({
  policy_id: "baseline_freeze_policy_v1",
  hash_algorithm: "sha256",
  hash_scope: "canonical_json_without_baseline_freeze",
  retention_class: "baseline",
  immutable: true,
  derivation: "Baseline JSON is frozen by a canonical content hash before it is stored or compared."
});
const defaultSlack = Object.freeze({
  shader: {
    value: 0,
    owner: "lab-metrics",
    derivation: "No unmeasured visual slack is allowed before a baseline owner signs a per-metric non-zero value."
  },
  webkit: {
    multiplier: 1,
    owner: "lab-metrics",
    derivation: "WebKit threshold is anchored to measured WebKit gap with no hidden multiplier until a baseline owner signs one."
  }
});
const metricThresholdPolicies = Object.freeze({
  oklab_delta_e_mean: metricPolicy("identity", "lower_is_better"),
  oklab_delta_e_p95: metricPolicy("identity", "lower_is_better"),
  oklab_delta_e_p99: metricPolicy("identity", "lower_is_better"),
  oklab_delta_e_max: metricPolicy("identity", "lower_is_better"),
  ssim: metricPolicy("one_minus_value", "higher_is_better"),
  ms_ssim: metricPolicy("one_minus_value", "higher_is_better"),
  flip_style_error_mean: metricPolicy("identity", "lower_is_better"),
  flip_style_error_p95: metricPolicy("identity", "lower_is_better"),
  flip_style_error_p99: metricPolicy("identity", "lower_is_better"),
  flip_style_error_max: metricPolicy("identity", "lower_is_better"),
  gradient_smoothness_mean_abs_delta: metricPolicy("identity", "lower_is_better"),
  max_abs_channel_delta: metricPolicy("identity", "lower_is_better"),
  mean_abs_channel_delta: metricPolicy("identity", "lower_is_better")
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = buildBaselineReport({
      refs: readRepeatManifestPaths(fixture.refManifest),
      probes: readRepeatManifestPaths(fixture.probeManifest),
      out: fixture.out,
      baselineClass: "mvl",
      repeatOverride: 50
    });
    assertOutlierPolicySelfTest();
    assertThresholdPolicySelfTest(report);
    assertBaselineIdentitySelfTest(report);
    assertBaselineApprovalSelfTest(fixture);
    assertBaselineFreezeSelfTest(report);
    console.log(`${report.baseline_status.toUpperCase()} ${fixture.out}`);
    return;
  }

  if (args.refs.length < 2) {
    console.error("usage: node scripts/lab-metrics-baseline.mjs --ref <capture.json> --ref <capture.json> [--probe <capture.json> ...] [--class mvl|prod_p99|sustained] [--owner name --approval id] [--out baseline.json]");
    console.error("       node scripts/lab-metrics-baseline.mjs --self-test [--out baseline.json]");
    process.exit(2);
  }

  const report = buildBaselineReport(args);
  console.log(`${report.baseline_status.toUpperCase()} ${args.out ?? ""}`.trim());
}

export function buildBaselineReport({ refs, probes, out, baselineClass = "mvl", repeatOverride, owner, approvalId }) {
  const referenceRecords = refs.map((path) => readCaptureArtifact(path));
  const probeRecords = probes.map((path) => readCaptureArtifact(path));
  const referenceReports = [];
  const candidateReports = [];

  for (let left = 0; left < referenceRecords.length; left += 1) {
    for (let right = left + 1; right < referenceRecords.length; right += 1) {
      referenceReports.push(makeMetricSample({
        sampleKind: "instrument_noise",
        referenceIndex: left,
        candidateIndex: right,
        referenceRecord: referenceRecords[left],
        candidateRecord: referenceRecords[right],
        metrics: compareRecords(referenceRecords[left], referenceRecords[right])
      }));
    }
  }

  for (let referenceIndex = 0; referenceIndex < referenceRecords.length; referenceIndex += 1) {
    for (let probeIndex = 0; probeIndex < probeRecords.length; probeIndex += 1) {
      candidateReports.push(makeMetricSample({
        sampleKind: "candidate_gap",
        referenceIndex,
        candidateIndex: probeIndex,
        referenceRecord: referenceRecords[referenceIndex],
        candidateRecord: probeRecords[probeIndex],
        metrics: compareRecords(referenceRecords[referenceIndex], probeRecords[probeIndex])
      }));
    }
  }

  const requested = repeatOverride ?? requestedRepeat[baselineClass] ?? requestedRepeat.mvl;
  const baselineIdentity = makeBaselineIdentity(referenceRecords[0], baselineClass);
  const namespace = makeBaselineNamespace(baselineIdentity);
  const instrumentNoise = summarizeReports(referenceReports);
  const candidateGap = summarizeReports(candidateReports);
  const infrastructureHealth = assessInfrastructureHealth(instrumentNoise);
  const thresholdDerivation = buildThresholdDerivation({
    referenceSamples: referenceReports,
    candidateSamples: candidateReports
  });
  const initialBaselineStatus = referenceRecords.length >= requested ? "complete" : "partial";
  const baselineApproval = makeBaselineApproval({
    baselineStatus: initialBaselineStatus,
    baselineClass,
    owner,
    approvalId
  });
  const failures = [
    ...infrastructureHealth.failures,
    ...baselineApproval.failures
  ];
  const baselineStatus = failures.length > 0 ? "invalid" : initialBaselineStatus;
  const report = {
    schema_version: "1.2.0",
    kind: "baseline_metric_report",
    baseline_namespace: namespace,
    baseline_identity: baselineIdentity,
    baseline_class: baselineClass,
    baseline_status: baselineStatus,
    failures,
    repeat_n_requested: requested,
    repeat_n_observed: referenceRecords.length,
    repeat_policy: {
      repeat_n_mvl: requestedRepeat.mvl,
      repeat_n_prod_p99: requestedRepeat.prod_p99,
      repeat_n_sustained: requestedRepeat.sustained,
      final_p99_allowed: baselineClass === "prod_p99" && referenceRecords.length >= requestedRepeat.prod_p99
    },
    gates: {
      G0_G1: "assumed_from_valid_capture_artifacts",
      G2: "computed_static_perception_metrics",
      baseline_infrastructure_health: infrastructureHealth.status,
      G3_G8: "not_run"
    },
    reference_artifacts: referenceRecords.map(artifactIdentity),
    probe_artifacts: probeRecords.map(artifactIdentity),
    instrument_noise: instrumentNoise,
    candidate_gap: candidateGap,
    statistics: {
      outlier_policy: outlierPolicy,
      bootstrap_policy: bootstrapPolicy,
      threshold_policy: thresholdPolicy,
      approval_policy: baselineApprovalPolicy,
      freeze_policy: baselineFreezePolicy,
      infrastructure_health: infrastructureHealth
    },
    threshold_derivation: thresholdDerivation,
    baseline_approval: baselineApproval,
    raw_report_counts: {
      reference_pair_count: referenceReports.length,
      candidate_pair_count: candidateReports.length
    },
    immutability: {
      raw_artifacts_retained: true,
      raw_metric_samples_retained: true,
      outlier_candidates_retained: true,
      rejected_samples_retained: true,
      outlier_rejection: outlierPolicy.policy_id,
      bootstrap_ci: bootstrapPolicy.policy_id,
      threshold_policy: thresholdPolicy.policy_id,
      baseline_owner: baselineApproval.owner
    }
  };
  const frozenReport = freezeBaselineReport(report);

  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(frozenReport, null, 2)}\n`);
  }
  return frozenReport;
}

function compareRecords(reference, candidate) {
  const report = compareMetricImages(reference.png, candidate.png);
  return flattenMetricReport(report);
}

function makeMetricSample({ sampleKind, referenceIndex, candidateIndex, referenceRecord, candidateRecord, metrics }) {
  return {
    sample_id: `${sampleKind}-${referenceIndex}-${candidateIndex}`,
    sample_kind: sampleKind,
    reference_index: referenceIndex,
    candidate_index: candidateIndex,
    reference_artifact: artifactIdentity(referenceRecord),
    candidate_artifact: artifactIdentity(candidateRecord),
    metrics
  };
}

function summarizeReports(samples) {
  if (samples.length === 0) {
    return {
      count: 0,
      raw_samples: [],
      outlier_candidates: [],
      rejected_samples: [],
      metrics: {}
    };
  }

  const keys = Object.keys(samples[0].metrics);
  const metrics = {};
  const outlierCandidates = [];
  const rejectedSamples = [];
  for (const key of keys) {
    const metricSummary = summarizeMetricSamples(samples, key);
    metrics[key] = metricSummary;
    outlierCandidates.push(...metricSummary.outlier_candidates);
    rejectedSamples.push(...metricSummary.rejected_samples);
  }

  return {
    count: samples.length,
    raw_samples: samples.map((sample) => ({
      sample_id: sample.sample_id,
      sample_kind: sample.sample_kind,
      reference_index: sample.reference_index,
      candidate_index: sample.candidate_index,
      reference_artifact: sample.reference_artifact,
      candidate_artifact: sample.candidate_artifact,
      metrics: sample.metrics
    })),
    outlier_candidates: outlierCandidates,
    rejected_samples: rejectedSamples,
    metrics
  };
}

function summarizeMetricSamples(samples, metricId) {
  const metricSamples = samples
    .map((sample) => ({
      sample_id: sample.sample_id,
      sample_kind: sample.sample_kind,
      reference_index: sample.reference_index,
      candidate_index: sample.candidate_index,
      reference_artifact: sample.reference_artifact,
      candidate_artifact: sample.candidate_artifact,
      value: sample.metrics[metricId]
    }))
    .filter((sample) => Number.isFinite(sample.value));
  const classified = classifyOutliers(metricSamples, metricId);
  const acceptedValues = classified.accepted.map((sample) => sample.value);
  const summary = summarizeMetricSeries(acceptedValues);
  return {
    ...summary,
    raw_sample_count: metricSamples.length,
    accepted_sample_count: classified.accepted.length,
    outlier_candidate_count: classified.flagged.length + classified.rejected.length,
    rejected_sample_count: classified.rejected.length,
    outlier_candidate_rate: metricSamples.length === 0
      ? 0
      : (classified.flagged.length + classified.rejected.length) / metricSamples.length,
    rejected_sample_rate: metricSamples.length === 0 ? 0 : classified.rejected.length / metricSamples.length,
    p99_ci95_upper: bootstrapP99CiUpper(acceptedValues, metricId),
    outlier_policy_id: outlierPolicy.policy_id,
    bootstrap_policy_id: bootstrapPolicy.policy_id,
    outlier_candidates: classified.flagged,
    rejected_samples: classified.rejected
  };
}

function classifyOutliers(samples, metricId) {
  if (samples.length < outlierPolicy.minimum_sample_count) {
    return {
      accepted: samples,
      flagged: [],
      rejected: []
    };
  }

  const values = samples.map((sample) => sample.value);
  const median = quantile(values, 0.5);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  const iqrLow = q1 - outlierPolicy.iqr_multiplier * iqr;
  const iqrHigh = q3 + outlierPolicy.iqr_multiplier * iqr;
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = quantile(deviations, 0.5);
  const accepted = [];
  const flagged = [];
  const rejected = [];
  const scale = mad * outlierPolicy.normal_consistency_scale;
  for (const sample of samples) {
    const iqrOutlier = iqr > 0 && (sample.value < iqrLow || sample.value > iqrHigh);
    const modifiedZ = scale > 0 ? Math.abs(sample.value - median) / scale : 0;
    const modifiedZOutlier = scale > 0 && modifiedZ > outlierPolicy.max_modified_z;
    const zeroSpreadOutlier = !(iqr > 0) && !(mad > 0) && sample.value !== median;
    if (iqrOutlier || modifiedZOutlier || zeroSpreadOutlier) {
      const reason = inferArtifactReason(sample);
      const outlierRecord = {
        ...sample,
        metric_id: metricId,
        policy_id: outlierPolicy.policy_id,
        reason,
        threshold_excluded: reason !== "UNKNOWN_OUTLIER",
        artifact_evidence: {
          reference_artifact: sample.reference_artifact,
          candidate_artifact: sample.candidate_artifact
        },
        statistical_evidence: {
          iqr_outlier: iqrOutlier,
          modified_z_outlier: modifiedZOutlier,
          zero_spread_outlier: zeroSpreadOutlier
        },
        median,
        q1,
        q3,
        iqr,
        iqr_low: iqrLow,
        iqr_high: iqrHigh,
        mad,
        modified_z: modifiedZ,
        max_modified_z: outlierPolicy.max_modified_z
      };
      if (outlierRecord.threshold_excluded) rejected.push(outlierRecord);
      else flagged.push(outlierRecord);
    }
    else {
      accepted.push(sample);
    }
  }

  return {
    accepted: [...accepted, ...flagged],
    flagged,
    rejected
  };
}

function inferArtifactReason(sample) {
  if (invalidCapturePath(sample.reference_artifact) || invalidCapturePath(sample.candidate_artifact)) {
    return "CAPTURE_PATH_INVALID";
  }
  if (thermalSpike(sample.reference_artifact) || thermalSpike(sample.candidate_artifact)) {
    return "THERMAL_SPIKE";
  }
  if (deviceStateDrift(sample.reference_artifact) || deviceStateDrift(sample.candidate_artifact)) {
    return "DEVICE_STATE_DRIFT";
  }
  return "UNKNOWN_OUTLIER";
}

function invalidCapturePath(identity) {
  return identity?.capture_kind && identity.capture_kind !== "compositor" && identity.capture_kind !== "framebuffer";
}

function thermalSpike(identity) {
  const thermalEnd = identity?.device?.thermal_state_end;
  return thermalEnd === "serious" || thermalEnd === "critical";
}

function deviceStateDrift(identity) {
  const device = identity?.device ?? {};
  return device.thermal_state_start !== undefined && device.thermal_state_start !== "nominal" ||
    device.low_power_mode === true;
}

function assessInfrastructureHealth(summary) {
  const failures = [];
  const metricEntries = Object.entries(summary.metrics ?? {});
  let maxOutlierCandidateRate = 0;
  let maxRejectedSampleRate = 0;
  for (const [metricId, metric] of metricEntries) {
    maxOutlierCandidateRate = Math.max(maxOutlierCandidateRate, metric.outlier_candidate_rate ?? 0);
    maxRejectedSampleRate = Math.max(maxRejectedSampleRate, metric.rejected_sample_rate ?? 0);
    if ((metric.outlier_candidate_rate ?? 0) > outlierPolicy.max_outlier_candidate_rate) {
      failures.push(`BASELINE_OUTLIER_RATE_ABOVE_HEALTH_THRESHOLD:${metricId}`);
    }
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    evaluated_metric_count: metricEntries.length,
    max_outlier_candidate_rate: maxOutlierCandidateRate,
    max_rejected_sample_rate: maxRejectedSampleRate,
    max_outlier_candidate_rate_allowed: outlierPolicy.max_outlier_candidate_rate,
    policy_id: outlierPolicy.policy_id
  };
}

function makeBaselineApproval({ baselineStatus, baselineClass, owner, approvalId }) {
  const normalizedOwner = normalizedApprovalText(owner) ?? baselineApprovalPolicy.owner_placeholder;
  const normalizedApprovalId = normalizedApprovalText(approvalId);
  const approvalRequired = baselineStatus === "complete";
  const approved = normalizedOwner !== baselineApprovalPolicy.owner_placeholder && Boolean(normalizedApprovalId);
  const failures = approvalRequired && !approved ? ["BASELINE_OWNER_APPROVAL_REQUIRED"] : [];
  return {
    policy_id: baselineApprovalPolicy.policy_id,
    owner: normalizedOwner,
    approval_id: normalizedApprovalId,
    approval_required: approvalRequired,
    approval_status: approvalRequired
      ? approved ? "approved" : "missing_required_approval"
      : approved ? "approved_partial" : "partial_unapproved",
    threshold_drift_requires_owner_approval: baselineApprovalPolicy.threshold_drift_requires_owner_approval,
    baseline_class: baselineClass,
    failures
  };
}

function normalizedApprovalText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function freezeBaselineReport(report) {
  const contentSha256 = baselineContentSha256(report);
  return {
    ...report,
    baseline_freeze: {
      policy_id: baselineFreezePolicy.policy_id,
      hash_algorithm: baselineFreezePolicy.hash_algorithm,
      hash_scope: baselineFreezePolicy.hash_scope,
      content_sha256: contentSha256,
      retention_class: baselineFreezePolicy.retention_class,
      immutable: baselineFreezePolicy.immutable
    },
    immutability: {
      ...report.immutability,
      frozen_by_hash: true,
      baseline_content_sha256: contentSha256,
      baseline_retention_class: baselineFreezePolicy.retention_class
    }
  };
}

function baselineContentSha256(report) {
  return sha256Buffer(Buffer.from(canonicalJson(baselineFreezePayload(report)), "utf8"));
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

function buildThresholdDerivation({ referenceSamples, candidateSamples }) {
  const metricIds = Object.keys(referenceSamples[0]?.metrics ?? {})
    .filter((metricId) => metricThresholdPolicies[metricId]);
  const metricThresholds = {};
  for (const metricId of metricIds) {
    const policy = metricThresholdPolicies[metricId];
    const instrumentLoss = summarizeMetricSamples(transformSamplesToLoss(referenceSamples, metricId, policy), `${metricId}_loss`);
    const webkitGapLoss = summarizeMetricSamples(transformSamplesToLoss(candidateSamples, metricId, policy), `${metricId}_loss`);
    const instrumentNoiseUpper = instrumentLoss.p99_ci95_upper ?? 0;
    const webkitGapUpper = webkitGapLoss.p99_ci95_upper ?? null;
    const shaderSlack = policy.shader_slack;
    const webkitSlack = policy.webkit_slack;
    metricThresholds[metricId] = {
      metric_id: metricId,
      direction: policy.direction,
      loss_transform: policy.loss_transform,
      instrument_noise_loss: instrumentLoss,
      webkit_gap_loss: webkitGapLoss,
      shader_slack: shaderSlack,
      webkit_slack: webkitSlack,
      shader_threshold_components: [
        "instrument_noise_loss_ci95_upper",
        "SHADER_SLACK"
      ],
      shader_threshold: instrumentNoiseUpper + shaderSlack.value,
      webkit_threshold_components: [
        "instrument_noise_loss_ci95_upper",
        "WEBKIT_SLACK",
        "webkit_gap_loss_ci95_upper"
      ],
      webkit_threshold: webkitGapUpper === null
        ? null
        : instrumentNoiseUpper + webkitSlack.multiplier * webkitGapUpper,
      no_worse_than_webkit_floor: {
        gate: false,
        role: thresholdPolicy.webkit_gap_role,
        candidate_loss_must_be_no_greater_than: webkitGapUpper
      }
    };
  }

  return {
    policy: thresholdPolicy,
    metric_count: Object.keys(metricThresholds).length,
    metric_thresholds: metricThresholds
  };
}

function transformSamplesToLoss(samples, metricId, policy) {
  return samples.map((sample) => ({
    sample_id: `${sample.sample_id}:${metricId}:loss`,
    sample_kind: sample.sample_kind,
    reference_index: sample.reference_index,
    candidate_index: sample.candidate_index,
    reference_artifact: sample.reference_artifact,
    candidate_artifact: sample.candidate_artifact,
    metrics: {
      [`${metricId}_loss`]: metricLoss(sample.metrics[metricId], policy)
    }
  })).filter((sample) => Number.isFinite(sample.metrics[`${metricId}_loss`]));
}

function metricLoss(value, policy) {
  if (!Number.isFinite(value)) return NaN;
  if (policy.loss_transform === "one_minus_value") return Math.max(0, 1 - value);
  return value;
}

function metricPolicy(lossTransform, direction) {
  return deepFreeze({
    direction,
    loss_transform: lossTransform,
    shader_slack: defaultSlack.shader,
    webkit_slack: defaultSlack.webkit
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertOutlierPolicySelfTest() {
  const unknownSamples = makeSyntheticSamples({ knownReason: false });
  const unknownSummary = summarizeMetricSamples(unknownSamples, "probe_metric");
  if (unknownSummary.outlier_candidate_count !== 1) {
    throw new Error("outlier policy self-test failed to flag statistical outlier candidate");
  }
  if (unknownSummary.rejected_sample_count !== 0) {
    throw new Error("outlier policy self-test deleted UNKNOWN_OUTLIER from threshold");
  }
  if (!unknownSummary.outlier_candidates.some((sample) =>
    sample.reason === "UNKNOWN_OUTLIER" &&
    sample.threshold_excluded === false
  )) {
    throw new Error("outlier policy self-test failed to retain UNKNOWN_OUTLIER evidence");
  }

  const driftSummary = summarizeMetricSamples(makeSyntheticSamples({ knownReason: true }), "probe_metric");
  if (driftSummary.rejected_sample_count !== 1) {
    throw new Error("outlier policy self-test failed to reject machine-proven device drift");
  }
  if (!driftSummary.rejected_samples.some((sample) =>
    sample.reason === "DEVICE_STATE_DRIFT" &&
    sample.threshold_excluded === true
  )) {
    throw new Error("outlier policy self-test failed to carry device drift reason");
  }

  const health = assessInfrastructureHealth({ metrics: { probe_metric: unknownSummary } });
  if (health.status !== "fail") {
    throw new Error("outlier policy self-test failed to mark high outlier rate unhealthy");
  }
}

function assertThresholdPolicySelfTest(report) {
  const thresholds = report.threshold_derivation?.metric_thresholds ?? {};
  const oklab = thresholds.oklab_delta_e_mean;
  if (!oklab) {
    throw new Error("threshold policy self-test failed to emit OKLab threshold");
  }
  if (oklab.shader_threshold_components.includes("webkit_gap_loss_ci95_upper")) {
    throw new Error("threshold policy self-test found WebKit gap inside shader threshold");
  }
  if (oklab.no_worse_than_webkit_floor.gate !== false) {
    throw new Error("threshold policy self-test made no_worse_than_webkit a gate");
  }
  if (!oklab.shader_slack.owner || !oklab.shader_slack.derivation) {
    throw new Error("threshold policy self-test found unowned SHADER_SLACK");
  }
  if (!oklab.webkit_slack.owner || !oklab.webkit_slack.derivation) {
    throw new Error("threshold policy self-test found unowned WEBKIT_SLACK");
  }

  const ssim = thresholds.ssim;
  if (!ssim || ssim.loss_transform !== "one_minus_value") {
    throw new Error("threshold policy self-test failed to transform high-good SSIM into loss");
  }
  if (report.statistics?.threshold_policy?.shader_threshold_never_borrows_webkit_gap !== true) {
    throw new Error("threshold policy self-test failed to carry shader/WebKit separation policy");
  }
}

function assertBaselineIdentitySelfTest(report) {
  const identity = report.baseline_identity ?? {};
  const required = [
    "device_model_name",
    "device_model_identifier",
    "os_version",
    "os_build",
    "sdk_build",
    "capture_daemon_version",
    "renderer_dependency_lockfile_sha256",
    "webkit_build",
    "pipeline_qualification_status"
  ];
  for (const key of required) {
    if (typeof identity[key] !== "string" || identity[key].length === 0) {
      throw new Error(`baseline identity self-test missing ${key}`);
    }
  }
  if (identity.renderer_dependency_lockfile_sha256 !== sha256File(join(repoRoot, "package-lock.json"))) {
    throw new Error("baseline identity self-test lockfile hash mismatch");
  }
  if (identity.pipeline_qualification_status !== "pass") {
    throw new Error("baseline identity self-test failed to carry null qualification");
  }
  for (const value of [
    identity.device_model_name,
    identity.device_model_identifier,
    identity.os_version,
    identity.os_build,
    identity.sdk_build,
    identity.capture_daemon_version,
    identity.renderer_dependency_lockfile_sha256,
    identity.webkit_build,
    identity.pipeline_qualification_status
  ]) {
    if (!report.baseline_namespace.includes(safePart(value))) {
      throw new Error(`baseline namespace self-test missing ${value}`);
    }
  }
}

function assertBaselineApprovalSelfTest(fixture) {
  const partialReport = buildBaselineReport({
    refs: readRepeatManifestPaths(fixture.refManifest),
    probes: readRepeatManifestPaths(fixture.probeManifest),
    baselineClass: "mvl",
    repeatOverride: 50
  });
  if (partialReport.baseline_status !== "partial" ||
      partialReport.baseline_approval?.approval_status !== "partial_unapproved") {
    throw new Error("baseline approval self-test failed partial evidence policy");
  }

  const unapprovedComplete = buildBaselineReport({
    refs: readRepeatManifestPaths(fixture.refManifest),
    probes: readRepeatManifestPaths(fixture.probeManifest),
    baselineClass: "mvl",
    repeatOverride: 3
  });
  if (unapprovedComplete.baseline_status !== "invalid" ||
      !unapprovedComplete.failures.includes("BASELINE_OWNER_APPROVAL_REQUIRED")) {
    throw new Error("baseline approval self-test failed to block complete unapproved baseline");
  }

  const approvedComplete = buildBaselineReport({
    refs: readRepeatManifestPaths(fixture.refManifest),
    probes: readRepeatManifestPaths(fixture.probeManifest),
    baselineClass: "mvl",
    repeatOverride: 3,
    owner: "lab-owner",
    approvalId: "approval-self-test"
  });
  if (approvedComplete.baseline_status !== "complete" ||
      approvedComplete.baseline_approval?.approval_status !== "approved") {
    throw new Error("baseline approval self-test failed approved complete baseline");
  }
}

function assertBaselineFreezeSelfTest(report) {
  const freeze = report.baseline_freeze ?? {};
  if (freeze.content_sha256 !== baselineContentSha256(report)) {
    throw new Error("baseline freeze self-test content hash mismatch");
  }
  if (freeze.immutable !== true || report.immutability?.frozen_by_hash !== true) {
    throw new Error("baseline freeze self-test missing immutable flags");
  }
  if (report.immutability?.baseline_retention_class !== "baseline") {
    throw new Error("baseline freeze self-test missing baseline retention class");
  }
}

function makeSyntheticSamples({ knownReason }) {
  return [0, 0, 0, 0, 0, 0, 0, 100].map((value, index) => ({
    sample_id: `outlier-self-test-${index}`,
    sample_kind: "outlier_policy_self_test",
    reference_index: index,
    candidate_index: index,
    reference_artifact: syntheticArtifactIdentity("R0", "nominal", false),
    candidate_artifact: syntheticArtifactIdentity(
      "R1",
      knownReason && index === 7 ? "fair" : "nominal",
      false
    ),
    metrics: {
      probe_metric: value
    }
  }));
}

function syntheticArtifactIdentity(rigId, thermalStateStart, lowPowerMode) {
  return {
    id: `synthetic-${rigId}`,
    rig_id: rigId,
    scene_id: "SYNTHETIC_OUTLIER_POLICY",
    state_id: "rest",
    capture_kind: "compositor",
    artifact_path: `synthetic-${rigId}.capture.json`,
    png_path: `synthetic-${rigId}.png`,
    png_sha256: "synthetic",
    device: {
      model_identifier: "iPhone-outlier-policy-self-test",
      os_build: "self-test",
      sdk_build: "self-test",
      screen_scale: 3,
      refresh_hz: 60,
      thermal_state_start: thermalStateStart,
      thermal_state_end: thermalStateStart,
      low_power_mode: lowPowerMode
    }
  };
}

function bootstrapP99CiUpper(values, metricId) {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const rng = makeSeededRng(stableSeed([
    bootstrapPolicy.seed_namespace,
    metricId,
    values.length,
    values.map((value) => value.toPrecision(17)).join(",")
  ].join("|")));
  const p99Values = [];
  for (let iteration = 0; iteration < bootstrapPolicy.iterations; iteration += 1) {
    const resample = [];
    for (let index = 0; index < values.length; index += 1) {
      resample.push(values[Math.floor(rng() * values.length)]);
    }
    p99Values.push(quantile(resample, bootstrapPolicy.statistic_quantile));
  }
  return quantile(p99Values, bootstrapPolicy.confidence);
}

function quantile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function stableSeed(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeSeededRng(seed) {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeBaselineIdentity(record, baselineClass) {
  const artifact = record.artifact;
  const device = artifact.device_info ?? {};
  const integrity = artifact.integrity ?? {};
  const rendererLockfile = rendererLockfileIdentity();
  return Object.freeze({
    baseline_class: baselineClass,
    scene_id: artifact.scene_id,
    state_id: artifact.state_id,
    rig_id: artifact.rig_id,
    device_model_name: device.model_name ?? "unknown",
    device_model_identifier: device.model_identifier ?? "unknown",
    os_version: device.os_version ?? "unknown",
    os_build: device.os_build ?? "unknown",
    sdk_build: device.sdk_build ?? "unknown",
    capture_daemon_version: integrity.producer_version ?? "unknown",
    renderer_dependency_lockfile_path: rendererLockfile.path,
    renderer_dependency_lockfile_sha256: rendererLockfile.sha256,
    webkit_build: device.webkit_build ?? artifact.environment?.webkit_build ?? "not_observable",
    pipeline_qualification_status: artifact.null_qualification ?? "not_recorded"
  });
}

function makeBaselineNamespace(identity) {
  return [
    "baseline",
    identity.baseline_class,
    identity.scene_id,
    identity.state_id,
    identity.rig_id,
    identity.device_model_name,
    identity.device_model_identifier,
    identity.os_version,
    identity.os_build,
    identity.sdk_build,
    identity.capture_daemon_version,
    `lock-${identity.renderer_dependency_lockfile_sha256}`,
    `webkit-${identity.webkit_build}`,
    `pipeline-${identity.pipeline_qualification_status}`
  ].map(safePart).join("__");
}

function rendererLockfileIdentity() {
  const path = join(repoRoot, "package-lock.json");
  return {
    path: "package-lock.json",
    sha256: sha256File(path)
  };
}

function safePart(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_.-]+/gi, "-");
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "metrics-baseline");
  mkdirSync(dir, { recursive: true });

  const refs = [];
  const probes = [];
  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  for (let index = 0; index < 3; index += 1) {
    const refPng = join(dir, `reference-${index}.png`);
    const probePng = join(dir, `probe-${index}.png`);
    writePng(refPng, 12, 12, makePixels(12, 12, 0));
    writePng(probePng, 12, 12, makePixels(12, 12, index === 2 ? 1 : 0));

    const refArtifact = join(dir, `reference-${index}.capture.json`);
    const probeArtifact = join(dir, `probe-${index}.capture.json`);
    writeFileSync(refArtifact, `${JSON.stringify(makeArtifact("R0", refPng, maskPath, index), null, 2)}\n`);
    writeFileSync(probeArtifact, `${JSON.stringify(makeArtifact("R1", probePng, maskPath, index), null, 2)}\n`);
    refs.push(refArtifact);
    probes.push(probeArtifact);
  }

  return {
    refs,
    probes,
    refManifest: writeRepeatManifest(dir, "reference.repeat-manifest.json", refs),
    probeManifest: writeRepeatManifest(dir, "probe.repeat-manifest.json", probes),
    out: outPath ? resolve(outPath) : join(dir, "baseline.metric.report.json")
  };
}

function makePixels(width, height, delta) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 48 + x + delta;
      pixels[offset + 1] = 88 + y;
      pixels[offset + 2] = 128;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function makeArtifact(rigId, pngPath, maskPath, index) {
  return finalizeCaptureArtifactIntegrity({
    schema_version: "1.2.0",
    id: `self-test-${rigId}-baseline-${index}`,
    rig_id: rigId,
    scene_id: "S01_SEARCH",
    state_id: "rest",
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
      low_power_mode: false
    },
    environment: {
      appearance: "dark",
      reduce_transparency: false,
      reduce_motion: false,
      content_seed: `g2-baseline-self-test-${index}`,
      viewport_px: { width: 12, height: 12 },
      capture_timestamp_ns: String(index)
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
      touch_phase: "rest",
      animation_t: 0
    },
    integrity: {
      artifact_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      producer_version: "lab-metrics-baseline.self-test"
    }
  });
}

function writeRepeatManifest(dir, name, artifactPaths) {
  const manifestPath = join(dir, name);
  const manifest = {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    id: name.replace(/\.json$/, ""),
    status: "partial",
    repeat_count_requested: 50,
    repeat_count_observed: artifactPaths.length,
    artifact_json_paths: artifactPaths
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function parseArgs(args) {
  const parsed = {
    refs: [],
    probes: [],
    baselineClass: "mvl"
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--ref") parsed.refs.push(args[++index]);
    else if (arg === "--probe") parsed.probes.push(args[++index]);
    else if (arg === "--ref-manifest") parsed.refs.push(...readRepeatManifestPaths(args[++index]));
    else if (arg === "--probe-manifest") parsed.probes.push(...readRepeatManifestPaths(args[++index]));
    else if (arg === "--class") parsed.baselineClass = args[++index];
    else if (arg === "--owner") parsed.owner = args[++index];
    else if (arg === "--approval") parsed.approvalId = args[++index];
    else if (arg === "--repeat") {
      parsed.repeatOverride = Number(args[++index]);
      if (!Number.isFinite(parsed.repeatOverride) || parsed.repeatOverride < 1) {
        throw new Error("--repeat must be a positive number");
      }
    }
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function readRepeatManifestPaths(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (manifest.kind !== "repeat_capture_manifest") {
    throw new Error(`${path}: expected repeat_capture_manifest`);
  }
  if (!Array.isArray(manifest.artifact_json_paths)) {
    throw new Error(`${path}: missing artifact_json_paths`);
  }
  return manifest.artifact_json_paths.map((artifactPath) => {
    if (typeof artifactPath !== "string" || artifactPath.length === 0) {
      throw new Error(`${path}: artifact_json_paths must contain non-empty strings`);
    }
    return artifactPath;
  });
}
