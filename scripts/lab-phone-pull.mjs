#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutRoot = join(repoRoot, "artifacts", "iphone");
const defaultReportPath = join(repoRoot, "artifacts", "phone-pull", "phone-pull.report.json");
const defaultVenvDir = join(repoRoot, "artifacts", "tooling", "pmd3-venv");
const pinnedPymobiledevice3 = "pymobiledevice3==9.27.0";
const defaultWaitMs = 15 * 60 * 1000;
const defaultPollMs = 2500;
const commandMaxBuffer = 64 * 1024 * 1024;

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const request = normalizeRequest(args);
  const report = request.waitMs > 0 ? runPhonePullAfterWait(request) : runPhonePull(request);
  writeJson(request.out, report);
  printSummary(report);
  if (report.status !== "pass") process.exit(1);
}

function normalizeRequest(args) {
  const appConfig = JSON.parse(readFileSync(join(repoRoot, "app.json"), "utf8"));
  const bundleId = args.bundleId ?? appConfig.expo?.ios?.bundleIdentifier ?? "com.zaeba.liquidglasscapture";
  const outRoot = resolve(repoRoot, args.outRoot ?? defaultOutRoot);
  const out = resolve(repoRoot, args.out ?? defaultReportPath);
  const venvDir = resolve(repoRoot, args.venvDir ?? defaultVenvDir);
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
    outRoot,
    venvDir,
    bundleId,
    remotePath: args.remotePath ?? "LiquidGlassCaptures",
    bootstrap: Boolean(args.bootstrap),
    skipDeviceCheck: Boolean(args.skipDeviceCheck),
    skipVerify: Boolean(args.skipVerify),
    minStartedAtNs: args.minStartedAtNs ?? null,
    waitMs,
    pollMs,
    udid: args.udid ?? null,
    tool: args.tool ? resolve(repoRoot, args.tool) : null
  };
}

function runPhonePullAfterWait(request) {
  const startedAt = Date.now();
  const deadline = startedAt + request.waitMs;
  let lastReport = null;
  while (Date.now() <= deadline) {
    const attempt = runPhonePull(request);
    lastReport = attempt;
    if (attempt.status === "pass") {
      return {
        ...attempt,
        waited_ms: Date.now() - startedAt
      };
    }
    if (!isRetryableReport(attempt)) {
      return {
        ...attempt,
        waited_ms: Date.now() - startedAt
      };
    }
    sleepMs(request.pollMs);
  }

  const timeoutCheck = {
    name: "wait_for_phone_pull",
    status: "fail",
    summary: `timed out after ${request.waitMs}ms waiting for trusted iPhone + LiquidGlassCaptures`,
    evidence: {
      waited_ms: Date.now() - startedAt,
      poll_ms: request.pollMs,
      last_report_status: lastReport?.status ?? "missing",
      last_failed_checks: (lastReport?.checks ?? [])
        .filter((check) => check.status === "fail")
        .map((check) => ({ name: check.name, summary: check.summary }))
    }
  };
  return report("fail", request, [...(lastReport?.checks ?? []), timeoutCheck]);
}

function isRetryableReport(value) {
  const failed = (value.checks ?? []).filter((check) => check.status === "fail");
  if (failed.length === 0) return false;
  return failed.every((check) =>
    check.name === "connected_ios_device" ||
    check.name === "pull_liquid_glass_captures" ||
    check.evidence?.retryable === true
  );
}

function runPhonePull(request) {
  const checks = [];
  const toolCheck = resolvePymobiledevice3(request);
  checks.push(toolCheck);
  if (toolCheck.status !== "pass") return report("fail", request, checks);

  const deviceCheck = request.skipDeviceCheck
    ? {
      name: "connected_ios_device",
      status: "skip",
      summary: "device preflight skipped by --skip-device-check",
      evidence: {}
    }
    : checkConnectedDevice(toolCheck.evidence.tool_path, request);
  checks.push(deviceCheck);
  if (deviceCheck.status === "fail") return report("fail", request, checks);

  const bundleCheck = resolveInstalledBundleId(toolCheck.evidence.tool_path, request);
  checks.push(bundleCheck);
  if (bundleCheck.status === "fail") return report("fail", request, checks);

  const resolvedRequest = {
    ...request,
    bundleId: bundleCheck.evidence.bundle_id
  };
  mkdirSync(resolvedRequest.outRoot, { recursive: true });
  const pullCheck = pullDocuments(toolCheck.evidence.tool_path, resolvedRequest);
  checks.push(pullCheck);
  if (pullCheck.status !== "pass") return report("fail", resolvedRequest, checks);

  if (!resolvedRequest.skipVerify) {
    const verifyCheck = runProofDoctor(resolvedRequest);
    checks.push(verifyCheck);
    if (verifyCheck.status !== "pass") return report("fail", resolvedRequest, checks);
  }

  return report("pass", resolvedRequest, checks);
}

