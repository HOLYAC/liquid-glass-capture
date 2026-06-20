#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkflow = "build-unsigned-ios-ipa.yml";
const defaultArtifact = "LiquidGlassCapture-unsigned-ipa";
const defaultIpa = "LiquidGlassCapture-unsigned.ipa";

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const request = normalizeRequest(args);
  const report = downloadUnsignedIpa(request);
  console.log(`PASS ${report.ipa_path}`);
  console.log(`RUN ${report.workflow_run.url}`);
  console.log(`REPORT ${report.report_path}`);
}

function normalizeRequest(args) {
  const repo = args.repo ?? readGithubRepo();
  const branch = args.branch ?? readCurrentBranch();
  const workflow = args.workflow ?? defaultWorkflow;
  const artifact = args.artifact ?? defaultArtifact;
  const outDir = resolve(repoRoot, args.outDir ?? join("artifacts", "unsigned-ipa"));
  const runId = args.runId ? Number(args.runId) : null;

  if (args.runId && (!Number.isInteger(runId) || runId <= 0)) {
    throw new Error("--run-id must be a positive integer");
  }
  if (!repo) {
    throw new Error("GitHub repo is required; pass --repo OWNER/REPO or set remote.origin.url");
  }
  if (!runId && !branch) {
    throw new Error("Git branch is required; pass --branch BRANCH when HEAD is detached");
  }

  return { repo, branch, workflow, artifact, outDir, runId };
}

