export const sceneContractSchemaVersion = "1.2.0";
export const glassBackgroundPackId = "glass_background_pack_v1";
export const glassGeometryPackId = "glass_geometry_pack_v1";
export const glassCaptureTimelinePackId = "glass_capture_timeline_pack_v1";

export function sceneStateKey(sceneId, stateId) {
  return `${sceneId}/${stateId}`;
}

export function geometryIdFor(sceneId, state) {
  return `${sceneId}__${state.state_id}__${state.shape}__${state.phase}__geometry_v1`;
}

export function captureTimelineIdFor(sceneId, state) {
  return `${sceneId}__${state.state_id}__${state.touch_phase}__timeline_v1`;
}

export function backgroundIdFor(sceneId, state) {
  return `${sceneId}__${state.state_id}__${state.substrate}__background_v1`;
}

export function sceneContractMaps(probe) {
  const background = {};
  const geometry = {};
  const timeline = {};
  for (const scene of probe.scenes ?? []) {
    for (const state of scene.states ?? []) {
      const key = sceneStateKey(scene.scene_id, state.state_id);
      background[key] = Object.freeze({
        background_pack_id: state.background_pack_id,
        background_id: state.background_id,
        background_pack_sha256: state.background_pack_sha256
      });
      geometry[key] = Object.freeze({
        geometry_pack_id: state.geometry_pack_id,
        geometry_id: state.geometry_id,
        geometry_pack_sha256: state.geometry_pack_sha256
      });
      timeline[key] = Object.freeze({
        capture_timeline_pack_id: state.capture_timeline_pack_id,
        capture_timeline_id: state.capture_timeline_id,
        capture_timeline_sha256: state.capture_timeline_sha256
      });
    }
  }
  return deepFreeze({ background, geometry, timeline });
}