function resolvePymobiledevice3(request) {
  if (request.tool) {
    return toolExists(request.tool, "explicit --tool path");
  }

  const localTool = localPymobiledevice3Path(request.venvDir);
  if (existsSync(localTool)) {
    return toolExists(localTool, "local repo venv");
  }

  const pathTool = findOnPath(process.platform === "win32" ? "pymobiledevice3.exe" : "pymobiledevice3")
    ?? findOnPath("pymobiledevice3");
  if (pathTool) {
    return toolExists(pathTool, "PATH");
  }

  if (!request.bootstrap) {
    return {
      name: "pymobiledevice3_available",
      status: "fail",
      summary: "pymobiledevice3 is not installed; rerun with --bootstrap to install it into artifacts/tooling",
      evidence: {
        bootstrap_command: "npm run phone:pull -- --bootstrap",
        checked_local_tool: localTool
      }
    };
  }

  const bootstrapCheck = bootstrapPymobiledevice3(request.venvDir);
  if (bootstrapCheck.status !== "pass") return bootstrapCheck;
  return toolExists(localTool, "local repo venv after bootstrap");
}

function bootstrapPymobiledevice3(venvDir) {
  const python = findOnPath("python.exe") ?? findOnPath("python") ?? findOnPath("py.exe") ?? findOnPath("py");
  if (!python) {
    return {
      name: "pymobiledevice3_available",
      status: "fail",
      summary: "Python was not found, cannot bootstrap pymobiledevice3",
      evidence: {}
    };
  }

  if (!existsSync(localPythonPath(venvDir))) {
    const venv = spawnSync(python, ["-m", "venv", venvDir], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    if (venv.status !== 0) {
      return commandFailure("pymobiledevice3_available", "python -m venv failed", venv);
    }
  }

  const pip = spawnSync(localPythonPath(venvDir), ["-m", "pip", "install", "-q", pinnedPymobiledevice3], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (pip.status !== 0) {
    return commandFailure("pymobiledevice3_available", "pip install pymobiledevice3 failed", pip);
  }

  return {
    name: "pymobiledevice3_available",
    status: "pass",
    summary: "bootstrapped pymobiledevice3 into local repo tooling",
    evidence: {
      package: pinnedPymobiledevice3,
      venv_dir: venvDir,
      tool_path: localPymobiledevice3Path(venvDir)
    }
  };
}

function toolExists(toolPath, source) {
  const help = runCommand(toolPath, ["apps", "pull", "--help"]);
  if (help.status !== 0) {
    return commandFailure("pymobiledevice3_available", "pymobiledevice3 exists but apps pull help failed", help, {
      tool_path: toolPath,
      source
    });
  }
  const supportsAppsPull = help.stdout.includes("Pull a file from an app container");
  if (!supportsAppsPull) {
    return {
      name: "pymobiledevice3_available",
      status: "fail",
      summary: "pymobiledevice3 is installed but does not expose the expected apps pull command",
      evidence: {
        tool_path: toolPath,
        source,
        stdout_tail: tailLines(help.stdout),
        stderr_tail: tailLines(help.stderr)
      }
    };
  }
  return {
    name: "pymobiledevice3_available",
    status: "pass",
    summary: `pymobiledevice3 found via ${source}`,
    evidence: {
      tool_path: toolPath,
      source,
      supports_apps_pull: supportsAppsPull
    }
  };
}

function checkConnectedDevice(toolPath, request) {
  const result = runCommand(toolPath, ["usbmux", "list"]);
  if (result.status !== 0) {
    return commandFailure("connected_ios_device", "pymobiledevice3 usbmux list failed", result);
  }

  const devices = parseJsonArray(result.stdout);
  const matchingDevices = request.udid
    ? devices.filter((device) => String(device.Identifier ?? device.SerialNumber ?? device.udid ?? "").includes(request.udid))
    : devices;
  if (matchingDevices.length === 0) {
    return {
      name: "connected_ios_device",
      status: "fail",
      summary: "no trusted USB iPhone was visible to usbmux",
      evidence: {
        devices,
        next: [
          "Connect the iPhone by USB.",
          "Unlock it and tap Trust This Computer.",
          "Rerun npm run proof:run, install the printed IPA, open the app, and press B."
        ]
      }
    };
  }

  return {
    name: "connected_ios_device",
    status: "pass",
    summary: "trusted iOS device visible through usbmux",
    evidence: {
      devices: matchingDevices
    }
  };
}

function resolveInstalledBundleId(toolPath, request) {
  const queryResult = runCommand(toolPath, [
    "apps",
    "query",
    ...deviceArgs(request),
    request.bundleId
  ]);
  if (queryResult.status === 0) {
    const queryApps = parseJsonObject(queryResult.stdout);
    const queryMatches = installedBundleMatches(queryApps, request.bundleId);
    if (queryMatches.length > 0) {
      const match = queryMatches[0];
      return {
        name: "installed_app_bundle_id",
        status: "pass",
        summary: match.bundle_id === request.bundleId
          ? "requested bundle id is installed"
          : `resolved installed app bundle id ${match.bundle_id}`,
        evidence: {
          requested_bundle_id: request.bundleId,
          bundle_id: match.bundle_id,
          resolution: match.bundle_id === request.bundleId ? "exact" : "query_alias",
          matches: queryMatches
        }
      };
    }
  }

  const listResult = runCommand(toolPath, [
    "apps",
    "list",
    "--type",
    "User",
    ...deviceArgs(request)
  ]);
  if (listResult.status !== 0) {
    return commandFailure("installed_app_bundle_id", "pymobiledevice3 apps list failed", listResult, {
      requested_bundle_id: request.bundleId,
      query_exit_code: queryResult.status,
      query_stderr_tail: tailLines(queryResult.stderr ?? "")
    });
  }

  const apps = parseJsonObject(listResult.stdout);
  const matches = installedBundleMatches(apps, request.bundleId);

  if (matches.length === 0) {
    return {
      name: "installed_app_bundle_id",
      status: "fail",
      summary: `no installed app matched ${request.bundleId}`,
      evidence: {
        requested_bundle_id: request.bundleId,
        query_exit_code: queryResult.status,
        query_stderr_tail: tailLines(queryResult.stderr ?? ""),
        app_count: Object.keys(apps).length
      }
    };
  }

  const match = matches[0];
  return {
    name: "installed_app_bundle_id",
    status: "pass",
    summary: match.bundle_id === request.bundleId
      ? "requested bundle id is installed"
      : `resolved installed sideload bundle id ${match.bundle_id}`,
    evidence: {
      requested_bundle_id: request.bundleId,
      bundle_id: match.bundle_id,
      resolution: match.bundle_id === request.bundleId ? "exact" : "sideload_suffix",
      matches
    }
  };
}

function installedBundleMatches(apps, requestedBundleId) {
  return Object.entries(apps)
    .filter(([bundleId, info]) => appMatchesBundleRequest(requestedBundleId, bundleId, info))
    .map(([bundleId, info]) => ({
      bundle_id: String(info?.CFBundleIdentifier ?? bundleId),
      key: bundleId,
      alt_bundle_id: typeof info?.ALTBundleIdentifier === "string" ? info.ALTBundleIdentifier : null,
      name: info?.CFBundleDisplayName ?? info?.CFBundleName ?? null,
      sequence_number: Number(info?.SequenceNumber ?? 0)
    }))
    .sort((left, right) => {
      if (left.sequence_number !== right.sequence_number) return right.sequence_number - left.sequence_number;
      return left.bundle_id.localeCompare(right.bundle_id);
    });
}

function appMatchesBundleRequest(requestedBundleId, bundleId, info) {
  const actualBundleId = String(info?.CFBundleIdentifier ?? bundleId);
  const altBundleId = String(info?.ALTBundleIdentifier ?? "");
  return actualBundleId === requestedBundleId ||
    altBundleId === requestedBundleId ||
    actualBundleId.startsWith(`${requestedBundleId}.`) ||
    bundleId.startsWith(`${requestedBundleId}.`);
}

function pullDocuments(toolPath, request) {
  const remoteFile = request.remotePath.startsWith("Documents/")
    ? request.remotePath
    : `Documents/${request.remotePath}`;
  const args = [
    "apps",
    "pull",
    ...deviceArgs(request),
    request.bundleId,
    remoteFile,
    request.outRoot
  ];
  rmSync(join(request.outRoot, request.remotePath), { recursive: true, force: true });
  const result = runCommand(toolPath, args);
  if (result.status !== 0) {
    return commandFailure("pull_liquid_glass_captures", "pymobiledevice3 apps pull failed", result, {
      command: [toolPath, ...args],
      bundle_id: request.bundleId,
      remote_path: remoteFile,
      out_root: request.outRoot
    });
  }
  const captureRoot = join(request.outRoot, request.remotePath);
  if (!existsSync(captureRoot)) {
    return {
      name: "pull_liquid_glass_captures",
      status: "fail",
      summary: "pymobiledevice3 apps pull completed but local LiquidGlassCaptures was not created",
      evidence: {
        retryable: true,
        command: [toolPath, ...args],
        bundle_id: request.bundleId,
        remote_path: remoteFile,
        out_root: request.outRoot,
        expected_capture_root: captureRoot,
        stdout_tail: tailLines(result.stdout ?? ""),
        stderr_tail: tailLines(result.stderr ?? "")
      }
    };
  }
  const hydrated = hydrateMissingCompositorSessions(toolPath, request, captureRoot);
  if (hydrated.status !== "pass") return hydrated;

  return {
    name: "pull_liquid_glass_captures",
    status: "pass",
    summary: "copied LiquidGlassCaptures from the app Documents container",
    evidence: {
      command: [toolPath, ...args],
      capture_root: captureRoot,
      hydrated_missing_sessions: hydrated.evidence.hydrated_sessions,
      already_present_sessions: hydrated.evidence.already_present_sessions
    }
  };
}

function hydrateMissingCompositorSessions(toolPath, request, captureRoot) {
  const missingSessions = missingCompositorSessions(captureRoot);
  if (missingSessions.length === 0) {
    return {
      name: "pull_missing_compositor_sessions",
      status: "pass",
      summary: "all manifest-referenced compositor sessions were present after root pull",
      evidence: {
        hydrated_sessions: [],
        already_present_sessions: referencedCompositorSessions(captureRoot).length
      }
    };
  }

  const tempRoot = join(request.outRoot, `.direct-compositor-pull-${process.pid}-${Date.now()}`);
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  const hydrated = [];
  try {
    for (const session of missingSessions) {
      const remoteFile = `Documents/${request.remotePath}/Compositor/${session}`;
      const args = [
        "apps",
        "pull",
        ...deviceArgs(request),
        request.bundleId,
        remoteFile,
        tempRoot
      ];
      const result = runCommand(toolPath, args);
      if (result.status !== 0) {
        return commandFailure("pull_missing_compositor_sessions", `direct compositor pull failed for ${session}`, result, {
          command: [toolPath, ...args],
          session,
          retryable: true
        });
      }
      const pulledSessionDir = join(tempRoot, session);
      if (!existsSync(pulledSessionDir)) {
        return {
          name: "pull_missing_compositor_sessions",
          status: "fail",
          summary: `direct compositor pull completed but did not create ${session}`,
          evidence: {
            command: [toolPath, ...args],
            session,
            retryable: true,
            expected_session_dir: pulledSessionDir
          }
        };
      }
      const localSessionDir = join(captureRoot, "Compositor", session);
      rmSync(localSessionDir, { recursive: true, force: true });
      mkdirSync(join(captureRoot, "Compositor"), { recursive: true });
      cpSync(pulledSessionDir, localSessionDir, { recursive: true });
      hydrated.push(session);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  return {
    name: "pull_missing_compositor_sessions",
    status: "pass",
    summary: `direct-pulled ${hydrated.length} manifest-referenced compositor sessions`,
    evidence: {
      hydrated_sessions: hydrated,
      already_present_sessions: referencedCompositorSessions(captureRoot).length - hydrated.length
    }
  };
}

function missingCompositorSessions(captureRoot) {
  return referencedCompositorSessions(captureRoot)
    .filter((session) => {
      const capturePath = join(captureRoot, "Compositor", session, `${session}.capture.json`);
      return !existsSync(capturePath);
    });
}

function referencedCompositorSessions(captureRoot) {
  const seriesDir = join(captureRoot, "Series");
  if (!existsSync(seriesDir)) return [];
  const manifests = [];
  for (const entry of readdirSync(seriesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".repeat-manifest.json")) continue;
    const path = join(seriesDir, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifests.push({ manifest, orderKey: repeatManifestOrderKey(manifest, path) });
    } catch {
      // A broken old manifest should be rejected by proof:doctor, not by the pull hydrator.
    }
  }
  const latest = manifests
    .sort((left, right) => {
      if (left.orderKey === right.orderKey) return 0;
      return left.orderKey > right.orderKey ? -1 : 1;
    })[0]?.manifest;
  if (!latest) return [];

  const sessions = new Set();
  const paths = Array.isArray(latest.artifact_json_paths) ? latest.artifact_json_paths : [];
  for (const artifactPath of paths) {
    if (typeof artifactPath !== "string") continue;
    const normalized = artifactPath.replace(/\\/g, "/");
    const match = normalized.match(/(?:^|\/)Compositor\/([^/]+)\/[^/]+\.capture\.json$/);
    if (match) sessions.add(match[1]);
  }
  return [...sessions].sort();
}

function repeatManifestOrderKey(manifest, path) {
  const raw = manifest?.finished_at_ns ?? manifest?.started_at_ns;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return BigInt(Math.round(raw));
  return BigInt(Math.round(statSync(path).mtimeMs * 1_000_000));
}

function runProofDoctor(request) {
  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "lab-proof-doctor.mjs"),
    "--capture-root",
    request.outRoot,
    ...minStartedAtArgs(request.minStartedAtNs)
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return commandFailure("verify_pulled_capture", "proof:doctor rejected the pulled capture", result, {
      retryable: proofDoctorRejectedOnlyStaleCapture()
    });
  }
  return {
    name: "verify_pulled_capture",
    status: "pass",
    summary: "proof:doctor verified the pulled max-fidelity capture",
    evidence: {
      stdout_tail: tailLines(result.stdout),
      stderr_tail: tailLines(result.stderr)
    }
  };
}

function minStartedAtArgs(value) {
  return value == null ? [] : ["--min-started-at-ns", value.toString()];
}

function proofDoctorRejectedOnlyStaleCapture() {
  const verifyPath = join(repoRoot, "artifacts", "proof-doctor", "ios-max-fidelity-proof.verify.json");
  try {
    const report = JSON.parse(readFileSync(verifyPath, "utf8"));
    const failures = Array.isArray(report.failures) ? report.failures : [];
    return failures.length > 0 && failures.every((failure) => failure === "MANIFEST_NOT_FRESH_FOR_PROOF_RUN");
  } catch {
    return false;
  }
}

function report(status, request, checks) {
  return {
    schema_version: "1.0.0",
    kind: "phone_pull_report",
    status,
    report_path: request.out,
    bundle_id: request.bundleId,
    remote_path: request.remotePath,
    out_root: request.outRoot,
    checks,
    next: nextSteps(status, checks)
  };
}

function nextSteps(status, checks) {
  if (status === "pass") {
    return {
      verify: "npm run proof:doctor -- --capture-root ./artifacts/iphone",
      inspect: "read the INSPECT line printed by proof:doctor"
    };
  }
  if (findCheck(checks, "pymobiledevice3_available")?.status === "fail") {
    return {
      bootstrap: "npm run phone:pull -- --bootstrap"
    };
  }
  if (findCheck(checks, "connected_ios_device")?.status === "fail") {
    return {
      connect_phone: "Connect iPhone by USB, unlock, Trust This Computer, rerun npm run proof:run, install the printed IPA, open the app, press B"
    };
  }
  if (findCheck(checks, "installed_app_bundle_id")?.status === "fail") {
    return {
      install_app: "Install the IPA printed by npm run proof:run, open it once, then rerun npm run proof:run"
    };
  }
  if (findCheck(checks, "pull_liquid_glass_captures")?.evidence?.retryable === true) {
    return {
      wait_again: "Keep the iPhone connected, rerun npm run proof:run, install the printed IPA, open the app, press B"
    };
  }
  if (findCheck(checks, "wait_for_phone_pull")?.status === "fail") {
    return {
      wait_again: "Keep the iPhone connected, rerun npm run proof:run, install the printed IPA, open the app, press B"
    };
  }
  return {
    manual_fallback: "Copy LiquidGlassCaptures or Documents under ./artifacts/iphone, then run npm run proof:doctor -- --capture-root ./artifacts/iphone"
  };
}

function printSummary(report) {
  console.log(`${report.status.toUpperCase()} ${report.report_path}`);
  for (const check of report.checks) {
    if (check.status === "fail") console.log(`FAIL ${check.name}: ${check.summary}`);
  }
  if (report.status === "pass") {
    console.log("VERIFY npm run proof:doctor -- --capture-root ./artifacts/iphone");
  } else if (report.next.bootstrap) {
    console.log(`NEXT ${report.next.bootstrap}`);
  } else if (report.next.connect_phone) {
    console.log(`NEXT ${report.next.connect_phone}`);
  } else if (report.next.install_app) {
    console.log(`NEXT ${report.next.install_app}`);
  } else if (report.next.wait_again) {
    console.log(`NEXT ${report.next.wait_again}`);
  } else if (report.next.manual_fallback) {
    console.log(`NEXT ${report.next.manual_fallback}`);
  }
}

function commandFailure(name, summary, result, evidence = {}) {
  return {
    name,
    status: "fail",
    summary,
    evidence: {
      ...evidence,
      exit_code: result.status,
      stdout_tail: tailLines(result.stdout ?? ""),
      stderr_tail: tailLines(result.stderr ?? "")
    }
  };
}

function runCommand(command, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawnSync("cmd.exe", ["/d", "/c", command, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: commandMaxBuffer
    });
  }
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: commandMaxBuffer
  });
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function findCheck(checks, name) {
  return checks.find((check) => check.name === name);
}