function downloadUnsignedIpa(request) {
  const run = request.runId
    ? readRun(request.repo, request.runId)
    : selectLatestSuccessfulRun(listWorkflowRuns(request));
  const artifacts = readRunArtifacts(request.repo, run.databaseId);
  const artifact = selectArtifact(artifacts, request.artifact);
  const downloadDir = join(request.outDir, `.download-${process.pid}-${Date.now()}`);

  mkdirSync(downloadDir, { recursive: true });
  try {
    runGh([
      "run",
      "download",
      String(run.databaseId),
      "--repo",
      request.repo,
      "--name",
      artifact.name,
      "--dir",
      downloadDir
    ]);

    const downloadedIpa = findIpa(downloadDir);
    const targetPath = join(request.outDir, basename(downloadedIpa));
    mkdirSync(request.outDir, { recursive: true });
    rmSync(targetPath, { force: true });
    copyFileSync(downloadedIpa, targetPath);
    const ipaSize = statSync(targetPath).size;
    if (ipaSize <= 0) {
      throw new Error(`Downloaded IPA is empty: ${targetPath}`);
    }
    const ipaInspection = inspectIpa(targetPath);
    if (!ipaInspection.has_payload_app) {
      throw new Error(`Downloaded IPA has no Payload/*.app bundle: ${targetPath}`);
    }
    if (!ipaInspection.has_main_js_bundle) {
      throw new Error(`Downloaded IPA has no embedded main.jsbundle: ${targetPath}`);
    }

    const reportPath = join(request.outDir, "unsigned-ipa-download.report.json");
    const report = {
      schema_version: "1.2.0",
      kind: "unsigned_ipa_download",
      status: "pass",
      repo: request.repo,
      branch: request.branch,
      workflow: request.workflow,
      artifact: {
        name: artifact.name,
        size_in_bytes: artifact.size_in_bytes,
        expired: Boolean(artifact.expired),
        url: artifact.url
      },
      workflow_run: {
        id: run.databaseId,
        url: run.url,
        head_sha: run.headSha,
        head_branch: run.headBranch,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.createdAt
      },
      ipa_path: targetPath,
      ipa_size_bytes: ipaSize,
      ipa_inspection: ipaInspection,
      report_path: reportPath,
      next: {
        sideload: `Install ${targetPath} with Sideloadly or AltStore, then open the app on the iPhone. No Metro server is required for this downloaded IPA because it contains ${ipaInspection.main_js_bundle_path}.`,
        proof_plan_command:
          "npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 1 --device-role mvl_primary --max-fidelity --out ./artifacts/ios-max-fidelity-proof.plan.json",
        proof_verify_command:
          "npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 1 --device-role mvl_primary --max-fidelity --capture-root ./artifacts/iphone/LiquidGlassCaptures --out ./artifacts/ios-max-fidelity-proof.verify.json"
      }
    };

    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

function listWorkflowRuns(request) {
  const raw = runGh([
    "run",
    "list",
    "--repo",
    request.repo,
    "--workflow",
    request.workflow,
    "--branch",
    request.branch,
    "--limit",
    "20",
    "--json",
    "databaseId,headSha,url,createdAt,status,conclusion,headBranch,workflowName"
  ]);
  const runs = JSON.parse(raw);
  if (!Array.isArray(runs)) {
    throw new Error("gh run list did not return an array");
  }
  return runs;
}

function readRun(repo, runId) {
  const raw = runGh([
    "run",
    "view",
    String(runId),
    "--repo",
    repo,
    "--json",
    "databaseId,headSha,url,createdAt,status,conclusion,headBranch,workflowName"
  ]);
  return JSON.parse(raw);
}

function readRunArtifacts(repo, runId) {
  const raw = runGh(["api", `repos/${repo}/actions/runs/${runId}/artifacts`]);
  const payload = JSON.parse(raw);
  if (!Array.isArray(payload.artifacts)) {
    throw new Error("GitHub artifacts response did not contain artifacts[]");
  }
  return payload.artifacts;
}

function selectLatestSuccessfulRun(runs) {
  const successful = runs
    .filter((run) => run.conclusion === "success" && run.status === "completed")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const run = successful[0];
  if (!run) {
    throw new Error(
      `No successful unsigned IPA workflow run found. Run: gh workflow run ${defaultWorkflow}`
    );
  }
  return run;
}

function selectArtifact(artifacts, expectedName = defaultArtifact) {
  const artifact = artifacts.find((candidate) => candidate.name === expectedName);
  if (!artifact) {
    throw new Error(`Artifact ${expectedName} was not found in the selected workflow run`);
  }
  if (artifact.expired) {
    throw new Error(`Artifact ${expectedName} is expired; rerun the workflow`);
  }
  if (!Number.isFinite(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
    throw new Error(`Artifact ${expectedName} has invalid size ${artifact.size_in_bytes}`);
  }
  return artifact;
}

function findIpa(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".ipa")) {
        files.push(path);
      }
    }
  }

  if (files.length === 0) {
    throw new Error(`No .ipa found in downloaded artifact under ${root}`);
  }
  return files.find((file) => basename(file) === defaultIpa) ?? files[0];
}

function inspectIpa(file) {
  const entries = listZipEntries(file);
  const appBundleRoots = [];
  for (const entry of entries) {
    const match = entry.match(/^(Payload\/[^/]+\.app)(?:\/|$)/);
    if (match && !appBundleRoots.includes(match[1])) {
      appBundleRoots.push(match[1]);
    }
  }
  const mainJsBundlePath = entries.find((entry) => /^Payload\/[^/]+\.app\/main\.jsbundle$/.test(entry)) ?? null;
  return {
    entry_count: entries.length,
    app_bundle_roots: appBundleRoots,
    has_payload_app: appBundleRoots.length > 0,
    has_main_js_bundle: Boolean(mainJsBundlePath),
    main_js_bundle_path: mainJsBundlePath,
    standalone_js_bundle: Boolean(mainJsBundlePath)
  };
}

function listZipEntries(file) {
  const buffer = readFileSync(file);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset === 0xffffffff || centralDirectorySize === 0xffffffff) {
    throw new Error(`ZIP64 central directory is not supported by this verifier: ${file}`);
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error(`ZIP central directory points past EOF: ${file}`);
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset < end && entries.length < totalEntries) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory header at byte ${offset}: ${file}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    entries.push(buffer.toString("utf8", nameStart, nameEnd).replace(/\\/g, "/"));
    offset = nameEnd + extraLength + commentLength;
  }

  if (entries.length !== totalEntries) {
    throw new Error(`ZIP central directory entry count mismatch: expected ${totalEntries}, read ${entries.length}`);
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ZIP end of central directory was not found");
}

