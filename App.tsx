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
  "loupe_text",
  "floating_bar_content",
  "tiny_control_content",
  "busy_photo",
  "p3_saturated_gradient",
  "near_white",
  "near_black",
  "video_frame",
  "system_material_adjacency",
  "noise"
] as const;
const shapes = ["circle", "capsule", "rounded_rect", "twin_capsules"] as const;
const phases = ["rest", "press", "drag_left", "drag_right", "merge_near", "merge_overlap", "morph_tall"] as const;
const tints = ["none", "cyan", "amber", "red"] as const;
const repeatCounts = [3, 10, 24, 50, 300] as const;
const s02LoupeTrajectorySha256 = "33a896a5ee2615762df4248ce2f3a327fe036d8a7df43deea316641118796f5c";
const s03PressTrajectorySha256 = "f3f1fb6f521cc525cdf5957a2c96682ec6e9098f34a1708c0621ce50a8fee376";
const s04MorphTrajectorySha256 = "2d56ff34315a85689661f74b5ea3d0a70144bf36c77546a1ffe9fb9e9cf3b5bd";
const busyPhotoAssetHash = "77238364440e942b31adefec365389a6f2c25a9b0a5561945db9468f8337f148";
const videoFrameAssetHash = "e976e690f06f8b955a86ab8e49d2fcef51f942c220e975a03c30d414702998a5";
const systemMaterialAssetHash = "15cc42e8ad24fd0179d917962281292ea97ea735ceb12796f8eb681e92049fe6";

type SceneId =
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
type Substrate = (typeof substrates)[number];
type Shape = (typeof shapes)[number];
type Phase = (typeof phases)[number];
type Mode = (typeof modes)[number];
type Tint = (typeof tints)[number];
type TouchPhase = "rest" | "press" | "drag" | "morph";
type SceneSpec = {
  sceneId: SceneId;
  stateId: string;
  substrate: Substrate;
  shape: Shape;
  phase: Phase;
  mode: Mode;
  tint: Tint;
  interactive: boolean;
  autoplay: boolean;
  touchPhase: TouchPhase;
  contentSeed: string;
  backgroundAssetHash?: string;
};

const trajectoryShaByScene: Partial<Record<SceneId, string>> = {
  S02_LOUPE: s02LoupeTrajectorySha256,
  S03_PRESS: s03PressTrajectorySha256,
  S04_MORPH: s04MorphTrajectorySha256
};