function deviceArgs(request) {
  return request.udid ? ["--udid", request.udid] : [];
}

function tailLines(text) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-8);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function localPymobiledevice3Path(venvDir) {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "pymobiledevice3.exe")
    : join(venvDir, "bin", "pymobiledevice3");
}

function localPythonPath(venvDir) {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function findOnPath(name) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).find(Boolean) ?? null;
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
    else if (token === "--bootstrap") args.bootstrap = true;
    else if (token === "--skip-device-check") args.skipDeviceCheck = true;
    else if (token === "--skip-verify") args.skipVerify = true;
    else if (token === "--wait") args.waitMs = defaultWaitMs;
    else if (token === "--wait-ms") args.waitMs = Number(readNext(argv, ++index, token));
    else if (token === "--poll-ms") args.pollMs = Number(readNext(argv, ++index, token));
    else if (token === "--min-started-at-ns") args.minStartedAtNs = BigInt(readNext(argv, ++index, token));
    else if (token === "--tool") args.tool = readNext(argv, ++index, token);
    else if (token === "--bundle-id") args.bundleId = readNext(argv, ++index, token);
    else if (token === "--remote") args.remotePath = readNext(argv, ++index, token);
    else if (token === "--out-root") args.outRoot = readNext(argv, ++index, token);
    else if (token === "--out") args.out = readNext(argv, ++index, token);
    else if (token === "--venv-dir") args.venvDir = readNext(argv, ++index, token);
    else if (token === "--udid") args.udid = readNext(argv, ++index, token);
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
  const dir = join(repoRoot, "artifacts", "lab-self-test", "phone-pull");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const request = normalizeRequest({
    outRoot: join(dir, "iphone"),
    out: join(dir, "phone-pull.report.json"),
    bundleId: "com.example.app",
    remotePath: "LiquidGlassCaptures",
    tool: join(dir, "missing-pmd3.exe")
  });
  const missing = runPhonePull(request);
  if (missing.status !== "fail" || findCheck(missing.checks, "pymobiledevice3_available")?.status !== "fail") {
    throw new Error("phone-pull self-test failed missing-tool path");
  }

  const fakeTool = join(dir, process.platform === "win32" ? "fake-pmd3.cmd" : "fake-pmd3.sh");
  const fakeBody = process.platform === "win32"
    ? "@echo off\r\nif \"%1\"==\"usbmux\" (echo []& exit /b 0)\r\nif \"%1\"==\"apps\" (echo Pull a file from an app container& exit /b 0)\r\nexit /b 0\r\n"
    : "#!/bin/sh\nif [ \"$1\" = \"usbmux\" ]; then echo '[]'; exit 0; fi\nif [ \"$1\" = \"apps\" ]; then echo 'Pull a file from an app container'; exit 0; fi\nexit 0\n";
  writeFileSync(fakeTool, fakeBody, { mode: 0o755 });
  const noDevice = runPhonePull({
    ...request,
    tool: fakeTool
  });
  if (noDevice.status !== "fail" || findCheck(noDevice.checks, "connected_ios_device")?.status !== "fail") {
    throw new Error("phone-pull self-test failed no-device path");
  }

  const args = [
    "apps",
    "pull",
    "--udid",
    "UDID",
    "com.example.app",
    "Documents/LiquidGlassCaptures",
    join(dir, "iphone")
  ];
  const expected = [
    "apps",
    "pull",
    ...deviceArgs({ udid: "UDID" }),
    "com.example.app",
    "Documents/LiquidGlassCaptures",
    join(dir, "iphone")
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    throw new Error("phone-pull self-test failed command argument construction");
  }

  const fakeInstalledTool = join(dir, process.platform === "win32" ? "fake-installed-pmd3.cmd" : "fake-installed-pmd3.sh");
  const fakeInstalledScript = join(dir, "fake-installed-pmd3.cjs");
  writeFileSync(fakeInstalledScript, `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "usbmux") {
  console.log(JSON.stringify([{ Identifier: "UDID", DeviceClass: "iPhone", ConnectionType: "USB" }]));
  process.exit(0);
}
if (args[0] === "apps" && args[1] === "query") {
  process.exit(1);
}
if (args[0] === "apps" && args[1] === "list") {
  console.log(JSON.stringify({
    "com.example.app.TEAMID": {
      CFBundleIdentifier: "com.example.app.TEAMID",
      ALTBundleIdentifier: "com.example.app",
      CFBundleDisplayName: "Liquid Glass Capture",
      SequenceNumber: 7
    }
  }));
  process.exit(0);
}
if (args[0] === "apps" && args[1] === "pull") {
  if (args.includes("--help")) {
    console.log("Pull a file from an app container");
    process.exit(0);
  }
  if (!args.includes("com.example.app.TEAMID")) process.exit(2);
  const outRoot = args[args.length - 1];
  fs.mkdirSync(path.join(outRoot, "LiquidGlassCaptures"), { recursive: true });
  console.log("Pull a file from an app container");
  process.exit(0);
}
process.exit(3);
`);
  const fakeInstalledBody = process.platform === "win32"
    ? `@echo off\r\nnode "%~dp0fake-installed-pmd3.cjs" %*\r\n`
    : `#!/bin/sh\nnode "$(dirname "$0")/fake-installed-pmd3.cjs" "$@"\n`;
  writeFileSync(fakeInstalledTool, fakeInstalledBody, { mode: 0o755 });
  const suffixBundle = runPhonePull({
    ...request,
    tool: fakeInstalledTool,
    skipVerify: true
  });
  const suffixBundleCheck = findCheck(suffixBundle.checks, "installed_app_bundle_id");
  if (
    suffixBundle.status !== "pass" ||
    suffixBundle.bundle_id !== "com.example.app.TEAMID" ||
    suffixBundleCheck?.evidence?.resolution !== "sideload_suffix"
  ) {
    throw new Error("phone-pull self-test failed sideload bundle suffix resolution");
  }

  const timeout = runPhonePullAfterWait({
    ...request,
    tool: fakeTool,
    waitMs: 1,
    pollMs: 1
  });
  if (
    timeout.status !== "fail" ||
    findCheck(timeout.checks, "wait_for_phone_pull")?.status !== "fail" ||
    timeout.next?.connect_phone !== "Connect iPhone by USB, unlock, Trust This Computer, rerun npm run proof:run, install the printed IPA, open the app, press B"
  ) {
    throw new Error("phone-pull self-test failed wait timeout path");
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("PASS phone-pull self-test");
}
