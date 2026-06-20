#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = join(repoRoot, "artifacts", "proof-doctor");
const defaultIpaDir = join(repoRoot, "artifacts", "unsigned-ipa");
const defaultCaptureRoot = join(repoRoot, "artifacts", "iphone", "LiquidGlassCaptures");
const proofPlanPath = join(repoRoot, "artifacts", "ios-max-fidelity-proof.plan.json");
const proofVerifyPath = join(defaultOutDir, "ios-max-fidelity-proof.verify.json");
const proofDoctorReportPath = join(defaultOutDir, "proof-doctor.report.json");
const proofHandoffPath = join(defaultOutDir, "PHONE_HANDOFF.md");
const defaultWaitMs = 15 * 60 * 1000;
const defaultPollMs = 2500;

const proofArgs = [
  "--rig",
  "R0",
  "--scene",
  "S01_SEARCH",
  "--state",
  "rest",
  "--device",
  "physical",
  "--capture",
  "compositor",
  "--repeat",
  "1",
  "--device-role",
  "mvl_primary",
  "--max-fidelity"
];

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const request = normalizeRequest(args);
  const report = request.waitMs > 0 ? runDoctorAfterWait(request) : runDoctor(request);
  writeJson(request.out, report);
  writePhoneHandoff(request.handoffOut, report);
  printSummary(report);
  if (report.status === "fail") process.exit(1);
}

function normalizeRequest(args) {
  const out = resolve(repoRoot, args.out ?? proofDoctorReportPath);
  const ipaReport = resolve(repoRoot, args.ipaReport ?? join(defaultIpaDir, "unsigned-ipa-download.report.json"));
  const planOut = resolve(repoRoot, args.planOut ?? proofPlanPath);
  const handoffOut = resolve(repoRoot, args.handoffOut ?? proofHandoffPath);
  const captureRootInput = args.captureRoot ? resolve(repoRoot, args.captureRoot) : defaultCaptureRoot;
  const captureRootResolution = resolveCaptureRoot(captureRootInput);
  const captureRoot = captureRootResolution.resolved_path ?? captureRootInput;
  const verifyOut = resolve(repoRoot, args.verifyOut ?? proofVerifyPath);
  const waitMs = args.waitMs ?? 0;
  const pollMs = args.pollMs ?? defaultPollMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error("--wait-ms must be a non-negative number");
  }
  if (!Number.isFinite(pollMs) || pollMs < 1) {
    throw new Error("--poll-ms must be a positive number");
  }
  return {
    out,
    ipaReport,
    planOut,
    handoffOut,
    captureRootInput,
    captureRootResolution,
    captureRoot,
    verifyOut,
    refreshIpa: Boolean(args.refreshIpa),
    verifyCapture: Boolean(args.verifyCapture || args.captureRoot || args.waitMs),
    minStartedAtNs: args.minStartedAtNs ?? null,
    waitMs,
    pollMs
  };
}

function runDoctorAfterWait(request) {
  const startedAt = Date.now();
  const deadline = startedAt + request.waitMs;
  let lastCheck = null;
  while (Date.now() <= deadline) {
    const resolution = resolveCaptureRoot(request.captureRootInput);
    const resolvedPath = resolution.resolved_path ?? request.captureRootInput;
    const check = inspectCopiedCaptureRoot(resolvedPath, resolution);
    lastCheck = check;
    if (check.status === "pass") {
      return runDoctor({
        ...request,
        captureRootResolution: resolution,
        captureRoot: resolvedPath,
        verifyCapture: true
      });
    }
    sleepMs(request.pollMs);
  }

  const report = runDoctor({
    ...request,
    waitMs: 0,
    verifyCapture: false
  });
  const timeoutCheck = {
    name: "wait_for_copied_capture_root",
    status: "fail",
    summary: `timed out after ${request.waitMs}ms waiting for LiquidGlassCaptures`,
    evidence: {
      waited_ms: Date.now() - startedAt,
      poll_ms: request.pollMs,
      last_copied_capture_root_check: lastCheck
    }
  };
  return {
    ...report,
    status: "fail",
    checks: [...report.checks, timeoutCheck],
    next: nextSteps({
      failedChecks: [timeoutCheck],
      ipaPath: report.artifacts.ipa_path,
      captureRoot: request.captureRootInput
    })
  };
}

