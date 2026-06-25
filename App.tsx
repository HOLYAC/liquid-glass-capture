import React, { useEffect, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  getStatus,
  onError,
  onPosted,
  onToken,
  startMinting,
  stopMinting
} from "liquid-glass-capture";

// ElevenLabs' hCaptcha sitekey — the in-app SDK solve for THIS key is the only token EL's siteverify
// accepts (Safari / Chrome-WKWebView / standalone solves were all silently rejected).
const SITEKEY = "7f1a1c8e-99e4-4ace-b106-4f3e78a0e5c2";
const DEFAULT_ORACLE = "http://192.168.1.82:8000/collect";

export default function App() {
  const [oracle, setOracle] = useState(DEFAULT_ORACLE);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState({ minted: 0, posted: 0 });
  const [log, setLog] = useState<string[]>([]);

  const push = (line: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 60));

  useEffect(() => {
    const subs = [
      onToken((e) => {
        push(`token #${e.minted}  len=${e.len}  ${e.head}…`);
        setStats((s) => ({ ...s, minted: e.minted }));
      }),
      onPosted((e) => {
        push(`oracle ${e.status}  (posted ${e.posted})${e.error ? "  err:" + e.error : ""}`);
        setStats((s) => ({ ...s, posted: e.posted }));
      }),
      onError((e) => push(`ERROR ${e.stage}: ${e.error}`))
    ];
    setStats({ minted: getStatus().minted, posted: getStatus().posted });
    return () => subs.forEach((s) => s.remove());
  }, []);

  async function toggle() {
    if (running) {
      stopMinting();
      setRunning(false);
      push("stopped");
    } else {
      await startMinting(SITEKEY, oracle, 8000);
      setRunning(true);
      push(`minting -> ${oracle}`);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>hCaptcha SDK Minter</Text>
      <Text style={styles.sub}>sitekey {SITEKEY.slice(0, 8)}…  ·  EL parity</Text>

      <TextInput
        style={styles.input}
        value={oracle}
        onChangeText={setOracle}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="oracle /collect URL"
        placeholderTextColor="#777"
      />

      <Pressable onPress={toggle} style={[styles.btn, running && styles.btnOn]}>
        <Text style={styles.btnText}>{running ? "STOP" : "START MINTING"}</Text>
      </Pressable>

      <Text style={styles.stats}>
        minted {stats.minted}   ·   posted {stats.posted}
      </Text>

      <ScrollView style={styles.logBox} contentContainerStyle={styles.logPad}>
        {log.map((line, i) => (
          <Text key={i} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0b0c", paddingHorizontal: 18, paddingTop: 24 },
  title: { color: "white", fontSize: 22, fontWeight: "800" },
  sub: { color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 4, fontFamily: "Menlo" },
  input: {
    marginTop: 20,
    color: "white",
    fontFamily: "Menlo",
    fontSize: 13,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.2)"
  },
  btn: {
    marginTop: 16,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: "rgba(90,200,120,0.18)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(90,200,120,0.5)"
  },
  btnOn: {
    backgroundColor: "rgba(230,90,90,0.18)",
    borderColor: "rgba(230,90,90,0.55)"
  },
  btnText: { color: "white", fontSize: 16, fontWeight: "800", letterSpacing: 1 },
  stats: {
    marginTop: 14,
    color: "rgba(255,255,255,0.8)",
    fontFamily: "Menlo",
    fontSize: 13,
    textAlign: "center"
  },
  logBox: {
    marginTop: 14,
    flex: 1,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.04)"
  },
  logPad: { padding: 12 },
  logLine: { color: "rgba(255,255,255,0.62)", fontFamily: "Menlo", fontSize: 10, marginBottom: 3 }
});
