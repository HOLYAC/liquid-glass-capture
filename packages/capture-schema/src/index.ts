export type RigId = "R0" | "R1" | "C0" | "C1" | "DOM_C" | "DX_REPLAY";

export type SceneId =
  | "S00_NULL"
  | "S01_SEARCH"
  | "S02_LOUPE"
  | "S03_PRESS"
  | "S04_MORPH"
  | "S05_FLOATING_BAR"
  | "S06_TINY_GLASS"
  | "S07_BUSY_PHOTO"
  | "S08_P3_GRADIENT"
  | "S09_NEAR_WHITE"
  | "S10_NEAR_BLACK"
  | "S11_VIDEO_FRAME"
  | "S12_SYSTEM_MATERIAL_ADJACENCY";

export type TouchPhase =
  | "rest"
  | "press"
  | "drag"
  | "release"
  | "morph"
  | "sustained";

export type TechnicalClass =
  | "SWIFTUI_PASS"
  | "WEBKIT_PASS"
  | "SHADER_PASS"
  | "FAIL"
  | "INVALID";

export type VerdictClass =
  | "TECH_PASS_PENDING_SIGNOFF"
  | "PASS_WITH_REVIEW"
  | "PROD_PASS"
  | "BLOCKED_FOR_DESIGN"
  | "LEGIBILITY_BLOCK"
  | "FAIL"
  | "INVALID";

export type FlakeClass =
  | "NONE"
  | "INFRA_FLAKE"
  | "PRODUCT_REGRESSION"
  | "METRIC_NOISE"
  | "UNKNOWN";

export type IdentifiabilityTag =
  | "MEASURED"
  | "BOUNDED_AMBIGUOUS"
  | "PROBABLE_UNDER_PRIOR"
  | "AMBIGUOUS";

export type CaptureKind = "compositor" | "framebuffer" | "layer_snapshot";

export type ShaderPipeline =
  | "uniform_calibration"
  | "baked_verdict"
  | "dom_css"
  | "dx_replay"
  | "passthrough";

export type ThermalState = "nominal" | "fair" | "serious" | "critical";

export interface CaptureArtifact {
  schema_version: "1.2.0";
  id: string;
  rig_id: RigId;
  scene_id: SceneId;
  state_id: string;
  git_commit: string;
  technical_class?: TechnicalClass;
  verdict_class?: VerdictClass;
  flake_class?: FlakeClass;
  null_qualification?: "pass" | "fail";
  invalid_reason?: string;
  capture_kind: CaptureKind;
  device_info: {
    model_name: string;
    model_identifier: string;
    os_name: "iOS";
    os_version: string;
    os_build: string;
    sdk_build: string;
    screen_scale: number;
    refresh_hz: number;
    thermal_state_start: ThermalState;
    thermal_state_end?: ThermalState;
    low_power_mode: boolean;
  };
  environment: {
    appearance: "light" | "dark";
    reduce_transparency: boolean;
    reduce_motion: boolean;
    content_seed?: string;
    background_asset_hash?: string;
    viewport_px: { width: number; height: number };
    capture_timestamp_ns: string;
  };
  color: {
    embedded_icc_profile: "Display P3";
    icc_sha256: string;
    working_space: "display-p3-linear";
    stored_transfer: "srgb-transfer";
    white_point: "D65";
  };
  frame_pack: {
    base_png_sha256: string;
    base_png_path: string;
    sequence_paths?: string[];
    sequence_timestamps_ms?: number[];
    mask_pack_sha256: string;
    mask_pack_path: string;
    touch_phase: TouchPhase;
    animation_t: number;
    sustained_duration_ms?: number;
    trajectory_source_sha256?: string;
  };
  shader?: {
    pipeline: ShaderPipeline;
    param_hash?: string;
    baked_shader_hash?: string;
    replay_source_artifact_id?: string;
    identifiability?: Record<string, IdentifiabilityTag>;
  };
  perf?: {
    measurement_source?: string;
    cpu_frame_ms_p95?: number;
    gpu_frame_ms_p95?: number;
    compositor_frame_ms_p95?: number;
    full_frame_ms_p95?: number;
    frame_interval_ms_p95?: number;
    dropped_frames?: number;
    sustained_degradation_pct?: number;
    memory_mb_p95?: number;
    refresh_budget_ms?: number;
  };
  energy?: {
    trace_available: boolean;
    trace_status?: "available" | "trace_unavailable";
    measurement_source?: string;
    trace_tool?:
      | "instruments_power_profiler"
      | "metrickit"
      | "validated_powermetrics_aux";
    energy_mj_per_10s?: number;
    average_power_mw?: number;
    thermal_onset_ms?: number;
  };
  review?: {
    g7_status?:
      | "not_run"
      | "passed"
      | "pass_with_review"
      | "blocked_for_design"
      | "legibility_block";
    design_class?:
      | "NOT_RUN"
      | "PASS"
      | "PASS_WITH_REVIEW"
      | "BLOCKED_FOR_DESIGN"
      | "LEGIBILITY_BLOCK";
    design_reviewer?: string;
    product_reviewer?: string;
    owner_decision?: "prod_pass" | "pass_with_review" | "blocked_for_design" | "legibility_block";
    review_packet_sha256?: string;
    g7_report_sha256?: string;
    g8_report_sha256?: string;
    comments_sha256?: string;
  };
  integrity: {
    artifact_sha256: string;
    producer_version: string;
  };
}

export const captureArtifactSchemaVersion = "1.2.0" as const;
