#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSolverReport } from "../packages/solver/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestFixture(args.out);
    const report = buildSolverReport({ candidates: fixture.candidates });
    assertSolverGuardRails(report);
    assertOverclaimGuard(fixture.candidates);
    writeReport(fixture.out, report);
    console.log(`${report.status.toUpperCase()} ${fixture.out}`);
    if (report.status !== "pass") process.exit(1);
    return;
  }

  const candidates = readCandidates(args);
  if (candidates.length === 0) {
    console.error("usage: node scripts/lab-solver-rank.mjs --candidate <solver-candidate.json> [--candidate ...] [--out solver.report.json]");
    console.error("       node scripts/lab-solver-rank.mjs --self-test [--out solver.report.json]");
    process.exit(2);
  }

  const report = buildSolverReport({ candidates });
  if (args.out) writeReport(args.out, report);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

function readCandidates(args) {
  const candidates = [];
  for (const path of args.candidates) {
    const json = JSON.parse(readFileSync(resolve(path), "utf8"));
    if (json.kind === "solver_candidate_manifest") {
      if (!Array.isArray(json.candidate_paths)) throw new Error(`${path}: missing candidate_paths`);
      for (const candidatePath of json.candidate_paths) {
        candidates.push(readCandidate(candidatePath));
      }
    } else {
      candidates.push(normalizeCandidate(json, path));
    }
  }
  return candidates;
}

function readCandidate(path) {
  return normalizeCandidate(JSON.parse(readFileSync(resolve(path), "utf8")), path);
}

function normalizeCandidate(json, sourcePath) {
  if (json.kind !== "solver_candidate") {
    throw new Error(`${sourcePath}: expected kind=solver_candidate`);
  }
  return {
    ...json,
    source_path: sourcePath
  };
}

function writeSelfTestFixture(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "solver");
  mkdirSync(dir, { recursive: true });
  const candidates = [
    makeCandidate("c0-visual-heavy", {
      lossBias: 0,
      runtime: 18.4,
      energy: 5.8,
      blurSensitivity: 0.16
    }),
    makeCandidate("c0-knee", {
      lossBias: 0.006,
      runtime: 12.2,
      energy: 2.4,
      blurSensitivity: 0.14
    }),
    makeCandidate("c0-dominated", {
      lossBias: 0.035,
      runtime: 20.0,
      energy: 8.0,
      blurSensitivity: 0.02
    })
  ];

  for (const candidate of candidates) {
    writeFileSync(join(dir, `${candidate.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
  }

  return {
    candidates,
    out: outPath ? resolve(outPath) : join(dir, "solver.pareto.report.json")
  };
}

function makeCandidate(id, { lossBias, runtime, energy, blurSensitivity }) {
  return {
    schema_version: "1.2.0",
    kind: "solver_candidate",
    id,
    rig_id: "C0",
    parameters: {
      blur_radius: 18.5,
      edge_lensing: 0.74,
      specular_gain: 1.18,
      chromatic_noise: 0.03
    },
    parameter_evidence: {
      blur_radius: {
        local_sensitivity: blurSensitivity,
        confidence: 0.96,
        normalized_interval_width: 0.08
      },
      edge_lensing: {
        local_sensitivity: 0.05,
        confidence: 0.72,
        normalized_interval_width: 0.38
      },
      specular_gain: {
        local_sensitivity: 0.03,
        confidence: 0.77,
        normalized_interval_width: 0.72,
        prior_required: true
      },
      chromatic_noise: {
        local_sensitivity: 0.01,
        confidence: 0.31,
        normalized_interval_width: 0.91
      }
    },
    claims: {
      parameter_level_match: {
        blur_radius: true,
        chromatic_noise: false
      }
    },
    objectives: {
      runtime_cost_ms: runtime,
      energy_cost: energy
    },
    background_sweep: ["S07_BUSY_PHOTO", "S08_P3_GRADIENT", "S09_NEAR_WHITE", "S10_NEAR_BLACK", "S11_VIDEO_HF"].map((sceneId, index) => ({
      scene_id: sceneId,
      background_id: `${sceneId.toLowerCase()}_self_test`,
      metrics: {
        static_loss: 0.010 + lossBias + index * 0.001,
        optics_loss: 0.014 + lossBias * 0.5 + index * 0.0005,
        temporal_loss: 0.004 + lossBias * 0.25
      }
    }))
  };
}

function assertSolverGuardRails(report) {
  if (report.status !== "pass") {
    throw new Error(`solver self-test expected pass: ${report.failures.join(", ")}`);
  }
  if (!report.pareto_front.some((candidate) => candidate.id === "c0-knee")) {
    throw new Error("solver self-test lost the knee candidate from Pareto front");
  }
  if (report.pareto_front.some((candidate) => candidate.id === "c0-dominated")) {
    throw new Error("solver self-test kept a dominated candidate on Pareto front");
  }
  if (report.selected_candidate?.id !== "c0-knee") {
    throw new Error(`solver self-test selected ${report.selected_candidate?.id ?? "nothing"} instead of c0-knee`);
  }
  const chromaticConstraint = report.claim_constraints.find((constraint) => constraint.parameter === "chromatic_noise");
  if (chromaticConstraint?.parameter_level_match_claim !== "forbidden") {
    throw new Error("solver self-test failed to forbid ambiguous parameter match claim");
  }
  for (const sceneId of ["S07", "S08", "S09", "S10", "S11"]) {
    if (!report.background_sweep.observed_scene_ids.includes(sceneId)) {
      throw new Error(`solver self-test missed degeneracy scene ${sceneId}`);
    }
  }
}

function assertOverclaimGuard(candidates) {
  const badCandidates = candidates.map((candidate) => candidate.id === "c0-knee"
    ? {
        ...candidate,
        claims: {
          parameter_level_match: {
            ...candidate.claims.parameter_level_match,
            edge_lensing: true
          }
        }
      }
    : candidate
  );
  const report = buildSolverReport({ candidates: badCandidates });
  if (report.status !== "fail" || !report.failures.some((failure) => failure.includes("SOLVER_PARAMETER_MATCH_OVERCLAIM_edge_lensing"))) {
    throw new Error("solver self-test failed to reject bounded ambiguous parameter overclaim");
  }
}

function writeReport(out, report) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = { candidates: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--candidate") parsed.candidates.push(args[++index]);
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
