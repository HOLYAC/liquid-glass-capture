import React, { useMemo, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View
} from "react-native";
import { LiquidGlassCaptureView } from "liquid-glass-capture";
import type {
  LiquidGlassCaptureLabArtifact,
  LiquidGlassCaptureRig,
  LiquidGlassCaptureSnapshot,
  LiquidGlassCaptureViewHandle,
  LiquidGlassCaptureViewProps
} from "liquid-glass-capture";

const rigs = ["R0", "R1", "C0", "DOM_C", "C1", "DX_REPLAY"] as const;
const modes = ["substrate_only", "glass_over_substrate", "glass_over_black"] as const;
const substrates = [
  "s00_flat_grey",
  "s00_hard_edge",
  "s00_p3_ramp",
  "s00_smooth_gradient",
  "checker_1px",
  "checker_2px",
  "checker_4px",
  "checker_8px",
  "grid",
  "rgb_stripes",
  "luma_ramp",
  "text_weights",
  "caret_selection",
  "native_text_selection",
  "noise"
] as const;
const shapes = ["circle", "capsule", "rounded_rect", "twin_capsules"] as const;
const phases = ["rest", "press", "drag_left", "drag_right", "merge_near", "merge_overlap", "morph_tall"] as const;
const tints = ["none", "cyan", "amber", "red"] as const;

type Choice = readonly string[];

const NativeLiquidGlassCaptureView = LiquidGlassCaptureView as React.ComponentType<
  LiquidGlassCaptureViewProps & {
    ref?: React.Ref<LiquidGlassCaptureViewHandle>;
  }
>;

function nextValue<T extends string>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length];
}

function contentSeedFor(substrate: string): string {
  switch (substrate) {
    case "s00_flat_grey":
      return "s00-flat-p3-grey-v1";
    case "s00_hard_edge":
      return "s00-hard-edge-v1";
    case "s00_p3_ramp":
      return "s00-p3-ramp-v1";
    case "s00_smooth_gradient":
      return "s00-smooth-gradient-v1";
    default:
      return `manual-${substrate}`;
  }
}

function Chip({
  label,
  value,
  onPress
}: {
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Text style={styles.chipValue}>{value}</Text>
    </Pressable>
  );
}

