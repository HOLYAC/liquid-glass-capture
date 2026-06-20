import {
  assertMaterialProbe,
  deepFreeze,
  metadataForSceneState,
  sceneDefaultsById,
  sceneStateMatrix,
  stateById,
  validateSceneState
} from "../../material-core/src/index.mjs";
import {
  backgroundIdFor,
  captureTimelineIdFor,
  geometryIdFor,
  glassBackgroundPackId,
  glassCaptureTimelinePackId,
  glassGeometryPackId,
  sceneContractMaps
} from "../../scene-contract/src/index.mjs";
import { buildSceneMaskEntries } from "../../mask-core/src/index.mjs";

export const glassMaskPackId = "glass_core_mask_pack_v1";
export const glassMaskPackSha256 = "19c6ff2fef5781d98f3e509c302bceab37e40c03bc1f51627dd79b5c1f3493e9";
export const glassBackgroundPackSha256 = "5c305dcadc6d32b7ca9366c5b82793345e791a3e7c5c58b46c3da5557450d877";
export const glassGeometryPackSha256 = "a7fa221f4cef5ee74492be403aa2dbe7a153f18cf0d41f84dbb43703d64c3425";
export const glassCaptureTimelinePackSha256 = "61c15338f00fce2349bcbcc05103643664fd248e28d7411772131e1796babd13";
export const s02LoupeTrajectorySha256 = "33a896a5ee2615762df4248ce2f3a327fe036d8a7df43deea316641118796f5c";
export const s03PressTrajectorySha256 = "f3f1fb6f521cc525cdf5957a2c96682ec6e9098f34a1708c0621ce50a8fee376";
export const s04MorphTrajectorySha256 = "2d56ff34315a85689661f74b5ea3d0a70144bf36c77546a1ffe9fb9e9cf3b5bd";
export const glassGestureSceneIds = deepFreeze(["S02_LOUPE", "S03_PRESS", "S04_MORPH"]);

export const glassMaskPack = deepFreeze({
  schema_version: "1.2.0",
  mask_pack_id: glassMaskPackId,
  description: "Scene/state mask pack for the full S00-S12 Apple Liquid Glass parity matrix. Metric tools rasterize fixed regions before scoring.",
  source: "packages/material-glass/src/index.mjs",
  scene_coverage: [
    "S00_NULL",
    "S01_SEARCH",
    "S02_LOUPE",
    "S03_PRESS",
    "S04_MORPH",
    "S05_FLOATING_BAR",
    "S06_TINY_GLASS",
    "S07_BUSY_PHOTO",
    "S08_P3_GRADIENT",
    "S09_NEAR_WHITE",
    "S10_NEAR_BLACK",
    "S11_VIDEO_FRAME",
    "S12_SYSTEM_MATERIAL_ADJACENCY"
  ],
  masks: [
    { id: "core", purpose: "body glass" },
    { id: "edge_band", purpose: "lens edge and refraction boundary" },
    { id: "highlight", purpose: "specular placement and width" },
    { id: "text", purpose: "glyph contrast and legibility" },
    { id: "text_halo", purpose: "glyph edge clarity over material" },
    { id: "background_control", purpose: "background false-positive guard" },
    { id: "motion_path", purpose: "temporal phase" },
    { id: "compositor_region", purpose: "DOM/WebKit layer cost" },
    { id: "product_focus", purpose: "real UI hierarchy priority" }
  ]
});

export const glassNullLadderManifest = deepFreeze({
  schema_version: "1.2.0",
  scene_id: "S00_NULL",
  purpose: "Pipeline qualification fixture. Candidate renders identity; no glass is present.",
  source: "packages/material-glass/src/index.mjs",
  rungs: [
    { id: "flat_p3_grey", state_id: "s00_flat_grey", kind: "flat", content_seed: "s00-flat-p3-grey-v1", expected_null: "byte_equal" },
    { id: "hard_edge", state_id: "s00_hard_edge", kind: "edge", content_seed: "s00-hard-edge-v1", expected_null: "byte_equal" },
    { id: "p3_ramp", state_id: "s00_p3_ramp", kind: "ramp", content_seed: "s00-p3-ramp-v1", expected_null: "gamut_path_flat" },
    { id: "smooth_gradient", state_id: "s00_smooth_gradient", kind: "gradient", content_seed: "s00-smooth-gradient-v1", expected_null: "structural_flat_after_noise_separator" }
  ],
  policy: {
    flat_p3_grey: { max_abs_channel_delta: 0, mean_abs_channel_delta: 0 },
    hard_edge: { max_abs_channel_delta: 0, mean_abs_channel_delta: 0 },
    p3_ramp: { max_abs_channel_delta: 1, mean_abs_channel_delta: 0.25 },
    smooth_gradient: { max_abs_channel_delta: 2, mean_abs_channel_delta: 0.5, gradient_mean_abs_delta: 0.25 }
  }
});

