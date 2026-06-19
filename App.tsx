import React, { useMemo, useState } from "react";
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

const modes = ["substrate_only", "glass_over_substrate", "glass_over_black"] as const;
const substrates = [
  "checker_1px",
  "checker_2px",
  "checker_4px",
  "checker_8px",
  "grid",
  "rgb_stripes",
  "luma_ramp",
  "text_weights",
  "caret_selection",
  "noise"
] as const;
const shapes = ["circle", "capsule", "rounded_rect", "twin_capsules"] as const;
const phases = ["rest", "press", "drag_left", "drag_right", "merge_near", "merge_overlap", "morph_tall"] as const;
const tints = ["none", "cyan", "amber", "red"] as const;

type Choice = readonly string[];

function nextValue<T extends string>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length];
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
  const [mode, setMode] = useState<(typeof modes)[number]>("glass_over_substrate");
  const [substrate, setSubstrate] = useState<(typeof substrates)[number]>("caret_selection");
  const [shape, setShape] = useState<(typeof shapes)[number]>("twin_capsules");
  const [phase, setPhase] = useState<(typeof phases)[number]>("merge_near");
  const [tint, setTint] = useState<(typeof tints)[number]>("none");
  const [interactive, setInteractive] = useState(true);
  const [autoplay, setAutoplay] = useState(true);
  const [controls, setControls] = useState(false);
  const [touchCount, setTouchCount] = useState(0);

  const scenario = useMemo(
    () => [substrate, shape, phase, mode, interactive ? "interactive" : "static", tint].join("__"),
    [substrate, shape, phase, mode, interactive, tint]
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

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <LiquidGlassCaptureView
        style={StyleSheet.absoluteFill}
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
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
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
