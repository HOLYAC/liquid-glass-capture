#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const defaultOut = "artifacts/ci/glass-gate.report.json";
const commandPlan = Object.freeze([
  { id: "typecheck", command: "npm run typecheck", gate: "typescript" },
  { id: "lab_self_test", command: "npm run lab:self-test", gate: "G0_G8_SELF_TEST" },
  { id: "diff_check", command: "git diff --check", gate: "workspace_hygiene" }
]);

if (process.argv[1] && process.argv[1].endsWith("ci-glass-gate.mjs")) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out ?? defaultOut;
  const changedFiles = args.selfTest
    ? [
        "App.tsx",
        "packages/color-pipeline/src/index.mjs",
        "modules/liquid-glass-capture/ios/ReplayKitCompositorCaptureDaemon.swift"
      ]
    : discoverChangedFiles(args);
  const lane = classifyLane(changedFiles, args);

  if (args.selfTest) {
    assertClassificationGuardRails();
    const report = makeReport({
      args,
      lane,
      changedFiles,
      commands: [],
      status: "pass",
      blockers: []
    });
    writeReport(out, report);
    console.log(`PASS ${resolve(out)}`);
    return;
  }

  const commands = commandPlan.map(runCommand);
  const blockers = commands
    .filter((command) => command.status !== "pass")
    .map((command) => `${command.gate}:${command.id}:exit_${command.exit_code}`);
  const status = blockers.length === 0 ? "pass" : "fail";
  const report = makeReport({
    args,
    lane,
    changedFiles,
    commands,
    status,
    blockers
  });
  writeReport(out, report);
  console.log(`${status.toUpperCase()} ${resolve(out)}`);
  if (status !== "pass") process.exit(1);
}

function makeReport({ args, lane, changedFiles, commands, status, blockers }) {
  return {
    schema_version: "1.2.0",
    kind: "ci_glass_gate_report",
    status,
    generated_at: new Date().toISOString(),
    head_sha: gitValue("rev-parse HEAD"),
    event: {
      name: process.env.GITHUB_EVENT_NAME ?? "local",
      ref: process.env.GITHUB_REF ?? "",
      base_ref: process.env.GITHUB_BASE_REF ?? ""
    },
    lane,
    changed_files: changedFiles,
    policy: {
      config_path: "ci/glass-gate.yml",
      physical_device_capture_required_for_final_verdict: lane.physical_device_capture_required,
      hosted_ci_scope: lane.physical_device_capture_required
        ? "source_guillotine_only_not_final_physical_verdict"
        : "source_guillotine",
      null_ladder_gate: lane.null_ladder_required ? "covered_by_lab_self_test" : "not_required_for_changed_files",
      g7_release_gate: lane.release_lane ? "required" : "fast_lane_may_skip"
    },
    gates: {
      typecheck: commandStatus(commands, "typecheck"),
      G0_G8_SELF_TEST: commandStatus(commands, "lab_self_test"),
      workspace_hygiene: commandStatus(commands, "diff_check"),
      physical_device_capture: lane.physical_device_capture_required ? "pending_device_lane" : "not_required",
      flake_class: blockers.length === 0 ? "NONE" : "UNKNOWN"
    },
    commands,
    blockers,
    evidence: {
      ci_report_path: args.out ?? defaultOut,
      upload_artifact_name: "glass-gate-report"
    }
  };
}

function classifyLane(changedFiles, args = {}) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "local";
  const ref = process.env.GITHUB_REF ?? "";
  const protectedSurface = changedFiles.some(isGlassAffectingPath);
  const nullLadderRequired = changedFiles.some(requiresNullLadder);
  const sustainedRequired = eventName === "schedule" || changedFiles.some((file) =>
    normalized(file).startsWith("packages/energy-stack/") ||
    normalized(file).includes("ReplayKitCompositorCaptureDaemon.swift")
  );
  const releaseLane = Boolean(args.release) || eventName === "workflow_dispatch" || ref === "refs/heads/main";
  const nightlyLane = eventName === "schedule";

  return {
    class: nightlyLane ? "nightly" : releaseLane ? "release" : protectedSurface ? "fast_pr" : "smoke",
    protected_surface: protectedSurface,
    null_ladder_required: nullLadderRequired,
    sustained_required: sustainedRequired,
    release_lane: releaseLane,
    physical_device_capture_required: protectedSurface,
    reason: protectedSurface
      ? "render_ui_color_animation_or_lab_path_changed"
      : "no_glass_affecting_paths_detected"
  };
}