export const glassMaterialProbe = assertMaterialProbe(deepFreeze({
  schema_version: "1.2.0",
  material_id: "apple_liquid_glass_parity",
  display_name: "Apple Liquid Glass Parity Probe",
  owner: "packages/material-glass",
  mask_pack: glassMaskPack,
  required_mask_ids: glassMaskPack.masks.map((mask) => mask.id),
  null_ladder: glassNullLadderManifest,
  gesture_scene_ids: glassGestureSceneIds,
  degeneracy_scene_ids: ["S07_BUSY_PHOTO", "S08_P3_GRADIENT", "S09_NEAR_WHITE", "S10_NEAR_BLACK", "S11_VIDEO_FRAME"],
  core_scene_ids: ["S01_SEARCH", "S02_LOUPE", "S03_PRESS", "S04_MORPH", "S05_FLOATING_BAR"],
  stress_scene_ids: ["S06_TINY_GLASS", "S07_BUSY_PHOTO", "S08_P3_GRADIENT", "S09_NEAR_WHITE", "S10_NEAR_BLACK", "S11_VIDEO_FRAME", "S12_SYSTEM_MATERIAL_ADJACENCY"],
  scenes: [
    scene("S00_NULL", "qualification", [
      state("s00_flat_grey", "s00_flat_grey", "capsule", "rest", "rest", "s00-flat-p3-grey-v1", { mode: "substrate_only", default: true }),
      state("s00_hard_edge", "s00_hard_edge", "capsule", "rest", "rest", "s00-hard-edge-v1", { mode: "substrate_only" }),
      state("s00_p3_ramp", "s00_p3_ramp", "capsule", "rest", "rest", "s00-p3-ramp-v1", { mode: "substrate_only" }),
      state("s00_smooth_gradient", "s00_smooth_gradient", "capsule", "rest", "rest", "s00-smooth-gradient-v1", { mode: "substrate_only" })
    ]),
    scene("S01_SEARCH", "core", [
      state("rest", "native_text_selection", "capsule", "rest", "rest", "s01-search-selection-v1", { interactive: true })
    ]),
    scene("S02_LOUPE", "core", [
      state("drag", "loupe_text", "circle", "drag_right", "drag", "s02-loupe-text-drag-v1", { interactive: true, autoplay: true })
    ], { trajectory_source_sha256: s02LoupeTrajectorySha256 }),
    scene("S03_PRESS", "core", [
      state("press", "tiny_control_content", "capsule", "press", "press", "s03-press-control-v1", { interactive: true, autoplay: true })
    ], { trajectory_source_sha256: s03PressTrajectorySha256 }),
    scene("S04_MORPH", "core", [
      state("morph", "floating_bar_content", "twin_capsules", "morph_tall", "morph", "s04-twin-capsule-morph-v1", { interactive: true, autoplay: true })
    ], { trajectory_source_sha256: s04MorphTrajectorySha256 }),
    scene("S05_FLOATING_BAR", "core", [
      state("floating_rest", "floating_bar_content", "capsule", "rest", "rest", "s05-floating-bar-v1", { interactive: true })
    ]),
    scene("S06_TINY_GLASS", "stress", [
      state("tiny_rest", "tiny_control_content", "circle", "rest", "rest", "s06-tiny-control-v1", { interactive: true })
    ]),
    scene("S07_BUSY_PHOTO", "stress", [
      state("busy_photo_rest", "busy_photo", "capsule", "rest", "rest", "s07-busy-photo-procedural-v1", {
        background_asset_hash: "77238364440e942b31adefec365389a6f2c25a9b0a5561945db9468f8337f148"
      })
    ]),
    scene("S08_P3_GRADIENT", "stress", [
      state("p3_gradient_rest", "p3_saturated_gradient", "capsule", "rest", "rest", "s08-p3-saturated-gradient-v1")
    ]),
    scene("S09_NEAR_WHITE", "stress", [
      state("near_white_rest", "near_white", "capsule", "rest", "rest", "s09-near-white-v1")
    ]),
    scene("S10_NEAR_BLACK", "stress", [
      state("near_black_rest", "near_black", "capsule", "rest", "rest", "s10-near-black-v1")
    ]),
    scene("S11_VIDEO_FRAME", "stress", [
      state("video_frame_rest", "video_frame", "capsule", "rest", "rest", "s11-video-high-frequency-procedural-v1", {
        autoplay: true,
        background_asset_hash: "e976e690f06f8b955a86ab8e49d2fcef51f942c220e975a03c30d414702998a5"
      })
    ]),
    scene("S12_SYSTEM_MATERIAL_ADJACENCY", "stress", [
      state("system_material_rest", "system_material_adjacency", "twin_capsules", "merge_near", "morph", "s12-system-material-adjacency-procedural-v1", {
        interactive: true,
        background_asset_hash: "15cc42e8ad24fd0179d917962281292ea97ea735ceb12796f8eb681e92049fe6"
      })
    ])
  ]
}));

