import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  glassBackgroundBySceneState,
  glassCaptureTimelineBySceneState,
  glassDefaultDeviceLaneTasks,
  glassGeometryBySceneState,
  glassSceneStateMatrix,
  glassTrajectoryShaByScene
} from "../../material-glass/src/index.mjs";
import { sceneStateKey } from "../../scene-contract/src/index.mjs";
import { validateMaskPack } from "../../mask-core/src/index.mjs";
import {
  canonicalArtifactHashMethod,
  validateCaptureArtifactIntegrity
} from "../../capture-schema/src/integrity.mjs";

const productionDeviceMatrixRoles = Object.freeze(["weakest_supported", "target", "latest_pro"]);

export const physicalDeviceLanePolicy = Object.freeze({
  schema_version: "1.2.0",
  lane_classes: Object.freeze({
    smoke: { repeat: 3, requires_gates: false },
    mvl: { repeat: 50, requires_gates: true },
    prod_p99: { repeat: 300, requires_gates: true, device_matrix_roles: productionDeviceMatrixRoles },
    sustained: { repeat: 24, requires_gates: true, sustained: true, capture_duration_ms: 60_000, cooldown_ms: 60_000 }
  }),
  required_gate_ids: Object.freeze(["G2", "G3", "G4", "G5", "G6"]),
  required_capture_kinds: Object.freeze(["compositor", "framebuffer"]),
  physical_rigs: Object.freeze(["R0", "R1", "C1", "DOM_C"]),
  scene_state_matrix: glassSceneStateMatrix,
  default_tasks: glassDefaultDeviceLaneTasks,
  trajectory_sha_by_scene: glassTrajectoryShaByScene,
  background_by_scene_state: glassBackgroundBySceneState,
  geometry_by_scene_state: glassGeometryBySceneState,
  capture_timeline_by_scene_state: glassCaptureTimelineBySceneState,
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
      production_device_matrix_roles: productionDeviceMatrixRoles,
      scene_state_matrix: policy.scene_state_matrix,
      derivation: policy.derivation
    },
    task_count: normalizedTasks.length,
    tasks: normalizedTasks,
    operator_commands: normalizedTasks.flatMap((task) =>
      commandMatrixForTask(task).map(({ role, suffix }) =>
        `npm run ios:capture -- --rig ${task.rig_id} --scene ${task.scene_id} --state ${task.state_id} --device physical --capture compositor --repeat ${task.repeat_count_requested}${role ? ` --device-role ${role}` : ""} --max-fidelity --capture-raw-frames --capture-raw-pixels --max-frames 900 --out ./artifacts/device-lane/${task.lane_task_id}${suffix}.plan.json`
      )
    )
  };
}

