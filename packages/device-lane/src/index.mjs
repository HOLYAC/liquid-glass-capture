import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  glassDefaultDeviceLaneTasks,
  glassSceneStateMatrix,
  glassTrajectoryShaByScene
} from "../../material-glass/src/index.mjs";

export const physicalDeviceLanePolicy = Object.freeze({
  schema_version: "1.2.0",
  lane_classes: Object.freeze({
    smoke: { repeat: 3, requires_gates: false },
    mvl: { repeat: 50, requires_gates: true },
    prod_p99: { repeat: 300, requires_gates: true },
    sustained: { repeat: 24, requires_gates: true, sustained: true }
  }),
  required_gate_ids: Object.freeze(["G2", "G3", "G4", "G5", "G6"]),
  required_capture_kinds: Object.freeze(["compositor", "framebuffer"]),
  physical_rigs: Object.freeze(["R0", "R1", "C1", "DOM_C"]),
  scene_state_matrix: glassSceneStateMatrix,
  default_tasks: glassDefaultDeviceLaneTasks,
  trajectory_sha_by_scene: glassTrajectoryShaByScene,
  derivation: "v1.2 physical truth: collected artifacts must be physical, compositor/framebuffer, hash-checked, nominal-thermal, and gate-backed"
});

export function buildPhysicalDeviceLanePlan({
  laneClass = "mvl",
  tasks = physicalDeviceLanePolicy.default_tasks,
  policy = physicalDeviceLanePolicy,
  generatedAt = new Date().toISOString(),
  gitCommit = "unknown",
  reason = "manual_physical_lane_plan"
} = {}) {
  const lanePolicy = policy.lane_classes[laneClass];
  if (!lanePolicy) throw new Error(`unknown physical lane class: ${laneClass}`);

  const normalizedTasks = tasks.map((task, index) => normalizeTask(task, index, lanePolicy, policy));
  return {
    schema_version: "1.2.0",
    kind: "physical_device_lane_plan",
    status: "pending_device_lane",
    generated_at: generatedAt,
    git_commit: gitCommit,
    lane_class: laneClass,
    reason,
    policy: {
      required_gate_ids: policy.required_gate_ids,
      required_capture_kinds: policy.required_capture_kinds,
      scene_state_matrix: policy.scene_state_matrix,
      derivation: policy.derivation
    },
    task_count: normalizedTasks.length,
    tasks: normalizedTasks,
    operator_commands: normalizedTasks.map((task) =>
      `npm run ios:capture -- --rig ${task.rig_id} --scene ${task.scene_id} --state ${task.state_id} --device physical --capture compositor --repeat ${task.repeat_count_requested} --out ./artifacts/device-lane/${task.lane_task_id}.plan.json`
    )
  };
}

export function verifyPhysicalDeviceLane({
  plan,
  manifests = [],
  gateReports = [],
  policy = physicalDeviceLanePolicy,
  generatedAt = new Date().toISOString()
} = {}) {
  if (!plan || plan.kind !== "physical_device_lane_plan") {
    throw new Error("verifyPhysicalDeviceLane requires a physical_device_lane_plan");
  }

  const failures = [];
  const taskReports = [];
  for (const task of plan.tasks ?? []) {
    const manifestRecord = findManifestForTask(task, manifests);
    if (!manifestRecord) {
      failures.push(`${task.lane_task_id}:PHYSICAL_LANE_MANIFEST_MISSING`);
      taskReports.push({
        lane_task_id: task.lane_task_id,
        status: "pending",
        failures: [`${task.lane_task_id}:PHYSICAL_LANE_MANIFEST_MISSING`],
        artifacts: []
      });
      continue;
    }

    const taskReport = verifyTaskManifest(task, manifestRecord, policy);
    failures.push(...taskReport.failures);
    taskReports.push(taskReport);
  }

  const gateBlock = verifyGateReports(gateReports, policy, plan);
  failures.push(...gateBlock.failures);

  const status = failures.length === 0
    ? "pass"
    : taskReports.some((task) => task.status === "pending")
      ? "pending"
      : "fail";

  return {
    schema_version: "1.2.0",
    kind: "physical_device_lane_report",
    gate: "PHYSICAL_DEVICE_LANE",
    status,
    generated_at: generatedAt,
    lane_class: plan.lane_class,
    plan_git_commit: plan.git_commit,
    task_count: plan.tasks?.length ?? 0,
    task_reports: taskReports,
    gates: gateBlock,
    failures: unique(failures),
    evidence: {
      compositor_or_framebuffer_only: true,
      simulator_forbidden: true,
      layer_snapshot_forbidden: true,
      nominal_thermal_required: true,
      low_power_mode_forbidden: true,
      hashes_verified: taskReports.every((task) => task.artifacts.every((artifact) => artifact.hashes_verified))
    }
  };
}

