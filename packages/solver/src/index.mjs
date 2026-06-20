export const solverPolicy = Object.freeze({
  schema_version: "1.2.0",
  required_degeneracy_scene_ids: Object.freeze(["S07", "S08", "S09", "S10", "S11"]),
  objective_weights: Object.freeze({
    loss_total: 0.45,
    runtime_cost_ms: 0.35,
    energy_cost: 0.20
  }),
  identifiability: Object.freeze({
    measured_sensitivity_min: 0.08,
    measured_confidence_min: 0.90,
    measured_interval_max: 0.20,
    bounded_confidence_min: 0.60,
    bounded_interval_max: 0.50,
    prior_confidence_min: 0.60
  }),
  derivation: "v1.2 solver guardrail: background-sweep loss + Pareto objectives + claim-constrained identifiability"
});

const identifiabilityOrder = Object.freeze([
  "MEASURED",
  "BOUNDED_AMBIGUOUS",
  "PROBABLE_UNDER_PRIOR",
  "AMBIGUOUS"
]);

export function buildSolverReport({ candidates, policy = solverPolicy } = {}) {
  const failures = [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    failures.push("SOLVER_CANDIDATES_REQUIRED");
    candidates = [];
  }

  const scoredCandidates = candidates.map((candidate) => scoreCandidate(candidate, policy));
  for (const scored of scoredCandidates) failures.push(...scored.failures);

  const validCandidates = scoredCandidates.filter((candidate) => candidate.failures.length === 0);
  const pareto = paretoFront(validCandidates);
  const selected = selectKneeCandidate(pareto, policy);
  const selectedIdentifiability = selected ? classifyCandidateParameters(selected.raw, policy) : {};
  const claimConstraints = buildClaimConstraints(selectedIdentifiability);

  if (validCandidates.length === 0 && candidates.length > 0) {
    failures.push("SOLVER_NO_VALID_CANDIDATES");
  }
  if (selected) {
    failures.push(...forbiddenParameterMatchClaims(selected.raw, selectedIdentifiability));
  }

  return {
    schema_version: "1.2.0",
    kind: "solver_pareto_report",
    gate: "SOLVER",
    status: failures.length === 0 ? "pass" : "fail",
    failures: unique(failures),
    policy: {
      required_degeneracy_scene_ids: policy.required_degeneracy_scene_ids,
      objective_weights: policy.objective_weights,
      identifiability: policy.identifiability,
      derivation: policy.derivation
    },
    background_sweep: summarizeSweep(scoredCandidates, policy),
    candidate_count: scoredCandidates.length,
    candidates: scoredCandidates.map(publicCandidateScore),
    pareto_front: pareto.map(publicCandidateScore),
    selected_candidate: selected ? publicCandidateScore(selected) : null,
    parameter_identifiability: selectedIdentifiability,
    claim_constraints: claimConstraints
  };
}

export function classifyIdentifiability(evidence = {}, policy = solverPolicy) {
  const localSensitivity = numeric(evidence.local_sensitivity);
  const confidence = numeric(evidence.confidence);
  const intervalWidth = numeric(evidence.normalized_interval_width);
  const priorRequired = evidence.prior_required === true;
  const idPolicy = policy.identifiability;

  if (
    localSensitivity >= idPolicy.measured_sensitivity_min &&
    confidence >= idPolicy.measured_confidence_min &&
    intervalWidth <= idPolicy.measured_interval_max
  ) {
    return "MEASURED";
  }

  if (
    confidence >= idPolicy.bounded_confidence_min &&
    intervalWidth <= idPolicy.bounded_interval_max
  ) {
    return "BOUNDED_AMBIGUOUS";
  }

  if (priorRequired && confidence >= idPolicy.prior_confidence_min) {
    return "PROBABLE_UNDER_PRIOR";
  }

  return "AMBIGUOUS";
}

export function paretoFront(candidates) {
  return candidates.filter((candidate) =>
    !candidates.some((other) => other.id !== candidate.id && dominates(other.objectives, candidate.objectives))
  );
}