function commandMatrixForTask(task) {
  const roles = task.required_device_matrix_roles ?? [];
  if (roles.length === 0) return [{ role: null, suffix: "" }];
  return roles.map((role) => ({ role, suffix: `__${role}` }));
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
    const manifestRecords = findManifestsForTask(task, manifests);
    if (manifestRecords.length === 0) {
      failures.push(`${task.lane_task_id}:PHYSICAL_LANE_MANIFEST_MISSING`);
      taskReports.push({
        lane_task_id: task.lane_task_id,
        status: "pending",
        failures: [`${task.lane_task_id}:PHYSICAL_LANE_MANIFEST_MISSING`],
        artifacts: []
      });
      continue;
    }

    const taskReport = verifyTaskManifests(task, manifestRecords, policy);
    failures.push(...taskReport.failures);
    taskReports.push(taskReport);
  }

  const gateBlock = verifyGateReports(gateReports, policy, plan);
  failures.push(...gateBlock.failures);
  const retryEvents = taskReports.flatMap((task) => task.retry_events ?? []);

  const status = taskReports.some((task) => task.status === "pending")
      ? "pending"
      : failures.length > 0
        ? "fail"
        : retryEvents.length > 0
          ? "pass_with_retries"
          : "pass";

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
    retry_event_count: retryEvents.length,
    retry_events: retryEvents,
    failures: unique(failures),
    evidence: {
      compositor_or_framebuffer_only: true,
      simulator_forbidden: true,
      layer_snapshot_forbidden: true,
      nominal_thermal_required: true,
      low_power_mode_forbidden: true,
      scene_contract_verified: taskReports.every((task) => task.artifacts.every((artifact) => artifact.scene_contract_verified)),
      hashes_verified: taskReports.every((task) => task.artifacts.every((artifact) => artifact.hashes_verified)),
      clean_capture_path_verified: retryEvents.length === 0,
      sustained_contract_verified: plan.lane_class !== "sustained" ||
        (failures.length === 0 && retryEvents.length === 0),
      production_device_matrix_verified: plan.lane_class !== "prod_p99" ||
        taskReports.every((task) => task.device_matrix?.verified === true)
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
  const sceneState = sceneStateKey(sceneId, stateId);
  const background = policy.background_by_scene_state?.[sceneState] ?? null;
  const geometry = policy.geometry_by_scene_state?.[sceneState] ?? null;
  const timeline = policy.capture_timeline_by_scene_state?.[sceneState] ?? null;
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
    required_device_matrix_roles: lanePolicy.device_matrix_roles ?? [],
    requires_sustained_capture: Boolean(lanePolicy.sustained),
    required_sustained_duration_ms: lanePolicy.sustained ? lanePolicy.capture_duration_ms : null,
    required_cooldown_ms: lanePolicy.sustained ? lanePolicy.cooldown_ms : null,
    requires_nominal_thermal_start: true,
    requires_low_power_mode_off: true,
    requires_null_qualification_pass: true,
    required_trajectory_source_sha256: policy.trajectory_sha_by_scene[sceneId] ?? null,
    required_background_pack_id: background?.background_pack_id ?? null,
    required_background_id: background?.background_id ?? null,
    required_background_pack_sha256: background?.background_pack_sha256 ?? null,
    required_geometry_pack_id: geometry?.geometry_pack_id ?? null,
    required_geometry_id: geometry?.geometry_id ?? null,
    required_geometry_pack_sha256: geometry?.geometry_pack_sha256 ?? null,
    required_capture_timeline_pack_id: timeline?.capture_timeline_pack_id ?? null,
    required_capture_timeline_id: timeline?.capture_timeline_id ?? null,
    required_capture_timeline_sha256: timeline?.capture_timeline_sha256 ?? null
  };
}

function findManifestsForTask(task, manifestRecords) {
  return manifestRecords.filter((record) => {
    const manifest = record.manifest ?? record;
    return manifest.rig_id === task.rig_id &&
      manifest.scene_id === task.scene_id &&
      manifest.state_id === task.state_id &&
      manifest.capture_kind === task.capture_kind;
  });
}

function verifyTaskManifests(task, manifestRecords, policy) {
  const manifestReports = manifestRecords.map((manifestRecord) =>
    verifyTaskManifest(task, manifestRecord, policy)
  );
  const matrix = verifyDeviceMatrix(task, manifestReports);
  const failures = [
    ...manifestReports.flatMap((report) => report.failures),
    ...matrix.failures
  ];
  const retryEvents = manifestReports.flatMap((report) => report.retry_events ?? []);
  const status = failures.length > 0
    ? "fail"
    : retryEvents.length > 0
      ? "pass_with_retries"
      : "pass";
  return {
    lane_task_id: task.lane_task_id,
    status,
    manifest_path: manifestReports.length === 1 ? manifestReports[0].manifest_path : null,
    manifest_reports: manifestReports,
    repeat_count_requested: task.repeat_count_requested,
    repeat_count_observed: manifestReports.reduce((sum, report) => sum + report.repeat_count_observed, 0),
    artifacts: manifestReports.flatMap((report) => report.artifacts),
    device_matrix: matrix.summary,
    retry_event_count: retryEvents.length,
    retry_events: retryEvents,
    failures
  };
}

