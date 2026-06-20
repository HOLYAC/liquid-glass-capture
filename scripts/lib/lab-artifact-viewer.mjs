import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lab-artifact.mjs";
import { readArtifactFrameSequence } from "./lab-sequence.mjs";
import { sha256File, writePng } from "./lab-png.mjs";
import { compareMetricImages } from "../../packages/metric-stack/src/index.mjs";
import { measureOptics } from "../../packages/metric-stack/src/optics.mjs";
import { measureTemporal } from "../../packages/metric-stack/src/temporal.mjs";
import { measureRuntime } from "../../packages/metric-stack/src/runtime.mjs";
import { measureEnergy } from "../../packages/energy-stack/src/index.mjs";
import { makeReviewPacketSeed } from "../../packages/review-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const s03PressTrajectorySha256 = "56148be556260e9f1647bf9ab09ddf12c7ae129b3194722b2ed54bb8ad2fbcdd";

export function resolveArtifactInput(input, options = {}) {
  const direct = resolve(input);
  if (existsSync(direct)) return direct;

  const roots = options.searchRoots ?? [join(repoRoot, "artifacts")];
  const matches = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const candidate of walkJson(root)) {
      try {
        const json = JSON.parse(readFileSync(candidate, "utf8"));
        if (json.id === input || json.baseline_namespace === input || candidate.endsWith(input)) {
          matches.push(candidate);
        }
      } catch {
        // A viewer search should skip non-JSON artifacts without hiding direct-read errors.
      }
    }
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Artifact id is ambiguous: ${input}\n${matches.join("\n")}`);
  }
  throw new Error(`Artifact not found by path or id: ${input}`);
}

export function renderInspectViewer(inputPath) {
  const absolute = resolveArtifactInput(inputPath);
  const json = JSON.parse(readFileSync(absolute, "utf8"));
  if (json.kind === "baseline_metric_report") {
    return renderBaselineViewer(absolute, json);
  }
  if (json.kind === "g8_verdict_report") {
    return renderVerdictViewer(absolute, json);
  }

  const record = readCaptureArtifact(absolute, {
    allowInvalid: true,
    allowLayerSnapshot: true
  });
  const artifact = record.artifact;
  const imageUri = record.png_path ? dataUri(record.png_path, "image/png") : "";
  const framePaths = artifact.frame_pack?.sequence_paths ?? [];
  const identity = artifactIdentity(record);
  const rows = [
    ["artifact_id", artifact.id],
    ["rig", artifact.rig_id],
    ["scene", artifact.scene_id],
    ["state", artifact.state_id],
    ["capture", artifact.capture_kind],
    ["null", artifact.null_qualification ?? "not_recorded"],
    ["technical", artifact.technical_class ?? "not_scored"],
    ["verdict", artifact.verdict_class ?? "not_scored"],
    ["invalid_reason", artifact.invalid_reason ?? ""],
    ["png_sha256", record.png?.sha256 ?? ""],
    ["mask_sha256", artifact.frame_pack?.mask_pack_sha256 ?? ""],
    ["sequence_frames", String(framePaths.length)],
    ["baseline_namespace", baselineNamespaceFromArtifact(artifact)]
  ];

  return page("Artifact Inspect", [
    hero("Artifact Inspect", artifact.id, [
      statusPill("null", artifact.null_qualification ?? "unknown"),
      statusPill("technical", artifact.technical_class ?? "not_scored"),
      statusPill("verdict", artifact.verdict_class ?? "not_scored")
    ]),
    section("Frame", `
      <div class="media-grid one">
        ${imageUri ? `<img class="frame" src="${imageUri}" alt="capture frame">` : `<div class="missing">no frame png</div>`}
      </div>
    `),
    section("Identity", table(rows)),
    section("Color Pipeline", table(objectRows(artifact.color))),
    section("Device", table(objectRows(identity.device ?? {}))),
    section("Performance", table(objectRows(artifact.perf ?? { status: "not_recorded" }))),
    section("Energy", table(objectRows(artifact.energy ?? { status: "not_recorded" }))),
    section("Identifiability", table(objectRows(artifact.shader?.identifiability ?? { status: "not_recorded" }))),
    section("Raw Artifact", `<pre>${escapeHtml(JSON.stringify(artifact, null, 2))}</pre>`)
  ]);
}

export function renderDiffViewer(referencePath, candidatePath) {
  const referenceRecord = readCaptureArtifact(resolveArtifactInput(referencePath), {
    allowInvalid: true,
    allowLayerSnapshot: true
  });
  const candidateRecord = readCaptureArtifact(resolveArtifactInput(candidatePath), {
    allowInvalid: true,
    allowLayerSnapshot: true
  });
  const report = compareMetricImages(referenceRecord.png, candidateRecord.png);
  const opticsReport = measureOptics(referenceRecord.png, candidateRecord.png);
  const temporalReport = measureTemporalSafely(referenceRecord, candidateRecord);
  const runtimeReport = measureRuntimeSafely(candidateRecord);
  const energyReport = measureEnergySafely(candidateRecord);
  const reference = referenceRecord.artifact;
  const candidate = candidateRecord.artifact;
  const reviewPacketSeed = makeReviewPacketSeed({
    reference,
    candidate,
    gateReports: [report, opticsReport, temporalReport, runtimeReport, energyReport]
  });
  const referenceUri = dataUri(referenceRecord.png_path, "image/png");
  const candidateUri = dataUri(candidateRecord.png_path, "image/png");

  return page("Artifact Diff", [
    hero("Artifact Diff", `${reference.id} -> ${candidate.id}`, [
      statusPill("G2", report.status),
      statusPill("G3", opticsReport.status),
      statusPill("G4", temporalReport.status),
      statusPill("G5", runtimeReport.status),
      statusPill("G6", energyReport.status),
      statusPill("ref null", reference.null_qualification ?? "unknown"),
      statusPill("cand null", candidate.null_qualification ?? "unknown")
    ]),
    section("Frames", `
      <div class="media-grid">
        <figure><img class="frame" id="reference-frame" src="${referenceUri}" alt="reference frame"><figcaption>reference ${escapeHtml(reference.rig_id)}</figcaption></figure>
        <figure><img class="frame" id="candidate-frame" src="${candidateUri}" alt="candidate frame"><figcaption>candidate ${escapeHtml(candidate.rig_id)}</figcaption></figure>
        <figure><canvas class="frame" id="heatmap"></canvas><figcaption>debug heatmap</figcaption></figure>
      </div>
    `),
    section("Metric Summary", metricTable(report.metrics ?? {})),
    section("Optics Summary", metricTable(opticsReport.metrics ?? {})),
    section("Temporal Summary", temporalSummary(temporalReport)),
    section("Runtime Summary", runtimeSummary(runtimeReport)),
    section("Energy Summary", energySummary(energyReport)),
    section("G7 Review Packet Seed", `<pre>${escapeHtml(JSON.stringify(reviewPacketSeed, null, 2))}</pre>`),
    section("Reference", table([
      ["id", reference.id],
      ["rig", reference.rig_id],
      ["scene", reference.scene_id],
      ["state", reference.state_id],
      ["baseline_namespace", baselineNamespaceFromArtifact(reference)]
    ])),
    section("Candidate", table([
      ["id", candidate.id],
      ["rig", candidate.rig_id],
      ["scene", candidate.scene_id],
      ["state", candidate.state_id],
      ["baseline_namespace", baselineNamespaceFromArtifact(candidate)]
    ])),
    section("Identifiability", table(objectRows(candidate.shader?.identifiability ?? { status: "not_recorded" }))),
    section("Energy", table(objectRows(candidate.energy ?? { status: "not_recorded" }))),
    `<script>${heatmapScript()}</script>`
  ]);
}

export function writeViewerHtml(path, html) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, html);
  return absolute;
}

export function writeViewerSelfTestArtifacts() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "artifact-viewer");
  mkdirSync(dir, { recursive: true });

  const width = 28;
  const height = 18;
  const referencePixels = Buffer.alloc(width * height * 4);
  const candidatePixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const base = 44 + x * 3 + y * 2;
      referencePixels[offset] = base;
      referencePixels[offset + 1] = 92;
      referencePixels[offset + 2] = 146;
      referencePixels[offset + 3] = 255;
      candidatePixels[offset] = Math.min(255, base + (x > 14 ? 6 : 0));
      candidatePixels[offset + 1] = 92;
      candidatePixels[offset + 2] = 146;
      candidatePixels[offset + 3] = 255;
    }
  }

  const referencePng = join(dir, "viewer-reference.png");
  const candidatePng = join(dir, "viewer-candidate.png");
  writePng(referencePng, width, height, referencePixels);
  writePng(candidatePng, width, height, candidatePixels);
  const referenceSequence = writeViewerMotionSequence(dir, "viewer-reference-seq", width, height, 0);
  const candidateSequence = writeViewerMotionSequence(dir, "viewer-candidate-seq", width, height, 4);

  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const referenceArtifact = join(dir, "viewer-reference.capture.json");
  const candidateArtifact = join(dir, "viewer-candidate.capture.json");
  writeFileSync(referenceArtifact, `${JSON.stringify(makeSelfTestArtifact("R0", referencePng, maskPath, referenceSequence), null, 2)}\n`);
  writeFileSync(candidateArtifact, `${JSON.stringify(makeSelfTestArtifact("R1", candidatePng, maskPath, candidateSequence), null, 2)}\n`);
  return {
    referenceArtifact,
    candidateArtifact
  };
}

function renderVerdictViewer(path, report) {
  return page("Verdict Inspect", [
    hero("Verdict Inspect", report.artifacts?.candidate?.id ?? relative(repoRoot, path), [
      statusPill("verdict", report.verdict_class ?? "unknown"),
      statusPill("technical", report.technical_class ?? "unknown"),
      statusPill("design", report.design_class ?? "unknown")
    ]),
    section("Final Verdict", table([
      ["verdict_class", report.verdict_class],
      ["technical_class", report.technical_class],
      ["design_class", report.design_class],
      ["flake_class", report.flake_class],
      ["status", report.status],
      ["null_qualification", report.null_qualification],
      ["source", relative(repoRoot, path)]
    ])),
    section("Scene", table([
      ["scene_id", report.scene?.scene_id ?? ""],
      ["state_id", report.scene?.state_id ?? ""],
      ["capture_kind", report.capture_kind ?? ""]
    ])),
    section("Gates", table(objectRows(report.gates ?? {}))),
    section("Device", table(objectRows(report.device ?? {}))),
    section("Identifiability", table(objectRows(report.identifiability ?? { status: "not_recorded" }))),
    section("Baseline", table(objectRows(report.baseline ?? { status: "not_recorded" }))),
    section("Blockers", table((report.blockers ?? []).map((blocker, index) => [index, blocker]))),
    section("Raw Verdict", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function renderBaselineViewer(path, report) {
  const rows = [
    ["baseline_namespace", report.baseline_namespace],
    ["baseline_class", report.baseline_class],
    ["status", report.baseline_status],
    ["repeat_requested", report.repeat_n_requested],
    ["repeat_observed", report.repeat_n_observed],
    ["final_p99_allowed", report.repeat_policy?.final_p99_allowed],
    ["source", relative(repoRoot, path)]
  ];

  return page("Baseline Inspect", [
    hero("Baseline Inspect", report.baseline_namespace ?? "unnamed baseline", [
      statusPill("baseline", report.baseline_status ?? "unknown"),
      statusPill("G2", report.gates?.G2 ?? "not_run")
    ]),
    section("Namespace", table(rows)),
    section("Instrument Noise", metricSummaryTable(report.instrument_noise?.metrics ?? {})),
    section("Candidate Gap", metricSummaryTable(report.candidate_gap?.metrics ?? {})),
    section("Artifacts", table([
      ["reference_count", report.reference_artifacts?.length ?? 0],
      ["probe_count", report.probe_artifacts?.length ?? 0]
    ])),
    section("Raw Baseline", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function measureRuntimeSafely(candidateRecord) {
  try {
    return measureRuntime(candidateRecord);
  } catch (error) {
    return {
      schema_version: "1.2.0",
      kind: "g5_runtime_report",
      gate: "G5",
      status: "fail",
      failures: [`G5_RUNTIME_UNREADABLE:${error.message}`],
      metrics: {}
    };
  }
}

function measureEnergySafely(candidateRecord) {
  try {
    return measureEnergy(candidateRecord);
  } catch (error) {
    return {
      schema_version: "1.2.0",
      kind: "g6_energy_report",
      gate: "G6",
      status: "fail",
      failures: [`G6_ENERGY_UNREADABLE:${error.message}`],
      warnings: [],
      metrics: {}
    };
  }
}

function measureTemporalSafely(referenceRecord, candidateRecord) {
  try {
    return measureTemporal(
      readArtifactFrameSequence(referenceRecord),
      readArtifactFrameSequence(candidateRecord)
    );
  } catch (error) {
    return {
      schema_version: "1.2.0",
      kind: "g4_temporal_report",
      gate: "G4",
      status: "fail",
      failures: [`G4_TEMPORAL_UNREADABLE:${error.message}`],
      metrics: {}
    };
  }
}

function runtimeSummary(report) {
  return [
    table([
      ["status", report.status],
      ["failures", (report.failures ?? []).join(", ")],
      ["source", report.policy?.source_note ?? ""],
      ["full_frame_p95_ceiling_ms", report.policy?.full_frame_p95_ceiling_ms ?? ""]
    ]),
    metricTable(report.metrics ?? {})
  ].join("");
}

function energySummary(report) {
  return [
    table([
      ["status", report.status],
      ["failures", (report.failures ?? []).join(", ")],
      ["warnings", (report.warnings ?? []).join(", ")],
      ["require_energy_trace", report.policy?.require_energy_trace ?? ""]
    ]),
    metricTable(report.metrics ?? {})
  ].join("");
}

function temporalSummary(report) {
  return [
    table([
      ["status", report.status],
      ["failures", (report.failures ?? []).join(", ")],
      ["reference_trajectory", report.trajectory?.reference_sha256 ?? ""],
      ["candidate_trajectory", report.trajectory?.candidate_sha256 ?? ""],
      ["byte_identical_source", report.trajectory?.byte_identical_source ?? ""],
      ["reference_frames", report.frame_counts?.reference ?? ""],
      ["candidate_frames", report.frame_counts?.candidate ?? ""]
    ]),
    metricTable(report.metrics ?? {})
  ].join("");
}

function writeViewerMotionSequence(dir, prefix, width, height, staticBias) {
  const positions = [4, 14, 14, 14, 14, 14];
  const paths = [];
  for (let index = 0; index < positions.length; index += 1) {
    const pixels = Buffer.alloc(width * height * 4);
    const centerX = positions[index];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const background = 38 + staticBias + x * 2 + y;
        const insideMotion = Math.abs(x - centerX) <= 2 && Math.abs(y - 9) <= 3;
        pixels[offset] = insideMotion ? 226 : Math.min(255, background);
        pixels[offset + 1] = insideMotion ? 232 : Math.min(255, background + 18);
        pixels[offset + 2] = insideMotion ? 238 : Math.min(255, background + 42);
        pixels[offset + 3] = 255;
      }
    }
    const path = join(dir, `${prefix}-${String(index).padStart(2, "0")}.png`);
    writePng(path, width, height, pixels);
    paths.push(path);
  }

  return {
    paths,
    timestamps_ms: [0, 16.67, 33.33, 50, 66.67, 83.33]
  };
}

function page(title, bodyParts) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${styles()}</style>
</head>
<body>
  <main>
    ${bodyParts.join("\n")}
  </main>
</body>
</html>
`;
}