function runDoctor(request) {
  mkdirSync(dirname(request.out), { recursive: true });
  const checks = [];
  const headSha = runGit(["rev-parse", "HEAD"]).trim();
  const branch = runGit(["branch", "--show-current"]).trim();
  checks.push(checkGitWorktreeClean());

  if (request.refreshIpa) {
    const result = runNodeScript("lab-ipa-download.mjs", ["--out-dir", defaultIpaDir]);
    checks.push(commandCheck("refresh_unsigned_ipa", result));
  }

  const appDefaultsResult = runNodeScript("lab-ios-capture.mjs", ["--self-test"]);
  checks.push(commandCheck("app_defaults_and_capture_contract", appDefaultsResult));

  const planResult = runNodeScript("lab-ios-capture.mjs", [...proofArgs, "--out", request.planOut]);
  checks.push(commandCheck("write_one_repeat_proof_plan", planResult));
  const planCheck = checkProofPlan(request.planOut);
  checks.push(planCheck);

  const ipaCheck = checkIpaReport(request.ipaReport, headSha);
  checks.push(ipaCheck);

  const copiedCaptureCheck = inspectCopiedCaptureRoot(request.captureRoot, request.captureRootResolution);
  checks.push(copiedCaptureCheck);

  let verifyReportPath = null;
  let inspectCommand = null;
  const shouldVerifyCapture = request.verifyCapture;
  if (shouldVerifyCapture && copiedCaptureCheck.status !== "pass") {
    checks.push({
      name: "capture_root_ready_for_verify",
      status: "fail",
      summary: "no copied LiquidGlassCaptures repeat manifest found yet",
      evidence: copiedCaptureCheck.evidence
    });
  } else if (shouldVerifyCapture) {
    rmSync(request.verifyOut, { force: true });
    const verifyResult = runNodeScript("lab-ios-capture.mjs", [
      ...proofArgs,
      "--capture-root",
      request.captureRoot,
      "--out",
      request.verifyOut,
      ...minStartedAtArgs(request.minStartedAtNs)
    ]);
    checks.push(commandCheck("verify_copied_max_fidelity_capture", verifyResult));
    const verifyCheck = checkVerifyReport(request.verifyOut);
    checks.push(verifyCheck);
    if (verifyCheck.status === "pass") {
      verifyReportPath = request.verifyOut;
      inspectCommand = verifyCheck.evidence.inspect_command ?? null;
    }
  }

  const failedChecks = checks.filter((check) => check.status === "fail");
  const verifiedCapture = Boolean(verifyReportPath);
  const readyForPhone = failedChecks.length === 0 && ipaCheck.status === "pass" && planCheck.status === "pass";
  const status = failedChecks.length > 0 ? "fail" : verifiedCapture ? "pass_verified_capture" : "pass_ready_for_phone";

  return {
    schema_version: "1.2.0",
    kind: "max_fidelity_launch_doctor",
    status,
    repo: {
      branch,
      head_sha: headSha
    },
    checks,
    artifacts: {
      ipa_path: ipaCheck.evidence.ipa_path ?? null,
      ipa_report_path: request.ipaReport,
      proof_plan_path: request.planOut,
      phone_handoff_path: request.handoffOut,
      copied_capture_root_input: request.captureRootInput,
      copied_capture_root: request.captureRoot,
      verify_report_path: verifyReportPath,
      proof_doctor_report_path: request.out
    },
    next: nextSteps({
      readyForPhone,
      verifiedCapture,
      failedChecks,
      ipaPath: ipaCheck.evidence.ipa_path,
      captureRoot: request.captureRoot,
      inspectCommand
    })
  };
}

function checkProofPlan(planPath) {
  const evidence = { path: planPath };
  try {
    const plan = readJson(planPath);
    evidence.status = plan.status;
    evidence.repeat = plan.repeat_count_requested;
    evidence.raw_required = plan.output_contract?.raw_required;
    evidence.display_raw_required = plan.output_contract?.display_raw_required;
    evidence.on_device_app_action = plan.on_device_app_action;
    const ok =
      plan.status === "awaiting_on_device_repeat_capture" &&
      plan.rig_id === "R0" &&
      plan.scene_id === "S01_SEARCH" &&
      plan.state_id === "rest" &&
      plan.repeat_count_requested === 1 &&
      plan.output_contract?.raw_required === true &&
      plan.output_contract?.display_raw_required === true &&
      plan.on_device_app_action?.set_max_fidelity === true &&
      plan.on_device_app_action?.set_repeat === 1 &&
      plan.on_device_app_action?.press_button === "B";
    return {
      name: "one_repeat_proof_plan_contract",
      status: ok ? "pass" : "fail",
      summary: ok ? "proof plan matches the on-device one-repeat max-fidelity route" : "proof plan does not match the one-repeat max-fidelity route",
      evidence
    };
  } catch (error) {
    return failCheck("one_repeat_proof_plan_contract", error, evidence);
  }
}