function verifyTaskManifest(task, manifestRecord, policy) {
  const manifest = manifestRecord.manifest ?? manifestRecord;
  const failures = [];
  const retryEvents = Array.isArray(manifest.retry_events)
    ? manifest.retry_events.map((event) => ({
      ...event,
      manifest_path: manifestRecord.path ?? null,
      lane_task_id: task.lane_task_id
    }))
    : [];
  const manifestFailures = Array.isArray(manifest.failures)
    ? manifest.failures.filter((failure) => typeof failure === "string" && failure.length > 0)
    : [];
  const requiresRawManifest = manifest.max_fidelity === true ||
    manifest.capture_raw_frames === true ||
    manifest.capture_raw_pixels === true;
  const requiresRawDisplay = manifest.capture_raw_pixels === true || manifest.max_fidelity === true;
  if (manifest.kind !== "repeat_capture_manifest") failures.push(`${task.lane_task_id}:MANIFEST_KIND_NOT_REPEAT_CAPTURE`);
  if (manifest.status !== "complete") {
    failures.push(`${task.lane_task_id}:MANIFEST_STATUS_NOT_COMPLETE:${String(manifest.status ?? "missing")}`);
  }
  if (manifestFailures.length > 0) failures.push(`${task.lane_task_id}:MANIFEST_RECORDED_FAILURES`);
  if ((manifest.repeat_count_observed ?? 0) < task.repeat_count_requested) failures.push(`${task.lane_task_id}:REPEAT_COUNT_INCOMPLETE`);
  if (!Array.isArray(manifest.artifact_json_paths) || manifest.artifact_json_paths.length < task.repeat_count_requested) {
    failures.push(`${task.lane_task_id}:ARTIFACT_PATHS_INCOMPLETE`);
  }
  failures.push(...verifySustainedManifestContract(task, manifest));

  const manifestDir = manifestRecord.path ? dirname(manifestRecord.path) : process.cwd();
  const artifactReports = [];
  for (const [index, rawPath] of (manifest.artifact_json_paths ?? []).entries()) {
    const artifactPath = isAbsolute(rawPath) ? rawPath : resolve(manifestDir, rawPath);
    const report = verifyArtifactForTask(task, artifactPath, index, policy, requiresRawManifest, requiresRawDisplay);
    failures.push(...report.failures);
    artifactReports.push(report);
  }

  const deviceKeys = unique(artifactReports.map((artifact) => artifact.device_key).filter(Boolean));
  if (deviceKeys.length > 1) failures.push(`${task.lane_task_id}:DEVICE_BUILD_DRIFT_WITHIN_TASK`);
  const status = failures.length > 0
    ? "fail"
    : retryEvents.length > 0
      ? "pass_with_retries"
      : "pass";

  return {
    lane_task_id: task.lane_task_id,
    status,
    manifest_path: manifestRecord.path ?? null,
    device_matrix_role: manifest.device_matrix_role ?? null,
    repeat_count_requested: task.repeat_count_requested,
    repeat_count_observed: manifest.repeat_count_observed ?? 0,
    manifest_status: manifest.status ?? null,
    manifest_failures: manifestFailures,
    retry_policy: manifest.policy
      ? {
        retry_replaykit_no_frame: manifest.policy.retry_replaykit_no_frame ?? false,
        max_no_frame_retries: manifest.policy.max_no_frame_retries ?? null
      }
      : null,
    retry_event_count: retryEvents.length,
    retry_events: retryEvents,
    artifacts: artifactReports,
    failures
  };
}

