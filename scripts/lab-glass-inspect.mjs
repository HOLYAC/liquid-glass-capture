#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderInspectViewer,
  writeViewerHtml,
  writeViewerSelfTestArtifacts
} from "./lib/lab-artifact-viewer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeViewerSelfTestArtifacts();
    const out = args.out ?? join(repoRoot, "artifacts", "lab-self-test", "artifact-viewer", "inspect.html");
    const html = renderInspectViewer(fixture.referenceArtifact);
    const path = writeViewerHtml(out, html);
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