export default function App() {
  const glassRef = useRef<LiquidGlassCaptureViewHandle>(null);
  const [rig, setRig] = useState<LiquidGlassCaptureRig>("R0");
  const [mode, setMode] = useState<(typeof modes)[number]>("substrate_only");
  const [substrate, setSubstrate] = useState<(typeof substrates)[number]>("native_text_selection");
  const [shape, setShape] = useState<(typeof shapes)[number]>("twin_capsules");
  const [phase, setPhase] = useState<(typeof phases)[number]>("merge_near");
  const [tint, setTint] = useState<(typeof tints)[number]>("none");
  const [interactive, setInteractive] = useState(true);
  const [autoplay, setAutoplay] = useState(true);
  const [controls, setControls] = useState(false);
  const [touchCount, setTouchCount] = useState(0);
  const [captureStatus, setCaptureStatus] = useState("no capture");
  const [compositorActive, setCompositorActive] = useState(false);

  const scenario = useMemo(
    () => [rig, substrate, shape, phase, mode, interactive ? "interactive" : "static", tint].join("__"),
    [rig, substrate, shape, phase, mode, interactive, tint]
  );

  function pressGlass() {
    setInteractive(true);
    setAutoplay(true);
    setPhase("press");
  }

  function releaseGlass() {
    const nextTouch = touchCount + 1;
    setTouchCount(nextTouch);
    setPhase(phases[nextTouch % phases.length]);

    if (nextTouch % 2 === 0) {
      setShape(nextValue(shapes, shape));
    }

    if (nextTouch % 3 === 0) {
      setSubstrate(nextValue(substrates, substrate));
    }
  }

  function cycleScene() {
    const nextTouch = touchCount + 1;
    setTouchCount(nextTouch);
    setPhase(phases[nextTouch % phases.length]);
    setShape(nextValue(shapes, shape));

    if (nextTouch % 2 === 0) {
      setSubstrate(nextValue(substrates, substrate));
    }
  }

  async function captureGlass() {
    const handle = glassRef.current;
    if (!handle?.captureSnapshotAsync) {
      setCaptureStatus("capture unavailable");
      setControls(true);
      return;
    }

    try {
      const metadata = {
        schemaVersion: "1.2.0",
        labPlan: "apple_glass_parity_execution_plan_v1_2",
        sceneId: substrate.startsWith("s00_") ? "S00_NULL" : "MANUAL_LEGACY",
        stateId: substrate,
        rigId: rig,
        captureKind: "layer_snapshot",
        invalidReason: mode === "substrate_only" && substrate.startsWith("s00_") ? "MANUAL_S00_SMOKE" : "CAPTURE_PATH_INVALID",
        scenario,
        touchCount,
        controls,
        capturedFrom: "bottom_bar"
      };

      if (handle.captureLabArtifactAsync) {
        const artifact: LiquidGlassCaptureLabArtifact = await handle.captureLabArtifactAsync("manual", metadata);
        setCaptureStatus(artifact.jsonPath);
      } else {
        const snapshot: LiquidGlassCaptureSnapshot = await handle.captureSnapshotAsync("manual", metadata);
        setCaptureStatus(snapshot.jsonPath);
      }
    } catch (error) {
      setCaptureStatus(`capture failed: ${String(error)}`);
    }
    setControls(true);
  }

  async function toggleCompositorCapture() {
    const handle = glassRef.current;
    if (!handle?.startCompositorCaptureAsync || !handle.stopCompositorCaptureAsync) {
      setCaptureStatus("compositor capture unavailable");
      setControls(true);
      return;
    }

    try {
      if (compositorActive) {
        const payload = await handle.stopCompositorCaptureAsync();
        setCompositorActive(false);
        setCaptureStatus(String(payload.jsonPath ?? payload.sessionDir ?? "compositor stopped"));
      } else {
        const metadata = {
          schemaVersion: "1.2.0",
          labPlan: "apple_glass_parity_execution_plan_v1_2",
          sceneId: substrate.startsWith("s00_") ? "S00_NULL" : "MANUAL_LEGACY",
          stateId: substrate,
          rigId: rig,
          captureKind: "compositor",
          touchPhase: phase === "press" ? "press" : phase.startsWith("drag") ? "drag" : "rest",
          nullQualification: "fail",
          maxFrames: 180,
          appearance: "dark",
          contentSeed: contentSeedFor(substrate)
        };
        const payload = await handle.startCompositorCaptureAsync("compositor", metadata);
        setCompositorActive(true);
        setCaptureStatus(String(payload.sessionDir ?? "compositor started"));
      }
    } catch (error) {
      setCompositorActive(false);
      setCaptureStatus(`compositor failed: ${String(error)}`);
    }
    setControls(true);
  }

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <NativeLiquidGlassCaptureView
        ref={glassRef}
        style={StyleSheet.absoluteFill}
        rig={rig}
        mode={mode}
        substrate={substrate}
        shape={shape}
        phase={phase}
        tint={tint}
        interactive={interactive}
        autoplay={autoplay}
      />

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {controls ? (
          <View style={styles.panel}>
            <Text style={styles.title}>Liquid Glass Capture</Text>
            <Text style={styles.scenario}>{scenario}</Text>
            <Text style={styles.captureStatus}>{captureStatus}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
              <Chip label="rig" value={rig} onPress={() => setRig(nextValue(rigs, rig))} />
              <Chip label="mode" value={mode} onPress={() => setMode(nextValue(modes, mode))} />
              <Chip label="substrate" value={substrate} onPress={() => setSubstrate(nextValue(substrates, substrate))} />
              <Chip label="shape" value={shape} onPress={() => setShape(nextValue(shapes, shape))} />
              <Chip label="phase" value={phase} onPress={() => setPhase(nextValue(phases, phase))} />
              <Chip label="tint" value={tint} onPress={() => setTint(nextValue(tints, tint))} />
              <Chip label="interactive" value={String(interactive)} onPress={() => setInteractive((value) => !value)} />
              <Chip label="autoplay" value={String(autoplay)} onPress={() => setAutoplay((value) => !value)} />
              <Chip label="controls" value="hide" onPress={() => setControls(false)} />
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.bottomBar} pointerEvents="box-none">
          <Pressable onPress={cycleScene} style={styles.bottomButton}>
            <Text style={styles.bottomButtonText}>1</Text>
          </Pressable>
          <Pressable onPressIn={pressGlass} onPressOut={releaseGlass} style={styles.bottomButtonPrimary}>
            <Text style={styles.bottomButtonText}>0</Text>
          </Pressable>
          <Pressable onPress={() => setControls((value) => !value)} style={styles.bottomButton}>
            <Text style={styles.bottomButtonText}>2</Text>
          </Pressable>
          <Pressable onPress={captureGlass} style={styles.bottomButton}>
            <Text style={styles.bottomButtonText}>C</Text>
          </Pressable>
          <Pressable onPress={toggleCompositorCapture} style={compositorActive ? styles.bottomButtonPrimary : styles.bottomButton}>
            <Text style={styles.bottomButtonText}>R</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000"
  },
  overlay: {
    bottom: 0,
    flex: 1,
    justifyContent: "flex-end",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 10
  },
  panel: {
    bottom: 86,
    left: 14,
    position: "absolute",
    right: 14,
    padding: 14,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.62)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)",
    zIndex: 3
  },
  title: {
    color: "white",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0
  },
  scenario: {
    marginTop: 4,
    color: "rgba(255,255,255,0.62)",
    fontFamily: "Menlo",
    fontSize: 10
  },
  captureStatus: {
    marginTop: 6,
    color: "rgba(255,255,255,0.58)",
    fontFamily: "Menlo",
    fontSize: 9
  },
  row: {
    gap: 10,
    paddingTop: 12
  },
  chip: {
    minWidth: 128,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)"
  },
  chipLabel: {
    color: "rgba(255,255,255,0.52)",
    fontSize: 10,
    fontWeight: "600"
  },
  chipValue: {
    marginTop: 3,
    color: "white",
    fontSize: 12,
    fontWeight: "700"
  },
  bottomBar: {
    alignItems: "center",
    alignSelf: "center",
    bottom: 16,
    flexDirection: "row",
    gap: 14,
    height: 58,
    justifyContent: "center",
    position: "absolute",
    zIndex: 2
  },
  bottomButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  bottomButtonPrimary: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderColor: "rgba(255,255,255,0.34)",
    borderRadius: 29,
    borderWidth: StyleSheet.hairlineWidth,
    height: 58,
    justifyContent: "center",
    width: 58
  },
  bottomButtonText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 12,
    fontWeight: "700"
  }
});