function verifyArtifactForTask(task, artifactPath, index, policy, requiresRawFrameManifest, requiresRawDisplay) {
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
  if (requiresRawFrameManifest) {
    const artifactDir = dirname(artifactPath);
    if (!artifact.frame_pack?.frame_manifest_path) {
      failures.push(`${task.lane_task_id}:ARTIFACT_${index}_RAW_MANIFEST_PATH_MISSING`);
    }
    if (!artifact.frame_pack?.frame_manifest_sha256) {
      failures.push(`${task.lane_task_id}:ARTIFACT_${index}_RAW_MANIFEST_SHA_MISSING`);
    }
    if (artifact.frame_pack?.frame_manifest_path && artifact.frame_pack?.frame_manifest_sha256) {
      verifyHash(
        failures,
        `${task.lane_task_id}:ARTIFACT_${index}_FRAME_MANIFEST`,
        artifactDir,
        artifact.frame_pack.frame_manifest_path,
        artifact.frame_pack.frame_manifest_sha256
      );
      verifyRawFrameManifest(
        failures,
        task.lane_task_id,
        index,
        artifactDir,
        artifact.frame_pack.frame_manifest_path,
        artifact.frame_pack.frame_manifest_sha256,
        {
          requiresRawDisplay,
          sequencePaths: artifact.frame_pack?.sequence_paths ?? []
        }
      );
    }
  }
  failures.push(...verifySustainedArtifactFields(task, artifact, index));
  failures.push(...verifySceneContractFields(task, artifact, index));
  for (const integrityFailure of validateCaptureArtifactIntegrity(artifact)) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_${integrityFailure}`);
  }
  if (artifact.integrity?.artifact_hash_method !== canonicalArtifactHashMethod) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_INTEGRITY_CANONICAL_HASH_METHOD_MISSING`);
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
    device_matrix_role: artifact.device_info?.device_matrix_role ?? null,
    device_key: deviceKey(artifact.device_info),
    scene_contract_verified: !failures.some((failure) =>
      failure.includes("_BACKGROUND_") ||
      failure.includes("_GEOMETRY_") ||
      failure.includes("_CAPTURE_TIMELINE_")
    ),
    hashes_verified: hashFailures.length === 0,
    failures
  };
}