export function validateSceneContract({
  probe,
  backgroundPack,
  geometryPack,
  timelinePack,
  expectedBackgroundSha256,
  expectedGeometrySha256,
  expectedTimelineSha256
}) {
  const failures = [];
  failures.push(...validatePackEnvelope(backgroundPack, {
    kind: "background_pack",
    idKey: "background_pack_id",
    id: glassBackgroundPackId
  }));
  failures.push(...validatePackEnvelope(geometryPack, {
    kind: "geometry_pack",
    idKey: "geometry_pack_id",
    id: glassGeometryPackId
  }));
  failures.push(...validatePackEnvelope(timelinePack, {
    kind: "capture_timeline_pack",
    idKey: "capture_timeline_pack_id",
    id: glassCaptureTimelinePackId
  }));

  const backgroundByKey = new Map((backgroundPack.backgrounds ?? []).map((entry) => [sceneStateKey(entry.scene_id, entry.state_id), entry]));
  const geometryByKey = new Map((geometryPack.scene_geometry ?? []).map((entry) => [sceneStateKey(entry.scene_id, entry.state_id), entry]));
  const timelineByKey = new Map((timelinePack.timelines ?? []).map((entry) => [sceneStateKey(entry.scene_id, entry.state_id), entry]));
  const seenKeys = new Set();

  for (const scene of probe.scenes ?? []) {
    for (const state of scene.states ?? []) {
      const key = sceneStateKey(scene.scene_id, state.state_id);
      seenKeys.add(key);

      const background = backgroundByKey.get(key);
      if (!background) {
        failures.push(`${key}:BACKGROUND_ENTRY_MISSING`);
      } else {
        if (background.substrate !== state.substrate) failures.push(`${key}:BACKGROUND_SUBSTRATE_MISMATCH`);
        if (background.background_id !== backgroundIdFor(scene.scene_id, state)) failures.push(`${key}:BACKGROUND_ID_MISMATCH`);
        if (background.content_seed !== state.content_seed) failures.push(`${key}:BACKGROUND_CONTENT_SEED_MISMATCH`);
        if ((background.background_asset_hash ?? null) !== (state.background_asset_hash ?? null)) failures.push(`${key}:BACKGROUND_ASSET_HASH_MISMATCH`);
        if (background.kind === "asset" && !background.background_asset_hash) failures.push(`${key}:BACKGROUND_ASSET_HASH_REQUIRED`);
        if (background.kind === "procedural" && background.background_asset_hash) failures.push(`${key}:BACKGROUND_PROCEDURAL_HAS_ASSET_HASH`);
      }

      const geometry = geometryByKey.get(key);
      if (!geometry) {
        failures.push(`${key}:GEOMETRY_ENTRY_MISSING`);
      } else {
        if (geometry.shape !== state.shape) failures.push(`${key}:GEOMETRY_SHAPE_MISMATCH`);
        if (geometry.phase !== state.phase) failures.push(`${key}:GEOMETRY_PHASE_MISMATCH`);
        if (geometry.geometry_id !== geometryIdFor(scene.scene_id, state)) failures.push(`${key}:GEOMETRY_ID_MISMATCH`);
      }

      const timeline = timelineByKey.get(key);
      if (!timeline) {
        failures.push(`${key}:TIMELINE_ENTRY_MISSING`);
      } else {
        if (timeline.touch_phase !== state.touch_phase) failures.push(`${key}:TIMELINE_TOUCH_PHASE_MISMATCH`);
        if (timeline.capture_timeline_id !== captureTimelineIdFor(scene.scene_id, state)) failures.push(`${key}:TIMELINE_ID_MISMATCH`);
        failures.push(...validateTimelineSamples(key, timeline));
      }

      if (state.background_pack_id !== glassBackgroundPackId) failures.push(`${key}:STATE_BACKGROUND_PACK_ID`);
      if (state.background_id !== backgroundIdFor(scene.scene_id, state)) failures.push(`${key}:STATE_BACKGROUND_ID`);
      if (state.background_pack_sha256 !== expectedBackgroundSha256) failures.push(`${key}:STATE_BACKGROUND_SHA`);
      if (state.geometry_pack_id !== glassGeometryPackId) failures.push(`${key}:STATE_GEOMETRY_PACK_ID`);
      if (state.geometry_id !== geometryIdFor(scene.scene_id, state)) failures.push(`${key}:STATE_GEOMETRY_ID`);
      if (state.geometry_pack_sha256 !== expectedGeometrySha256) failures.push(`${key}:STATE_GEOMETRY_SHA`);
      if (state.capture_timeline_pack_id !== glassCaptureTimelinePackId) failures.push(`${key}:STATE_TIMELINE_PACK_ID`);
      if (state.capture_timeline_id !== captureTimelineIdFor(scene.scene_id, state)) failures.push(`${key}:STATE_TIMELINE_ID`);
      if (state.capture_timeline_sha256 !== expectedTimelineSha256) failures.push(`${key}:STATE_TIMELINE_SHA`);
    }
  }

  for (const key of backgroundByKey.keys()) {
    if (!seenKeys.has(key)) failures.push(`${key}:BACKGROUND_ENTRY_WITHOUT_SCENE_STATE`);
  }
  for (const key of geometryByKey.keys()) {
    if (!seenKeys.has(key)) failures.push(`${key}:GEOMETRY_ENTRY_WITHOUT_SCENE_STATE`);
  }
  for (const key of timelineByKey.keys()) {
    if (!seenKeys.has(key)) failures.push(`${key}:TIMELINE_ENTRY_WITHOUT_SCENE_STATE`);
  }

  return unique(failures);
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validatePackEnvelope(pack, { kind, idKey, id }) {
  const failures = [];
  if (!pack || typeof pack !== "object") return [`${kind}:PACK_REQUIRED`];
  if (pack.schema_version !== sceneContractSchemaVersion) failures.push(`${kind}:SCHEMA_VERSION`);
  if (pack.kind !== kind) failures.push(`${kind}:KIND`);
  if (pack[idKey] !== id) failures.push(`${kind}:ID`);
  return failures;
}

function validateTimelineSamples(key, timeline) {
  const failures = [];
  if (!Array.isArray(timeline.sample_times_ms) || timeline.sample_times_ms.length === 0) {
    failures.push(`${key}:TIMELINE_SAMPLES_REQUIRED`);
  }
  if (!Array.isArray(timeline.animation_t) || timeline.animation_t.length !== timeline.sample_times_ms?.length) {
    failures.push(`${key}:TIMELINE_ANIMATION_T_LENGTH`);
  }
  let previous = -Infinity;
  for (const [index, sampleTime] of (timeline.sample_times_ms ?? []).entries()) {
    if (!Number.isFinite(sampleTime)) failures.push(`${key}:TIMELINE_SAMPLE_${index}_NUMBER`);
    if (Number.isFinite(sampleTime) && sampleTime < previous) failures.push(`${key}:TIMELINE_SAMPLE_${index}_MONOTONIC`);
    previous = Number.isFinite(sampleTime) ? sampleTime : previous;
  }
  if (!Number.isFinite(timeline.duration_ms) || timeline.duration_ms < 0) failures.push(`${key}:TIMELINE_DURATION`);
  const last = timeline.sample_times_ms?.[timeline.sample_times_ms.length - 1];
  if (Number.isFinite(last) && Number.isFinite(timeline.duration_ms) && last > timeline.duration_ms) {
    failures.push(`${key}:TIMELINE_SAMPLE_AFTER_DURATION`);
  }
  return failures;
}

function unique(values) {
  return [...new Set(values)];
}
