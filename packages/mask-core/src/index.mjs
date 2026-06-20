export const maskPackSchemaVersion = "1.2.0";
export const glassMaskPackId = "glass_core_mask_pack_v1";
export const requiredGlassMaskIds = Object.freeze([
  "core",
  "edge_band",
  "highlight",
  "text",
  "text_halo",
  "background_control",
  "motion_path",
  "compositor_region",
  "product_focus"
]);

const supportedRegionKinds = new Set([
  "full_frame",
  "geometry_core",
  "geometry_edge_band",
  "geometry_expanded",
  "geometry_highlight",
  "geometry_text",
  "geometry_text_halo",
  "outside_geometry"
]);

export function buildSceneMaskEntries(probe) {
  return (probe.scenes ?? []).flatMap((scene) =>
    (scene.states ?? []).map((state) => buildSceneMaskEntry(scene.scene_id, state))
  );
}

export function buildSceneMaskEntry(sceneId, state) {
  const core = coreRegionForShape(state.shape);
  return {
    scene_id: sceneId,
    state_id: state.state_id,
    shape: state.shape,
    phase: state.phase,
    touch_phase: state.touch_phase,
    mask_basis: "fixture_scene_mask_regions_v1",
    masks: {
      core: {
        kind: "geometry_core",
        shape: state.shape,
        region: core
      },
      edge_band: {
        kind: "geometry_edge_band",
        shape: state.shape,
        region: core,
        band_px: 3
      },
      highlight: {
        kind: "geometry_highlight",
        shape: state.shape,
        region: core
      },
      text: {
        kind: "geometry_text",
        shape: state.shape,
        region: core
      },
      text_halo: {
        kind: "geometry_text_halo",
        shape: state.shape,
        region: core,
        expand_px: 2
      },
      background_control: {
        kind: "outside_geometry",
        shape: state.shape,
        region: core,
        min_gap_px: 6
      },
      motion_path: {
        kind: "geometry_expanded",
        shape: state.shape,
        region: core,
        expand_px: motionExpandPx(state.touch_phase)
      },
      compositor_region: {
        kind: "full_frame"
      },
      product_focus: {
        kind: "geometry_expanded",
        shape: state.shape,
        region: core,
        expand_px: 5
      }
    }
  };
}

export function validateMaskPack(maskPack, {
  sceneStates = [],
  sceneId,
  stateId,
  requiredMaskIds = requiredGlassMaskIds
} = {}) {
  const failures = [];
  if (!maskPack || typeof maskPack !== "object") return ["MASK_PACK_REQUIRED"];
  if (maskPack.schema_version !== maskPackSchemaVersion) failures.push("MASK_PACK_SCHEMA_VERSION");
  if (maskPack.mask_pack_id !== glassMaskPackId) failures.push("MASK_PACK_ID");
  const maskIds = new Set((maskPack.masks ?? []).map((mask) => mask.id));
  for (const maskId of requiredMaskIds) {
    if (!maskIds.has(maskId)) failures.push(`MASK_ID_MISSING_${maskId}`);
  }

  const expectedStates = sceneStates.length > 0
    ? sceneStates
    : sceneId && stateId
      ? [{ scene_id: sceneId, state_id: stateId }]
      : [];
  const entriesByKey = new Map((maskPack.scene_masks ?? []).map((entry) => [sceneStateKey(entry.scene_id, entry.state_id), entry]));
  if (expectedStates.length > 0 && entriesByKey.size === 0) failures.push("MASK_SCENE_ENTRIES_REQUIRED");
  for (const state of expectedStates) {
    const key = sceneStateKey(state.scene_id ?? state.sceneId, state.state_id ?? state.stateId);
    const entry = entriesByKey.get(key);
    if (!entry) {
      failures.push(`${key}:MASK_SCENE_ENTRY_MISSING`);
      continue;
    }
    if (state.shape && entry.shape !== state.shape) failures.push(`${key}:MASK_SHAPE_MISMATCH`);
    for (const maskId of requiredMaskIds) {
      const region = entry.masks?.[maskId];
      if (!region) {
        failures.push(`${key}:MASK_REGION_MISSING_${maskId}`);
      } else {
        failures.push(...validateRegion(`${key}:${maskId}`, region));
      }
    }
  }

  return unique(failures);
}

export function maskIndexesFor(maskPack, {
  sceneId,
  stateId,
  maskId,
  width,
  height
}) {
  const entry = (maskPack.scene_masks ?? []).find((candidate) =>
    candidate.scene_id === sceneId && candidate.state_id === stateId
  );
  if (!entry) return [];
  const region = entry.masks?.[maskId];
  if (!region) return [];
  return indexesForRegion(region, width, height);
}

export function maskContainsPointFor(maskPack, {
  sceneId,
  stateId,
  maskId,
  x,
  y,
  width,
  height
}) {
  const entry = (maskPack.scene_masks ?? []).find((candidate) =>
    candidate.scene_id === sceneId && candidate.state_id === stateId
  );
  const region = entry?.masks?.[maskId];
  if (!region) return false;
  return containsRegion(region, x, y, width, height);
}

export function maskScopeBlock(maskPack, {
  sceneId,
  stateId,
  maskId,
  sampleCount
}) {
  return {
    source: "fixed_scene_mask_pack_v1",
    mask_pack_id: maskPack?.mask_pack_id ?? null,
    scene_id: sceneId,
    state_id: stateId,
    mask_id: maskId,
    sample_count: sampleCount
  };
}

