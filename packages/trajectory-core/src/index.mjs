import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const trajectorySchemaVersion = "1.2.0";
export const trajectoryAuthority = "single_source_trajectory";
export const compiledTrajectoryAuthority = "compiled_from_single_source_trajectory";
export const trajectoryConsumerKinds = Object.freeze(["xcuitest", "pointer_events"]);

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

export function readTrajectorySource(path) {
  const absolutePath = resolve(path);
  const source = JSON.parse(readFileSync(absolutePath, "utf8"));
  return {
    path: absolutePath,
    source,
    source_sha256: sha256File(absolutePath)
  };
}

export function listTrajectorySources(gestureDir) {
  const absoluteDir = resolve(gestureDir);
  return readdirSync(absoluteDir)
    .filter((name) => name.endsWith(".trajectory.json"))
    .sort()
    .map((name) => readTrajectorySource(`${absoluteDir}/${name}`));
}

export function validateTrajectorySource(source) {
  const failures = [];
  if (!source || typeof source !== "object") return ["TRAJECTORY_SOURCE_REQUIRED"];
  if (source.schema_version !== trajectorySchemaVersion) failures.push("TRAJECTORY_SCHEMA_VERSION");
  if (!nonEmpty(source.gesture_id)) failures.push("TRAJECTORY_GESTURE_ID_REQUIRED");
  if (!nonEmpty(source.scene_id)) failures.push("TRAJECTORY_SCENE_ID_REQUIRED");
  if (source.authority !== trajectoryAuthority) failures.push(`${source.scene_id ?? "UNKNOWN"}:TRAJECTORY_AUTHORITY`);
  if (source.coordinate_space !== "viewport_px") failures.push(`${source.scene_id ?? "UNKNOWN"}:TRAJECTORY_COORDINATE_SPACE`);
  if (!Array.isArray(source.samples) || source.samples.length < 2) failures.push(`${source.scene_id ?? "UNKNOWN"}:TRAJECTORY_SAMPLES_REQUIRED`);

  let previousT = -Infinity;
  for (const [index, sample] of (source.samples ?? []).entries()) {
    const prefix = `${source.scene_id ?? "UNKNOWN"}:SAMPLE_${index}`;
    if (!["down", "move", "up"].includes(sample?.phase)) failures.push(`${prefix}:PHASE`);
    if (sample?.unit !== "normalized") failures.push(`${prefix}:UNIT`);
    for (const key of ["x", "y", "t", "pressure"]) {
      if (!Number.isFinite(sample?.[key])) failures.push(`${prefix}:${key.toUpperCase()}_NUMBER`);
    }
    if (Number.isFinite(sample?.x) && (sample.x < 0 || sample.x > 1)) failures.push(`${prefix}:X_RANGE`);
    if (Number.isFinite(sample?.y) && (sample.y < 0 || sample.y > 1)) failures.push(`${prefix}:Y_RANGE`);
    if (Number.isFinite(sample?.pressure) && (sample.pressure < 0 || sample.pressure > 1)) failures.push(`${prefix}:PRESSURE_RANGE`);
    if (Number.isFinite(sample?.t) && sample.t < previousT) failures.push(`${prefix}:TIME_MONOTONIC`);
    if (Number.isFinite(sample?.t)) previousT = sample.t;
  }

  const first = source.samples?.[0];
  const last = source.samples?.[source.samples.length - 1];
  if (first?.phase !== "down") failures.push(`${source.scene_id ?? "UNKNOWN"}:TRAJECTORY_FIRST_PHASE_DOWN`);
  if (last?.phase !== "up") failures.push(`${source.scene_id ?? "UNKNOWN"}:TRAJECTORY_LAST_PHASE_UP`);
  for (const kind of trajectoryConsumerKinds) {
    if (!nonEmpty(source.compiled_consumers?.[kind])) failures.push(`${source.scene_id ?? "UNKNOWN"}:${kind.toUpperCase()}_CONSUMER_PATH_REQUIRED`);
  }

  return unique(failures);
}

export function compilePointerEvents(source, sourceSha256) {
  return compiledBase(source, sourceSha256, "pointer_events", {
    events: source.samples.map((sample, index) => ({
      index,
      type: pointerEventType(sample.phase),
      time_s: sample.t,
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure,
      unit: sample.unit,
      pointer_id: 1,
      pointer_type: "touch"
    }))
  });
}

export function compileXCUITest(source, sourceSha256) {
  return compiledBase(source, sourceSha256, "xcuitest", {
    events: source.samples.map((sample, index) => ({
      index,
      command: xcuiCommand(sample.phase),
      at_seconds: sample.t,
      normalized_x: sample.x,
      normalized_y: sample.y,
      pressure: sample.pressure,
      unit: sample.unit
    }))
  });
}

export function validateCompiledConsumer(sourceRecord, consumerKind, compiled, consumerPath) {
  const failures = [];
  if (!trajectoryConsumerKinds.includes(consumerKind)) failures.push(`UNKNOWN_CONSUMER_${consumerKind}`);
  const expected = consumerKind === "xcuitest"
    ? compileXCUITest(sourceRecord.source, sourceRecord.source_sha256)
    : compilePointerEvents(sourceRecord.source, sourceRecord.source_sha256);

  if (!existsSync(resolve(consumerPath))) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:CONSUMER_FILE_MISSING`);
  if (compiled.schema_version !== trajectorySchemaVersion) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:SCHEMA_VERSION`);
  if (compiled.kind !== "compiled_trajectory_consumer") failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:KIND`);
  if (compiled.authority !== compiledTrajectoryAuthority) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:AUTHORITY`);
  if (compiled.consumer !== consumerKind) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:CONSUMER_KIND`);
  if (compiled.scene_id !== sourceRecord.source.scene_id) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:SCENE_ID`);
  if (compiled.gesture_id !== sourceRecord.source.gesture_id) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:GESTURE_ID`);
  if (compiled.source_sha256 !== sourceRecord.source_sha256) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:SOURCE_SHA256`);
  if (stableJson(compiled) !== stableJson(expected)) failures.push(`${sourceRecord.source.scene_id}:${consumerKind}:COMPILED_EVENTS_DRIFT`);
  return unique(failures);
}

export function sourceFileNameForScene(sceneId) {
  return `${sceneId}.trajectory.json`;
}

function compiledBase(source, sourceSha256, consumer, body) {
  return {
    schema_version: trajectorySchemaVersion,
    kind: "compiled_trajectory_consumer",
    consumer,
    authority: compiledTrajectoryAuthority,
    scene_id: source.scene_id,
    gesture_id: source.gesture_id,
    source_sha256: sourceSha256,
    source_file: `fixtures/gestures/${sourceFileNameForScene(source.scene_id)}`,
    source_coordinate_space: source.coordinate_space,
    notes: "Generated from trajectory source; do not edit by hand.",
    ...body
  };
}

function pointerEventType(phase) {
  if (phase === "down") return "pointerdown";
  if (phase === "up") return "pointerup";
  return "pointermove";
}

function xcuiCommand(phase) {
  if (phase === "down") return "press_begin";
  if (phase === "up") return "press_end";
  return "press_move";
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values) {
  return [...new Set(values)];
}
