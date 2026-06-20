import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactIdentity, readCaptureArtifact } from "./lab-artifact.mjs";
import { finalizeCaptureArtifactIntegrity } from "../../packages/capture-schema/src/integrity.mjs";
import { readArtifactFrameSequence } from "./lab-sequence.mjs";
import { sha256File, writePng } from "./lab-png.mjs";
import { compareMetricImages } from "../../packages/metric-stack/src/index.mjs";
import { measureOptics } from "../../packages/metric-stack/src/optics.mjs";
import { measureTemporal } from "../../packages/metric-stack/src/temporal.mjs";
import { measureRuntime } from "../../packages/metric-stack/src/runtime.mjs";
import { measureEnergy } from "../../packages/energy-stack/src/index.mjs";
import { maskContainsPointFor, requiredGlassMaskIds } from "../../packages/mask-core/src/index.mjs";
import { makeReviewPacketSeed } from "../../packages/review-stack/src/index.mjs";
import { glassTrajectoryShaByScene } from "../../packages/material-glass/src/index.mjs";
import { sha256TracePath } from "./lab-trace-hash.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const s03PressTrajectorySha256 = glassTrajectoryShaByScene.S03_PRESS;

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
  if (json.kind === "trend_report") {
    return renderTrendViewer(absolute, json);
  }
  if (json.kind === "flake_classification_report") {
    return renderFlakeClassificationViewer(absolute, json);
  }
  if (json.kind === "glass_instruments_report") {
    return renderInstrumentsViewer(absolute, json);
  }
  if (json.kind === "solver_pareto_report") {
    return renderSolverViewer(absolute, json);
  }
  if (json.kind === "physical_device_lane_report" || json.kind === "physical_device_lane_plan" || json.kind === "physical_device_lane_self_test_report") {
    return renderPhysicalDeviceLaneViewer(absolute, json);
  }
  if (
    json.kind === "artifact_store_index" ||
    json.kind === "artifact_store_write_report" ||
    json.kind === "artifact_store_verify_report" ||
    json.kind === "artifact_store_retention_plan" ||
    json.kind === "artifact_store_self_test_report"
  ) {
    return renderArtifactStoreViewer(absolute, json);
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
    section("Frame Manifest", frameManifestPanel(absolute, artifact)),
    section("Mask Overlay", maskOverlay(record)),
    section("Identity", table(rows)),
    section("Color Pipeline", table(objectRows(artifact.color))),
    section("Device", table(objectRows(identity.device ?? {}))),
    section("Performance", table(objectRows(artifact.perf ?? { status: "not_recorded" }))),
    section("Energy", table(objectRows(artifact.energy ?? { status: "not_recorded" }))),
    section("Energy Trace", energyTracePanel(record)),
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
    section("Mask Overlay", maskOverlay(referenceRecord)),
    section("Temporal Phase Plot", temporalPhasePlot(temporalReport)),
    section("Frame Budget Timeline", frameBudgetTimeline(temporalReport, runtimeReport)),
    section("Metric Summary", metricTable(report.metrics ?? {})),
    section("Optics Summary", metricTable(opticsReport.metrics ?? {})),
    section("Temporal Summary", temporalSummary(temporalReport)),
    section("Runtime Summary", runtimeSummary(runtimeReport)),
    section("Energy Summary", energySummary(energyReport)),
    section("Candidate Energy Trace", energyTracePanel(candidateRecord)),
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
  const referenceFrameManifest = writeViewerFrameManifest(dir, "viewer-reference", referenceSequence);
  const candidateFrameManifest = writeViewerFrameManifest(dir, "viewer-candidate", candidateSequence);
  const referenceTrace = writeViewerTracePackage(dir, "viewer-reference");
  const candidateTrace = writeViewerTracePackage(dir, "viewer-candidate");

  const maskPath = join(repoRoot, "fixtures", "masks", "glass_core_mask_pack_v1.json");
  const referenceArtifact = join(dir, "viewer-reference.capture.json");
  const candidateArtifact = join(dir, "viewer-candidate.capture.json");
  writeFileSync(referenceArtifact, `${JSON.stringify(
    makeSelfTestArtifact("R0", referencePng, maskPath, { ...referenceSequence, frameManifest: referenceFrameManifest }, referenceTrace),
    null,
    2
  )}\n`);
  writeFileSync(candidateArtifact, `${JSON.stringify(
    makeSelfTestArtifact("R1", candidatePng, maskPath, { ...candidateSequence, frameManifest: candidateFrameManifest }, candidateTrace),
    null,
    2
  )}\n`);
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
    section("Solver", table(objectRows(report.solver ?? { status: "not_recorded" }))),
    section("Physical Device Lane", table(objectRows(report.physical_device_lane ?? { status: "not_recorded" }))),
    section("Flake Classification", table(objectRows(report.flake_classification ?? { status: "not_recorded" }))),
    section("Identifiability", table(objectRows(report.identifiability ?? { status: "not_recorded" }))),
    section("Claim Constraints", table((report.claim_constraints ?? []).map((constraint) => [
      constraint.parameter,
      `${constraint.tag}: ${constraint.allowed_claim}`
    ]))),
    section("Baseline", table(objectRows(report.baseline ?? { status: "not_recorded" }))),
    section("Retention", table(objectRows(report.retention ?? { status: "not_recorded" }))),
    section("Blockers", table((report.blockers ?? []).map((blocker, index) => [index, blocker]))),
    section("Raw Verdict", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function renderTrendViewer(path, report) {
  return page("Trend Inspect", [
    hero("Trend Inspect", report.generated_at ?? relative(repoRoot, path), [
      statusPill("trend", report.status ?? "unknown"),
      statusPill("valid", report.run_counts?.valid ?? "0"),
      statusPill("last", report.run_counts?.last_valid ?? "0")
    ]),
    section("Summary", table([
      ["kind", report.kind],
      ["status", report.status],
      ["generated_at", report.generated_at],
      ["input_runs", report.run_counts?.input ?? ""],
      ["grouped_runs", report.run_counts?.grouped ?? ""],
      ["valid_runs", report.run_counts?.valid ?? ""],
      ["last_valid_runs", report.run_counts?.last_valid ?? ""],
      ["failures", (report.failures ?? []).join(", ")],
      ["source", relative(repoRoot, path)]
    ])),
    section("Policy", table(objectRows(report.policy ?? { status: "not_recorded" }))),
    section("Sources", table(countRows(report.source_counts))),
    section("Trend Slopes", `<div id="trend-slopes">${table(trendMetricRows(report.trends ?? {}))}</div>`),
    section("Per Gate", `<div id="trend-per-gate">${table(trendBucketRows(report.trends?.per_gate))}</div>`),
    section("Per Device", `<div id="trend-per-device">${table(trendBucketRows(report.trends?.per_device))}</div>`),
    section("Per iOS Build", `<div id="trend-per-ios-build">${table(trendBucketRows(report.trends?.per_ios_build))}</div>`),
    section("Last 30 Valid Runs", `<div id="trend-last-valid-runs">${table(trendRunRows(report.last_30_valid_runs))}</div>`),
    section("Raw Trend", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function renderFlakeClassificationViewer(path, report) {
  return page("Flake Classification Inspect", [
    hero("Flake Classification Inspect", report.flake_class ?? relative(repoRoot, path), [
      statusPill("flake", report.flake_class ?? "unknown"),
      statusPill("status", report.status ?? "unknown"),
      statusPill("action", report.action ?? "unknown")
    ]),
    section("Summary", table([
      ["kind", report.kind],
      ["status", report.status],
      ["generated_at", report.generated_at],
      ["flake_class", report.flake_class],
      ["action", report.action],
      ["failures", (report.failures ?? []).join(", ")],
      ["source", relative(repoRoot, path)]
    ])),
    section("Class Counts", table(countRows(report.class_counts))),
    section("Policy", table([
      ["classes", (report.policy?.classes ?? []).join(", ")],
      ["priority", report.policy?.priority ?? ""],
      ...policyRuleRows(report.policy?.rules)
    ])),
    section("Evidence", `<div id="flake-classification-evidence">${table(flakeEvidenceRows(report.evidence))}</div>`),
    section("Raw Flake Classification", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function renderInstrumentsViewer(path, report) {
  const parsed = report.trace?.parsed ?? {};
  return page("Instruments Inspect", [
    hero("Instruments Inspect", report.artifact?.id ?? relative(repoRoot, path), [
      statusPill("G6", report.status ?? "unknown"),
      statusPill("trace", report.trace?.status ?? "unknown"),
      statusPill("parsed", parsed.status ?? "unknown")
    ]),
    section("Summary", table([
      ["kind", report.kind],
      ["status", report.status],
      ["gate", report.gate],
      ["artifact_id", report.artifact?.id ?? ""],
      ["tool", report.trace?.tool ?? ""],
      ["trace_path", report.trace?.repo_relative_path ?? report.trace?.path ?? ""],
      ["hash_method", report.trace?.hash_method ?? ""],
      ["hash_match", report.trace?.expected_sha256 && report.trace?.actual_sha256
        ? String(report.trace.expected_sha256 === report.trace.actual_sha256)
        : ""],
      ["source", relative(repoRoot, path)]
    ])),
    section("Parsed Trace", `<div id="instruments-parsed-trace">${table([
      ["kind", parsed.kind ?? ""],
      ["status", parsed.status ?? ""],
      ["source_file", parsed.source_file ?? ""],
      ...objectRows(parsed.metrics ?? {})
    ])}</div>`),
    section("Energy", table(objectRows(report.energy ?? { status: "not_recorded" }))),
    section("Failures", table((report.failures ?? []).map((failure, index) => [index, failure]))),
    section("Raw Instruments", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function renderSolverViewer(path, report) {
  return page("Solver Inspect", [
    hero("Solver Inspect", report.selected_candidate?.id ?? relative(repoRoot, path), [
      statusPill("solver", report.status ?? "unknown"),
      statusPill("pareto", String(report.pareto_front?.length ?? 0)),
      statusPill("candidates", String(report.candidate_count ?? 0))
    ]),
    section("Selection", table([
      ["status", report.status],
      ["selected_candidate", report.selected_candidate?.id ?? ""],
      ["candidate_count", report.candidate_count ?? 0],
      ["pareto_count", report.pareto_front?.length ?? 0],
      ["source", relative(repoRoot, path)]
    ])),
    section("Background Sweep", table([
      ["required_scene_ids", (report.background_sweep?.required_scene_ids ?? []).join(", ")],
      ["observed_scene_ids", (report.background_sweep?.observed_scene_ids ?? []).join(", ")]
    ])),
    section("Pareto Front", table((report.pareto_front ?? []).map((candidate) => [
      candidate.id,
      JSON.stringify(candidate.objectives)
    ]))),
    section("Identifiability", table(objectRows(report.parameter_identifiability ?? { status: "not_recorded" }))),
    section("Claim Constraints", table((report.claim_constraints ?? []).map((constraint) => [
      constraint.parameter,
      `${constraint.tag}: ${constraint.allowed_claim}`
    ]))),
    section("Failures", table((report.failures ?? []).map((failure, index) => [index, failure]))),
    section("Raw Solver Report", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function trendMetricRows(trends) {
  const metrics = ["visual_loss", "runtime_cost_ms", "energy_cost", "flake_rate"];
  const rows = metrics.map((metric) => {
    const summary = trends[metric] ?? {};
    const latest = metric === "flake_rate" ? summary.rate : summary.latest;
    return [
      metric,
      `count=${summary.count ?? 0} latest=${formatValue(latest)} min=${formatValue(summary.min)} max=${formatValue(summary.max)} slope=${formatValue(summary.slope_per_run)} direction=${summary.direction ?? "not_recorded"}`
    ];
  });
  return rows.length > 0 ? rows : [["trends", "not_recorded"]];
}

function trendBucketRows(buckets) {
  const rows = Object.entries(buckets ?? {}).map(([key, summary]) => [
    key,
    `count=${summary.count ?? 0} pass=${summary.pass_count ?? 0} fail=${summary.fail_count ?? 0} statuses=${formatValue(summary.statuses ?? {})}`
  ]);
  return rows.length > 0 ? rows : [["buckets", "not_recorded"]];
}

function trendRunRows(runs) {
  const rows = (runs ?? []).map((run) => [
    run.run_id ?? "",
    [
      run.generated_at ?? "",
      `status=${run.status ?? ""}`,
      `verdict=${run.verdict_class ?? ""}`,
      `technical=${run.technical_class ?? ""}`,
      `flake=${run.flake_class ?? ""}`,
      `device=${run.device?.model_identifier ?? ""}`,
      `ios=${run.device?.os_build ?? ""}`,
      `visual=${formatValue(run.metrics?.visual_loss)}`,
      `runtime=${formatValue(run.metrics?.runtime_cost_ms)}`,
      `energy=${formatValue(run.metrics?.energy_cost)}`,
      `sources=${(run.source_kinds ?? [run.source_kind]).join("+")}`
    ].join(" ")
  ]);
  return rows.length > 0 ? rows : [["runs", "not_recorded"]];
}

function flakeEvidenceRows(evidence) {
  const rows = (evidence ?? []).map((entry) => [
    entry.code ?? "",
    [
      `class=${entry.class ?? ""}`,
      `rule=${entry.rule ?? ""}`,
      `type=${entry.type ?? ""}`,
      `source=${entry.source_kind ?? ""}`,
      `path=${entry.input_path ?? ""}`
    ].join(" ")
  ]);
  return rows.length > 0 ? rows : [["evidence", "not_recorded"]];
}

function policyRuleRows(rules) {
  return Object.entries(rules ?? {}).map(([key, value]) => [`rule.${key}`, value]);
}

function countRows(counts) {
  const rows = Object.entries(counts ?? {}).map(([key, value]) => [key, value]);
  return rows.length > 0 ? rows : [["counts", "not_recorded"]];
}

function renderPhysicalDeviceLaneViewer(path, report) {
  const taskReports = report.task_reports ?? report.positive_report?.task_reports ?? [];
  const tasks = report.tasks ?? [];
  return page("Physical Device Lane", [
    hero("Physical Device Lane", report.lane_class ?? relative(repoRoot, path), [
      statusPill("lane", report.status ?? "pending"),
      statusPill("tasks", String(report.task_count ?? tasks.length ?? taskReports.length ?? 0)),
      statusPill("kind", report.kind ?? "unknown")
    ]),
    section("Summary", table([
      ["kind", report.kind],
      ["status", report.status],
      ["lane_class", report.lane_class ?? ""],
      ["task_count", report.task_count ?? tasks.length ?? taskReports.length ?? ""],
      ["gate_status", report.gates?.status ?? ""],
      ["source", relative(repoRoot, path)]
    ])),
    section("Evidence", table(objectRows(report.evidence ?? {
      status: report.kind === "physical_device_lane_plan" ? "plan_only_pending_collection" : "not_recorded"
    }))),
    section("Tasks", table(tasks.map((task) => [
      task.lane_task_id,
      `${task.rig_id} ${task.scene_id}/${task.state_id} repeat=${task.repeat_count_requested}`
    ]))),
    section("Task Reports", table(taskReports.map((task) => [
      task.lane_task_id,
      `${task.status} artifacts=${task.artifacts?.length ?? 0} failures=${task.failures?.length ?? 0}`
    ]))),
    section("Failures", table((report.failures ?? report.simulator_negative_report?.failures ?? []).map((failure, index) => [index, failure]))),
    section("Raw Physical Lane", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function renderArtifactStoreViewer(path, report) {
  const entries = report.entries ?? report.retention_plan?.delete_candidates ?? report.delete_candidates ?? [];
  return page("Artifact Store Inspect", [
    hero("Artifact Store Inspect", report.store_root ?? relative(repoRoot, path), [
      statusPill("store", report.status ?? "index"),
      statusPill("kind", report.kind ?? "unknown"),
      statusPill("entries", String(report.entry_count ?? entries.length ?? 0))
    ]),
    section("Summary", table([
      ["kind", report.kind],
      ["status", report.status ?? "index"],
      ["store_root", report.store_root ?? ""],
      ["index_path", report.index_path ?? ""],
      ["hash_manifest_path", report.hash_manifest_path ?? report.immutability?.hash_manifest_path ?? ""],
      ["entry_count", report.entry_count ?? entries.length ?? ""],
      ["delete_candidate_count", report.delete_candidate_count ?? ""],
      ["source", relative(repoRoot, path)]
    ])),
    section("Immutability", table(objectRows(report.immutability ?? report.invariant ?? {
      deletion_never_removes_hash_manifest: "not_recorded"
    }))),
    section("Entries", table((report.entries ?? []).slice(0, 80).map((entry) => [
      entry.logical_id ?? entry.artifact_store_id,
      `${entry.retention_class} ${entry.sha256 ?? ""} expires=${entry.expires_at ?? "never"}`
    ]))),
    section("Delete Candidates", table((report.delete_candidates ?? []).map((entry) => [
      entry.logical_id ?? entry.artifact_store_id,
      `${entry.retention_class} ${entry.sha256 ?? ""} tombstone=${entry.tombstone?.hash_manifest_preserved === true}`
    ]))),
    section("Failures", table((report.failures ?? []).map((failure, index) => [index, failure]))),
    section("Raw Store Report", `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`)
  ]);
}

function frameManifestPanel(artifactPath, artifact) {
  const manifest = resolveFrameManifest(artifactPath, artifact);
  const rows = [
    ["frame_manifest_path", artifact.frame_pack?.frame_manifest_path ?? ""],
    ["frame_manifest_sha256", artifact.frame_pack?.frame_manifest_sha256 ?? ""],
    ["repo_relative_path", manifest.repoRelativePath],
    ["manifest_path", manifest.path],
    ["path_exists", String(manifest.pathExists)],
    ["schema_version", manifest.schemaVersion],
    ["frame_pack_count", manifest.framePackCount],
    ["frame_manifest_count", manifest.frameCount],
    ["frame_count_match", String(!manifest.mismatch)],
    ["failures", manifest.failures.join(", ")]
  ];

  const previewRows = (manifest.frames ?? []).slice(0, 8).map((frame) => {
    const hasRaw = Boolean(frame.raw?.path);
    const hasDisplay = Boolean(frame.raw?.display?.path);
    return [
      frame.index,
      frame.png,
      String(hasRaw),
      String(hasDisplay),
      frame.raw?.format ?? "",
      frame.raw?.sha256 ?? "",
      frame.raw?.display?.sha256 ?? ""
    ];
  });
  const preview = previewRows.length > 0
    ? table([
      ["index", "png", "has_raw", "has_display", "raw_format", "raw_sha256", "display_sha256"],
      ...previewRows
    ])
    : "<div class=\"missing\">frame manifest data unavailable</div>";

  const tone = manifest.failures.length === 0 ? "ok" : "warn";
  const link = manifest.path
    ? `<p><a id="frame-manifest-link" href="${escapeHtml(pathToFileURL(manifest.path).href)}">open frame manifest package</a></p>`
    : "";

  return `
    <div id="frame-manifest-panel" class="trace-panel ${tone}">
      ${link}
      ${table(rows)}
      <p><strong>Frame manifest sample</strong></p>
      ${preview}
      ${rawFileManifestLinks(manifest)}
    </div>
  `;
}

function resolveFrameManifest(artifactPath, artifact) {
  const framePack = artifact.frame_pack ?? {};
  const manifestRelativePath = framePack.frame_manifest_path;
  const manifestPath = typeof manifestRelativePath === "string" && manifestRelativePath.length > 0
    ? isAbsolute(manifestRelativePath) ? manifestRelativePath : resolve(dirname(artifactPath), manifestRelativePath)
    : "";
  const failures = [];
  let schemaVersion = "";
  let frameCount = 0;
  let frames = [];
  let mismatch = false;
  let pathExists = false;
  let repoRelativePath = "";

  if (manifestPath) {
    repoRelativePath = relative(dirname(artifactPath), manifestPath).replace(/\\/g, "/");
    pathExists = existsSync(manifestPath);
    if (!pathExists) {
      failures.push("FRAME_MANIFEST_PATH_UNREADABLE");
    } else {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        schemaVersion = manifest?.schema_version ?? "";
        frameCount = manifest?.frame_count;
        if (!Number.isFinite(frameCount) || frameCount < 0) {
          failures.push("FRAME_MANIFEST_FRAME_COUNT_INVALID");
        } else if (!Array.isArray(manifest?.frames)) {
          failures.push("FRAME_MANIFEST_FRAMES_NOT_ARRAY");
        } else {
          frames = manifest.frames;
          if (frames.length !== frameCount) {
            failures.push("FRAME_MANIFEST_FRAME_COUNT_MISMATCH");
            mismatch = true;
          }
          if (framePack.frame_manifest_sha256) {
            const actualFrameManifestSha = sha256File(manifestPath);
            if (String(actualFrameManifestSha).toLowerCase() !== String(framePack.frame_manifest_sha256).toLowerCase()) {
              failures.push("FRAME_MANIFEST_SHA256_MISMATCH");
            }
          }
        }
      } catch (error) {
        failures.push(`FRAME_MANIFEST_UNREADABLE:${error.message}`);
      }
    }
  } else {
    failures.push("FRAME_MANIFEST_PATH_MISSING");
  }

  return {
    path: manifestPath,
    repoRelativePath,
    failures,
    pathExists,
    framePackCount: framePack.sequence_paths?.length ?? 0,
    frameCount,
    mismatch,
    schemaVersion,
    frames,
    resolveFramePath(rawPath) {
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return "";
      }
      return isAbsolute(rawPath) ? rawPath : resolve(dirname(artifactPath), rawPath);
    }
  };
}

function rawFileManifestLinks(manifest) {
  if (!Array.isArray(manifest.frames)) {
    return "";
  }
  const links = [];
  for (let index = 0; index < Math.min(4, manifest.frames.length); index += 1) {
    const frame = manifest.frames[index];
    const rawPath = manifest.resolveFramePath(frame?.raw?.path);
    const displayPath = manifest.resolveFramePath(frame?.raw?.display?.path);
    if (rawPath) {
      links.push(`<a href="${escapeHtml(pathToFileURL(rawPath).href)}">frame-${frame.index}-raw</a>`);
    }
    if (displayPath) {
      links.push(`<a href="${escapeHtml(pathToFileURL(displayPath).href)}">frame-${frame.index}-display-raw</a>`);
    }
  }
  return links.length > 0 ? `<p>${links.join(" | ")}</p>` : "";
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
    section("Baseline Identity", table(objectRows(report.baseline_identity ?? {}))),
    section("Approval", table(objectRows(report.baseline_approval ?? {}))),
    section("Freeze", table(objectRows(report.baseline_freeze ?? {}))),
    section("Instrument Noise", metricSummaryTable(report.instrument_noise?.metrics ?? {})),
    section("Candidate Gap", metricSummaryTable(report.candidate_gap?.metrics ?? {})),
    section("Thresholds", thresholdSummaryTable(report.threshold_derivation?.metric_thresholds ?? {})),
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

function energyTracePanel(record) {
  const energy = record.artifact.energy ?? {};
  const trace = resolveEnergyTrace(record.artifact_path, energy);
  const rows = [
    ["trace_available", energy.trace_available ?? "not_recorded"],
    ["trace_status", energy.trace_status ?? "not_recorded"],
    ["trace_tool", energy.trace_tool ?? ""],
    ["trace_path", trace.path ?? ""],
    ["repo_relative_path", trace.repoRelativePath ?? ""],
    ["path_exists", trace.pathExists],
    ["trace_hash_method", energy.trace_hash_method ?? ""],
    ["expected_sha256", energy.trace_sha256 ?? ""],
    ["actual_sha256", trace.actualSha256 ?? ""],
    ["hash_match", trace.hashMatch ?? ""],
    ["failures", trace.failures.join(", ")],
    ["open_macos", trace.path ? `open "${trace.path}"` : ""],
    ["open_windows", trace.path ? `start "" "${trace.path}"` : ""]
  ];
  const tone = trace.failures.length === 0 && energy.trace_available === true ? "ok" : "warn";
  const link = trace.path
    ? `<p><a id="energy-trace-link" href="${escapeHtml(pathToFileURL(trace.path).href)}">open trace package</a></p>`
    : "";
  return `
    <div id="energy-trace-panel" class="trace-panel ${tone}">
      ${link}
      ${table(rows)}
    </div>
  `;
}

function resolveEnergyTrace(artifactPath, energy) {
  const rawPath = energy.trace_path;
  const tracePath = typeof rawPath === "string" && rawPath.length > 0
    ? isAbsolute(rawPath)
      ? rawPath
      : resolve(dirname(artifactPath), rawPath)
    : "";
  const failures = [];
  let actualSha256 = "";
  let hashMatch = "";

  if (energy.trace_available !== true) failures.push("TRACE_UNAVAILABLE");
  if (energy.trace_available === true && energy.trace_status !== "available") failures.push("TRACE_STATUS_NOT_AVAILABLE");
  if (energy.trace_available === true && !energy.trace_tool) failures.push("TRACE_TOOL_MISSING");
  if (energy.trace_available === true && !tracePath) failures.push("TRACE_PATH_MISSING");
  if (energy.trace_available === true && !energy.trace_hash_method) failures.push("TRACE_HASH_METHOD_MISSING");
  if (energy.trace_available === true && !energy.trace_sha256) failures.push("TRACE_SHA256_MISSING");

  if (tracePath && energy.trace_hash_method && energy.trace_sha256) {
    try {
      actualSha256 = sha256TracePath(tracePath, energy.trace_hash_method);
      hashMatch = String(actualSha256.toLowerCase() === energy.trace_sha256.toLowerCase());
      if (hashMatch !== "true") failures.push("TRACE_SHA256_MISMATCH");
    } catch (error) {
      failures.push(`TRACE_UNREADABLE:${error.message}`);
    }
  }

  return {
    path: tracePath,
    repoRelativePath: tracePath ? relative(repoRoot, tracePath).replace(/\\/g, "/") : "",
    pathExists: tracePath ? existsSync(tracePath) : false,
    actualSha256,
    hashMatch,
    failures
  };
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

function maskOverlay(record) {
  const artifact = record.artifact;
  const maskPack = record.mask_pack;
  const width = record.png?.width ?? artifact.environment?.viewport_px?.width ?? 0;
  const height = record.png?.height ?? artifact.environment?.viewport_px?.height ?? 0;
  const maskIds = requiredGlassMaskIds;
  if (!maskPack || !width || !height) {
    return `<div id="mask-overlay" class="missing">mask overlay unavailable</div>`;
  }

  const gridWidth = Math.min(72, width);
  const gridHeight = Math.max(1, Math.round((height / width) * gridWidth));
  const colors = {
    core: "rgba(78, 220, 255, 0.36)",
    edge_band: "rgba(255, 228, 114, 0.42)",
    highlight: "rgba(255, 255, 160, 0.48)",
    text: "rgba(255, 255, 255, 0.38)",
    text_halo: "rgba(188, 148, 255, 0.34)",
    background_control: "rgba(120, 255, 150, 0.16)",
    motion_path: "rgba(255, 96, 180, 0.22)",
    compositor_region: "rgba(124, 184, 255, 0.13)",
    product_focus: "rgba(255, 142, 96, 0.30)"
  };
  const panels = maskIds.map((maskId) => {
    const rects = [];
    let sampleCount = 0;
    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const px = Math.min(width - 1, Math.floor((x + 0.5) * width / gridWidth));
        const py = Math.min(height - 1, Math.floor((y + 0.5) * height / gridHeight));
        if (maskContainsPointFor(maskPack, {
          sceneId: artifact.scene_id,
          stateId: artifact.state_id,
          maskId,
          x: px + 0.5,
          y: py + 0.5,
          width,
          height
        })) {
          sampleCount += 1;
          rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${colors[maskId] ?? "rgba(255,255,255,0.28)"}"/>`);
        }
      }
    }
    return `<figure class="viz-panel">
      <svg class="plot" viewBox="0 0 ${gridWidth} ${gridHeight}" role="img" aria-label="${escapeHtml(maskId)} mask preview">
        <rect x="0" y="0" width="${gridWidth}" height="${gridHeight}" fill="#050607"/>
        ${rects.join("")}
      </svg>
      <figcaption>${escapeHtml(maskId)} grid_samples=${sampleCount}</figcaption>
    </figure>`;
  });

  return `<div id="mask-overlay" class="viz-grid">${panels.join("")}</div>`;
}

function temporalPhasePlot(report) {
  const reference = report.debug_series?.reference_motion ?? [];
  const candidate = report.debug_series?.candidate_motion ?? [];
  if (reference.length === 0 || candidate.length === 0) {
    return `<div id="temporal-phase-plot" class="missing">temporal phase data unavailable</div>`;
  }

  const width = 720;
  const height = 190;
  const pad = 24;
  const allTimes = [...reference, ...candidate].map((point) => point.t_ms);
  const allEnergy = [...reference, ...candidate].map((point) => point.energy);
  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);
  const maxE = Math.max(...allEnergy, 0.000001);
  const sx = (time) => pad + ((time - minT) / Math.max(1, maxT - minT)) * (width - pad * 2);
  const sy = (energy) => height - pad - (energy / maxE) * (height - pad * 2);
  const refPeak = report.metrics?.optical_flow_phase?.reference_peak_time_ms;
  const candPeak = report.metrics?.optical_flow_phase?.candidate_peak_time_ms;
  const phaseError = report.metrics?.optical_flow_phase?.peak_phase_error_ms;

  return `<svg id="temporal-phase-plot" class="plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="temporal phase plot">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#050607"/>
    ${axisSvg(width, height, pad)}
    <polyline points="${linePoints(reference, sx, sy)}" fill="none" stroke="#63d8ff" stroke-width="2"/>
    <polyline points="${linePoints(candidate, sx, sy)}" fill="none" stroke="#ff72c6" stroke-width="2"/>
    ${Number.isFinite(refPeak) ? markerLine(sx(refPeak), pad, height - pad, "#63d8ff", "R peak") : ""}
    ${Number.isFinite(candPeak) ? markerLine(sx(candPeak), pad, height - pad, "#ff72c6", "C peak") : ""}
    <text x="${pad}" y="18" fill="#c9d7e4" font-size="11">motion energy phase, error=${escapeHtml(round(phaseError))}ms</text>
  </svg>`;
}

function frameBudgetTimeline(temporalReport, runtimeReport) {
  const intervals = temporalReport.debug_series?.candidate_frame_intervals_ms ?? [];
  if (intervals.length === 0) {
    return `<div id="frame-budget-timeline" class="missing">frame interval data unavailable</div>`;
  }

  const width = 720;
  const height = 190;
  const pad = 24;
  const budget = runtimeReport.policy?.full_frame_p95_ceiling_ms ?? 25;
  const maxInterval = Math.max(...intervals.map((point) => point.interval_ms), budget * 1.2);
  const barWidth = (width - pad * 2) / intervals.length;
  const sy = (value) => height - pad - (value / maxInterval) * (height - pad * 2);
  const budgetY = sy(budget);
  const bars = intervals.map((point, index) => {
    const x = pad + index * barWidth;
    const y = sy(point.interval_ms);
    const fill = point.interval_ms > budget ? "#ff6666" : "#7ee7a8";
    return `<rect x="${x}" y="${y}" width="${Math.max(1, barWidth - 2)}" height="${height - pad - y}" fill="${fill}" opacity="0.82"/>`;
  }).join("");

  return `<svg id="frame-budget-timeline" class="plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="frame budget timeline">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#050607"/>
    ${axisSvg(width, height, pad)}
    ${bars}
    <line x1="${pad}" y1="${budgetY}" x2="${width - pad}" y2="${budgetY}" stroke="#ffe472" stroke-width="2" stroke-dasharray="6 5"/>
    <text x="${pad}" y="18" fill="#c9d7e4" font-size="11">candidate frame intervals, budget=${escapeHtml(round(budget))}ms</text>
  </svg>`;
}

function axisSvg(width, height, pad) {
  return `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="rgba(255,255,255,0.28)"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="rgba(255,255,255,0.28)"/>`;
}

function linePoints(points, sx, sy) {
  return points.map((point) => `${sx(point.t_ms)},${sy(point.energy)}`).join(" ");
}

function markerLine(x, top, bottom, color, label) {
  return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${x + 4}" y="${bottom - 6}" fill="${color}" font-size="10">${escapeHtml(label)}</text>`;
}

function writeViewerFrameManifest(dir, prefix, sequence) {
  const manifestPath = join(dir, `${prefix}.frame_manifest.json`);
  const frames = sequence.paths.map((path, index) => ({
    index,
    ptsSeconds: Number.isFinite(sequence.timestamps_ms[index]) ? sequence.timestamps_ms[index] / 1000 : undefined,
    png: path,
    sha256: sha256File(path),
    width: sequence.width,
    height: sequence.height
  }));
  const manifest = {
    schema_version: "1.0.0",
    frame_count: frames.length,
    frames
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    path: manifestPath,
    sha256: sha256File(manifestPath)
  };
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
    timestamps_ms: [0, 16.67, 33.33, 50, 66.67, 83.33],
    width,
    height
  };
}

function writeViewerTracePackage(dir, prefix) {
  const tracePath = join(dir, `${prefix}.trace`);
  mkdirSync(tracePath, { recursive: true });
  writeFileSync(join(tracePath, "metadata.json"), `${JSON.stringify({
    tool: "instruments_power_profiler",
    sample_rate_hz: 10,
    fixture: prefix
  }, null, 2)}\n`);
  writeFileSync(join(tracePath, "samples.jsonl"), [
    JSON.stringify({ t_ms: 0, power_mw: 118.2 }),
    JSON.stringify({ t_ms: 100, power_mw: 118.9 }),
    JSON.stringify({ t_ms: 200, power_mw: 117.8 })
  ].join("\n") + "\n");
  return {
    path: tracePath,
    artifactPath: `${prefix}.trace`,
    sha256: sha256TracePath(tracePath, "sha256_tree_v1")
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

function thresholdSummaryTable(metrics) {
  const rows = [];
  for (const [metric, threshold] of Object.entries(metrics)) {
    rows.push([
      metric,
      `loss=${threshold.loss_transform} shader=${round(threshold.shader_threshold)} webkit=${round(threshold.webkit_threshold)} floor_gate=${threshold.no_worse_than_webkit_floor?.gate === true}`
    ]);
  }
  return table(rows.length > 0 ? rows : [["thresholds", "not_recorded"]]);
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
    device.model_name,
    safePart(device.model_identifier),
    device.os_version,
    safePart(device.os_build),
    safePart(device.sdk_build),
    safePart(integrity.producer_version),
    `lock-${rendererLockfileSha256()}`,
    `webkit-${device.webkit_build ?? artifact.environment?.webkit_build ?? "not_observable"}`,
    `pipeline-${artifact.null_qualification ?? "not_recorded"}`
  ].map(safePart).join("__");
}

function rendererLockfileSha256() {
  return sha256File(join(repoRoot, "package-lock.json"));
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
.viz-grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:10px; align-items:start; }
.viz-panel { min-width:0; }
.plot { display:block; width:100%; min-height:150px; background:#050607; border:1px solid rgba(255,255,255,0.14); border-radius:8px; }
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
  .viz-grid { grid-template-columns:1fr; }
  th { width:42%; }
}
`;
}

function makeSelfTestArtifact(rigId, pngPath, maskPath, sequence, trace) {
  return finalizeCaptureArtifactIntegrity({
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
      frame_manifest_path: sequence.frameManifest?.path ?? "",
      frame_manifest_sha256: sequence.frameManifest?.sha256 ?? "",
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
      trace_available: true,
      trace_status: "available",
      measurement_source: "artifact_viewer_self_test_power_trace",
      trace_tool: "instruments_power_profiler",
      trace_path: trace.artifactPath,
      trace_hash_method: "sha256_tree_v1",
      trace_sha256: trace.sha256,
      energy_mj_per_10s: 1.18,
      average_power_mw: 118.3
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
      artifact_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      producer_version: "lab-artifact-viewer.self-test"
    }
  });
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