function scoreCandidate(candidate, policy) {
  const failures = [];
  const id = nonEmpty(candidate?.id) ? candidate.id : "candidate-missing-id";
  if (!nonEmpty(candidate?.id)) failures.push("SOLVER_CANDIDATE_ID_REQUIRED");

  const sweep = Array.isArray(candidate?.background_sweep) ? candidate.background_sweep : [];
  if (sweep.length === 0) failures.push(`${id}:SOLVER_BACKGROUND_SWEEP_REQUIRED`);

  const observedSceneIds = new Set(sweep.map((sample) => scenePrefix(sample.scene_id)));
  for (const sceneId of policy.required_degeneracy_scene_ids) {
    if (!observedSceneIds.has(sceneId)) failures.push(`${id}:SOLVER_DEGENERACY_SCENE_MISSING_${sceneId}`);
  }

  const sampleScores = sweep.map((sample, index) => scoreSweepSample(id, sample, index, failures));
  const validScores = sampleScores.filter((sample) => Number.isFinite(sample.loss));
  const lossValues = validScores.map((sample) => sample.loss);
  const lossTotal = mean(lossValues);
  const runtimeCost = firstNumber(
    candidate?.objectives?.runtime_cost_ms,
    candidate?.runtime?.full_frame_ms_p95,
    candidate?.perf?.full_frame_ms_p95
  );
  const energyCost = firstNumber(
    candidate?.objectives?.energy_cost,
    candidate?.energy?.sustained_degradation_pct,
    candidate?.perf?.sustained_degradation_pct
  );

  if (!Number.isFinite(lossTotal)) failures.push(`${id}:SOLVER_LOSS_TOTAL_UNREADABLE`);
  if (!Number.isFinite(runtimeCost)) failures.push(`${id}:SOLVER_RUNTIME_OBJECTIVE_REQUIRED`);
  if (!Number.isFinite(energyCost)) failures.push(`${id}:SOLVER_ENERGY_OBJECTIVE_REQUIRED`);

  return {
    id,
    raw: candidate,
    failures,
    observed_scene_ids: [...observedSceneIds].sort(),
    sweep_count: sweep.length,
    loss_samples: validScores,
    objectives: {
      loss_total: lossTotal,
      loss_p95: percentile(lossValues, 0.95),
      runtime_cost_ms: runtimeCost,
      energy_cost: energyCost
    }
  };
}

function scoreSweepSample(candidateId, sample, index, failures) {
  const metrics = sample?.metrics ?? {};
  const explicitLoss = numeric(sample?.loss);
  const staticLoss = firstNumber(metrics.static_loss, metrics.g2_loss, metrics.flip_style_error_mean);
  const opticsLoss = firstNumber(metrics.optics_loss, metrics.g3_loss, metrics.edge_lensing_error);
  const temporalLoss = firstNumber(metrics.temporal_loss, metrics.g4_loss, metrics.phase_error);
  const weight = Number.isFinite(numeric(sample?.weight)) ? numeric(sample.weight) : 1;

  let loss;
  if (Number.isFinite(explicitLoss)) {
    loss = explicitLoss;
  } else if (Number.isFinite(staticLoss) && Number.isFinite(opticsLoss) && Number.isFinite(temporalLoss)) {
    loss = staticLoss + opticsLoss + temporalLoss;
  } else {
    failures.push(`${candidateId}:SOLVER_SWEEP_SAMPLE_${index}_LOSS_UNREADABLE`);
    loss = NaN;
  }

  return {
    scene_id: sample?.scene_id ?? "",
    background_id: sample?.background_id ?? sample?.background_asset_hash ?? sample?.content_seed ?? "",
    weight,
    loss: Number.isFinite(loss) ? loss * weight : NaN
  };
}

function classifyCandidateParameters(candidate, policy) {
  const evidenceByParameter = candidate?.parameter_evidence ?? {};
  const parameterNames = new Set([
    ...Object.keys(candidate?.parameters ?? {}),
    ...Object.keys(evidenceByParameter)
  ]);
  const tags = {};

  for (const parameter of [...parameterNames].sort()) {
    const evidence = evidenceByParameter[parameter] ?? {};
    tags[parameter] = {
      tag: classifyIdentifiability(evidence, policy),
      value: candidate?.parameters?.[parameter] ?? null,
      evidence: {
        local_sensitivity: evidence.local_sensitivity ?? null,
        confidence: evidence.confidence ?? null,
        normalized_interval_width: evidence.normalized_interval_width ?? null,
        prior_required: evidence.prior_required === true,
        source: evidence.source ?? "candidate_parameter_evidence"
      }
    };
  }

  return tags;
}

