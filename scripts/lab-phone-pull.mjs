#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutRoot = join(repoRoot, "artifacts", "iphone");
const defaultReportPath = join(repoRoot, "artifacts", "phone-pull", "phone-pull.report.json");
const defaultVenvDir = join(repoRoot, "artifacts", "tooling", "pmd3-venv");
const pinnedPymobiledevice3 = "pymobiledevice3==9.27.0";

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const request = normalizeRequest(args);
  const report = runPhonePull(request);
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
  return {
    out,
    outRoot,
    venvDir,
    bundleId,
    remotePath: args.remotePath ?? "LiquidGlassCaptures",
    bootstrap: Boolean(args.bootstrap),
    skipDeviceCheck: Boolean(args.skipDeviceCheck),
    skipVerify: Boolean(args.skipVerify),
    udid: args.udid ?? null,
    tool: args.tool ? resolve(repoRoot, args.tool) : null
  };
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

  mkdirSync(request.outRoot, { recursive: true });
  const pullCheck = pullDocuments(toolCheck.evidence.tool_path, request);
  checks.push(pullCheck);
  if (pullCheck.status !== "pass") return report("fail", request, checks);

  if (!request.skipVerify) {
    const verifyCheck = runProofDoctor(request);
    checks.push(verifyCheck);
    if (verifyCheck.status !== "pass") return report("fail", request, checks);
  }

  return report("pass", request, checks);
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
          "Open the app, press B, then rerun npm run phone:pull -- --bootstrap."
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

function pullDocuments(toolPath, request) {
  const args = [
    "apps",
    "pull",
    "--documents",
    ...deviceArgs(request),
    request.bundleId,
    request.remotePath,
    request.outRoot
  ];
  const result = runCommand(toolPath, args);
  if (result.status !== 0) {
    return commandFailure("pull_liquid_glass_captures", "pymobiledevice3 apps pull failed", result, {
      command: [toolPath, ...args],
      bundle_id: request.bundleId,
      remote_path: request.remotePath,
      out_root: request.outRoot
    });
  }

  return {
    name: "pull_liquid_glass_captures",
    status: "pass",
    summary: "copied LiquidGlassCaptures from the app Documents container",
    evidence: {
      command: [toolPath, ...args],
      capture_root: join(request.outRoot, request.remotePath)
    }
  };
}

function runProofDoctor(request) {
  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "lab-proof-doctor.mjs"),
    "--capture-root",
    request.outRoot
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return commandFailure("verify_pulled_capture", "proof:doctor rejected the pulled capture", result);
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
      connect_phone: "Connect iPhone by USB, unlock, Trust This Computer, open app, press B, rerun npm run phone:pull -- --bootstrap"
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
      encoding: "utf8"
    });
  }
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8"
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

function findCheck(checks, name) {
  return checks.find((check) => check.name === name);
}

function deviceArgs(request) {
  return request.udid ? ["--udid", request.udid] : [];
}

function tailLines(text) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-8);
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
    "--documents",
    "--udid",
    "UDID",
    "com.example.app",
    "LiquidGlassCaptures",
    join(dir, "iphone")
  ];
  const expected = [
    "apps",
    "pull",
    "--documents",
    ...deviceArgs({ udid: "UDID" }),
    "com.example.app",
    "LiquidGlassCaptures",
    join(dir, "iphone")
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    throw new Error("phone-pull self-test failed command argument construction");
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("PASS phone-pull self-test");
}