function coreRegionForShape(shape) {
  if (shape === "circle") {
    return { type: "ellipse", x: 0.41, y: 0.33, width: 0.18, height: 0.26 };
  }
  if (shape === "rounded_rect") {
    return { type: "rounded_rect", x: 0.22, y: 0.38, width: 0.56, height: 0.24, radius_ratio: 0.22 };
  }
  if (shape === "twin_capsules") {
    return {
      type: "multi_capsule",
      rects: [
        { x: 0.16, y: 0.40, width: 0.30, height: 0.17 },
        { x: 0.54, y: 0.40, width: 0.30, height: 0.17 }
      ]
    };
  }
  return { type: "capsule", x: 0.18, y: 0.42, width: 0.64, height: 0.17 };
}

function motionExpandPx(touchPhase) {
  if (touchPhase === "drag") return 12;
  if (touchPhase === "morph") return 10;
  if (touchPhase === "press") return 7;
  return 5;
}

function validateRegion(prefix, region) {
  const failures = [];
  if (!supportedRegionKinds.has(region.kind)) failures.push(`${prefix}:MASK_REGION_KIND`);
  if (region.kind !== "full_frame" && !region.region) failures.push(`${prefix}:MASK_REGION_GEOMETRY`);
  return failures;
}

function indexesForRegion(region, width, height) {
  const indexes = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (containsRegion(region, x + 0.5, y + 0.5, width, height)) {
        indexes.push(y * width + x);
      }
    }
  }
  return indexes;
}

function containsRegion(region, x, y, width, height) {
  if (region.kind === "full_frame") return true;
  if (region.kind === "outside_geometry") {
    return !insideGeometry(region.region, x, y, width, height, region.min_gap_px ?? 0);
  }
  if (region.kind === "geometry_edge_band") {
    return edgeBandContains(region.region, x, y, width, height, region.band_px ?? 3);
  }
  if (region.kind === "geometry_highlight") {
    const highlight = insetRegion(region.region, { x: 0.18, y: 0.12, width: 0.42, height: 0.24 });
    return insideGeometry(highlight, x, y, width, height, 0);
  }
  if (region.kind === "geometry_text") {
    const text = insetRegion(region.region, { x: 0.18, y: 0.36, width: 0.64, height: 0.30 });
    return insideGeometry(text, x, y, width, height, 0);
  }
  if (region.kind === "geometry_text_halo") {
    const text = insetRegion(region.region, { x: 0.14, y: 0.30, width: 0.72, height: 0.42 });
    return insideGeometry(text, x, y, width, height, region.expand_px ?? 2);
  }
  if (region.kind === "geometry_expanded") {
    return insideGeometry(region.region, x, y, width, height, region.expand_px ?? 0);
  }
  return insideGeometry(region.region, x, y, width, height, 0);
}

function insetRegion(region, relative) {
  if (region.type === "multi_capsule") {
    return {
      type: "multi_capsule",
      rects: region.rects.map((rect) => ({
        x: rect.x + rect.width * relative.x,
        y: rect.y + rect.height * relative.y,
        width: rect.width * relative.width,
        height: rect.height * relative.height
      }))
    };
  }
  return {
    type: region.type,
    x: region.x + region.width * relative.x,
    y: region.y + region.height * relative.y,
    width: region.width * relative.width,
    height: region.height * relative.height,
    radius_ratio: region.radius_ratio
  };
}

function insideGeometry(region, x, y, width, height, expandPx) {
  if (region.type === "multi_capsule") {
    return region.rects.some((rect) => insideCapsule(rect, x, y, width, height, expandPx));
  }
  if (region.type === "ellipse") return insideEllipse(region, x, y, width, height, expandPx);
  if (region.type === "rounded_rect") return insideRoundedRect(region, x, y, width, height, expandPx);
  return insideCapsule(region, x, y, width, height, expandPx);
}

function edgeBandContains(region, x, y, width, height, bandPx) {
  const inner = insideGeometry(region, x, y, width, height, -bandPx);
  const outer = insideGeometry(region, x, y, width, height, bandPx);
  return outer && !inner;
}

function pixelRect(rect, width, height, expandPx = 0) {
  return {
    x: rect.x * width - expandPx,
    y: rect.y * height - expandPx,
    width: rect.width * width + expandPx * 2,
    height: rect.height * height + expandPx * 2
  };
}

function insideCapsule(rect, x, y, width, height, expandPx) {
  const box = pixelRect(rect, width, height, expandPx);
  if (box.width <= 0 || box.height <= 0) return false;
  const radius = Math.min(box.width, box.height) / 2;
  const left = box.x + radius;
  const right = box.x + box.width - radius;
  const cy = box.y + box.height / 2;
  const clampedX = Math.max(left, Math.min(right, x));
  return Math.hypot(x - clampedX, y - cy) <= radius;
}

function insideRoundedRect(rect, x, y, width, height, expandPx) {
  const box = pixelRect(rect, width, height, expandPx);
  if (box.width <= 0 || box.height <= 0) return false;
  const radius = Math.min(box.width, box.height) * (rect.radius_ratio ?? 0.22);
  const cx = Math.max(box.x + radius, Math.min(box.x + box.width - radius, x));
  const cy = Math.max(box.y + radius, Math.min(box.y + box.height - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}

function insideEllipse(rect, x, y, width, height, expandPx) {
  const box = pixelRect(rect, width, height, expandPx);
  if (box.width <= 0 || box.height <= 0) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

function sceneStateKey(sceneId, stateId) {
  return `${sceneId}/${stateId}`;
}

function unique(values) {
  return [...new Set(values)];
}
