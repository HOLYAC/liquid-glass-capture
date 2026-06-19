import { requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";

export type LiquidGlassCaptureMode =
  | "substrate_only"
  | "glass_over_substrate"
  | "glass_over_black";

export type LiquidGlassCaptureRig =
  | "R0"
  | "R1"
  | "C0"
  | "C1"
  | "DOM_C"
  | "DX_REPLAY";

export type LiquidGlassCaptureSubstrate =
  | "s00_flat_grey"
  | "s00_hard_edge"
  | "s00_p3_ramp"
  | "s00_smooth_gradient"
  | "checker_1px"
  | "checker_2px"
  | "checker_4px"
  | "checker_8px"
  | "grid"
  | "rgb_stripes"
  | "luma_ramp"
  | "text_weights"
  | "caret_selection"
  | "native_text_selection"
  | "noise";

export type LiquidGlassCaptureShape =
  | "circle"
  | "capsule"
  | "rounded_rect"
  | "twin_capsules";

export type LiquidGlassCapturePhase =
  | "rest"
  | "press"
  | "drag_left"
  | "drag_right"
  | "merge_near"
  | "merge_overlap"
  | "morph_tall";

export type LiquidGlassCaptureTint = "none" | "cyan" | "amber" | "red";

export type LiquidGlassCaptureViewProps = ViewProps & {
  rig?: LiquidGlassCaptureRig;
  mode?: LiquidGlassCaptureMode;
  substrate?: LiquidGlassCaptureSubstrate;
  shape?: LiquidGlassCaptureShape;
  phase?: LiquidGlassCapturePhase;
  tint?: LiquidGlassCaptureTint;
  interactive?: boolean;
  autoplay?: boolean;
};

export type LiquidGlassCaptureSnapshot = {
  label: string;
  timestampMs: number;
  pngPath: string;
  jsonPath: string;
  view: {
    width: number;
    height: number;
    scale: number;
  };
  props: Record<string, unknown>;
  metadata: Record<string, unknown>;
  metrics: Record<string, unknown>;
};

export type LiquidGlassCaptureLabArtifact = Record<string, unknown> & {
  schema_version: "1.2.0";
  id: string;
  jsonPath: string;
};

export type LiquidGlassCaptureViewHandle = {
  captureSnapshotAsync(
    label: string,
    metadata: Record<string, unknown>
  ): Promise<LiquidGlassCaptureSnapshot>;
  captureLabArtifactAsync?(
    label: string,
    metadata: Record<string, unknown>
  ): Promise<LiquidGlassCaptureLabArtifact>;
  startCompositorCaptureAsync?(
    label: string,
    metadata: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  stopCompositorCaptureAsync?(): Promise<Record<string, unknown>>;
  runNullQualificationAsync?(
    referenceArtifactPath: string,
    candidateArtifactPath: string,
    rung?: string | null
  ): Promise<Record<string, unknown>>;
};

export const LiquidGlassCaptureView =
  requireNativeViewManager<LiquidGlassCaptureViewProps>("LiquidGlassCapture");