const sceneSpecs = [
  {
    sceneId: "S00_NULL",
    stateId: "s00_flat_grey",
    substrate: "s00_flat_grey",
    shape: "capsule",
    phase: "rest",
    mode: "substrate_only",
    tint: "none",
    interactive: false,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s00-flat-p3-grey-v1"
  },
  {
    sceneId: "S01_SEARCH",
    stateId: "rest",
    substrate: "native_text_selection",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s01-search-selection-v1"
  },
  {
    sceneId: "S02_LOUPE",
    stateId: "drag",
    substrate: "loupe_text",
    shape: "circle",
    phase: "drag_right",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: true,
    touchPhase: "drag",
    contentSeed: "s02-loupe-text-drag-v1"
  },
  {
    sceneId: "S03_PRESS",
    stateId: "press",
    substrate: "tiny_control_content",
    shape: "capsule",
    phase: "press",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: true,
    touchPhase: "press",
    contentSeed: "s03-press-control-v1"
  },
  {
    sceneId: "S04_MORPH",
    stateId: "morph",
    substrate: "floating_bar_content",
    shape: "twin_capsules",
    phase: "morph_tall",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: true,
    touchPhase: "morph",
    contentSeed: "s04-twin-capsule-morph-v1"
  },
  {
    sceneId: "S05_FLOATING_BAR",
    stateId: "floating_rest",
    substrate: "floating_bar_content",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s05-floating-bar-v1"
  },
  {
    sceneId: "S06_TINY_GLASS",
    stateId: "tiny_rest",
    substrate: "tiny_control_content",
    shape: "circle",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s06-tiny-control-v1"
  },
  {
    sceneId: "S07_BUSY_PHOTO",
    stateId: "busy_photo_rest",
    substrate: "busy_photo",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: false,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s07-busy-photo-procedural-v1",
    backgroundAssetHash: busyPhotoAssetHash
  },
  {
    sceneId: "S08_P3_GRADIENT",
    stateId: "p3_gradient_rest",
    substrate: "p3_saturated_gradient",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: false,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s08-p3-saturated-gradient-v1"
  },
  {
    sceneId: "S09_NEAR_WHITE",
    stateId: "near_white_rest",
    substrate: "near_white",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: false,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s09-near-white-v1"
  },
  {
    sceneId: "S10_NEAR_BLACK",
    stateId: "near_black_rest",
    substrate: "near_black",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: false,
    autoplay: false,
    touchPhase: "rest",
    contentSeed: "s10-near-black-v1"
  },
  {
    sceneId: "S11_VIDEO_FRAME",
    stateId: "video_frame_rest",
    substrate: "video_frame",
    shape: "capsule",
    phase: "rest",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: false,
    autoplay: true,
    touchPhase: "rest",
    contentSeed: "s11-video-high-frequency-procedural-v1",
    backgroundAssetHash: videoFrameAssetHash
  },
  {
    sceneId: "S12_SYSTEM_MATERIAL_ADJACENCY",
    stateId: "system_material_rest",
    substrate: "system_material_adjacency",
    shape: "twin_capsules",
    phase: "merge_near",
    mode: "glass_over_substrate",
    tint: "none",
    interactive: true,
    autoplay: false,
    touchPhase: "morph",
    contentSeed: "s12-system-material-adjacency-procedural-v1",
    backgroundAssetHash: systemMaterialAssetHash
  }
] as const satisfies readonly SceneSpec[];
const sceneIds = sceneSpecs.map((scene) => scene.sceneId) as readonly SceneId[];

const NativeLiquidGlassCaptureView = LiquidGlassCaptureView as React.ComponentType<
  LiquidGlassCaptureViewProps & {
    ref?: React.Ref<LiquidGlassCaptureViewHandle>;
  }
>;

function nextValue<T extends string | number>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length];
}

function sceneSpecFor(sceneId: SceneId): SceneSpec {
  return sceneSpecs.find((scene) => scene.sceneId === sceneId) ?? sceneSpecs[1];
}

function trajectoryShaFor(sceneId: SceneId): string | undefined {
  return trajectoryShaByScene[sceneId];
}