function verifyRawFrameManifest(
  failures,
  taskId,
  artifactIndex,
  artifactDir,
  frameManifestPath,
  frameManifestSha,
  options = {}
) {
  const baseLabel = `${taskId}:ARTIFACT_${artifactIndex}_FRAME_MANIFEST`;
  const manifestPath = resolveMaybe(artifactDir, frameManifestPath);
  if (!existsSync(manifestPath)) {
    failures.push(`${baseLabel}_MANIFEST_MISSING`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`${baseLabel}_JSON_INVALID:${error.message}`);
    return;
  }

  if (manifest.schema_version !== "1.0.0" && manifest.schema_version !== "1.2.0") {
    failures.push(`${baseLabel}_SCHEMA_VERSION_UNEXPECTED_${String(manifest.schema_version ?? "missing")}`);
  }
  if (!Number.isFinite(manifest.frame_count) || manifest.frame_count < 0) {
    failures.push(`${baseLabel}_FRAME_COUNT_INVALID`);
  }
  if (!Array.isArray(manifest.frames)) {
    failures.push(`${baseLabel}_FRAMES_NOT_ARRAY`);
    return;
  }
  if (Number.isFinite(manifest.frame_count) && manifest.frames.length !== manifest.frame_count) {
    failures.push(`${baseLabel}_FRAME_COUNT_MISMATCH`);
  }

  const requiresRawDisplay = options.requiresRawDisplay === true;
  const expectedSequencePaths = Array.isArray(options.sequencePaths) ? options.sequencePaths : [];
  const expectedSequenceMap = new Map();
  for (let frameIndex = 0; frameIndex < expectedSequencePaths.length; frameIndex += 1) {
    const sequencePath = expectedSequencePaths[frameIndex];
    if (typeof sequencePath === "string" && sequencePath.length > 0) {
      const expectedPath = resolveMaybe(artifactDir, sequencePath);
      expectedSequenceMap.set(frameIndex, expectedPath);
    }
  }
  const sequenceMatches = new Set();
  const seenIndices = new Set();

  for (let entryIndex = 0; entryIndex < manifest.frames.length; entryIndex += 1) {
    const frame = manifest.frames[entryIndex];
    const frameLabel = `${baseLabel}_FRAME_${entryIndex}`;
    const framePath = resolveMaybe(artifactDir, frame?.png);

    if (!Number.isFinite(frame?.index) || !Number.isInteger(frame.index) || frame.index < 0) {
      failures.push(`${frameLabel}_INDEX_INVALID`);
    } else {
      if (seenIndices.has(frame.index)) {
        failures.push(`${frameLabel}_INDEX_DUPLICATE`);
      } else {
        seenIndices.add(frame.index);
      }
      const expectedPngPath = expectedSequenceMap.get(frame.index);
      if (expectedPngPath !== undefined && typeof frame?.png === "string") {
        if (framePath !== expectedPngPath) {
          failures.push(`${frameLabel}_PNG_PATH_MISMATCH_SEQUENCE`);
        } else {
          sequenceMatches.add(expectedPngPath);
        }
      }
      if (expectedPngPath !== undefined && (typeof frame?.png !== "string" || frame.png.length === 0)) {
        failures.push(`${frameLabel}_PNG_PATH_MISSING`);
      }
    }

    if (typeof frame?.width !== "number" || frame.width <= 0) {
      failures.push(`${frameLabel}_WIDTH_INVALID`);
    }
    if (typeof frame?.height !== "number" || frame.height <= 0) {
      failures.push(`${frameLabel}_HEIGHT_INVALID`);
    }

    if (typeof frame?.png !== "string" || frame.png.length === 0) {
      failures.push(`${frameLabel}_PNG_PATH_MISSING`);
    } else if (!existsSync(framePath)) {
      failures.push(`${frameLabel}_PNG_MISSING`);
    } else if (typeof frame?.sha256 !== "string" || frame.sha256.length === 0) {
      failures.push(`${frameLabel}_PNG_SHA_MISSING`);
    } else {
      verifyHash(failures, `${frameLabel}_PNG`, artifactDir, frame.png, frame.sha256);
    }

    if (frame?.raw == null) {
      failures.push(`${frameLabel}_RAW_MISSING`);
      continue;
    }
    if (typeof frame.raw !== "object") {
      failures.push(`${frameLabel}_RAW_NOT_OBJECT`);
      continue;
    }

    if (typeof frame.raw?.path !== "string" || frame.raw.path.length === 0) {
      failures.push(`${frameLabel}_RAW_PATH_MISSING`);
    } else {
      verifyHash(failures, `${frameLabel}_RAW`, artifactDir, frame.raw.path, frame.raw.sha256, frame.raw.byteCount);
    }
    if (typeof frame.raw?.sha256 !== "string" || frame.raw.sha256.length === 0) {
      failures.push(`${frameLabel}_RAW_SHA_MISSING`);
    }
    if (typeof frame.raw?.width !== "number" || frame.raw.width <= 0) {
      failures.push(`${frameLabel}_RAW_WIDTH_INVALID`);
    }
    if (typeof frame.raw?.height !== "number" || frame.raw.height <= 0) {
      failures.push(`${frameLabel}_RAW_HEIGHT_INVALID`);
    }
    if (typeof frame.raw?.bytesPerRow !== "number" || frame.raw.bytesPerRow <= 0) {
      failures.push(`${frameLabel}_RAW_BYTES_PER_ROW_INVALID`);
    }
    if (typeof frame.raw?.byteCount !== "number" || frame.raw.byteCount <= 0) {
      failures.push(`${frameLabel}_RAW_BYTE_COUNT_INVALID`);
    }
    if (frame.raw.source_planes != null && !Array.isArray(frame.raw.source_planes)) {
      failures.push(`${frameLabel}_SOURCE_PLANES_NOT_ARRAY`);
    }

    if (frame.raw.display) {
      if (typeof frame.raw.display !== "object") {
        failures.push(`${frameLabel}_DISPLAY_NOT_OBJECT`);
      } else {
        if (typeof frame.raw.display?.path !== "string" || frame.raw.display.path.length === 0) {
          failures.push(`${frameLabel}_DISPLAY_PATH_MISSING`);
          if (requiresRawDisplay) {
            failures.push(`${frameLabel}_DISPLAY_REQUIRED`);
          }
        } else {
          verifyHash(
            failures,
            `${frameLabel}_DISPLAY`,
            artifactDir,
            frame.raw.display.path,
            frame.raw.display.sha256,
            frame.raw.display.byteCount
          );
        }
        if (typeof frame.raw.display?.sha256 !== "string" || frame.raw.display.sha256.length === 0) {
          failures.push(`${frameLabel}_DISPLAY_SHA_MISSING`);
        }
        if (typeof frame.raw.display?.byteCount !== "number" || frame.raw.display.byteCount <= 0) {
          failures.push(`${frameLabel}_DISPLAY_BYTE_COUNT_INVALID`);
        }
      }
    } else if (requiresRawDisplay) {
      failures.push(`${frameLabel}_DISPLAY_REQUIRED`);
    }
  }

  if (expectedSequencePaths.length > 0 && expectedSequencePaths.length !== manifest.frames.length) {
    failures.push(`${baseLabel}_FRAME_COUNT_SEQUENCE_MISMATCH`);
  }
  for (let frameIndex = 0; frameIndex < expectedSequencePaths.length; frameIndex += 1) {
    const expectedPath = expectedSequenceMap.get(frameIndex);
    if (expectedPath && !sequenceMatches.has(expectedPath)) {
      failures.push(`${baseLabel}_SEQUENCE_FRAME_${frameIndex}_MISSING`);
    }
    if (expectedPath && !existsSync(expectedPath)) {
      failures.push(`${baseLabel}_SEQUENCE_FRAME_${frameIndex}_PATH_MISSING`);
    }
  }

  if (frameManifestSha && frameManifestSha.length) {
    const actual = sha256File(manifestPath);
    if (actual.toLowerCase() !== String(frameManifestSha).toLowerCase()) {
      failures.push(`${baseLabel}_SHA_MISMATCH`);
    }
  }
}