function checkIpaReport(reportPath, headSha) {
  const evidence = { path: reportPath };
  try {
    const report = readJson(reportPath);
    evidence.status = report.status;
    evidence.run = report.workflow_run?.url;
    evidence.head_sha = report.workflow_run?.head_sha;
    evidence.ipa_path = report.ipa_path;
    evidence.ipa_size_bytes = report.ipa_size_bytes;
    evidence.standalone_js_bundle = report.ipa_inspection?.standalone_js_bundle;
    evidence.main_js_bundle_path = report.ipa_inspection?.main_js_bundle_path;

    const failures = [];
    if (report.status !== "pass") failures.push("download report status is not pass");
    if (report.workflow_run?.conclusion !== "success") failures.push("workflow run is not successful");
    if (report.workflow_run?.head_sha !== headSha) failures.push("downloaded IPA was not built from current HEAD");
    if (!report.ipa_inspection?.has_payload_app) failures.push("IPA report has no Payload/*.app evidence");
    if (!report.ipa_inspection?.standalone_js_bundle) failures.push("IPA report has no standalone main.jsbundle evidence");
    if (!report.ipa_path || !existsSync(report.ipa_path)) {
      failures.push("IPA file does not exist at reported path");
    } else {
      const actualSize = statSync(report.ipa_path).size;
      evidence.actual_ipa_size_bytes = actualSize;
      if (actualSize !== report.ipa_size_bytes) failures.push("IPA file size differs from report");
    }

    return {
      name: "unsigned_ipa_current_head_standalone",
      status: failures.length === 0 ? "pass" : "fail",
      summary: failures.length === 0 ? "unsigned IPA is current-head and standalone" : failures.join("; "),
      evidence
    };
  } catch (error) {
    return failCheck("unsigned_ipa_current_head_standalone", error, evidence);
  }
}

function checkGitWorktreeClean() {
  const porcelain = runGit(["status", "--porcelain"]).trim();
  const dirtyEntries = porcelain.length > 0 ? porcelain.split(/\r?\n/) : [];
  return {
    name: "git_worktree_clean",
    status: dirtyEntries.length === 0 ? "pass" : "fail",
    summary: dirtyEntries.length === 0
      ? "tracked and untracked git status is clean"
      : "git worktree has uncommitted files; commit or clean them before treating the IPA as current-state evidence",
    evidence: {
      dirty_entries: dirtyEntries.slice(0, 20),
      dirty_entry_count: dirtyEntries.length
    }
  };
}

function inspectCopiedCaptureRoot(captureRoot, resolution = resolveCaptureRoot(captureRoot)) {
  const evidence = {
    input_path: resolution.input_path,
    path: captureRoot,
    resolution
  };
  if (!existsSync(captureRoot)) {
    return {
      name: "copied_capture_root",
      status: "pending",
      summary: "copy LiquidGlassCaptures here after pressing B on the iPhone",
      evidence
    };
  }

  const seriesDir = join(captureRoot, "Series");
  evidence.series_dir = seriesDir;
  if (!existsSync(seriesDir)) {
    return {
      name: "copied_capture_root",
      status: "pending",
      summary: "capture root exists but has no Series directory yet",
      evidence
    };
  }

  const manifests = readdirSync(seriesDir).filter((entry) => entry.endsWith(".repeat-manifest.json"));
  evidence.repeat_manifest_count = manifests.length;
  return {
    name: "copied_capture_root",
    status: manifests.length > 0 ? "pass" : "pending",
    summary: manifests.length > 0 ? "copied capture root contains repeat manifests" : "Series directory has no repeat manifests yet",
    evidence
  };
}

function checkVerifyReport(reportPath) {
  const evidence = { path: reportPath };
  try {
    const report = readJson(reportPath);
    const inferredCaptureCount = Array.isArray(report.observed?.artifact_json_paths_resolved)
      ? report.observed.artifact_json_paths_resolved.length
      : Array.isArray(report.observed?.artifact_json_paths)
        ? report.observed.artifact_json_paths.length
        : undefined;
    const captureCount = Number.isFinite(report.capture_count)
      ? report.capture_count
      : inferredCaptureCount;
    evidence.status = report.status;
    evidence.manifest_path = report.manifest_path;
    evidence.capture_count = captureCount;
    evidence.inspect_command = report.next?.inspect_command;
    const ok =
      report.status === "pass" &&
      Number.isFinite(captureCount) &&
      captureCount >= 1 &&
      typeof report.next?.inspect_command === "string";
    return {
      name: "max_fidelity_capture_verification_report",
      status: ok ? "pass" : "fail",
      summary: ok ? "copied capture verifies with raw frame evidence" : "copied capture verification report is not a pass",
      evidence
    };
  } catch (error) {
    return failCheck("max_fidelity_capture_verification_report", error, evidence);
  }
}