function addSceneMetadata(metadata: Record<string, unknown>, scene: SceneSpec) {
  metadata["contentSeed"] = scene.contentSeed;
  if (scene.backgroundAssetHash) {
    metadata["backgroundAssetHash"] = scene.backgroundAssetHash;
  }
  const trajectorySourceSha256 = trajectoryShaFor(scene.sceneId);
  if (trajectorySourceSha256) {
    metadata["trajectorySourceSha256"] = trajectorySourceSha256;
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
  const [sceneId, setSceneId] = useState<SceneId>("S01_SEARCH");
  const [rig, setRig] = useState<LiquidGlassCaptureRig>("R0");
  const [mode, setMode] = useState<Mode>(sceneSpecFor("S01_SEARCH").mode);
  const [tint, setTint] = useState<Tint>(sceneSpecFor("S01_SEARCH").tint);
  const [interactive, setInteractive] = useState(true);
  const [autoplay, setAutoplay] = useState(false);
  const [controls, setControls] = useState(false);
  const [touchCount, setTouchCount] = useState(0);
  const [captureStatus, setCaptureStatus] = useState("no capture");
  const [compositorActive, setCompositorActive] = useState(false);
  const [batchActive, setBatchActive] = useState(false);
  const [repeatCount, setRepeatCount] = useState<(typeof repeatCounts)[number]>(50);
  const [lastReferenceArtifact, setLastReferenceArtifact] = useState<string | null>(null);
  const [lastCandidateArtifact, setLastCandidateArtifact] = useState<string | null>(null);
  const scene = useMemo(() => sceneSpecFor(sceneId), [sceneId]);

  const scenario = useMemo(
    () => [rig, scene.sceneId, scene.stateId, scene.substrate, scene.shape, scene.phase, mode, interactive ? "interactive" : "static", tint].join("__"),
    [rig, scene, mode, interactive, tint]
  );

  function applyScene(nextSceneId: SceneId) {
    const nextScene = sceneSpecFor(nextSceneId);
    setSceneId(nextSceneId);
    setMode(nextScene.mode);
    setTint(nextScene.tint);
    setInteractive(nextScene.interactive);
    setAutoplay(nextScene.autoplay);
  }

  function pressGlass() {
    applyScene("S03_PRESS");
  }

  function releaseGlass() {
    const nextTouch = touchCount + 1;
    setTouchCount(nextTouch);
    applyScene(sceneIds[nextTouch % sceneIds.length]);
  }

  function cycleScene() {
    const nextTouch = touchCount + 1;
    setTouchCount(nextTouch);
    applyScene(nextValue(sceneIds, sceneId));
  }

  async function captureGlass() {
    const handle = glassRef.current;
    if (!handle?.captureSnapshotAsync) {
      setCaptureStatus("capture unavailable");
      setControls(true);
      return;
    }

    try {
      const metadata: Record<string, unknown> = {
        schemaVersion: "1.2.0",
        labPlan: "apple_glass_parity_execution_plan_v1_2",
        sceneId: scene.sceneId,
        stateId: scene.stateId,
        rigId: rig,
        captureKind: "layer_snapshot",
        invalidReason: mode === "substrate_only" && scene.sceneId === "S00_NULL" ? "MANUAL_S00_SMOKE" : "CAPTURE_PATH_INVALID",
        scenario,
        touchCount,
        controls,
        capturedFrom: "bottom_bar"
      };
      addSceneMetadata(metadata, scene);

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
        const metadata: Record<string, unknown> = {
          schemaVersion: "1.2.0",
          labPlan: "apple_glass_parity_execution_plan_v1_2",
          sceneId: scene.sceneId,
          stateId: scene.stateId,
          rigId: rig,
          captureKind: "compositor",
          touchPhase: scene.touchPhase,
          nullQualification: scene.sceneId === "S00_NULL" ? "pass" : "fail",
          maxFrames: 180,
          appearance: "dark"
        };
        addSceneMetadata(metadata, scene);
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

    const baselineClass = repeatCount >= 300 ? "prod_p99" : repeatCount === 24 ? "sustained" : "mvl";
    const captureDurationMs = baselineClass === "sustained" ? 60_000 : 900;
    const cooldownMs = baselineClass === "sustained" ? 60_000 : 750;
    const metadata: Record<string, unknown> = {
      schemaVersion: "1.2.0",
      labPlan: "apple_glass_parity_execution_plan_v1_2",
      sceneId: scene.sceneId,
      stateId: scene.stateId,
      rigId: rig,
      captureKind: "compositor",
      touchPhase: scene.touchPhase,
      nullQualification: scene.sceneId === "S00_NULL" ? "pass" : "fail",
      baselineClass,
      requiresNominalThermal: true,
      maxFrames: baselineClass === "sustained" ? 900 : 90,
      appearance: "dark"
    };
    addSceneMetadata(metadata, scene);

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
        substrate={scene.substrate}
        shape={scene.shape}
        phase={scene.phase}
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
              <Chip label="scene" value={scene.sceneId} onPress={() => applyScene(nextValue(sceneIds, sceneId))} />
              <Chip label="rig" value={rig} onPress={() => setRig(nextValue(rigs, rig))} />
              <Chip label="mode" value={mode} onPress={() => setMode(nextValue(modes, mode))} />
              <Chip label="substrate" value={scene.substrate} onPress={() => applyScene(nextValue(sceneIds, sceneId))} />
              <Chip label="shape" value={scene.shape} onPress={() => applyScene(nextValue(sceneIds, sceneId))} />
              <Chip label="phase" value={scene.phase} onPress={() => applyScene(nextValue(sceneIds, sceneId))} />
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