function verifyDeviceMatrix(task, manifestReports) {
  const requiredRoles = task.required_device_matrix_roles ?? [];
  if (requiredRoles.length === 0) {
    return {
      failures: [],
      summary: {
        required_roles: [],
        observed_roles: [],
        verified: true
      }
    };
  }

  const failures = [];
  const observedRoles = unique(manifestReports.map((report) => report.device_matrix_role).filter(Boolean));
  const reportsByRole = new Map();
  for (const report of manifestReports) {
    const role = report.device_matrix_role;
    if (!role) {
      failures.push(`${task.lane_task_id}:DEVICE_MATRIX_ROLE_MISSING`);
      continue;
    }
    if (!requiredRoles.includes(role)) {
      failures.push(`${task.lane_task_id}:DEVICE_MATRIX_ROLE_UNEXPECTED:${role}`);
      continue;
    }
    if (!reportsByRole.has(role)) reportsByRole.set(role, []);
    reportsByRole.get(role).push(report);
  }

  for (const role of requiredRoles) {
    const roleReports = reportsByRole.get(role) ?? [];
    if (roleReports.length === 0) {
      failures.push(`${task.lane_task_id}:DEVICE_MATRIX_ROLE_${role.toUpperCase()}_MISSING`);
      continue;
    }
    for (const report of roleReports) {
      for (const artifact of report.artifacts) {
        if (artifact.device_matrix_role !== role) {
          failures.push(`${task.lane_task_id}:DEVICE_MATRIX_ARTIFACT_ROLE_MISMATCH:${role}`);
        }
      }
    }
  }

  const roleDeviceKeys = Object.fromEntries(requiredRoles.map((role) => {
    const keys = unique((reportsByRole.get(role) ?? [])
      .flatMap((report) => report.artifacts.map((artifact) => artifact.device_key))
      .filter(Boolean));
    if (keys.length === 0) failures.push(`${task.lane_task_id}:DEVICE_MATRIX_ROLE_${role.toUpperCase()}_DEVICE_MISSING`);
    if (keys.length > 1) failures.push(`${task.lane_task_id}:DEVICE_MATRIX_ROLE_${role.toUpperCase()}_DEVICE_DRIFT`);
    return [role, keys[0] ?? null];
  }));
  const distinctKeys = unique(Object.values(roleDeviceKeys).filter(Boolean));
  if (distinctKeys.length < requiredRoles.length) {
    failures.push(`${task.lane_task_id}:DEVICE_MATRIX_DISTINCT_HARDWARE_REQUIRED`);
  }

  return {
    failures,
    summary: {
      required_roles: requiredRoles,
      observed_roles: observedRoles.sort(),
      role_device_keys: roleDeviceKeys,
      verified: failures.length === 0
    }
  };
}

