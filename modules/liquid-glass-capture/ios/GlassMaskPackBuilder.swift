import Foundation

enum GlassMaskPackBuilder {
  static func make(sceneId: String, stateId: String, shape: String, phase: String, touchPhase: String) -> [String: Any] {
    let core = coreRegion(for: shape)
    let sceneMask: [String: Any] = [
      "scene_id": sceneId,
      "state_id": stateId,
      "shape": shape,
      "phase": phase,
      "touch_phase": touchPhase,
      "mask_basis": "fixture_scene_mask_regions_v1",
      "masks": [
        "core": [
          "kind": "geometry_core",
          "shape": shape,
          "region": core
        ],
        "edge_band": [
          "kind": "geometry_edge_band",
          "shape": shape,
          "region": core,
          "band_px": 3
        ],
        "highlight": [
          "kind": "geometry_highlight",
          "shape": shape,
          "region": core
        ],
        "text": [
          "kind": "geometry_text",
          "shape": shape,
          "region": core
        ],
        "text_halo": [
          "kind": "geometry_text_halo",
          "shape": shape,
          "region": core,
          "expand_px": 2
        ],
        "background_control": [
          "kind": "outside_geometry",
          "shape": shape,
          "region": core,
          "min_gap_px": 6
        ],
        "motion_path": [
          "kind": "geometry_expanded",
          "shape": shape,
          "region": core,
          "expand_px": motionExpandPx(touchPhase: touchPhase)
        ],
        "compositor_region": [
          "kind": "full_frame"
        ],
        "product_focus": [
          "kind": "geometry_expanded",
          "shape": shape,
          "region": core,
          "expand_px": 5
        ]
      ]
    ]

    return [
      "schema_version": "1.2.0",
      "mask_pack_id": "glass_core_mask_pack_v1",
      "description": "Scene/state mask pack for the full S00-S12 Apple Liquid Glass parity matrix. Metric tools rasterize fixed regions before scoring.",
      "source": "modules/liquid-glass-capture/ios/GlassMaskPackBuilder.swift",
      "scene_coverage": [
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
      "masks": [
        ["id": "core"],
        ["id": "edge_band"],
        ["id": "highlight"],
        ["id": "text"],
        ["id": "text_halo"],
        ["id": "background_control"],
        ["id": "motion_path"],
        ["id": "compositor_region"],
        ["id": "product_focus"]
      ],
      "scene_masks": [sceneMask]
    ]
  }

  private static func coreRegion(for shape: String) -> [String: Any] {
    switch shape {
    case "circle":
      return ["type": "ellipse", "x": 0.41, "y": 0.33, "width": 0.18, "height": 0.26]
    case "rounded_rect":
      return ["type": "rounded_rect", "x": 0.22, "y": 0.38, "width": 0.56, "height": 0.24, "radius_ratio": 0.22]
    case "twin_capsules":
      return [
        "type": "multi_capsule",
        "rects": [
          ["x": 0.16, "y": 0.40, "width": 0.30, "height": 0.17],
          ["x": 0.54, "y": 0.40, "width": 0.30, "height": 0.17]
        ]
      ]
    default:
      return ["type": "capsule", "x": 0.18, "y": 0.42, "width": 0.64, "height": 0.17]
    }
  }

  private static func motionExpandPx(touchPhase: String) -> Int {
    switch touchPhase {
    case "drag":
      return 12
    case "morph":
      return 10
    case "press":
      return 7
    default:
      return 5
    }
  }
}
