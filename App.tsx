import React, { useEffect, useMemo, useRef, useState } from "react";
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
  onDiagnostic,
  onError,
  onPosted,
  onToken,
  startMinting,
  stopMinting,
  updateMintConfig
} from "liquid-glass-capture";
import { computeNextDelayMs, deriveHistory, type OracleStats } from "./src/controller";
import { PROVIDERS } from "./src/providers/registry";

// ElevenLabs' hCaptcha sitekey — the in-app SDK solve for THIS key is the only token EL's siteverify
// accepts (Safari / Chrome-WKWebView / standalone solves were all silently rejected).
const DEFAULT_SITEKEY = "7f1a1c8e-99e4-4ace-b106-4f3e78a0e5c2"; // EL preset; editable in the field
const DEFAULT_ORACLE = "http://192.168.1.82:8000/collect";

const intervalChoices = [4000, 6000, 8000, 12000, 20000] as const;
const jitterChoices = [0, 0.15, 0.3, 0.5] as const;
const adaptiveCfg = { baseIntervalMs: 8000, minIntervalMs: 2000, maxIntervalMs: 60000 };
const ADAPTIVE_POLL_MS = 10000;

function nextOf<T>(arr: readonly T[], cur: T): T {
  const i = arr.indexOf(cur);
  return arr[(i + 1) % arr.length];
}

function statsUrl(collectUrl: string): string {
  const t = collectUrl.trim();
  return t.endsWith("/collect") ? `${t.slice(0, -"/collect".length)}/stats` : `${t.replace(/\/+$/, "")}/stats`;
}

function oracleBase(collectUrl: string): string {
  const t = collectUrl.trim().replace(/\/+$/, "");
  return t.endsWith("/collect") ? t.slice(0, -"/collect".length) : t;
}

