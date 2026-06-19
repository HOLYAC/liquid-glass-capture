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
  const [substrate, setSubstrate] = useState<(typeof substrates)[number]>("checker_4px");
  const [shape, setShape] = useState<(typeof shapes)[number]>("capsule");
  const [phase, setPhase] = useState<(typeof phases)[number]>("rest");
  const [tint, setTint] = useState<(typeof tints)[number]>("none");
  const [interactive, setInteractive] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const [controls, setControls] = useState(true);

  const scenario = useMemo(
    () => [substrate, shape, phase, mode, interactive ? "interactive" : "static", tint].join("__"),
    [substrate, shape, phase, mode, interactive, tint]
  );

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

      {controls ? (
        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
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
        </SafeAreaView>
      ) : (
        <Pressable style={styles.restore} onLongPress={() => setControls(true)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000"
  },
  overlay: {
    flex: 1,
    justifyContent: "flex-end"
  },
  panel: {
    margin: 14,
    padding: 14,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.62)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)"
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
  restore: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 44,
    height: 44
  }
});