function normalizeTask(task, index, lanePolicy, policy) {
  const rigId = task.rig_id;
  const sceneId = task.scene_id;
  const stateId = task.state_id;
  const repeat = task.repeat_count_requested ?? lanePolicy.repeat;
  if (!policy.physical_rigs.includes(rigId)) throw new Error(`task ${index}: unsupported physical rig ${rigId}`);
  if (!sceneId || !stateId) throw new Error(`task ${index}: scene_id and state_id are required`);
  const validStates = policy.scene_state_matrix?.[sceneId];
  if (!validStates) throw new Error(`task ${index}: unsupported scene ${sceneId}`);
  if (!validStates.includes(stateId)) throw new Error(`task ${index}: state ${stateId} is not valid for ${sceneId}`);
  return {
    schema_version: "1.2.0",
    kind: "physical_device_lane_task",
    lane_task_id: `${rigId}__${sceneId}__${stateId}`,
    rig_id: rigId,
    scene_id: sceneId,
    state_id: stateId,
    capture_kind: "compositor",
    device: "physical",
    repeat_count_requested: repeat,
    baseline_class: lanePolicy.sustained ? "sustained" : lanePolicy.repeat >= 300 ? "prod_p99" : lanePolicy.repeat === 50 ? "mvl" : "smoke",
    requires_nominal_thermal_start: true,
    requires_low_power_mode_off: true,
    requires_null_qualification_pass: true,
    required_trajectory_source_sha256: policy.trajectory_sha_by_scene[sceneId] ?? null
  };
}

function findManifestForTask(task, manifestRecords) {
  return manifestRecords.find((record) => {
    const manifest = record.manifest ?? record;
    return manifest.rig_id === task.rig_id &&
      manifest.scene_id === task.scene_id &&
      manifest.state_id === task.state_id &&
      manifest.capture_kind === task.capture_kind;
  });
}

function verifyTaskManifest(task, manifestRecord, policy) {
  const manifest = manifestRecord.manifest ?? manifestRecord;
  const failures = [];
  if (manifest.kind !== "repeat_capture_manifest") failures.push(`${task.lane_task_id}:MANIFEST_KIND_NOT_REPEAT_CAPTURE`);
  if ((manifest.repeat_count_observed ?? 0) < task.repeat_count_requested) failures.push(`${task.lane_task_id}:REPEAT_COUNT_INCOMPLETE`);
  if (!Array.isArray(manifest.artifact_json_paths) || manifest.artifact_json_paths.length < task.repeat_count_requested) {
    failures.push(`${task.lane_task_id}:ARTIFACT_PATHS_INCOMPLETE`);
  }

  const manifestDir = manifestRecord.path ? dirname(manifestRecord.path) : process.cwd();
  const artifactReports = [];
  for (const [index, rawPath] of (manifest.artifact_json_paths ?? []).entries()) {
    const artifactPath = isAbsolute(rawPath) ? rawPath : resolve(manifestDir, rawPath);
    const report = verifyArtifactForTask(task, artifactPath, index, policy);
    failures.push(...report.failures);
    artifactReports.push(report);
  }

  const deviceKeys = unique(artifactReports.map((artifact) => artifact.device_key).filter(Boolean));
  if (deviceKeys.length > 1) failures.push(`${task.lane_task_id}:DEVICE_BUILD_DRIFT_WITHIN_TASK`);

  return {
    lane_task_id: task.lane_task_id,
    status: failures.length === 0 ? "pass" : "fail",
    manifest_path: manifestRecord.path ?? null,
    repeat_count_requested: task.repeat_count_requested,
    repeat_count_observed: manifest.repeat_count_observed ?? 0,
    artifacts: artifactReports,
    failures
  };
}

