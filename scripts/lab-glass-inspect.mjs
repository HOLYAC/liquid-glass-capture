#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderInspectViewer,
  writeViewerHtml,
  writeViewerSelfTestArtifacts
} from "./lib/lab-artifact-viewer.mjs";
import { requiredGlassMaskIds } from "../packages/mask-core/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeViewerSelfTestArtifacts();
    const out = args.out ?? join(repoRoot, "artifacts", "lab-self-test", "artifact-viewer", "inspect.html");
    const html = renderInspectViewer(fixture.referenceArtifact);
    const path = writeViewerHtml(out, html);
    const reportFixtures = writeInspectReportFixtures();
    const outDir = dirname(resolve(out));
    const trendPath = writeViewerHtml(
      join(outDir, "trend.inspect.html"),
      renderInspectViewer(reportFixtures.trendReport)
    );
    const flakePath = writeViewerHtml(
      join(outDir, "flake-classification.inspect.html"),
      renderInspectViewer(reportFixtures.flakeReport)
    );
    const instrumentsPath = writeViewerHtml(
      join(outDir, "instruments.inspect.html"),
      renderInspectViewer(reportFixtures.instrumentsReport)
    );
    assertInspectViewerContract(path);
    assertTrendViewerContract(trendPath);
    assertFlakeViewerContract(flakePath);
    assertInstrumentsViewerContract(instrumentsPath);
    console.log(`PASS ${path}`);
    return;
  }

  if (!args.input) {
    console.error("usage: node scripts/lab-glass-inspect.mjs <capture.json|baseline.json|artifact-id> [--out inspect.html]");
    console.error("       node scripts/lab-glass-inspect.mjs --self-test [--out inspect.html]");
    process.exit(2);
  }

  const out = args.out ?? join(repoRoot, "artifacts", "viewer", `${safeName(args.input)}.inspect.html`);
  const html = renderInspectViewer(args.input);
  const path = writeViewerHtml(out, html);
  console.log(`PASS ${path}`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--out") parsed.out = args[++index];
    else if (!parsed.input) parsed.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "artifact";
}

function assertInspectViewerContract(path) {
  const html = readFileSync(path, "utf8");
  for (const required of [
    'id="energy-trace-panel"',
    'id="energy-trace-link"',
    'id="frame-manifest-panel"',
    'id="mask-overlay"',
    ...requiredGlassMaskIds,
    "instruments_power_profiler",
    "sha256_tree_v1",
    "hash_match",
    "open_macos",
    "open_windows"
  ]) {
    if (!html.includes(required)) {
      throw new Error(`inspect viewer self-test missing ${required}`);
    }
  }
}

function writeInspectReportFixtures() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "artifact-viewer");
  const trendReport = join(dir, "trend.report.json");
  const flakeReport = join(dir, "flake-classification.report.json");
  const instrumentsReport = join(dir, "instruments.report.json");
  writeFileSync(trendReport, `${JSON.stringify(makeInspectTrendReport(), null, 2)}\n`);
  writeFileSync(flakeReport, `${JSON.stringify(makeInspectFlakeReport(), null, 2)}\n`);
  writeFileSync(instrumentsReport, `${JSON.stringify(makeInspectInstrumentsReport(), null, 2)}\n`);
  return {
    trendReport,
    flakeReport,
    instrumentsReport
  };
}

function makeInspectTrendReport() {
  return {
    schema_version: "1.2.0",
    kind: "trend_report",
    status: "pass",
    generated_at: "2026-01-01T00:00:00.000Z",
    failures: [],
    policy: {
      last_valid_run_limit: 30,
      valid_run_rule: "exclude INVALID verdicts and INFRA_FLAKE runs",
      slope_method: "ordinary_least_squares_over_sequence_index"
    },
    source_counts: {
      g8_verdict_report: 35
    },
    run_counts: {
      input: 35,
      grouped: 35,
      valid: 33,
      last_valid: 30
    },
    trends: {
      per_gate: {
        static: {
          count: 30,
          pass_count: 29,
          fail_count: 1,
          statuses: { pass: 29, fail: 1 }
        }
      },
      per_device: {
        "iPhone16,2": {
          count: 15,
          pass_count: 15,
          fail_count: 0,
          statuses: { pass: 15 }
        }
      },
      per_ios_build: {
        "26A200": {
          count: 17,
          pass_count: 16,
          fail_count: 1,
          statuses: { pass: 16, fail: 1 }
        }
      },
      visual_loss: {
        count: 30,
        latest: 0.0245,
        min: 0.0105,
        max: 0.0245,
        slope_per_run: 0.0005,
        direction: "up"
      },
      runtime_cost_ms: {
        count: 30,
        latest: 16.25,
        min: 16.25,
        max: 17.95,
        slope_per_run: -0.05,
        direction: "down"
      },
      energy_cost: {
        count: 30,
        latest: 2.08,
        min: 1.42,
        max: 2.08,
        slope_per_run: 0.02,
        direction: "up"
      },
      flake_rate: {
        count: 30,
        rate: 0.13,
        slope_per_run: 0.01,
        direction: "up"
      }
    },
    last_30_valid_runs: [
      {
        run_id: "trend-self-test-30",
        source_kind: "g8_verdict_report",
        source_kinds: ["g8_verdict_report"],
        input_paths: ["artifacts/lab-self-test/trend-report/run-30.g8-verdict.report.json"],
        generated_at: "2026-01-01T00:30:00.000Z",
        status: "pass",
        verdict_class: "PROD_PASS",
        technical_class: "SHADER_PASS",
        flake_class: "NONE",
        device: {
          model_name: "iPhone Pro",
          model_identifier: "iPhone16,2",
          os_build: "26A200",
          sdk_build: "26.0"
        },
        gates: {
          static: "pass",
          optics: "pass",
          energy: "pass"
        },
        metrics: {
          visual_loss: 0.0245,
          runtime_cost_ms: 16.25,
          energy_cost: 2.08
        }
      }
    ]
  };
}