function verifySceneContractFields(task, artifact, index) {
  const failures = [];
  const environment = artifact.environment ?? {};
  const framePack = artifact.frame_pack ?? {};
  verifyContractValue(failures, task, index, "BACKGROUND_PACK_ID", environment.background_pack_id, task.required_background_pack_id);
  verifyContractValue(failures, task, index, "BACKGROUND_ID", environment.background_id, task.required_background_id);
  verifyContractValue(failures, task, index, "BACKGROUND_PACK_SHA256", environment.background_pack_sha256, task.required_background_pack_sha256);
  verifyContractValue(failures, task, index, "GEOMETRY_PACK_ID", environment.geometry_pack_id, task.required_geometry_pack_id);
  verifyContractValue(failures, task, index, "GEOMETRY_ID", environment.geometry_id, task.required_geometry_id);
  verifyContractValue(failures, task, index, "GEOMETRY_PACK_SHA256", environment.geometry_pack_sha256, task.required_geometry_pack_sha256);
  verifyContractValue(failures, task, index, "CAPTURE_TIMELINE_PACK_ID", framePack.capture_timeline_pack_id, task.required_capture_timeline_pack_id);
  verifyContractValue(failures, task, index, "CAPTURE_TIMELINE_ID", framePack.capture_timeline_id, task.required_capture_timeline_id);
  verifyContractValue(failures, task, index, "CAPTURE_TIMELINE_SHA256", framePack.capture_timeline_sha256, task.required_capture_timeline_sha256);
  return failures;
}

function verifyContractValue(failures, task, index, label, actual, expected) {
  if (!expected) return;
  if (actual !== expected) failures.push(`${task.lane_task_id}:ARTIFACT_${index}_${label}_MISMATCH`);
}

function verifyFrameHashes(artifact, artifactPath, index, taskId) {
  const failures = [];
  const framePack = artifact.frame_pack ?? {};
  const artifactDir = dirname(artifactPath);
  verifyHash(failures, `${taskId}:ARTIFACT_${index}_BASE_PNG`, artifactDir, framePack.base_png_path, framePack.base_png_sha256);
  verifyHash(failures, `${taskId}:ARTIFACT_${index}_MASK_PACK`, artifactDir, framePack.mask_pack_path, framePack.mask_pack_sha256);
  verifyMaskPackContract(failures, `${taskId}:ARTIFACT_${index}_MASK_PACK`, artifactDir, framePack.mask_pack_path, artifact);
  for (const [frameIndex, rawPath] of (framePack.sequence_paths ?? []).entries()) {
    const path = resolveMaybe(artifactDir, rawPath);
    if (!existsSync(path)) failures.push(`${taskId}:ARTIFACT_${index}_SEQUENCE_FRAME_${frameIndex}_MISSING`);
  }
  return failures;
}

function verifyMaskPackContract(failures, label, baseDir, rawPath, artifact) {
  if (!rawPath) return;
  const path = resolveMaybe(baseDir, rawPath);
  if (!existsSync(path) || !statSync(path).isFile()) return;
  try {
    const maskPack = JSON.parse(readFileSync(path, "utf8"));
    for (const failure of validateMaskPack(maskPack, {
      sceneId: artifact.scene_id,
      stateId: artifact.state_id
    })) {
      failures.push(`${label}_${failure}`);
    }
  } catch (error) {
    failures.push(`${label}_JSON_INVALID:${error.message}`);
  }
}

function verifyHash(failures, label, baseDir, rawPath, expected, expectedByteCount = undefined) {
  if (!rawPath || !expected) {
    failures.push(`${label}_HASH_CONTRACT_MISSING`);
    return;
  }
  const path = resolveMaybe(baseDir, rawPath);
  if (!existsSync(path)) {
    failures.push(`${label}_MISSING`);
    return;
  }
  const stats = statSync(path);
  if (!stats.isFile()) {
    failures.push(`${label}_NOT_FILE`);
    return;
  }
  if (
    typeof expectedByteCount === "number" &&
    Number.isFinite(expectedByteCount) &&
    stats.size !== expectedByteCount
  ) {
    failures.push(`${label}_BYTE_COUNT_MISMATCH`);
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
    if (gate === "G6" && lanePolicy.sustained) {
      failures.push(...verifySustainedG6Report(report, lanePolicy));
    }
  }
  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    required_gate_ids: policy.required_gate_ids,
    provided_gate_ids: [...reportsByGate.keys()].sort()
  };
}