function verifyArtifactForTask(task, artifactPath, index, policy) {
  const failures = [];
  if (!existsSync(artifactPath)) {
    return {
      index,
      artifact_path: artifactPath,
      status: "fail",
      hashes_verified: false,
      failures: [`${task.lane_task_id}:ARTIFACT_${index}_MISSING`]
    };
  }

  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (error) {
    return {
      index,
      artifact_path: artifactPath,
      status: "fail",
      hashes_verified: false,
      failures: [`${task.lane_task_id}:ARTIFACT_${index}_JSON_INVALID:${error.message}`]
    };
  }

  if (artifact.schema_version !== "1.2.0") failures.push(`${task.lane_task_id}:ARTIFACT_${index}_SCHEMA_VERSION_NOT_1_2_0`);
  if (artifact.rig_id !== task.rig_id) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_RIG_MISMATCH`);
  if (artifact.scene_id !== task.scene_id) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_SCENE_MISMATCH`);
  if (artifact.state_id !== task.state_id) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_STATE_MISMATCH`);
  if (!policy.required_capture_kinds.includes(artifact.capture_kind)) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_CAPTURE_PATH_INVALID`);
  if (looksLikeSimulator(artifact.device_info?.model_identifier)) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_SIMULATOR_FORBIDDEN`);
  if (artifact.device_info?.thermal_state_start !== "nominal") failures.push(`${task.lane_task_id}:ARTIFACT_${index}_THERMAL_START_NOT_NOMINAL`);
  if (artifact.device_info?.low_power_mode !== false) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_LOW_POWER_MODE_ON_OR_MISSING`);
  if (task.requires_null_qualification_pass && artifact.null_qualification !== "pass") {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_NULL_QUALIFICATION_NOT_PASS`);
  }
  if (task.rig_id === "C1" && artifact.shader?.pipeline !== "baked_verdict") {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_C1_REQUIRES_BAKED_VERDICT_SHADER`);
  }
  if (
    task.required_trajectory_source_sha256 &&
    artifact.frame_pack?.trajectory_source_sha256 !== task.required_trajectory_source_sha256
  ) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_TRAJECTORY_SOURCE_MISMATCH`);
  }

  const hashFailures = verifyFrameHashes(artifact, artifactPath, index, task.lane_task_id);
  failures.push(...hashFailures);

  return {
    index,
    artifact_path: artifactPath,
    artifact_id: artifact.id ?? null,
    status: failures.length === 0 ? "pass" : "fail",
    rig_id: artifact.rig_id,
    scene_id: artifact.scene_id,
    state_id: artifact.state_id,
    capture_kind: artifact.capture_kind,
    null_qualification: artifact.null_qualification ?? "not_recorded",
    device_key: deviceKey(artifact.device_info),
    hashes_verified: hashFailures.length === 0,
    failures
  };
}

function verifyFrameHashes(artifact, artifactPath, index, taskId) {
  const failures = [];
  const framePack = artifact.frame_pack ?? {};
  const artifactDir = dirname(artifactPath);
  verifyHash(failures, `${taskId}:ARTIFACT_${index}_BASE_PNG`, artifactDir, framePack.base_png_path, framePack.base_png_sha256);
  verifyHash(failures, `${taskId}:ARTIFACT_${index}_MASK_PACK`, artifactDir, framePack.mask_pack_path, framePack.mask_pack_sha256);
  for (const [frameIndex, rawPath] of (framePack.sequence_paths ?? []).entries()) {
    const path = resolveMaybe(artifactDir, rawPath);
    if (!existsSync(path)) failures.push(`${taskId}:ARTIFACT_${index}_SEQUENCE_FRAME_${frameIndex}_MISSING`);
  }
  return failures;
}

function verifyHash(failures, label, baseDir, rawPath, expected) {
  if (!rawPath || !expected) {
    failures.push(`${label}_HASH_CONTRACT_MISSING`);
    return;
  }
  const path = resolveMaybe(baseDir, rawPath);
  if (!existsSync(path)) {
    failures.push(`${label}_MISSING`);
    return;
  }
  if (!statSync(path).isFile()) {
    failures.push(`${label}_NOT_FILE`);
    return;
  }
  const actual = sha256File(path);
  if (actual !== String(expected).toLowerCase()) failures.push(`${label}_SHA256_MISMATCH`);
}

function verifyGateReports(gateReports, policy, plan) {
  const lanePolicy = policy.lane_classes[plan.lane_class] ?? {};
  if (!lanePolicy.requires_gates) {
    return {
      status: "not_required",
      failures: [],
      required_gate_ids: []
    };
  }

  const failures = [];
  const reportsByGate = new Map(gateReports.map((record) => [(record.report ?? record).gate, record.report ?? record]));
  for (const gate of policy.required_gate_ids) {
    if (!reportsByGate.has(gate)) {
      failures.push(`PHYSICAL_LANE_${gate}_REPORT_MISSING`);
      continue;
    }
    const report = reportsByGate.get(gate);
    if (report.status !== "pass") {
      failures.push(`PHYSICAL_LANE_${gate}_REPORT_NOT_PASS`);
    }
  }
  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    required_gate_ids: policy.required_gate_ids,
    provided_gate_ids: [...reportsByGate.keys()].sort()
  };
}

export function readPhysicalLaneJson(path) {
  const absolute = resolve(path);
  return {
    path: absolute,
    json: JSON.parse(readFileSync(absolute, "utf8"))
  };
}

function resolveMaybe(baseDir, rawPath) {
  return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function deviceKey(device = {}) {
  const parts = [
    device.model_identifier,
    device.os_build,
    device.sdk_build,
    device.screen_scale,
    device.refresh_hz
  ].filter((part) => part !== undefined && part !== null);
  return parts.length > 0 ? parts.join("|") : null;
}

function looksLikeSimulator(modelIdentifier) {
  return typeof modelIdentifier === "string" && /simulator|x86|arm64-sim/i.test(modelIdentifier);
}

function unique(values) {
  return [...new Set(values)];
}
