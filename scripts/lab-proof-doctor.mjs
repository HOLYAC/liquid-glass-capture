#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = join(repoRoot, "artifacts", "proof-doctor");
const defaultIpaDir = join(repoRoot, "artifacts", "unsigned-ipa");
const defaultCaptureRoot = join(repoRoot, "artifacts", "iphone", "LiquidGlassCaptures");
const proofPlanPath = join(repoRoot, "artifacts", "ios-max-fidelity-proof.plan.json");
const proofVerifyPath = join(defaultOutDir, "ios-max-fidelity-proof.verify.json");
const proofDoctorReportPath = join(defaultOutDir, "proof-doctor.report.json");

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
  const report = runDoctor(request);
  writeJson(request.out, report);
  printSummary(report);
  if (report.status === "fail") process.exit(1);
}

function normalizeRequest(args) {
  const out = resolve(repoRoot, args.out ?? proofDoctorReportPath);
  const ipaReport = resolve(repoRoot, args.ipaReport ?? join(defaultIpaDir, "unsigned-ipa-download.report.json"));
  const planOut = resolve(repoRoot, args.planOut ?? proofPlanPath);
  const captureRoot = args.captureRoot ? resolve(repoRoot, args.captureRoot) : defaultCaptureRoot;
  const verifyOut = resolve(repoRoot, args.verifyOut ?? proofVerifyPath);
  return {
    out,
    ipaReport,
    planOut,
    captureRoot,
    verifyOut,
    refreshIpa: Boolean(args.refreshIpa),
    verifyCapture: Boolean(args.verifyCapture || args.captureRoot)
  };
}

function runDoctor(request) {
  mkdirSync(dirname(request.out), { recursive: true });
  const checks = [];
  const headSha = runGit(["rev-parse", "HEAD"]).trim();
  const branch = runGit(["branch", "--show-current"]).trim();

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

  const copiedCaptureCheck = inspectCopiedCaptureRoot(request.captureRoot);
  checks.push(copiedCaptureCheck);

  let verifyReportPath = null;
  let inspectCommand = null;
  if (request.verifyCapture || copiedCaptureCheck.status === "pass") {
    const verifyResult = runNodeScript("lab-ios-capture.mjs", [
      ...proofArgs,
      "--capture-root",
      request.captureRoot,
      "--out",
      request.verifyOut
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
      copied_capture_root: request.captureRoot,
      verify_report_path: verifyReportPath,
      proof_doctor_report_path: request.out
    },
    next: nextSteps({
      readyForPhone,
      verifiedCapture,
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

function inspectCopiedCaptureRoot(captureRoot) {
  const evidence = { path: captureRoot };
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
    evidence.status = report.status;
    evidence.manifest_path = report.manifest_path;
    evidence.capture_count = report.capture_count;
    evidence.inspect_command = report.next?.inspect_command;
    const ok =
      report.status === "pass" &&
      Number.isFinite(report.capture_count) &&
      report.capture_count >= 1 &&
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

function nextSteps({ readyForPhone, verifiedCapture, ipaPath, captureRoot, inspectCommand }) {
  if (verifiedCapture) {
    return {
      state: "verified_capture_ready_to_inspect",
      inspect: inspectCommand,
      repeat_50_mvl:
        "npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50 --device-role mvl_primary --max-fidelity --out ./artifacts/ios-mvl.plan.json"
    };
  }
  if (readyForPhone) {
    return {
      state: "ready_for_phone",
      install: `Install ${ipaPath} with Sideloadly or AltStore.`,
      on_phone: "Open Liquid Glass Capture and press B. Defaults are S01_SEARCH/R0/mvl_primary/repeat=1/max-fidelity=true.",
      copy_back: `Copy the app Documents/LiquidGlassCaptures folder to ${captureRoot}.`,
      verify: `npm run proof:doctor -- --capture-root ./artifacts/iphone/LiquidGlassCaptures`
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

function printSummary(report) {
  console.log(`${report.status.toUpperCase()} ${report.artifacts.proof_doctor_report_path}`);
  if (report.status === "pass_ready_for_phone") {
    console.log(`INSTALL ${report.artifacts.ipa_path}`);
    console.log(`PHONE ${report.next.on_phone}`);
    console.log(`VERIFY ${report.next.verify}`);
  } else if (report.status === "pass_verified_capture") {
    console.log(`INSPECT ${report.next.inspect}`);
  } else {
    const failures = report.checks.filter((check) => check.status === "fail");
    for (const failure of failures) {
      console.log(`FAIL ${failure.name}: ${failure.summary}`);
    }
    console.log(`NEXT ${report.next.prepare}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") args.selfTest = true;
    else if (token === "--refresh-ipa") args.refreshIpa = true;
    else if (token === "--verify-capture") args.verifyCapture = true;
    else if (token === "--out") args.out = readNext(argv, ++index, token);
    else if (token === "--ipa-report") args.ipaReport = readNext(argv, ++index, token);
    else if (token === "--plan-out") args.planOut = readNext(argv, ++index, token);
    else if (token === "--capture-root") args.captureRoot = readNext(argv, ++index, token);
    else if (token === "--verify-out") args.verifyOut = readNext(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
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

  const captureRoot = join(dir, "LiquidGlassCaptures");
  mkdirSync(join(captureRoot, "Series"), { recursive: true });
  writeFileSync(join(captureRoot, "Series", "one.repeat-manifest.json"), "{}\n");
  const copied = inspectCopiedCaptureRoot(captureRoot);
  if (copied.status !== "pass") {
    throw new Error("proof-doctor self-test failed to recognize copied capture root");
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("PASS proof-doctor self-test");
}