function makeInspectFlakeReport() {
  return {
    schema_version: "1.2.0",
    kind: "flake_classification_report",
    status: "pass",
    generated_at: "2026-01-01T00:00:00.000Z",
    flake_class: "PRODUCT_REGRESSION",
    failures: [],
    policy: {
      classes: ["NONE", "METRIC_NOISE", "INFRA_FLAKE", "PRODUCT_REGRESSION", "UNKNOWN"],
      priority: "UNKNOWN > PRODUCT_REGRESSION > INFRA_FLAKE > METRIC_NOISE > NONE",
      rules: {
        INFRA_FLAKE: "device/daemon/runner/capture-path/thermal-precondition failures",
        PRODUCT_REGRESSION: "deterministic G2-G6/G8 product or metric failures after valid capture",
        METRIC_NOISE: "explicit noise/outlier/confidence evidence only",
        UNKNOWN: "evidence exists but no deterministic rule matched"
      }
    },
    action: "block_as_product_red",
    class_counts: {
      PRODUCT_REGRESSION: 1
    },
    evidence: [
      {
        type: "failure",
        code: "G2_SSIM_BELOW_FLOOR",
        source_kind: "g2_metric_report",
        input_path: "artifacts/g2.report.json",
        class: "PRODUCT_REGRESSION",
        rule: "product_pattern"
      }
    ]
  };
}

function makeInspectInstrumentsReport() {
  return {
    schema_version: "1.2.0",
    kind: "glass_instruments_report",
    gate: "G6",
    status: "pass",
    failures: [],
    warnings: [],
    artifact: {
      id: "viewer-self-test-c1-instruments",
      rig_id: "C1",
      scene_id: "S03_PRESS",
      state_id: "sustained"
    },
    trace: {
      available: true,
      status: "available",
      tool: "instruments_power_profiler",
      path: "artifacts/lab-self-test/artifact-viewer/power.trace",
      repo_relative_path: "artifacts/lab-self-test/artifact-viewer/power.trace",
      hash_method: "sha256_tree_v1",
      expected_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      actual_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parsed: {
        kind: "instruments_power_profiler",
        status: "pass",
        source_file: "artifacts/lab-self-test/artifact-viewer/power.trace/samples.jsonl",
        metrics: {
          sample_count: 2,
          duration_ms: 100,
          average_power_mw: 118.65,
          max_power_mw: 119.1,
          energy_mj: 11.865
        }
      }
    },
    energy: {
      energy_mj_per_10s: 1.19,
      average_power_mw: 118.65
    }
  };
}

function assertTrendViewerContract(path) {
  const html = readFileSync(path, "utf8");
  for (const required of [
    'id="trend-slopes"',
    'id="trend-last-valid-runs"',
    "visual_loss",
    "per_gate",
    "iPhone16,2",
    "26A200"
  ]) {
    if (!html.includes(required)) {
      throw new Error(`trend inspect viewer self-test missing ${required}`);
    }
  }
}

function assertFlakeViewerContract(path) {
  const html = readFileSync(path, "utf8");
  for (const required of [
    'id="flake-classification-evidence"',
    "PRODUCT_REGRESSION",
    "block_as_product_red",
    "G2_SSIM_BELOW_FLOOR",
    "product_pattern"
  ]) {
    if (!html.includes(required)) {
      throw new Error(`flake inspect viewer self-test missing ${required}`);
    }
  }
}

function assertInstrumentsViewerContract(path) {
  const html = readFileSync(path, "utf8");
  for (const required of [
    'id="instruments-parsed-trace"',
    "instruments_power_profiler",
    "sample_count",
    "average_power_mw",
    "energy_mj",
    "hash_match"
  ]) {
    if (!html.includes(required)) {
      throw new Error(`instruments inspect viewer self-test missing ${required}`);
    }
  }
}
