#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProofReport = join(repoRoot, "artifacts", "proof-doctor", "proof-doctor.report.json");
const defaultWaitMs = 15 * 60 * 1000;
const defaultPollMs = 2500;
const defaultFreshnessSkewMs = 120 * 1000;

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const request = normalizeRequest(args);
  const result = runProof(request);
  if (result.status !== "pass") process.exit(1);
}

function runProof(request) {
  const prepare = runNodeScript(request.prepareScript, ["--refresh-ipa"]);
  if (prepare.status !== 0) {
    printCommandFailure("PREPARE", prepare);
    return { status: "fail", phase: "prepare" };
  }

  const proofReport = readJson(request.proofReport);
  if (proofReport.status !== "pass_ready_for_phone" && proofReport.status !== "pass_verified_capture") {
    console.log(`FAIL_PREPARE ${request.proofReport}`);
    console.log(`STATUS ${proofReport.status ?? "unknown"}`);
    return { status: "fail", phase: "prepare" };
  }

  const ipaPath = proofReport.artifacts?.ipa_path ?? "artifacts/unsigned-ipa/LiquidGlassCapture-unsigned.ipa";
  console.log(`PASS_READY_FOR_PHONE ${request.proofReport}`);
  console.log(`INSTALL ${ipaPath}`);
  console.log("PHONE Open Liquid Glass Capture, press B after this line, keep the iPhone unlocked and trusted over USB.");

  const freshnessStartedAtNs = freshnessStartNs(request.freshnessSkewMs);
  console.log(`FRESHNESS_MIN_STARTED_AT_NS ${freshnessStartedAtNs}`);

  if (request.dryRun) {
    console.log("DRY_RUN_SKIP_PHONE_WAIT");
    return { status: "pass", phase: "dry_run", freshnessStartedAtNs };
  }

  const phone = runNodeScript(request.phoneScript, [
    "--bootstrap",
    "--wait",
    "--wait-ms",
    String(request.waitMs),
    "--poll-ms",
    String(request.pollMs),
    "--min-started-at-ns",
    freshnessStartedAtNs.toString()
  ]);
  if (phone.status !== 0) {
    printCommandFailure("PHONE_WAIT", phone);
    return { status: "fail", phase: "phone_wait", freshnessStartedAtNs };
  }
  console.log("PASS_VERIFIED_CAPTURE");
  return { status: "pass", phase: "verified", freshnessStartedAtNs };
}

function normalizeRequest(args) {
  const waitMs = args.waitMs ?? defaultWaitMs;
  const pollMs = args.pollMs ?? defaultPollMs;
  const freshnessSkewMs = args.freshnessSkewMs ?? defaultFreshnessSkewMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("--wait-ms must be a non-negative number");
  if (!Number.isFinite(pollMs) || pollMs < 1) throw new Error("--poll-ms must be a positive number");
  if (!Number.isFinite(freshnessSkewMs) || freshnessSkewMs < 0) {
    throw new Error("--freshness-skew-ms must be a non-negative number");
  }
  return {
    waitMs,
    pollMs,
    freshnessSkewMs,
    dryRun: Boolean(args.dryRun),
    proofReport: resolve(repoRoot, args.proofReport ?? defaultProofReport),
    prepareScript: resolve(repoRoot, args.prepareScript ?? join("scripts", "lab-proof-doctor.mjs")),
    phoneScript: resolve(repoRoot, args.phoneScript ?? join("scripts", "lab-phone-pull.mjs"))
  };
}

function freshnessStartNs(skewMs) {
  return BigInt(Date.now() - skewMs) * 1_000_000n;
}

function runNodeScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function printCommandFailure(label, result) {
  console.log(`FAIL_${label} exit=${result.status}`);
  for (const line of tailLines(result.stdout)) console.log(`stdout: ${line}`);
  for (const line of tailLines(result.stderr)) console.log(`stderr: ${line}`);
}

function tailLines(text) {
  return String(text ?? "").split(/\r?\n/).filter(Boolean).slice(-8);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") args.selfTest = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--wait-ms") args.waitMs = Number(readNext(argv, ++index, token));
    else if (token === "--poll-ms") args.pollMs = Number(readNext(argv, ++index, token));
    else if (token === "--freshness-skew-ms") args.freshnessSkewMs = Number(readNext(argv, ++index, token));
    else if (token === "--proof-report") args.proofReport = readNext(argv, ++index, token);
    else if (token === "--prepare-script") args.prepareScript = readNext(argv, ++index, token);
    else if (token === "--phone-script") args.phoneScript = readNext(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function readNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function runSelfTest() {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "proof-run");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const proofReport = join(dir, "proof-doctor.report.json");
  writeJson(proofReport, {
    status: "pass_ready_for_phone",
    artifacts: {
      ipa_path: join(dir, "fixture.ipa")
    }
  });

  const prepareScript = join(dir, "fake-prepare.mjs");
  writeFileSync(prepareScript, "process.exit(0);\n");
  const phoneArgsPath = join(dir, "phone-args.json");
  const phoneScript = join(dir, "fake-phone.mjs");
  writeFileSync(
    phoneScript,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(phoneArgsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(0);\n`
  );

  const run = runProof(normalizeRequest({
    proofReport,
    prepareScript,
    phoneScript,
    waitMs: 7,
    pollMs: 3,
    freshnessSkewMs: 0
  }));
  if (run.status !== "pass") {
    throw new Error("proof-run self-test expected pass");
  }
  const phoneArgs = JSON.parse(readFileSync(phoneArgsPath, "utf8"));
  if (!phoneArgs.includes("--min-started-at-ns")) {
    throw new Error("proof-run self-test failed to pass freshness timestamp to phone pull");
  }
  if (!phoneArgs.includes("--wait-ms") || !phoneArgs.includes("7")) {
    throw new Error("proof-run self-test failed to pass wait-ms");
  }

  const dry = runProof(normalizeRequest({
    proofReport,
    prepareScript,
    phoneScript,
    dryRun: true
  }));
  if (dry.status !== "pass" || dry.phase !== "dry_run") {
    throw new Error("proof-run self-test expected dry-run pass");
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("PASS proof-run self-test");
}
