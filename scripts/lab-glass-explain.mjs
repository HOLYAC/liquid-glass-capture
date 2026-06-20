#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestVerdict(args.out);
    const report = explainVerdictFile(fixture.verdict, { out: fixture.out });
    assertExplainGuardRails(report);
    console.log(`PASS ${fixture.out}`);
    return;
  }

  if (!args.verdict) {
    console.error("usage: node scripts/lab-glass-explain.mjs --verdict <g8-verdict.json|candidate-id|hash> [--out explain.json]");
    console.error("       node scripts/lab-glass-explain.mjs --self-test [--out explain.json]");
    process.exit(2);
  }

  const report = explainVerdictFile(resolveVerdictInput(args.verdict), args);
  printFailureChain(report);
}

export function explainVerdictFile(path, options = {}) {
  const absolute = resolve(path);
  const verdict = JSON.parse(readFileSync(absolute, "utf8"));
  const report = buildExplainReport(verdict, {
    verdictPath: absolute
  });
  if (options.out) writeJson(options.out, report);
  return report;
}

export function buildExplainReport(verdict, { verdictPath = null } = {}) {
  if (!verdict || verdict.kind !== "g8_verdict_report") {
    throw new Error("glass explain requires a g8_verdict_report");
  }

  const gateChain = gateStatusChain(verdict);
  const blockerChain = (verdict.blockers ?? []).map((blocker, index) =>
    blockerNode(blocker, index)
  );
  const chain = [...gateChain, ...blockerChain];
  return {
    schema_version: "1.2.0",
    kind: "glass_explain_report",
    status: "pass",
    generated_at: new Date().toISOString(),
    verdict_path: verdictPath,
    verdict: {
      status: verdict.status,
      verdict_class: verdict.verdict_class,
      technical_class: verdict.technical_class,
      design_class: verdict.design_class,
      flake_class: verdict.flake_class,
      scene_id: verdict.scene?.scene_id ?? null,
      state_id: verdict.scene?.state_id ?? null,
      candidate_id: verdict.artifacts?.candidate?.id ?? null
    },
    artifact_hashes: {
      candidate_png_sha256: verdict.artifacts?.candidate?.png_sha256 ?? null,
      candidate_artifact_path: verdict.artifacts?.candidate?.artifact_path ?? null
    },
    baseline: verdict.baseline ?? { status: "not_recorded" },
    physical_device_lane: verdict.physical_device_lane ?? { status: "not_recorded" },
    traces: verdict.traces ?? { status: "not_recorded" },
    report_kinds: verdict.reports ?? {},
    failure_chain: chain,
    first_action: chain[0]?.action ?? (verdict.status === "pass"
      ? "No blocking failure chain; inspect G7 and retention before release sign-off."
      : "No machine-local blocker recorded; inspect raw verdict report.")
  };
}

function gateStatusChain(verdict) {
  const gates = verdict.gates ?? {};
  return Object.entries(gates)
    .filter(([, status]) => isGateProblemStatus(status))
    .map(([gate, status], index) => ({
      index,
      source: "gate_status",
      gate: gate.toUpperCase(),
      scope: scopeFromGateName(gate),
      code: `${gate}:${status}`,
      severity: gate === "energy" && status === "trace_unavailable" ? "warning" : "blocker",
      action: actionForGateStatus(gate, status)
    }));
}

function blockerNode(blocker, index) {
  const code = String(blocker);
  const gate = gateFromBlocker(code);
  const scope = scopeFromBlocker(code);
  return {
    index,
    source: "blocker",
    gate,
    scope,
    code,
    severity: "blocker",
    action: actionForBlocker(code, scope)
  };
}

function isGateProblemStatus(status) {
  return ["fail", "missing", "block"].includes(String(status).toLowerCase());
}

function gateFromBlocker(code) {
  const match = code.match(/\b(G[0-8])\b/);
  if (match) return match[1];
  if (code.startsWith("PHYSICAL_LANE_")) return "PHYSICAL_DEVICE_LANE";
  if (code.includes("BASELINE")) return "BASELINE";
  return "UNKNOWN";
}

function scopeFromBlocker(code) {
  if (code.includes("BASELINE")) return "baseline";
  if (code.includes("PHYSICAL_DEVICE_LANE") || code.includes("PHYSICAL_LANE") || code.includes("DEVICE_MATRIX")) {
    return "physical_device_lane";
  }
  if (code.includes("SOLVER")) return "solver";
  if (code.includes("REVIEW") || code.includes("G7")) return "review";
  if (code.includes("C1") || code.includes("BAKED_VERDICT") || code.includes("SHADER")) return "candidate_shader";
  if (code.includes("SIMULATOR") || code.includes("CAPTURE_PATH") || code.includes("PHYSICAL_DEVICE")) return "capture";
  if (code.startsWith("G2")) return "static_metrics";
  if (code.startsWith("G3")) return "optics";
  if (code.startsWith("G4")) return "temporal";
  if (code.startsWith("G5")) return "runtime";
  if (code.startsWith("G6")) return "energy";
  return "verdict";
}

function scopeFromGateName(gate) {
  return {
    color: "color_pipeline",
    static: "static_metrics",
    optics: "optics",
    temporal: "temporal",
    runtime: "runtime",
    energy: "energy",
    design: "review"
  }[gate] ?? gate;
}

