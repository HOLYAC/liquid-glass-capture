export const materialProbeSchemaVersion = "1.2.0";

export function validateMaterialProbe(probe) {
  const failures = [];
  if (!probe || typeof probe !== "object") {
    return ["MATERIAL_PROBE_REQUIRED"];
  }

  if (probe.schema_version !== materialProbeSchemaVersion) failures.push("MATERIAL_PROBE_SCHEMA_VERSION");
  if (!nonEmpty(probe.material_id)) failures.push("MATERIAL_PROBE_ID_REQUIRED");
  if (!Array.isArray(probe.scenes) || probe.scenes.length === 0) failures.push("MATERIAL_PROBE_SCENES_REQUIRED");
  if (!probe.mask_pack || typeof probe.mask_pack !== "object") failures.push("MATERIAL_PROBE_MASK_PACK_REQUIRED");
  if (!probe.null_ladder || typeof probe.null_ladder !== "object") failures.push("MATERIAL_PROBE_NULL_LADDER_REQUIRED");

  const sceneIds = new Set();
  const statePairs = new Set();
  for (const [sceneIndex, scene] of (probe.scenes ?? []).entries()) {
    const prefix = `SCENE_${sceneIndex}`;
    if (!nonEmpty(scene.scene_id)) failures.push(`${prefix}_ID_REQUIRED`);
    if (sceneIds.has(scene.scene_id)) failures.push(`${scene.scene_id}:SCENE_DUPLICATE`);
    sceneIds.add(scene.scene_id);
    if (!nonEmpty(scene.mask_pack_id)) failures.push(`${scene.scene_id}:MASK_PACK_ID_REQUIRED`);
    if (!Array.isArray(scene.states) || scene.states.length === 0) failures.push(`${scene.scene_id}:STATES_REQUIRED`);

    for (const [stateIndex, state] of (scene.states ?? []).entries()) {
      const statePrefix = `${scene.scene_id}:STATE_${stateIndex}`;
      if (!nonEmpty(state.state_id)) failures.push(`${statePrefix}_ID_REQUIRED`);
      const pair = `${scene.scene_id}/${state.state_id}`;
      if (statePairs.has(pair)) failures.push(`${pair}:STATE_DUPLICATE`);
      statePairs.add(pair);
      if (!nonEmpty(state.substrate)) failures.push(`${pair}:SUBSTRATE_REQUIRED`);
      if (!nonEmpty(state.shape)) failures.push(`${pair}:SHAPE_REQUIRED`);
      if (!nonEmpty(state.phase)) failures.push(`${pair}:PHASE_REQUIRED`);
      if (!nonEmpty(state.touch_phase)) failures.push(`${pair}:TOUCH_PHASE_REQUIRED`);
      if (!nonEmpty(state.content_seed) && !nonEmpty(state.background_asset_hash)) {
        failures.push(`${pair}:CONTENT_SEED_OR_BACKGROUND_HASH_REQUIRED`);
      }
    }
  }

  const maskIds = new Set((probe.mask_pack?.masks ?? []).map((mask) => mask.id));
  for (const requiredMask of probe.required_mask_ids ?? []) {
    if (!maskIds.has(requiredMask)) failures.push(`MASK_REQUIRED_${requiredMask}`);
  }
  for (const sceneId of sceneIds) {
    if (!(probe.mask_pack?.scene_coverage ?? []).includes(sceneId)) {
      failures.push(`${sceneId}:MASK_COVERAGE_MISSING`);
    }
  }

  if (probe.null_ladder?.scene_id !== "S00_NULL") failures.push("NULL_LADDER_SCENE_MUST_BE_S00_NULL");
  for (const rung of probe.null_ladder?.rungs ?? []) {
    const pair = `S00_NULL/${rung.state_id ?? rung.id}`;
    if (!statePairs.has(pair)) failures.push(`${pair}:NULL_LADDER_STATE_NOT_IN_SCENE_MATRIX`);
  }

  return unique(failures);
}

export function assertMaterialProbe(probe) {
  const failures = validateMaterialProbe(probe);
  if (failures.length > 0) {
    throw new Error(`material probe invalid: ${failures.join(", ")}`);
  }
  return probe;
}

export function sceneStateMatrix(probe) {
  const matrix = {};
  for (const scene of probe.scenes ?? []) {
    matrix[scene.scene_id] = Object.freeze((scene.states ?? []).map((state) => state.state_id));
  }
  return deepFreeze(matrix);
}

export function sceneDefaultsById(probe) {
  const defaults = {};
  for (const scene of probe.scenes ?? []) {
    const defaultState = scene.states?.find((state) => state.default === true) ?? scene.states?.[0];
    defaults[scene.scene_id] = Object.freeze({
      states: Object.freeze((scene.states ?? []).map((state) => state.state_id)),
      touchPhase: defaultState?.touch_phase,
      contentSeed: defaultState?.content_seed,
      backgroundAssetHash: defaultState?.background_asset_hash,
      trajectorySourceSha256: scene.trajectory_source_sha256,
      defaultStateId: defaultState?.state_id
    });
  }
  return deepFreeze(defaults);
}

export function sceneById(probe, sceneId) {
  return (probe.scenes ?? []).find((scene) => scene.scene_id === sceneId) ?? null;
}

export function stateById(probe, sceneId, stateId) {
  const scene = sceneById(probe, sceneId);
  return scene?.states?.find((state) => state.state_id === stateId) ?? null;
}

export function validateSceneState(probe, sceneId, stateId) {
  const scene = sceneById(probe, sceneId);
  if (!scene) return [`UNSUPPORTED_SCENE_${sceneId}`];
  if (!stateById(probe, sceneId, stateId)) return [`STATE_${stateId}_NOT_VALID_FOR_${sceneId}`];
  return [];
}

export function metadataForSceneState(probe, { sceneId, stateId }) {
  const scene = sceneById(probe, sceneId);
  const state = stateById(probe, sceneId, stateId);
  if (!scene || !state) {
    throw new Error(`unknown material scene/state: ${sceneId}/${stateId}`);
  }

  const metadata = {
    sceneId,
    stateId,
    touchPhase: state.touch_phase
  };
  if (state.content_seed) metadata.contentSeed = state.content_seed;
  if (state.background_asset_hash) metadata.backgroundAssetHash = state.background_asset_hash;
  if (scene.trajectory_source_sha256) metadata.trajectorySourceSha256 = scene.trajectory_source_sha256;
  return metadata;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values) {
  return [...new Set(values)];
}