export const glassSceneMaskPack = deepFreeze({
  ...glassMaskPack,
  scene_masks: buildSceneMaskEntries(glassMaterialProbe)
});

export const glassSceneStateMatrix = sceneStateMatrix(glassMaterialProbe);
export const glassSceneDefaults = sceneDefaultsById(glassMaterialProbe);
export const glassSceneIds = Object.freeze(glassMaterialProbe.scenes.map((entry) => entry.scene_id));
export const glassDegeneracySceneIds = glassMaterialProbe.degeneracy_scene_ids;
export const glassDegeneracyScenePrefixes = Object.freeze(glassDegeneracySceneIds.map((sceneId) => sceneId.slice(0, 3)));
export const glassSceneContractMaps = sceneContractMaps(glassMaterialProbe);
export const glassBackgroundBySceneState = glassSceneContractMaps.background;
export const glassGeometryBySceneState = glassSceneContractMaps.geometry;
export const glassCaptureTimelineBySceneState = glassSceneContractMaps.timeline;
export const glassTrajectoryShaByScene = deepFreeze(Object.fromEntries(
  glassMaterialProbe.scenes
    .filter((entry) => entry.trajectory_source_sha256)
    .map((entry) => [entry.scene_id, entry.trajectory_source_sha256])
));
export const glassDefaultDeviceLaneTasks = deepFreeze([
  { rig_id: "R0", scene_id: "S01_SEARCH", state_id: "rest" },
  { rig_id: "R1", scene_id: "S01_SEARCH", state_id: "rest" },
  { rig_id: "C1", scene_id: "S03_PRESS", state_id: "press" },
  { rig_id: "DOM_C", scene_id: "S01_SEARCH", state_id: "rest" },
  ...glassMaterialProbe.scenes
    .filter((entry) => ["S02_LOUPE", "S04_MORPH", "S05_FLOATING_BAR", "S06_TINY_GLASS", ...glassDegeneracySceneIds, "S12_SYSTEM_MATERIAL_ADJACENCY"].includes(entry.scene_id))
    .map((entry) => ({ rig_id: "C1", scene_id: entry.scene_id, state_id: entry.states[0].state_id }))
]);

export function validateGlassSceneState(sceneId, stateId) {
  return validateSceneState(glassMaterialProbe, sceneId, stateId);
}

export function metadataForGlassSceneState(sceneId, stateId) {
  return metadataForSceneState(glassMaterialProbe, { sceneId, stateId });
}

export function glassStateFor(sceneId, stateId) {
  return stateById(glassMaterialProbe, sceneId, stateId);
}

function scene(scene_id, class_id, states, extras = {}) {
  return {
    scene_id,
    class_id,
    mask_pack_id: glassMaskPackId,
    states: states.map((entry) => bindSceneContract(scene_id, entry)),
    ...extras
  };
}

function state(state_id, substrate, shape, phase, touch_phase, content_seed, extras = {}) {
  return {
    state_id,
    substrate,
    shape,
    phase,
    touch_phase,
    content_seed,
    mode: extras.mode ?? "glass_over_substrate",
    tint: extras.tint ?? "none",
    interactive: extras.interactive === true,
    autoplay: extras.autoplay === true,
    default: extras.default === true,
    ...(extras.background_asset_hash ? { background_asset_hash: extras.background_asset_hash } : {})
  };
}

function bindSceneContract(sceneId, stateEntry) {
  return {
    ...stateEntry,
    background_pack_id: glassBackgroundPackId,
    background_id: backgroundIdFor(sceneId, stateEntry),
    background_pack_sha256: glassBackgroundPackSha256,
    geometry_pack_id: glassGeometryPackId,
    geometry_id: geometryIdFor(sceneId, stateEntry),
    geometry_pack_sha256: glassGeometryPackSha256,
    capture_timeline_pack_id: glassCaptureTimelinePackId,
    capture_timeline_id: captureTimelineIdFor(sceneId, stateEntry),
    capture_timeline_sha256: glassCaptureTimelinePackSha256
  };
}