function hero(title, subtitle, pills) {
  return `<header class="hero">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle ?? "")}</p>
    </div>
    <div class="pills">${pills.join("")}</div>
  </header>`;
}

function section(title, body) {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function statusPill(label, value) {
  const status = String(value ?? "unknown").toLowerCase();
  const tone = status.includes("pass") || status === "complete" ? "ok" : status.includes("fail") || status.includes("invalid") || status.includes("blocked") ? "bad" : "warn";
  return `<span class="pill ${tone}"><b>${escapeHtml(label)}</b>${escapeHtml(String(value ?? "unknown"))}</span>`;
}

function table(rows) {
  return `<table>${rows.map(([key, value]) => `<tr><th>${escapeHtml(String(key))}</th><td>${escapeHtml(formatValue(value))}</td></tr>`).join("")}</table>`;
}

function objectRows(object) {
  return Object.entries(object ?? {}).map(([key, value]) => [key, formatValue(value)]);
}

function metricTable(metrics) {
  const rows = [];
  for (const [group, values] of Object.entries(metrics)) {
    if (!values || typeof values !== "object") continue;
    for (const [name, value] of Object.entries(values)) {
      rows.push([`${group}.${name}`, value]);
    }
  }
  return table(rows.length > 0 ? rows : [["metrics", "not_recorded"]]);
}

function metricSummaryTable(metrics) {
  const rows = [];
  for (const [metric, summary] of Object.entries(metrics)) {
    rows.push([
      metric,
      `n=${summary.count} mean=${round(summary.mean)} p95=${round(summary.p95)} p99=${round(summary.p99)} max=${round(summary.max)}`
    ]);
  }
  return table(rows.length > 0 ? rows : [["metrics", "not_recorded"]]);
}

function baselineNamespaceFromArtifact(artifact) {
  const device = artifact.device_info ?? {};
  const integrity = artifact.integrity ?? {};
  return [
    "baseline",
    "unbound",
    artifact.scene_id,
    artifact.state_id,
    artifact.rig_id,
    safePart(device.model_identifier),
    safePart(device.os_build),
    safePart(device.sdk_build),
    safePart(integrity.producer_version)
  ].join("__");
}

function safePart(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_.-]+/gi, "-");
}