function verifySustainedManifestContract(task, manifest) {
  if (!task.requires_sustained_capture) return [];
  const failures = [];
  if (manifest.baseline_class !== "sustained") {
    failures.push(`${task.lane_task_id}:MANIFEST_BASELINE_CLASS_NOT_SUSTAINED`);
  }
  if (!atLeast(manifest.capture_duration_ms, task.required_sustained_duration_ms)) {
    failures.push(`${task.lane_task_id}:MANIFEST_SUSTAINED_CAPTURE_DURATION_INCOMPLETE`);
  }
  if (!atLeast(manifest.cooldown_ms, task.required_cooldown_ms)) {
    failures.push(`${task.lane_task_id}:MANIFEST_SUSTAINED_COOLDOWN_NOT_LOGGED`);
  }
  const thermal = manifest.thermal ?? {};
  if (thermal.initial_state !== "nominal") {
    failures.push(`${task.lane_task_id}:MANIFEST_THERMAL_INITIAL_NOT_NOMINAL`);
  }
  if (thermal.final_state === "serious" || thermal.final_state === "critical") {
    failures.push(`${task.lane_task_id}:MANIFEST_THERMAL_FINAL_${String(thermal.final_state).toUpperCase()}`);
  }
  return failures;
}

function verifySustainedArtifactFields(task, artifact, index) {
  if (!task.requires_sustained_capture) return [];
  const failures = [];
  const framePack = artifact.frame_pack ?? {};
  const perf = artifact.perf ?? {};
  const energy = artifact.energy ?? {};
  const device = artifact.device_info ?? {};
  if (!atLeast(framePack.sustained_duration_ms, task.required_sustained_duration_ms)) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_SUSTAINED_DURATION_INCOMPLETE`);
  }
  if (!isFiniteNumber(perf.sustained_degradation_pct)) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_SUSTAINED_DEGRADATION_NOT_RECORDED`);
  }
  if (!isFiniteNumber(perf.frame_interval_ms_p95)) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_SUSTAINED_FRAME_INTERVAL_P95_NOT_RECORDED`);
  }
  if (device.thermal_state_end === "serious" || device.thermal_state_end === "critical") {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_THERMAL_END_${String(device.thermal_state_end).toUpperCase()}`);
  }
  if (isFiniteNumber(energy.thermal_onset_ms) && energy.thermal_onset_ms >= 0) {
    failures.push(`${task.lane_task_id}:ARTIFACT_${index}_THERMAL_ONSET_IN_SUSTAINED_WINDOW`);
  }
  return failures;
}

function verifySustainedG6Report(report, lanePolicy) {
  const failures = [];
  const sustained = report.metrics?.sustained ?? {};
  const thermal = report.metrics?.thermal ?? {};
  if (!atLeast(sustained.duration_ms, lanePolicy.capture_duration_ms)) {
    failures.push("PHYSICAL_LANE_G6_SUSTAINED_DURATION_INCOMPLETE");
  }
  if (!isFiniteNumber(sustained.degradation_pct)) {
    failures.push("PHYSICAL_LANE_G6_SUSTAINED_DEGRADATION_NOT_RECORDED");
  }
  if (!isFiniteNumber(sustained.frame_interval_ms_p95)) {
    failures.push("PHYSICAL_LANE_G6_SUSTAINED_FRAME_INTERVAL_P95_NOT_RECORDED");
  }
  if (thermal.start_state !== "nominal") {
    failures.push("PHYSICAL_LANE_G6_THERMAL_START_NOT_NOMINAL");
  }
  if (thermal.end_state === "serious" || thermal.end_state === "critical") {
    failures.push(`PHYSICAL_LANE_G6_THERMAL_END_${String(thermal.end_state).toUpperCase()}`);
  }
  return failures;
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

function atLeast(value, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function unique(values) {
  return [...new Set(values)];
}
