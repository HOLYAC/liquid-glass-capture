export const flakeClassOrder = Object.freeze([
  "NONE",
  "METRIC_NOISE",
  "INFRA_FLAKE",
  "PRODUCT_REGRESSION",
  "UNKNOWN"
]);

const infraPatterns = Object.freeze([
  /PHYSICAL_DEVICE_REQUIRED/,
  /SIMULATOR(_ARTIFACT)?_FORBIDDEN/,
  /THERMAL_START_NOT_NOMINAL/,
  /LOW_POWER_MODE/,
  /CAPTURE_PATH_(INVALID|NOT_COMPOSITOR_OR_FRAMEBUFFER)/,
  /CAPTURE(_KIND)?_MISMATCH/,
  /REPEAT_COUNT_INCOMPLETE/,
  /ARTIFACT_PATHS_INCOMPLETE/,
  /ARTIFACT_.*_(MISSING|UNREADABLE|NOT_FILE|JSON_INVALID|SHA256_MISMATCH|HASH_CONTRACT_MISSING)/,
  /FRAME_PACK_.*_MISSING/,
  /MASK_PACK_(PATH_MISSING|JSON_INVALID|SHA256_MISMATCH|MISSING)/,
  /BASE_PNG_SHA256_MISMATCH/,
  /TRACE_(UNAVAILABLE|PATH_MISSING|SHA256_MISSING|SHA256_MISMATCH|UNREADABLE)/,
  /ENERGY_TRACE_UNAVAILABLE_REQUIRED/,
  /SEQUENCE_(TOO_SHORT|LENGTH_MISMATCH|TIMESTAMPS_MISSING|FRAME_.*_MISSING)/,
  /TRAJECTORY_SOURCE_(MISSING|MISMATCH)/,
  /G5_PHYSICAL_DEVICE_REQUIRED/,
  /G6_PHYSICAL_DEVICE_REQUIRED/,
  /UNREADABLE/,
  /runner|daemon|cable|provisioning|device offline/i
]);

const productPatterns = Object.freeze([
  /typescript:typecheck/,
  /G0_G8_SELF_TEST:lab_self_test/,
  /workspace_hygiene:diff_check/,
  /G2_.*(BELOW_FLOOR|ABOVE_CEILING)/,
  /G3_.*(FAIL|ABOVE_CEILING|BELOW_FLOOR|MISMATCH)/,
  /G4_(PHASE_ERROR|PRESS_OVERSHOOT|FRAME_PACING|DROPPED_FRAME|REFERENCE_MOTION|CANDIDATE_MOTION).*$/,
  /G5_(FULL_FRAME_P95|DROPPED_FRAMES|C1_REQUIRES_BAKED_VERDICT_SHADER|DOM_C_COMPOSITOR_COST).*$/,
  /G6_(SUSTAINED_DEGRADATION|SUSTAINED_FRAME_INTERVAL|THERMAL_CRITICAL|THERMAL_SERIOUS).*$/,
  /SOLVER_(NO_VALID_CANDIDATES|LOSS_TOTAL_UNREADABLE|RUNTIME_OBJECTIVE_REQUIRED|ENERGY_OBJECTIVE_REQUIRED)/,
  /G8_(BASELINE_|C1_REQUIRES|C1_NOT_SELECTED|PHYSICAL_DEVICE_LANE_FAIL|SOLVER_REPORT_FAILED)/,
  /LEGIBILITY_BLOCK|BLOCKED_FOR_DESIGN/
]);

const noisePatterns = Object.freeze([
  /METRIC_NOISE/,
  /UNKNOWN_OUTLIER/,
  /WITHIN_(INSTRUMENT_)?NOISE/i,
  /CI95_OVERLAP/i,
  /NOISE_BAND/i
]);

