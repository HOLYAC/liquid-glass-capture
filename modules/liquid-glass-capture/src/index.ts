import { requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";

export type LiquidGlassCaptureMode =
  | "substrate_only"
  | "glass_over_substrate"
  | "glass_over_black";

export type LiquidGlassCaptureSubstrate =
  | "checker_1px"
  | "checker_2px"
  | "checker_4px"
  | "checker_8px"
  | "grid"
  | "rgb_stripes"
  | "luma_ramp"
  | "text_weights"
  | "caret_selection"
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
  mode?: LiquidGlassCaptureMode;
  substrate?: LiquidGlassCaptureSubstrate;
  shape?: LiquidGlassCaptureShape;
  phase?: LiquidGlassCapturePhase;
  tint?: LiquidGlassCaptureTint;
  interactive?: boolean;
  autoplay?: boolean;
};

export const LiquidGlassCaptureView =
  requireNativeViewManager<LiquidGlassCaptureViewProps>("LiquidGlassCapture");