function nextSteps({ readyForPhone, verifiedCapture, failedChecks = [], ipaPath, captureRoot, inspectCommand }) {
  if (verifiedCapture) {
    return {
      state: "verified_capture_ready_to_inspect",
      inspect: inspectCommand,
      repeat_50_mvl:
        "npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50 --device-role mvl_primary --max-fidelity --out ./artifacts/ios-mvl.plan.json"
    };
  }
  if (failedChecks.some((check) => check.name === "capture_root_ready_for_verify")) {
    return {
      state: "awaiting_copied_capture",
      copy_back: `Copy LiquidGlassCaptures or the whole app Documents folder under ./artifacts/iphone.`,
      verify: `npm run proof:doctor -- --capture-root ./artifacts/iphone`
    };
  }
  if (failedChecks.some((check) => check.name === "wait_for_copied_capture_root")) {
    return {
      state: "awaiting_copied_capture",
      copy_back: `Copy LiquidGlassCaptures or the whole app Documents folder under ./artifacts/iphone.`,
      watch: `npm run proof:watch`
    };
  }
  if (readyForPhone) {
    return {
      state: "ready_for_phone",
      install: `Install ${ipaPath} with Sideloadly or AltStore.`,
      on_phone: "Open Liquid Glass Capture and press B. Defaults are S01_SEARCH/R0/mvl_primary/repeat=1/max-fidelity=true.",
      copy_back: `Copy the app Documents/LiquidGlassCaptures folder to ${captureRoot}, or copy the whole Documents folder under ./artifacts/iphone and let proof:doctor find LiquidGlassCaptures inside it.`,
      verify: `npm run proof:doctor -- --capture-root ./artifacts/iphone`,
      watch: `npm run proof:watch`
    };
  }
  return {
    state: "not_ready",
    prepare: "npm run proof:prepare"
  };
}

function commandCheck(name, result) {
  const tail = result.stdout.split(/\r?\n/).filter(Boolean).slice(-4);
  return {
    name,
    status: result.status === 0 ? "pass" : "fail",
    summary: result.status === 0 ? "command completed" : "command failed",
    evidence: {
      exit_code: result.status,
      stdout_tail: tail,
      stderr_tail: result.stderr.split(/\r?\n/).filter(Boolean).slice(-4)
    }
  };
}

function minStartedAtArgs(value) {
  return value == null ? [] : ["--min-started-at-ns", value.toString()];
}

function resolveCaptureRoot(inputPath) {
  const candidates = [];
  if (existsSync(inputPath)) {
    collectCaptureRootCandidates(inputPath, candidates, 0, 5);
  }
  const uniqueCandidates = Array.from(new Map(candidates.map((candidate) => [candidate.path, candidate])).values())
    .sort((left, right) => {
      if (left.order_key === right.order_key) return left.path.localeCompare(right.path);
      return left.order_key > right.order_key ? -1 : 1;
    });
  const selected = uniqueCandidates[0] ?? null;
  return {
    input_path: inputPath,
    resolved_path: selected?.path ?? null,
    status: selected ? "resolved" : "unresolved",
    candidate_count: uniqueCandidates.length,
    candidates: uniqueCandidates.slice(0, 8).map((candidate) => ({
      path: candidate.path,
      repeat_manifest_count: candidate.repeat_manifest_count,
      has_series_dir: candidate.has_series_dir,
      has_sessions_dir: candidate.has_sessions_dir,
      order_key: candidate.order_key.toString()
    }))
  };
}

function collectCaptureRootCandidates(path, candidates, depth, maxDepth) {
  const candidate = describeCaptureRootCandidate(path);
  if (candidate) {
    candidates.push(candidate);
  }
  if (depth >= maxDepth) {
    return;
  }
  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(path, entry.name);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.name === "LiquidGlassCaptures" || depth < 3) {
      collectCaptureRootCandidates(child, candidates, depth + 1, maxDepth);
    }
  }
}

function describeCaptureRootCandidate(path) {
  const seriesDir = join(path, "Series");
  const sessionsDir = join(path, "Sessions");
  const hasSeriesDir = existsSync(seriesDir);
  const hasSessionsDir = existsSync(sessionsDir);
  const namedCaptureRoot = basename(path) === "LiquidGlassCaptures";
  if (!namedCaptureRoot && !hasSeriesDir && !hasSessionsDir) {
    return null;
  }

  const manifests = hasSeriesDir
    ? readdirSync(seriesDir)
      .filter((entry) => entry.endsWith(".repeat-manifest.json"))
      .map((entry) => join(seriesDir, entry))
    : [];
  const orderKey = manifests
    .map((manifest) => repeatManifestOrderKey(manifest))
    .sort((left, right) => (left === right ? 0 : left > right ? -1 : 1))[0] ?? BigInt(Math.round(statSync(path).mtimeMs * 1_000_000));
  return {
    path,
    repeat_manifest_count: manifests.length,
    has_series_dir: hasSeriesDir,
    has_sessions_dir: hasSessionsDir,
    order_key: orderKey
  };
}