export function classifyFlakiness({ reports = [], blockers = [], generatedAt = new Date().toISOString() } = {}) {
  const evidence = collectEvidence(reports, blockers);
  const classified = evidence.map(classifyCode);
  const counts = countBy(classified, (entry) => entry.class);
  const flakeClass = chooseClass(classified);
  const failures = [];
  if (evidence.length === 0) failures.push("FLAKE_CLASSIFIER_EVIDENCE_REQUIRED");
  if (flakeClass === "UNKNOWN") failures.push("FLAKE_CLASSIFIER_UNKNOWN_REQUIRES_HUMAN_CLASSIFICATION");

  return {
    schema_version: "1.2.0",
    kind: "flake_classification_report",
    status: failures.length === 0 ? "pass" : "fail",
    generated_at: generatedAt,
    flake_class: flakeClass,
    failures,
    policy: {
      classes: flakeClassOrder,
      priority: "UNKNOWN > PRODUCT_REGRESSION > INFRA_FLAKE > METRIC_NOISE > NONE",
      rules: {
        INFRA_FLAKE: "device/daemon/runner/capture-path/thermal-precondition failures",
        PRODUCT_REGRESSION: "deterministic G2-G6/G8 product or metric failures after valid capture",
        METRIC_NOISE: "explicit noise/outlier/confidence evidence only",
        UNKNOWN: "evidence exists but no deterministic rule matched"
      }
    },
    action: actionForClass(flakeClass),
    class_counts: counts,
    evidence: classified
  };
}

export function collectEvidence(reports = [], blockers = []) {
  const evidence = [];
  for (const blocker of blockers ?? []) evidence.push(makeEvidence("blocker", blocker));
  for (const entry of reports ?? []) {
    const report = entry.report ?? entry;
    const path = entry.path ?? "";
    const sourceKind = report?.kind ?? "unknown_report";
    for (const failure of report?.failures ?? []) {
      evidence.push(makeEvidence("failure", failure, sourceKind, path));
    }
    for (const blocker of report?.blockers ?? []) {
      evidence.push(makeEvidence("blocker", blocker, sourceKind, path));
    }
    const flakeClass = report?.flake_class ?? report?.gates?.flake_class;
    if (flakeClass && flakeClass !== "NONE") {
      evidence.push(makeEvidence("flake_class", flakeClass, sourceKind, path));
    }
  }
  return evidence;
}

function classifyCode(evidence) {
  const code = String(evidence.code ?? "");
  let flakeClass = "UNKNOWN";
  let rule = "unmatched";

  if (code === "NONE" || code.length === 0) {
    flakeClass = "NONE";
    rule = "empty_or_none";
  } else if (code === "INFRA_FLAKE" || matchesAny(code, infraPatterns)) {
    flakeClass = "INFRA_FLAKE";
    rule = "infra_pattern";
  } else if (code === "PRODUCT_REGRESSION" || matchesAny(code, productPatterns)) {
    flakeClass = "PRODUCT_REGRESSION";
    rule = "product_pattern";
  } else if (code === "METRIC_NOISE" || matchesAny(code, noisePatterns)) {
    flakeClass = "METRIC_NOISE";
    rule = "metric_noise_pattern";
  }

  return {
    ...evidence,
    class: flakeClass,
    rule
  };
}

function chooseClass(classified) {
  if (classified.length === 0) return "UNKNOWN";
  const classes = new Set(classified.map((entry) => entry.class));
  if (classes.has("UNKNOWN")) return "UNKNOWN";
  if (classes.has("PRODUCT_REGRESSION")) return "PRODUCT_REGRESSION";
  if (classes.has("INFRA_FLAKE")) return "INFRA_FLAKE";
  if (classes.has("METRIC_NOISE")) return "METRIC_NOISE";
  return "NONE";
}

function actionForClass(flakeClass) {
  return {
    NONE: "continue",
    INFRA_FLAKE: "rerun_once_then_block_as_infrastructure_red_if_repeated",
    PRODUCT_REGRESSION: "block_as_product_red",
    METRIC_NOISE: "do_not_block_alone_record_trend_warning",
    UNKNOWN: "block_until_classified"
  }[flakeClass] ?? "block_until_classified";
}

function makeEvidence(type, code, sourceKind = "manual", path = "") {
  return {
    type,
    code: String(code),
    source_kind: sourceKind,
    input_path: path
  };
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
