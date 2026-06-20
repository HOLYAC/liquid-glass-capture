#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderDiffViewer,
  writeViewerHtml,
  writeViewerSelfTestArtifacts
} from "./lib/lab-artifact-viewer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeViewerSelfTestArtifacts();
    const out = args.out ?? join(repoRoot, "artifacts", "lab-self-test", "artifact-viewer", "diff.html");
    const html = renderDiffViewer(fixture.referenceArtifact, fixture.candidateArtifact);
    const path = writeViewerHtml(out, html);
    assertDiffViewerContract(path);
    console.log(`PASS ${path}`);
    return;
  }

  if (!args.reference || !args.candidate) {
    console.error("usage: node scripts/lab-glass-diff.mjs --reference <capture.json|artifact-id> --candidate <capture.json|artifact-id> [--out diff.html]");
    console.error("       node scripts/lab-glass-diff.mjs --self-test [--out diff.html]");
    process.exit(2);
  }

  const out = args.out ?? join(repoRoot, "artifacts", "viewer", `${safeName(args.reference)}__${safeName(args.candidate)}.diff.html`);
  const html = renderDiffViewer(args.reference, args.candidate);
  const path = writeViewerHtml(out, html);
  console.log(`PASS ${path}`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--reference") parsed.reference = args[++index];
    else if (arg === "--candidate") parsed.candidate = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 56) || "artifact";
}

function assertDiffViewerContract(path) {
  const html = readFileSync(path, "utf8");
  for (const required of [
    'id="heatmap"',
    'id="mask-overlay"',
    'id="temporal-phase-plot"',
    'id="frame-budget-timeline"',
    'id="energy-trace-panel"',
    'id="energy-trace-link"',
    "instruments_power_profiler",
    "sha256_tree_v1"
  ]) {
    if (!html.includes(required)) {
      throw new Error(`diff viewer self-test missing ${required}`);
    }
  }
}
