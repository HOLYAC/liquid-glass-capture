import { dirname, isAbsolute, resolve } from "node:path";
import { readPng } from "./lab-png.mjs";

export function readArtifactFrameSequence(record) {
  const framePack = record.artifact.frame_pack ?? {};
  const rawPaths = Array.isArray(framePack.sequence_paths) && framePack.sequence_paths.length > 0
    ? framePack.sequence_paths
    : [framePack.base_png_path];
  const artifactDir = dirname(record.artifact_path);
  const paths = rawPaths.map((path) => (isAbsolute(path) ? path : resolve(artifactDir, path)));
  const timestampsMs = Array.isArray(framePack.sequence_timestamps_ms)
    ? framePack.sequence_timestamps_ms
    : undefined;

  return {
    artifact_id: record.artifact.id,
    rig_id: record.artifact.rig_id,
    scene_id: record.artifact.scene_id,
    state_id: record.artifact.state_id,
    trajectory_source_sha256: framePack.trajectory_source_sha256,
    paths,
    timestamps_ms: timestampsMs,
    frames: paths.map((path, index) => ({
      path,
      timestamp_ms: timestampsMs?.[index],
      png: readPng(path)
    }))
  };
}