function actionForGateStatus(gate, status) {
  if (status === "missing") return `Attach the ${gate} gate report before building G8 verdict.`;
  if (gate === "energy" && status === "trace_unavailable") {
    return "Energy trace is unavailable; acceptable only when G6 policy does not require a power trace.";
  }
  return `Open the ${gate} gate report, inspect failures, and regenerate the artifact after fixing that gate.`;
}

function actionForBlocker(code, scope) {
  if (scope === "baseline") {
    return "Provide a complete, approved, frozen prod_p99 baseline for the same device/OS/SDK namespace.";
  }
  if (scope === "physical_device_lane") {
    return "Collect or attach the required physical-device lane report with matching scene, hashes, and device matrix evidence.";
  }
  if (scope === "solver") {
    return "Run solver ranking and make sure the C1 artifact matches the selected candidate id.";
  }
  if (scope === "review") {
    return "Fix the structured G7 packet or owner decision; free-form taste is not accepted.";
  }
  if (scope === "candidate_shader") {
    return "Use a baked verdict shader artifact for C1; calibration or replay artifacts cannot mint parity.";
  }
  if (scope === "capture") {
    return "Recapture on a physical compositor/framebuffer path; simulator or layer-snapshot evidence is invalid.";
  }
  if (code.startsWith("G2") || code.startsWith("G3") || code.startsWith("G4") || code.startsWith("G5") || code.startsWith("G6")) {
    return `Open the ${code.slice(0, 2)} report and inspect its gate-local metric failure.`;
  }
  return "Inspect the raw verdict blocker and attached gate report.";
}

function resolveVerdictInput(input) {
  const direct = resolve(input);
  if (existsSync(direct)) return direct;

  const matches = [];
  const artifactsRoot = join(repoRoot, "artifacts");
  if (existsSync(artifactsRoot)) {
    for (const candidate of walkJson(artifactsRoot)) {
      try {
        const json = JSON.parse(readFileSync(candidate, "utf8"));
        if (json.kind !== "g8_verdict_report") continue;
        if (
          json.id === input ||
          json.verdict_id === input ||
          json.artifacts?.candidate?.id === input ||
          json.artifacts?.candidate?.png_sha256 === input ||
          basename(candidate) === input ||
          candidate.endsWith(input)
        ) {
          matches.push(candidate);
        }
      } catch {
        // Keep id search tolerant of unrelated JSON in artifacts.
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Verdict id is ambiguous: ${input}\n${matches.join("\n")}`);
  throw new Error(`Verdict not found by path, candidate id, or hash: ${input}`);
}

function writeSelfTestVerdict(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "glass-explain");
  mkdirSync(dir, { recursive: true });
  const verdict = join(dir, "failing-g8-verdict.report.json");
  writeJson(verdict, {
    schema_version: "1.2.0",
    kind: "g8_verdict_report",
    status: "fail",
    verdict_class: "FAIL",
    technical_class: "FAIL",
    design_class: "NOT_RUN",
    flake_class: "NONE",
    scene: {
      scene_id: "S03_PRESS",
      state_id: "press"
    },
    gates: {
      color: "assumed_from_G0_G1_artifact_contract",
      static: "fail",
      optics: "pass",
      temporal: "missing",
      runtime: "pass",
      energy: "trace_unavailable",
      design: "not_run"
    },
    artifacts: {
      candidate: {
        id: "glass-explain-self-test-candidate",
        rig_id: "C1",
        png_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        artifact_path: "artifacts/lab-self-test/glass-explain/candidate.capture.json"
      }
    },
    reports: {
      G2: "g2_metric_report",
      G4: "missing"
    },
    baseline: {
      status: "missing",
      freeze_verified: false
    },
    physical_device_lane: {
      status: "fail",
      failure_count: 2
    },
    traces: {
      energy_trace: "trace_unavailable"
    },
    blockers: [
      "G2_OKLAB_DELTA_ABOVE_THRESHOLD",
      "G8_BASELINE_REPORT_MISSING",
      "G8_PHYSICAL_DEVICE_LANE_FAIL",
      "G8_C1_REQUIRES_BAKED_VERDICT_SHADER"
    ]
  });
  return {
    verdict,
    out: outPath ? resolve(outPath) : join(dir, "glass-explain.report.json")
  };
}

function assertExplainGuardRails(report) {
  const scopes = new Set(report.failure_chain.map((node) => node.scope));
  for (const scope of ["static_metrics", "baseline", "physical_device_lane", "candidate_shader"]) {
    if (!scopes.has(scope)) {
      throw new Error(`glass explain self-test did not classify ${scope}`);
    }
  }
  if (!report.artifact_hashes.candidate_png_sha256) {
    throw new Error("glass explain self-test did not retain candidate artifact hash");
  }
  if (!String(report.first_action).includes("static")) {
    throw new Error("glass explain self-test did not surface the first gate-local action");
  }
}

function printFailureChain(report) {
  if (report.verdict.status === "pass" && report.failure_chain.length === 0) {
    console.log(`PASS ${report.verdict.candidate_id ?? ""}`.trim());
    console.log(report.first_action);
    return;
  }
  console.log(`${String(report.verdict.status ?? "unknown").toUpperCase()} ${report.verdict.candidate_id ?? ""}`.trim());
  for (const node of report.failure_chain) {
    console.log(`[${node.index}] ${node.gate}/${node.scope}: ${node.code}`);
    console.log(`    ${node.action}`);
  }
  console.log(`FIRST_ACTION ${report.first_action}`);
}

function walkJson(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...walkJson(path));
    else if (entry.endsWith(".json")) files.push(path);
  }
  return files;
}

function writeJson(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--verdict") parsed.verdict = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