function repeatManifestOrderKey(path) {
  try {
    const manifest = readJson(path);
    const raw = manifest.finished_at_ns ?? manifest.started_at_ns;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return BigInt(Math.round(raw));
  } catch {
    // Fall back to filesystem mtime below.
  }
  return BigInt(Math.round(statSync(path).mtimeMs * 1_000_000));
}

function runNodeScript(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: Number.isInteger(error.status) ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? "")
    };
  }
}

function runGit(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function failCheck(name, error, evidence = {}) {
  return {
    name,
    status: "fail",
    summary: String(error.message ?? error),
    evidence
  };
}

function writePhoneHandoff(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPhoneHandoff(report));
}

function renderPhoneHandoff(report) {
  const ipaCheck = findCheck(report, "unsigned_ipa_current_head_standalone");
  const planCheck = findCheck(report, "one_repeat_proof_plan_contract");
  const verifyCheck = findCheck(report, "max_fidelity_capture_verification_report");
  const status = String(report.status ?? "unknown").toUpperCase();
  const lines = [
    "# Liquid Glass Capture Phone Handoff",
    "",
    "This file is generated by `npm run proof:run` / `npm run proof:prepare` / `npm run proof:doctor` from the current proof report.",
    "",
    "## Current Proof State",
    "",
    `- status: \`${status}\``,
    `- branch: \`${report.repo?.branch ?? "unknown"}\``,
    `- head: \`${report.repo?.head_sha ?? "unknown"}\``,
    `- IPA: \`${report.artifacts?.ipa_path ?? "missing"}\``,
    `- proof report: \`${report.artifacts?.proof_doctor_report_path ?? "missing"}\``,
    `- proof plan: \`${report.artifacts?.proof_plan_path ?? "missing"}\``,
    `- IPA workflow: ${ipaCheck?.evidence?.run ?? "missing"}`,
    `- standalone JS bundle: \`${String(ipaCheck?.evidence?.standalone_js_bundle ?? false)}\``,
    "",
    "## What This Proves",
    "",
    "- `PASS_READY_FOR_PHONE` proves the local repo, current-head unsigned IPA, embedded `main.jsbundle`, app defaults, and one-repeat max-fidelity proof plan agree.",
    "- `PASS_VERIFIED_CAPTURE` proves the copied iPhone capture contains the repeat manifest, capture JSON, `frame_manifest.json`, `.source.raw`, `.display.rgba`, and matching SHA-256 hashes.",
    "- Before `PASS_VERIFIED_CAPTURE`, the only missing proof is the physical iPhone capture copied back into this repo.",
    "",
    "## Phone Run",
    "",
    "1. Preferred single command: run this first, then install the printed IPA, open the app, press `B`, and keep the iPhone trusted over USB while the command waits:",
    "",
    "```powershell",
    "npm run proof:run",
    "```",
    "",
    "`proof:run` refreshes the current-head IPA proof packet, starts a freshness-locked phone wait, rejects older copied captures from before this run, pulls `Documents/LiquidGlassCaptures`, and then runs `proof:doctor`.",
    "",
    "2. Manual install path if you already ran `proof:prepare`: install the IPA on the iPhone with Sideloadly or AltStore.",
    "",
    "```text",
    report.artifacts?.ipa_path ?? "artifacts/unsigned-ipa/LiquidGlassCapture-unsigned.ipa",
    "```",
    "",
    "3. Open **Liquid Glass Capture** on the iPhone and press `B`.",
    "",
    "Expected proof defaults:",
    "",
    "```text",
    `scene=${planCheck?.evidence?.on_device_app_action?.set_scene_state ?? "S01_SEARCH/rest"}`,
    `rig=${planCheck?.evidence?.on_device_app_action?.set_rig ?? "R0"}`,
    `device=mvl_primary`,
    `repeat=${planCheck?.evidence?.on_device_app_action?.set_repeat ?? 1}`,
    `max-fidelity=${String(planCheck?.evidence?.on_device_app_action?.set_max_fidelity ?? true)}`,
    "```",
    "",
    "4. Lower-level USB pull if the proof packet is already prepared: start the waiting command, then connect the iPhone, unlock it, tap **Trust This Computer**, and let it pull + verify:",
    "",
    "```powershell",
    "npm run phone:wait",
    "```",
    "",
    "`phone:wait` installs `pymobiledevice3` into `artifacts/tooling` if missing, waits up to 15 minutes for a trusted USB iPhone, pulls `Documents/LiquidGlassCaptures` from `com.zaeba.liquidglasscapture`, and then runs `proof:doctor`. `proof:run` is safer because it also passes a freshness timestamp.",
    "",
    "5. Manual fallback: start the watcher before or after the phone capture:",
    "",
    "```powershell",
    "npm run proof:watch",
    "```",
    "",
    "6. Copy `LiquidGlassCaptures` or the whole app `Documents` folder under:",
    "",
    "```text",
    "./artifacts/iphone/",
    "```",
    "",
    "The watcher auto-discovers nested `LiquidGlassCaptures` and verifies the newest repeat manifest.",
    "",
    "7. Success output:",
    "",
    "```text",
    "PASS_VERIFIED_CAPTURE <proof-doctor-report>",
    "INSPECT <npm run glass:inspect ...>",
    "```"
  ];

  if (report.status === "pass_verified_capture") {
    lines.push(
      "",
      "## Verified Capture",
      "",
      `- verify report: \`${report.artifacts?.verify_report_path ?? "missing"}\``,
      `- inspect command: \`${verifyCheck?.evidence?.inspect_command ?? report.next?.inspect ?? "missing"}\``
    );
  } else {
    lines.push(
      "",
      "## If The Watcher Times Out",
      "",
      "Run the verifier directly after copying the folder:",
      "",
      "```powershell",
      "npm run proof:doctor -- --capture-root ./artifacts/iphone",
      "```",
      "",
      "If it reports stale IPA/current-head mismatch, rerun:",
      "",
      "```powershell",
      "npm run proof:prepare",
      "```"
    );
  }

  return `${lines.join("\n")}\n`;
}