function parsePool(text: string): OracleStats | null {
  try {
    const j = JSON.parse(text) as { hcaptcha_pool?: Partial<OracleStats> };
    const p = j.hcaptcha_pool;
    if (!p) return null;
    return {
      pool_size: p.pool_size ?? 0,
      consumed: p.consumed ?? 0,
      expired: p.expired ?? 0,
      max_age_s: p.max_age_s ?? 100
    };
  } catch {
    return null;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const [sitekey, setSitekey] = useState(DEFAULT_SITEKEY);
  const [oracle, setOracle] = useState(DEFAULT_ORACLE);
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState<(typeof intervalChoices)[number]>(8000);
  const [jitterPct, setJitterPct] = useState<(typeof jitterChoices)[number]>(0);
  const [adaptive, setAdaptive] = useState(false);
  const [stats, setStats] = useState({ minted: 0, posted: 0 });
  const [reason, setReason] = useState("idle");
  const [log, setLog] = useState<string[]>([]);
  const [fleetMode, setFleetMode] = useState(false);
  const [fleetStatus, setFleetStatus] = useState("");
  const prevStats = useRef<OracleStats | null>(null);
  const fleetRef = useRef<{ base: string; device: string } | null>(null);

  const liveCount = useMemo(() => PROVIDERS.filter((p) => p.live).length, []);

  const push = (line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 60));
    const f = fleetRef.current;
    if (f) {
      // off-device log sink (brothers' yield-as-health) — fire-and-forget, never blocks the loop
      fetch(`${f.base}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: f.device, line })
      }).catch(() => {});
    }
  };

  useEffect(() => {
    const subs = [
      onToken((e) => {
        push(`token #${e.minted}  len=${e.len}  ${e.head}…`);
        setStats((s) => ({ ...s, minted: e.minted }));
      }),
      onPosted((e) => {
        const body = e.status >= 200 && e.status < 300 ? "" : `  body:${e.body}`;
        push(`oracle ${e.status}  (posted ${e.posted})${e.error ? "  err:" + e.error : ""}${body}`);
        setStats((s) => ({ ...s, posted: e.posted }));
      }),
      onError((e) => push(`ERROR ${e.stage}: ${e.error}`)),
      onDiagnostic((e) => push(`diag ${e.stage}: ${e.message}`))
    ];
    setStats({ minted: getStatus().minted, posted: getStatus().posted });
    return () => subs.forEach((s) => s.remove());
  }, []);

  // Foreground adaptive supervisor: poll /stats, rate-match, push the interval to native.
  // Wrapped so a flaky oracle never throws into the (proven, native) mint loop.
  useEffect(() => {
    if (!running || !adaptive || fleetMode) return;   // fleet mode: the oracle drives the interval
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(statsUrl(oracle));
        const cur = parsePool(await res.text());
        if (!cur || cancelled) return;
        const hist = deriveHistory(prevStats.current, cur);
        prevStats.current = cur;
        const d = computeNextDelayMs(cur, adaptiveCfg, hist);
        setReason(d.reason);
        await updateMintConfig(d.delayMs, jitterPct);
        push(`adapt ${d.reason} → ${d.delayMs}ms  (pool=${cur.pool_size})`);
      } catch (e) {
        push(`adapt skipped: ${errMsg(e)}`);
      }
    };
    void tick();
    const h = setInterval(tick, ADAPTIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [running, adaptive, oracle, jitterPct, fleetMode]);

  // Fleet supervisor: the OFF-DEVICE oracle drives this phone. Poll /command, apply run/interval/
  // sitekey, post /fleet/heartbeat, and FAIL CLOSED — if the oracle is unreachable past the lease,
  // STOP (so a partitioned phone can't outlive the remote kill-switch). Wrapped; can't break the mint.
  useEffect(() => {
    if (!fleetMode) return;
    const dev = getStatus().device;
    const base = oracleBase(oracle);
    fleetRef.current = { base, device: dev };
    let lastCmdOkTs = Date.now();
    let leaseMs = 30000;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(`${base}/command?device=${encodeURIComponent(dev)}`);
        const cmd = (await r.json()) as {
          run?: boolean; sitekey?: string; interval_ms?: number; lease_ttl_s?: number; reason?: string;
        };
        lastCmdOkTs = Date.now();
        leaseMs = (cmd.lease_ttl_s ?? 30) * 1000;
        if (cmd.run) {
          const iv = cmd.interval_ms ?? intervalMs;
          const sk = cmd.sitekey ?? sitekey;
          if (!getStatus().minting) {
            await startMinting(sk, oracle, iv);
            setRunning(true);
          }
          await updateMintConfig(iv, jitterPct);
          setFleetStatus(`run @ ${iv}ms ${cmd.reason ?? ""}`);
        } else {
          if (getStatus().minting) {
            stopMinting();
            setRunning(false);
          }
          setFleetStatus(`hold: ${cmd.reason ?? "oracle"}`);
        }
      } catch (e) {
        // fail-closed: cannot reach the oracle past the lease => STOP (kill-switch can't be outlived)
        if (Date.now() - lastCmdOkTs > leaseMs && getStatus().minting) {
          stopMinting();
          setRunning(false);
          setFleetStatus("FAIL-CLOSED: oracle unreachable past lease");
          push("fleet fail-closed: stopped (oracle unreachable > lease)");
        } else {
          setFleetStatus(`cmd retry: ${errMsg(e)}`);
        }
      }
    };

    const beat = async () => {
      if (cancelled) return;
      try {
        const s = getStatus();
        await fetch(`${base}/fleet/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device: dev, minted: s.minted, posted: s.posted })
        });
      } catch {}
    };

    void poll();
    void beat();
    const ph = setInterval(poll, 8000);
    const bh = setInterval(beat, 10000);
    return () => {
      cancelled = true;
      clearInterval(ph);
      clearInterval(bh);
      fleetRef.current = null;
    };
  }, [fleetMode, oracle, jitterPct, intervalMs, sitekey]);

  async function toggle() {
    if (running) {
      stopMinting();
      setRunning(false);
      setReason("idle");
      prevStats.current = null;
      push("stopped");
      return;
    }
    // Proven path — unchanged. Then push jitter/interval via the additive config hook.
    await startMinting(sitekey.trim(), oracle, intervalMs);
    try {
      await updateMintConfig(intervalMs, jitterPct);
    } catch (e) {
      push(`config skipped: ${errMsg(e)}`);
    }
    setRunning(true);
    setReason(adaptive ? "adaptive" : "manual");
    push(`minting → ${oracle}  (interval ${intervalMs}ms, jitter ${Math.round(jitterPct * 100)}%)`);
  }

  async function checkOracle() {
    try {
      const res = await fetch(statsUrl(oracle));
      const cur = parsePool(await res.text());
      push(cur ? `oracle pool=${cur.pool_size} consumed=${cur.consumed} expired=${cur.expired}` : "oracle: no pool");
    } catch (e) {
      push(`oracle check failed: ${errMsg(e)}`);
    }
  }

  async function bumpInterval() {
    const v = nextOf(intervalChoices, intervalMs);
    setIntervalMs(v);
    if (running) {
      try {
        await updateMintConfig(v, jitterPct);
      } catch {}
    }
  }

  async function bumpJitter() {
    const v = nextOf(jitterChoices, jitterPct);
    setJitterPct(v);
    if (running) {
      try {
        await updateMintConfig(intervalMs, v);
      } catch {}
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>hCaptcha Minter — combine</Text>
      <Text style={styles.sub}>
        sitekey {sitekey.slice(0, 8)}…  ·  providers {liveCount}/{PROVIDERS.length} live  ·  {fleetMode ? (fleetStatus || "fleet") : reason}
      </Text>

      <TextInput
        style={styles.input}
        value={sitekey}
        onChangeText={setSitekey}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!running}
        placeholder="hCaptcha sitekey"
        placeholderTextColor="#777"
      />
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

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="interval" value={`${intervalMs}ms`} onPress={bumpInterval} />
        <Chip label="jitter" value={`${Math.round(jitterPct * 100)}%`} onPress={bumpJitter} />
        <Chip label="adaptive" value={adaptive ? "on" : "off"} onPress={() => setAdaptive((v) => !v)} on={adaptive} />
        <Chip label="fleet" value={fleetMode ? "on" : "off"} onPress={() => setFleetMode((v) => !v)} on={fleetMode} />
      </ScrollView>

      <View style={styles.buttonRow}>
        <Pressable onPress={toggle} style={[styles.btn, styles.mainBtn, running && styles.btnOn]}>
          <Text style={styles.btnText}>{running ? "STOP" : "START MINTING"}</Text>
        </Pressable>
        <Pressable onPress={checkOracle} style={[styles.btn, styles.checkBtn]}>
          <Text style={styles.btnText}>CHECK</Text>
        </Pressable>
      </View>

      <Text style={styles.stats}>
        minted {stats.minted}   ·   posted {stats.posted}
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.roster}>
        {PROVIDERS.map((p) => (
          <View key={p.id} style={[styles.prov, p.live ? styles.provLive : styles.provDark]}>
            <Text style={styles.provLabel}>{p.label}</Text>
            <Text style={styles.provTag}>{p.live ? "LIVE" : p.portability}</Text>
          </View>
        ))}
      </ScrollView>

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

function Chip({ label, value, onPress, on }: { label: string; value: string; onPress: () => void; on?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Text style={styles.chipValue}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0b0c", paddingHorizontal: 18, paddingTop: 24 },
  title: { color: "white", fontSize: 22, fontWeight: "800" },
  sub: { color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 4, fontFamily: "Menlo" },
  input: {
    marginTop: 18,
    color: "white",
    fontFamily: "Menlo",
    fontSize: 13,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.2)"
  },
  chips: { gap: 8, paddingTop: 12 },
  chip: {
    minWidth: 92,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.2)"
  },
  chipOn: { backgroundColor: "rgba(90,200,120,0.18)", borderColor: "rgba(90,200,120,0.5)" },
  chipLabel: { color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: "600" },
  chipValue: { marginTop: 3, color: "white", fontSize: 13, fontWeight: "700" },
  buttonRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  btn: {
    minHeight: 54,
    paddingVertical: 15,
    paddingHorizontal: 10,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(90,200,120,0.18)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(90,200,120,0.5)"
  },
  mainBtn: { flex: 1.1 },
  checkBtn: { flex: 1, backgroundColor: "rgba(120,170,255,0.16)", borderColor: "rgba(120,170,255,0.45)" },
  btnOn: { backgroundColor: "rgba(230,90,90,0.18)", borderColor: "rgba(230,90,90,0.55)" },
  btnText: { color: "white", fontSize: 13, fontWeight: "800", letterSpacing: 1, textAlign: "center" },
  stats: { marginTop: 14, color: "rgba(255,255,255,0.8)", fontFamily: "Menlo", fontSize: 13, textAlign: "center" },
  roster: { gap: 8, paddingTop: 14, paddingBottom: 4 },
  prov: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  provLive: { backgroundColor: "rgba(90,200,120,0.16)", borderColor: "rgba(90,200,120,0.5)" },
  provDark: { backgroundColor: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.16)" },
  provLabel: { color: "white", fontSize: 12, fontWeight: "700" },
  provTag: { marginTop: 2, color: "rgba(255,255,255,0.55)", fontSize: 9, fontWeight: "600" },
  logBox: { marginTop: 14, flex: 1, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.04)" },
  logPad: { padding: 12 },
  logLine: { color: "rgba(255,255,255,0.62)", fontFamily: "Menlo", fontSize: 10, marginBottom: 3 }
});