function dataUri(path, mime) {
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

function walkJson(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...walkJson(path));
    } else if (entry.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

function heatmapScript() {
  return `
(() => {
  const ref = document.getElementById("reference-frame");
  const cand = document.getElementById("candidate-frame");
  const canvas = document.getElementById("heatmap");
  if (!ref || !cand || !canvas) return;
  function draw() {
    const width = Math.min(ref.naturalWidth, cand.naturalWidth);
    const height = Math.min(ref.naturalHeight, cand.naturalHeight);
    if (!width || !height) return;
    canvas.width = width;
    canvas.height = height;
    const scratch = document.createElement("canvas");
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    const out = canvas.getContext("2d");
    ctx.drawImage(ref, 0, 0, width, height);
    const left = ctx.getImageData(0, 0, width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(cand, 0, 0, width, height);
    const right = ctx.getImageData(0, 0, width, height);
    const image = out.createImageData(width, height);
    for (let i = 0; i < image.data.length; i += 4) {
      const d = Math.max(
        Math.abs(left.data[i] - right.data[i]),
        Math.abs(left.data[i + 1] - right.data[i + 1]),
        Math.abs(left.data[i + 2] - right.data[i + 2])
      );
      image.data[i] = Math.min(255, d * 10);
      image.data[i + 1] = Math.max(0, 80 - d * 2);
      image.data[i + 2] = 255 - Math.min(255, d * 6);
      image.data[i + 3] = 255;
    }
    out.putImageData(image, 0, 0);
  }
  if (ref.complete && cand.complete) draw();
  ref.addEventListener("load", draw);
  cand.addEventListener("load", draw);
})();`;
}

function styles() {
  return `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#090b0d; color:#f3f7fb; }
* { box-sizing:border-box; }
body { margin:0; background:#090b0d; }
main { width:min(1440px, 100%); margin:0 auto; padding:24px; }
.hero { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; padding:18px 0 22px; border-bottom:1px solid rgba(255,255,255,0.16); }
h1 { margin:0; font-size:26px; line-height:1.05; letter-spacing:0; }
h2 { margin:0 0 10px; font-size:14px; line-height:1.15; color:#c9d7e4; letter-spacing:0; }
p { margin:8px 0 0; color:#8f9dac; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; overflow-wrap:anywhere; }
section { padding:18px 0; border-bottom:1px solid rgba(255,255,255,0.10); }
.pills { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.pill { display:inline-flex; gap:8px; align-items:center; min-height:28px; padding:6px 9px; border:1px solid rgba(255,255,255,0.18); border-radius:8px; background:#12171c; font-size:12px; }
.pill b { color:#7f8b98; font-weight:650; }
.pill.ok { border-color:rgba(92,220,155,0.45); }
.pill.bad { border-color:rgba(255,100,100,0.50); }
.pill.warn { border-color:rgba(245,190,92,0.45); }
.media-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; align-items:start; }
.media-grid.one { grid-template-columns:minmax(0, 1fr); }
figure { margin:0; min-width:0; }
figcaption { margin-top:6px; color:#8f9dac; font-size:11px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.frame { display:block; width:100%; max-height:62vh; min-height:180px; object-fit:contain; background:#050607; border:1px solid rgba(255,255,255,0.14); border-radius:8px; }
.missing { display:grid; place-items:center; min-height:180px; border:1px solid rgba(255,255,255,0.14); border-radius:8px; color:#8f9dac; }
table { width:100%; border-collapse:collapse; table-layout:fixed; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
th, td { padding:8px 10px; vertical-align:top; border-top:1px solid rgba(255,255,255,0.08); overflow-wrap:anywhere; }
th { width:260px; color:#8f9dac; font-weight:600; text-align:left; }
td { color:#edf5ff; }
pre { margin:0; overflow:auto; max-height:56vh; padding:12px; background:#050607; border:1px solid rgba(255,255,255,0.12); border-radius:8px; font-size:11px; line-height:1.45; }
@media (max-width: 860px) {
  main { padding:16px; }
  .hero { align-items:flex-start; flex-direction:column; }
  .pills { justify-content:flex-start; }
  .media-grid { grid-template-columns:1fr; }
  th { width:42%; }
}
`;
}

function makeSelfTestArtifact(rigId, pngPath, maskPath, sequence) {
  return {
    schema_version: "1.2.0",
    id: `viewer-self-test-${rigId}`,
    rig_id: rigId,
    scene_id: "S01_SEARCH",
    state_id: "rest",
    git_commit: "self-test",
    technical_class: "INVALID",
    verdict_class: "INVALID",
    invalid_reason: "NON_PHYSICAL_PATH",
    null_qualification: rigId === "R0" ? "pass" : "fail",
    capture_kind: "compositor",
    device_info: {
      model_name: "Self Test Device",
      model_identifier: "iPhone-self-test",
      os_name: "iOS",
      os_version: "26.0",
      os_build: "self-test",
      sdk_build: "self-test",
      screen_scale: 3,
      refresh_hz: 60,
      thermal_state_start: "nominal",
      thermal_state_end: "nominal",
      low_power_mode: false
    },
    environment: {
      appearance: "dark",
      reduce_transparency: false,
      reduce_motion: false,
      content_seed: "artifact-viewer-self-test",
      viewport_px: { width: 28, height: 18 },
      capture_timestamp_ns: "0"
    },
    color: {
      embedded_icc_profile: "Display P3",
      icc_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      working_space: "display-p3-linear",
      stored_transfer: "srgb-transfer",
      white_point: "D65"
    },
    frame_pack: {
      base_png_sha256: sha256File(pngPath),
      base_png_path: pngPath,
      sequence_paths: sequence.paths,
      sequence_timestamps_ms: sequence.timestamps_ms,
      trajectory_source_sha256: s03PressTrajectorySha256,
      mask_pack_sha256: sha256File(maskPath),
      mask_pack_path: maskPath,
      touch_phase: "rest",
      animation_t: 0,
      sustained_duration_ms: 10_000
    },
    shader: {
      pipeline: rigId === "R0" ? "passthrough" : "dom_css",
      identifiability: {
        blur_radius: "AMBIGUOUS",
        tint: "MEASURED"
      }
    },
    energy: {
      trace_available: false
    },
    perf: {
      measurement_source: "artifact-viewer-self-test",
      full_frame_ms_p95: 14.2,
      frame_interval_ms_p95: 16.67,
      compositor_frame_ms_p95: 16.67,
      dropped_frames: 0,
      sustained_degradation_pct: 0.4
    },
    integrity: {
      artifact_sha256: "self-test-pending",
      producer_version: "lab-artifact-viewer.self-test"
    }
  };
}

function formatValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return round(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function round(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value ?? "");
  if (Math.abs(value) >= 100) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(4);
  return value.toPrecision(4);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
