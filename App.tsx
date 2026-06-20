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
const repeatCounts = [3, 10, 24, 50, 300] as const;
const s03PressTrajectorySha256 = "56148be556260e9f1647bf9ab09ddf12c7ae129b3194722b2ed54bb8ad2fbcdd";

type Choice = readonly string[];

const NativeLiquidGlassCaptureView = LiquidGlassCaptureView as React.ComponentType<
  LiquidGlassCaptureViewProps & {
    ref?: React.Ref<LiquidGlassCaptureViewHandle>;
  }
>;

function nextValue<T extends string | number>(values: readonly T[], current: T): T {
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

function sceneIdFor(substrate: string, phase: string): "S00_NULL" | "S01_SEARCH" | "S03_PRESS" {
  if (substrate.startsWith("s00_")) {
    return "S00_NULL";
  }
  return phase === "press" ? "S03_PRESS" : "S01_SEARCH";
}

function stateIdFor(substrate: string, phase: string): string {
  if (substrate.startsWith("s00_")) {
    return substrate;
  }
  if (phase === "press") {
    return "press";
  }
  if (phase.startsWith("drag")) {
    return "drag";
  }
  if (phase.startsWith("merge") || phase.startsWith("morph")) {
    return "morph";
  }
  return "rest";
}

function touchPhaseFor(phase: string): "rest" | "press" | "drag" | "morph" {
  if (phase === "press") return "press";
  if (phase.startsWith("drag")) return "drag";
  if (phase.startsWith("merge") || phase.startsWith("morph")) return "morph";
  return "rest";
}

function trajectoryShaFor(sceneId: string): string | undefined {
  return sceneId === "S03_PRESS" ? s03PressTrajectorySha256 : undefined;
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
  const [batchActive, setBatchActive] = useState(false);
  const [repeatCount, setRepeatCount] = useState<(typeof repeatCounts)[number]>(50);
  const [lastReferenceArtifact, setLastReferenceArtifact] = useState<string | null>(null);
  const [lastCandidateArtifact, setLastCandidateArtifact] = useState<string | null>(null);

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
      const sceneId = sceneIdFor(substrate, phase);
      const stateId = stateIdFor(substrate, phase);
      const metadata: Record<string, unknown> = {
        schemaVersion: "1.2.0",
        labPlan: "apple_glass_parity_execution_plan_v1_2",
        sceneId,
        stateId,
        rigId: rig,
        captureKind: "layer_snapshot",
        invalidReason: mode === "substrate_only" && substrate.startsWith("s00_") ? "MANUAL_S00_SMOKE" : "CAPTURE_PATH_INVALID",
        scenario,
        touchCount,
        controls,
        capturedFrom: "bottom_bar"
      };
      const trajectorySourceSha256 = trajectoryShaFor(sceneId);
      if (trajectorySourceSha256) {
        metadata["trajectorySourceSha256"] = trajectorySourceSha256;
      }

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
        const jsonPath = typeof payload.jsonPath === "string" ? payload.jsonPath : null;
        if (jsonPath) {
          if (payload.rig_id === "R0") {
            setLastReferenceArtifact(jsonPath);
          } else {
            setLastCandidateArtifact(jsonPath);
          }
        }
        setCaptureStatus(String(payload.jsonPath ?? payload.sessionDir ?? "compositor stopped"));
      } else {
        const sceneId = sceneIdFor(substrate, phase);
        const stateId = stateIdFor(substrate, phase);
        const metadata: Record<string, unknown> = {
          schemaVersion: "1.2.0",
          labPlan: "apple_glass_parity_execution_plan_v1_2",
          sceneId,
          stateId,
          rigId: rig,
          captureKind: "compositor",
          touchPhase: touchPhaseFor(phase),
          nullQualification: "fail",
          maxFrames: 180,
          appearance: "dark",
          contentSeed: contentSeedFor(substrate)
        };
        const trajectorySourceSha256 = trajectoryShaFor(sceneId);
        if (trajectorySourceSha256) {
          metadata["trajectorySourceSha256"] = trajectorySourceSha256;
        }
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

  async function runRepeatCapture() {
    const handle = glassRef.current;
    if (!handle?.runCompositorRepeatCaptureAsync) {
      setCaptureStatus("repeat capture unavailable");
      setControls(true);
      return;
    }

    if (batchActive || compositorActive) {
      setCaptureStatus("capture already active");
      setControls(true);
      return;
    }

    const sceneId = sceneIdFor(substrate, phase);
    const stateId = stateIdFor(substrate, phase);
    const baselineClass = repeatCount >= 300 ? "prod_p99" : repeatCount === 24 ? "sustained" : "mvl";
    const captureDurationMs = baselineClass === "sustained" ? 60_000 : 900;
    const cooldownMs = baselineClass === "sustained" ? 60_000 : 750;
    const metadata: Record<string, unknown> = {
      schemaVersion: "1.2.0",
      labPlan: "apple_glass_parity_execution_plan_v1_2",
      sceneId,
      stateId,
      rigId: rig,
      captureKind: "compositor",
      touchPhase: touchPhaseFor(phase),
      nullQualification: sceneId === "S00_NULL" ? "pass" : "fail",
      baselineClass,
      requiresNominalThermal: true,
      maxFrames: baselineClass === "sustained" ? 900 : 90,
      appearance: "dark",
      contentSeed: contentSeedFor(substrate)
    };
    const trajectorySourceSha256 = trajectoryShaFor(sceneId);
    if (trajectorySourceSha256) {
      metadata["trajectorySourceSha256"] = trajectorySourceSha256;
    }

    try {
      setBatchActive(true);
      setControls(true);
      setCaptureStatus(`repeat ${repeatCount} started`);
      const payload = await handle.runCompositorRepeatCaptureAsync(
        "baseline-repeat",
        metadata,
        repeatCount,
        captureDurationMs,
        cooldownMs
      );
      const manifestPath = typeof payload.jsonPath === "string" ? payload.jsonPath : "repeat manifest written";
      setCaptureStatus(manifestPath);

      const artifactPaths = Array.isArray(payload.artifact_json_paths)
        ? payload.artifact_json_paths.filter((value): value is string => typeof value === "string")
        : [];
      const lastArtifact = artifactPaths.at(-1) ?? null;
      if (lastArtifact) {
        if (rig === "R0") {
          setLastReferenceArtifact(lastArtifact);
        } else {
          setLastCandidateArtifact(lastArtifact);
        }
      }
    } catch (error) {
      setCaptureStatus(`repeat failed: ${String(error)}`);
    } finally {
      setBatchActive(false);
      setControls(true);
    }
  }

  async function runNullQualification() {
    const handle = glassRef.current;
    if (!handle?.runNullQualificationAsync) {
      setCaptureStatus("null qualification unavailable");
      setControls(true);
      return;
    }

    if (!lastReferenceArtifact || !lastCandidateArtifact) {
      setCaptureStatus("need R0 and candidate compositor captures");
      setControls(true);
      return;
    }

    try {
      const report = await handle.runNullQualificationAsync(lastReferenceArtifact, lastCandidateArtifact, null);
      setCaptureStatus(String(report.jsonPath ?? report.null_qualification ?? "null report written"));
    } catch (error) {
      setCaptureStatus(`null failed: ${String(error)}`);
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
            <Text style={styles.captureStatus}>R0 {lastReferenceArtifact ? "ready" : "missing"} / C {lastCandidateArtifact ? "ready" : "missing"}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
              <Chip label="rig" value={rig} onPress={() => setRig(nextValue(rigs, rig))} />
              <Chip label="mode" value={mode} onPress={() => setMode(nextValue(modes, mode))} />
              <Chip label="substrate" value={substrate} onPress={() => setSubstrate(nextValue(substrates, substrate))} />
              <Chip label="shape" value={shape} onPress={() => setShape(nextValue(shapes, shape))} />
              <Chip label="phase" value={phase} onPress={() => setPhase(nextValue(phases, phase))} />
              <Chip label="tint" value={tint} onPress={() => setTint(nextValue(tints, tint))} />
              <Chip label="interactive" value={String(interactive)} onPress={() => setInteractive((value) => !value)} />
              <Chip label="autoplay" value={String(autoplay)} onPress={() => setAutoplay((value) => !value)} />
              <Chip label="repeat" value={String(repeatCount)} onPress={() => setRepeatCount(nextValue(repeatCounts, repeatCount))} />
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
          <Pressable onPress={runNullQualification} style={styles.bottomButton}>
            <Text style={styles.bottomButtonText}>N</Text>
          </Pressable>
          <Pressable onPress={runRepeatCapture} style={batchActive ? styles.bottomButtonPrimary : styles.bottomButton}>
            <Text style={styles.bottomButtonText}>B</Text>
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
    gap: 8,
    height: 54,
    justifyContent: "center",
    position: "absolute",
    zIndex: 2
  },
  bottomButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  bottomButtonPrimary: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderColor: "rgba(255,255,255,0.34)",
    borderRadius: 27,
    borderWidth: StyleSheet.hairlineWidth,
    height: 54,
    justifyContent: "center",
    width: 54
  },
  bottomButtonText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 12,
    fontWeight: "700"
  }
});