function buildClaimConstraints(identifiability) {
  return Object.entries(identifiability).map(([parameter, entry]) => {
    const tag = typeof entry === "string" ? entry : entry.tag;
    return {
      parameter,
      tag,
      parameter_level_match_claim: tag === "MEASURED" ? "allowed" : "forbidden",
      allowed_claim: claimForTag(tag)
    };
  });
}

function forbiddenParameterMatchClaims(candidate, identifiability) {
  const failures = [];
  const claims = candidate?.claims?.parameter_level_match ?? {};
  for (const [parameter, entry] of Object.entries(identifiability)) {
    const tag = typeof entry === "string" ? entry : entry.tag;
    if (tag !== "MEASURED" && claims[parameter] === true) {
      failures.push(`${candidate.id}:SOLVER_PARAMETER_MATCH_OVERCLAIM_${parameter}`);
    }
  }
  return failures;
}

function claimForTag(tag) {
  return {
    MEASURED: "parameter_match_allowed",
    BOUNDED_AMBIGUOUS: "bounded_fit_only",
    PROBABLE_UNDER_PRIOR: "prior_conditioned_fit_only",
    AMBIGUOUS: "fit_level_only_no_parameter_match"
  }[tag] ?? "fit_level_only_no_parameter_match";
}

function selectKneeCandidate(candidates, policy) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const ranges = {};
  for (const key of Object.keys(policy.objective_weights)) {
    const values = candidates.map((candidate) => candidate.objectives[key]).filter(Number.isFinite);
    ranges[key] = {
      min: Math.min(...values),
      max: Math.max(...values)
    };
  }

  return [...candidates].sort((left, right) =>
    kneeScore(left, ranges, policy) - kneeScore(right, ranges, policy) ||
    left.objectives.loss_total - right.objectives.loss_total ||
    left.id.localeCompare(right.id)
  )[0];
}

function kneeScore(candidate, ranges, policy) {
  let score = 0;
  for (const [key, weight] of Object.entries(policy.objective_weights)) {
    const range = ranges[key];
    const value = candidate.objectives[key];
    const denominator = range.max - range.min;
    const normalized = denominator === 0 ? 0 : (value - range.min) / denominator;
    score += normalized * weight;
  }
  return score;
}

function dominates(left, right) {
  const keys = ["loss_total", "runtime_cost_ms", "energy_cost"];
  return keys.every((key) => left[key] <= right[key]) && keys.some((key) => left[key] < right[key]);
}

function summarizeSweep(scoredCandidates, policy) {
  const observed = new Set();
  for (const candidate of scoredCandidates) {
    for (const sceneId of candidate.observed_scene_ids) observed.add(sceneId);
  }
  return {
    required_scene_ids: policy.required_degeneracy_scene_ids,
    observed_scene_ids: [...observed].sort(),
    candidate_sweeps: scoredCandidates.map((candidate) => ({
      id: candidate.id,
      sweep_count: candidate.sweep_count,
      observed_scene_ids: candidate.observed_scene_ids
    }))
  };
}

function publicCandidateScore(candidate) {
  return {
    id: candidate.id,
    status: candidate.failures.length === 0 ? "valid" : "invalid",
    failures: candidate.failures,
    objectives: candidate.objectives,
    sweep_count: candidate.sweep_count,
    observed_scene_ids: candidate.observed_scene_ids
  };
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = numeric(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function numeric(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) return Number(value);
  return NaN;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return NaN;
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

function percentile(values, q) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return NaN;
  const index = (finite.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return finite[lower];
  const weight = index - lower;
  return finite[lower] * (1 - weight) + finite[upper] * weight;
}

function scenePrefix(sceneId) {
  const match = String(sceneId ?? "").match(/^S\d{2}/);
  return match ? match[0] : String(sceneId ?? "");
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values) {
  return [...new Set(values)];
}

export function identifiabilityRank(tag) {
  const index = identifiabilityOrder.indexOf(tag);
  return index === -1 ? identifiabilityOrder.length : index;
}