function findCheck(report, name) {
  return (report.checks ?? []).find((check) => check.name === name);
}

function printSummary(report) {
  console.log(`${report.status.toUpperCase()} ${report.artifacts.proof_doctor_report_path}`);
  if (report.artifacts.phone_handoff_path) console.log(`HANDOFF ${report.artifacts.phone_handoff_path}`);
  if (report.status === "pass_ready_for_phone") {
    console.log(`INSTALL ${report.artifacts.ipa_path}`);
    console.log(`PHONE ${report.next.on_phone}`);
    if (report.next.watch) console.log(`WATCH ${report.next.watch}`);
    console.log(`VERIFY ${report.next.verify}`);
  } else if (report.status === "pass_verified_capture") {
    console.log(`INSPECT ${report.next.inspect}`);
  } else {
    const failures = report.checks.filter((check) => check.status === "fail");
    for (const failure of failures) {
      console.log(`FAIL ${failure.name}: ${failure.summary}`);
    }
    if (report.next.copy_back) console.log(`NEXT ${report.next.copy_back}`);
    if (report.next.verify) console.log(`VERIFY ${report.next.verify}`);
    if (report.next.watch) console.log(`WATCH ${report.next.watch}`);
    if (report.next.prepare) console.log(`NEXT ${report.next.prepare}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") args.selfTest = true;
    else if (token === "--refresh-ipa") args.refreshIpa = true;
    else if (token === "--verify-capture") args.verifyCapture = true;
    else if (token === "--wait") args.waitMs = defaultWaitMs;
    else if (token === "--wait-ms") args.waitMs = Number(readNext(argv, ++index, token));
    else if (token === "--poll-ms") args.pollMs = Number(readNext(argv, ++index, token));
    else if (token === "--min-started-at-ns") args.minStartedAtNs = BigInt(readNext(argv, ++index, token));
    else if (token === "--out") args.out = readNext(argv, ++index, token);
    else if (token === "--ipa-report") args.ipaReport = readNext(argv, ++index, token);
    else if (token === "--plan-out") args.planOut = readNext(argv, ++index, token);
    else if (token === "--handoff-out") args.handoffOut = readNext(argv, ++index, token);
    else if (token === "--capture-root") args.captureRoot = readNext(argv, ++index, token);
    else if (token === "--verify-out") args.verifyOut = readNext(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function runSelfTest() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "proof-doctor");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ipaPath = join(dir, "fixture.ipa");
  writeFileSync(ipaPath, "fake ipa");
  const headSha = "a".repeat(40);
  const reportPath = join(dir, "unsigned-ipa-download.report.json");
  writeJson(reportPath, {
    status: "pass",
    workflow_run: {
      conclusion: "success",
      head_sha: headSha,
      url: "https://example.test/run"
    },
    ipa_path: ipaPath,
    ipa_size_bytes: statSync(ipaPath).size,
    ipa_inspection: {
      has_payload_app: true,
      has_main_js_bundle: true,
      standalone_js_bundle: true,
      main_js_bundle_path: "Payload/LiquidGlassCapture.app/main.jsbundle"
    }
  });
  const pass = checkIpaReport(reportPath, headSha);
  if (pass.status !== "pass") {
    throw new Error(`proof-doctor self-test expected IPA report pass, got ${pass.summary}`);
  }

  const stale = checkIpaReport(reportPath, "b".repeat(40));
  if (stale.status !== "fail" || !stale.summary.includes("current HEAD")) {
    throw new Error("proof-doctor self-test failed to reject stale-head IPA");
  }

  const handoff = renderPhoneHandoff({
    status: "pass_ready_for_phone",
    repo: {
      branch: "codex/self-test",
      head_sha: headSha
    },
    checks: [pass, {
      name: "one_repeat_proof_plan_contract",
      status: "pass",
      evidence: {
        on_device_app_action: {
          set_scene_state: "S01_SEARCH/rest",
          set_rig: "R0",
          set_repeat: 1,
          set_max_fidelity: true
        }
      }
    }],
    artifacts: {
      ipa_path: ipaPath,
      proof_doctor_report_path: join(dir, "proof-doctor.report.json"),
      proof_plan_path: join(dir, "proof.plan.json")
    }
  });
  if (
    !handoff.includes("PASS_READY_FOR_PHONE") ||
    !handoff.includes("PASS_VERIFIED_CAPTURE") ||
    !handoff.includes("npm run proof:run") ||
    !handoff.includes("npm run phone:wait") ||
    !handoff.includes("npm run proof:watch")
  ) {
    throw new Error("proof-doctor self-test failed to render phone handoff runbook");
  }

  const captureRoot = join(dir, "LiquidGlassCaptures");
  mkdirSync(join(captureRoot, "Series"), { recursive: true });
  writeFileSync(join(captureRoot, "Series", "one.repeat-manifest.json"), "{}\n");
  const copied = inspectCopiedCaptureRoot(captureRoot);
  if (copied.status !== "pass") {
    throw new Error("proof-doctor self-test failed to recognize copied capture root");
  }

  const currentHeadSha = runGit(["rev-parse", "HEAD"]).trim();
  const currentHeadIpaReport = join(dir, "current-head-ipa.report.json");
  writeJson(currentHeadIpaReport, {
    status: "pass",
    workflow_run: {
      conclusion: "success",
      head_sha: currentHeadSha,
      url: "https://example.test/current-run"
    },
    ipa_path: ipaPath,
    ipa_size_bytes: statSync(ipaPath).size,
    ipa_inspection: {
      has_payload_app: true,
      has_main_js_bundle: true,
      standalone_js_bundle: true,
      main_js_bundle_path: "Payload/LiquidGlassCapture.app/main.jsbundle"
    }
  });
  const prepareWithExistingCapture = runDoctor({
    out: join(dir, "prepare-existing-capture.report.json"),
    ipaReport: currentHeadIpaReport,
    planOut: join(dir, "prepare-existing-capture.plan.json"),
    captureRootInput: captureRoot,
    captureRootResolution: resolveCaptureRoot(captureRoot),
    captureRoot,
    verifyOut: join(dir, "prepare-existing-capture.verify.json"),
    refreshIpa: false,
    verifyCapture: false,
    waitMs: 0,
    pollMs: 1
  });
  if (prepareWithExistingCapture.checks.some((check) => check.name === "verify_copied_max_fidelity_capture") ||
      prepareWithExistingCapture.checks.some((check) => check.name === "max_fidelity_capture_verification_report")) {
    throw new Error("proof-doctor self-test failed to keep prepare mode from verifying existing captures");
  }

  const copiedParent = join(dir, "CopiedDocuments");
  const nestedCaptureRoot = join(copiedParent, "Documents", "LiquidGlassCaptures");
  mkdirSync(join(nestedCaptureRoot, "Series"), { recursive: true });
  writeJson(join(nestedCaptureRoot, "Series", "nested.repeat-manifest.json"), {
    finished_at_ns: "200"
  });
  const nestedResolution = resolveCaptureRoot(copiedParent);
  if (nestedResolution.resolved_path !== nestedCaptureRoot) {
    throw new Error("proof-doctor self-test failed to resolve nested LiquidGlassCaptures");
  }

  const olderCaptureRoot = join(copiedParent, "Old", "LiquidGlassCaptures");
  mkdirSync(join(olderCaptureRoot, "Series"), { recursive: true });
  writeJson(join(olderCaptureRoot, "Series", "old.repeat-manifest.json"), {
    finished_at_ns: "100"
  });
  const newestResolution = resolveCaptureRoot(copiedParent);
  if (newestResolution.resolved_path !== nestedCaptureRoot || newestResolution.candidate_count < 2) {
    throw new Error("proof-doctor self-test failed to pick newest nested LiquidGlassCaptures");
  }

  const timeoutReport = runDoctorAfterWait({
    out: join(dir, "timeout.report.json"),
    ipaReport: reportPath,
    planOut: join(dir, "timeout.plan.json"),
    captureRootInput: join(dir, "timeout-root"),
    captureRootResolution: resolveCaptureRoot(join(dir, "timeout-root")),
    captureRoot: join(dir, "timeout-root"),
    verifyOut: join(dir, "timeout.verify.json"),
    refreshIpa: false,
    verifyCapture: true,
    waitMs: 1,
    pollMs: 1
  });
  if (timeoutReport.status !== "fail" || !timeoutReport.checks.some((check) => check.name === "wait_for_copied_capture_root")) {
    throw new Error("proof-doctor self-test failed to report wait timeout");
  }

  const staleVerifyOut = join(dir, "stale.verify.json");
  writeJson(staleVerifyOut, {
    status: "pass",
    capture_count: 1,
    next: {
      inspect_command: "stale-inspect-command"
    }
  });
  const compatibleVerify = join(dir, "compatible.verify.json");
  writeJson(compatibleVerify, {
    status: "pass",
    observed: {
      artifact_json_paths_resolved: [join(dir, "one.capture.json")]
    },
    next: {
      inspect_command: "inspect-compatible"
    }
  });
  const compatibleVerifyCheck = checkVerifyReport(compatibleVerify);
  if (compatibleVerifyCheck.status !== "pass" || compatibleVerifyCheck.evidence.capture_count !== 1) {
    throw new Error("proof-doctor self-test failed to infer capture_count from ios-capture observed paths");
  }

  const missingCountVerify = join(dir, "missing-count.verify.json");
  writeJson(missingCountVerify, {
    status: "pass",
    next: {
      inspect_command: "inspect-missing-count"
    }
  });
  if (checkVerifyReport(missingCountVerify).status !== "fail") {
    throw new Error("proof-doctor self-test accepted verify report without capture_count evidence");
  }

  const missingRootReport = runDoctor({
    out: join(dir, "stale-trap.report.json"),
    ipaReport: reportPath,
    planOut: join(dir, "stale-trap.plan.json"),
    captureRoot: join(dir, "missing-LiquidGlassCaptures"),
    verifyOut: staleVerifyOut,
    refreshIpa: false,
    verifyCapture: true
  });
  if (missingRootReport.status !== "fail") {
    throw new Error("proof-doctor self-test failed to reject missing capture root");
  }
  if (!missingRootReport.checks.some((check) => check.name === "capture_root_ready_for_verify" && check.status === "fail")) {
    throw new Error("proof-doctor self-test failed to explain missing capture root");
  }
  if (missingRootReport.artifacts.verify_report_path !== null) {
    throw new Error("proof-doctor self-test reused stale verify report path");
  }

  const badCaptureRoot = join(dir, "Bad", "LiquidGlassCaptures");
  mkdirSync(join(badCaptureRoot, "Series"), { recursive: true });
  writeJson(join(badCaptureRoot, "Series", "bad.repeat-manifest.json"), {
    schema_version: "1.2.0",
    kind: "repeat_capture_manifest",
    status: "complete",
    rig_id: "R0",
    scene_id: "S01_SEARCH",
    state_id: "rest",
    capture_kind: "compositor",
    device_matrix_role: "mvl_primary",
    repeat_count_requested: 1,
    repeat_count_observed: 1,
    artifact_json_paths: ["missing.capture.json"],
    max_fidelity: true,
    capture_raw_frames: true,
    capture_raw_pixels: true,
    max_frames: 1
  });
  writeJson(staleVerifyOut, {
    status: "pass",
    capture_count: 1,
    next: {
      inspect_command: "stale-inspect-command"
    }
  });
  const staleTrapReport = runDoctor({
    out: join(dir, "bad-root.report.json"),
    ipaReport: reportPath,
    planOut: join(dir, "bad-root.plan.json"),
    captureRoot: badCaptureRoot,
    verifyOut: staleVerifyOut,
    refreshIpa: false,
    verifyCapture: true
  });
  if (staleTrapReport.status !== "fail") {
    throw new Error("proof-doctor self-test failed to reject bad capture root");
  }
  const overwrittenVerify = readJson(staleVerifyOut);
  if (overwrittenVerify.next?.inspect_command === "stale-inspect-command") {
    throw new Error("proof-doctor self-test reused stale verify report content");
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS proof-doctor self-test");
}