function isGlassAffectingPath(file) {
  const path = normalized(file);
  return (
    path === "App.tsx" ||
    path === "app.json" ||
    path === "eas.json" ||
    path === "package.json" ||
    path === "package-lock.json" ||
    path.startsWith("modules/liquid-glass-capture/") ||
    path.startsWith("packages/capture-schema/") ||
    path.startsWith("packages/color-pipeline/") ||
    path.startsWith("packages/metric-stack/") ||
    path.startsWith("packages/energy-stack/") ||
    path.startsWith("packages/solver/") ||
    path.startsWith("packages/review-stack/") ||
    path.startsWith("packages/verdict-stack/") ||
    path.startsWith("scripts/lab-") ||
    path.startsWith("scripts/lib/lab-") ||
    path.startsWith("fixtures/") ||
    path.startsWith("apps/artifact-viewer/") ||
    path.startsWith(".github/workflows/glass-gate") ||
    path.startsWith("ci/glass-gate")
  );
}

function requiresNullLadder(file) {
  const path = normalized(file);
  return (
    path.startsWith("packages/color-pipeline/") ||
    path.startsWith("scripts/lab-null-ladder") ||
    path.startsWith("modules/liquid-glass-capture/") ||
    path === "App.tsx" ||
    path.startsWith("fixtures/backgrounds/") ||
    path.startsWith("fixtures/masks/")
  );
}

function runCommand(plan) {
  const started = Date.now();
  const result = spawnSync(plan.command, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const exitCode = result.status ?? (result.error ? 1 : 0);
  return {
    id: plan.id,
    gate: plan.gate,
    command: plan.command,
    status: exitCode === 0 ? "pass" : "fail",
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr || result.error?.message || "")
  };
}

function discoverChangedFiles(args) {
  if (args.changed.length > 0) return args.changed;

  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    const diff = gitValue(`diff --name-only --diff-filter=ACMRTUXB origin/${baseRef}...HEAD`);
    if (diff.trim()) return lines(diff);
  }

  const workingTree = [
    ...lines(gitValue("diff --name-only --diff-filter=ACMRTUXB HEAD")),
    ...lines(gitValue("ls-files --others --exclude-standard"))
  ];
  if (workingTree.length > 0) return unique(workingTree);

  const previous = gitValue("diff --name-only --diff-filter=ACMRTUXB HEAD~1..HEAD");
  if (previous.trim()) return lines(previous);

  const tracked = gitValue("ls-files");
  return lines(tracked);
}

function gitValue(command) {
  const result = spawnSync(`git ${command}`, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function assertClassificationGuardRails() {
  const glass = classifyLane(["packages/color-pipeline/src/index.mjs"]);
  if (!glass.protected_surface || !glass.null_ladder_required || !glass.physical_device_capture_required) {
    throw new Error("CI glass classification guardrail failed for color-pipeline change");
  }
  const docs = classifyLane(["docs/notes.md"]);
  if (docs.protected_surface || docs.null_ladder_required) {
    throw new Error("CI glass classification guardrail failed for docs-only change");
  }
}

function commandStatus(commands, id) {
  if (commands.length === 0) return "self_test_not_run";
  return commands.find((command) => command.id === id)?.status ?? "missing";
}

function writeReport(path, report) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = { changed: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--release") parsed.release = true;
    else if (arg === "--changed") parsed.changed.push(args[++index]);
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function normalized(file) {
  return String(file).replaceAll("\\", "/");
}

function lines(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function tail(value, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(text.length - max) : text;
}