function readCurrentBranch() {
  return tryRunGit(["branch", "--show-current"]).trim();
}

function readGithubRepo() {
  const remote = tryRunGit(["config", "--get", "remote.origin.url"]).trim();
  const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = remote.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return "";
}

function tryRunGit(args) {
  try {
    return runGit(args);
  } catch {
    return "";
  }
}

function runGit(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function runGh(args) {
  try {
    return execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim();
    const detail = stderr ? `\n${stderr}` : "";
    throw new Error(`gh ${args.join(" ")} failed${detail}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") {
      args.selfTest = true;
    } else if (token === "--repo") {
      args.repo = readNext(argv, ++index, token);
    } else if (token === "--branch") {
      args.branch = readNext(argv, ++index, token);
    } else if (token === "--workflow") {
      args.workflow = readNext(argv, ++index, token);
    } else if (token === "--artifact") {
      args.artifact = readNext(argv, ++index, token);
    } else if (token === "--out-dir") {
      args.outDir = readNext(argv, ++index, token);
    } else if (token === "--run-id") {
      args.runId = readNext(argv, ++index, token);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
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
  const runs = [
    {
      databaseId: 1,
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-06-20T10:00:00Z"
    },
    {
      databaseId: 2,
      status: "completed",
      conclusion: "success",
      createdAt: "2026-06-20T11:00:00Z"
    },
    {
      databaseId: 3,
      status: "in_progress",
      conclusion: "",
      createdAt: "2026-06-20T12:00:00Z"
    }
  ];
  const run = selectLatestSuccessfulRun(runs);
  assert(run.databaseId === 2, "latest successful completed run must be selected");

  const artifact = selectArtifact([
    { name: "wrong", size_in_bytes: 10, expired: false },
    { name: defaultArtifact, size_in_bytes: 7302854, expired: false }
  ]);
  assert(artifact.name === defaultArtifact, "expected unsigned IPA artifact must be selected");

  const fixtureDir = join(repoRoot, "artifacts", "lab-self-test", "ipa-download");
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(join(fixtureDir, "nested"), { recursive: true });
  const fixtureIpa = join(fixtureDir, "nested", defaultIpa);
  writeFileSync(fixtureIpa, "fake ipa");
  assert(findIpa(fixtureDir) === fixtureIpa, "recursive IPA discovery must find the canonical file");
  assert(existsSync(fixtureIpa), "fixture IPA must exist before cleanup");

  const zipIpa = join(fixtureDir, "fixture.ipa");
  writeMinimalZip(zipIpa, [
    "Payload/",
    "Payload/LiquidGlassCapture.app/",
    "Payload/LiquidGlassCapture.app/main.jsbundle",
    "Payload/LiquidGlassCapture.app/Info.plist"
  ]);
  const inspection = inspectIpa(zipIpa);
  assert(inspection.has_payload_app, "IPA inspection must find Payload app bundle");
  assert(inspection.has_main_js_bundle, "IPA inspection must find embedded JS bundle");
  assert(
    inspection.main_js_bundle_path === "Payload/LiquidGlassCapture.app/main.jsbundle",
    "IPA inspection must report the JS bundle path"
  );
  rmSync(fixtureDir, { recursive: true, force: true });

  console.log("PASS ipa-download self-test");
}

function writeMinimalZip(file, names) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of names) {
    const nameBuffer = Buffer.from(name, "utf8");
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(0, 18);
    localHeader.writeUInt32LE(0, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);
    localParts.push(localHeader);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(0, 20);
    centralHeader.writeUInt32LE(0, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuffer.copy(centralHeader, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(names.length, 8);
  endOfCentralDirectory.writeUInt16LE(names.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);
  writeFileSync(file, Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory]));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
