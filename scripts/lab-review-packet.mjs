#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReviewPacket } from "../packages/review-stack/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const fixture = writeSelfTestPacket(args.out);
    const report = evaluateReviewPacket(JSON.parse(readFileSync(fixture.packet, "utf8")));
    assertReviewGuardRails();
    writeReport(fixture.out, report);
    console.log(`${report.status.toUpperCase()} ${fixture.out}`);
    if (report.status !== "pass") process.exit(1);
    return;
  }

  if (!args.packet) {
    console.error("usage: node scripts/lab-review-packet.mjs --packet <g7-review-packet.json> [--out report.json]");
    console.error("       node scripts/lab-review-packet.mjs --self-test [--out report.json]");
    process.exit(2);
  }

  const packet = JSON.parse(readFileSync(resolve(args.packet), "utf8"));
  const report = evaluateReviewPacket(packet);
  if (args.out) writeReport(args.out, report);
  console.log(`${report.status.toUpperCase()} ${args.out ?? ""}`.trim());
  if (report.status !== "pass") process.exit(1);
}

export function writeSelfTestPacket(outPath) {
  const dir = join(repoRoot, "artifacts", "lab-self-test", "review-packet");
  mkdirSync(dir, { recursive: true });
  const packet = join(dir, "g7-review.packet.json");
  writeFileSync(packet, `${JSON.stringify(makePassingPacket(), null, 2)}\n`);
  return {
    packet,
    out: outPath ? resolve(outPath) : join(dir, "g7-review.report.json")
  };
}

export function makePassingPacket() {
  return {
    schema_version: "1.2.0",
    kind: "g7_review_packet",
    id: "self-test-g7-review",
    technical_verdict_class: "TECH_PASS_PENDING_SIGNOFF",
    design_reviewer: "design.self-test",
    product_reviewer: "product.self-test",
    owner_decision: "prod_pass",
    artifacts: [
      artifactRef("R0"),
      artifactRef("R1"),
      artifactRef("C1"),
      artifactRef("DOM_C")
    ],
    metrics_summary: {
      G2: "pass",
      G3: "pass",
      G4: "pass",
      G5: "pass",
      G6: "pass"
    },
    review_items: [
      reviewItem("design", "premium_perception", "product_focus", "C1"),
      reviewItem("design", "material_hierarchy", "core", "C1"),
      reviewItem("product", "readability", "text", "DOM_C"),
      reviewItem("product", "interaction_clarity", "motion_path", "C1")
    ]
  };
}

function artifactRef(role) {
  return {
    role,
    id: `self-test-${role}`,
    rig_id: role,
    scene_id: "S03_PRESS",
    state_id: "press",
    png_sha256: `${role.toLowerCase()}-sha256-self-test`
  };
}

function reviewItem(reviewerCategory, concernCategory, maskId, role) {
  return {
    scene_id: "S03_PRESS",
    state_id: "press",
    mask_id: maskId,
    artifact_role: role,
    artifact_id: `self-test-${role}`,
    artifact_path: `artifacts/lab-self-test/review-packet/${role}.capture.json`,
    media_kind: maskId === "motion_path" ? "frame_sequence" : "screenshot",
    reviewer_category: reviewerCategory,
    concern_category: concernCategory,
    decision: "pass",
    reason: ""
  };
}

function assertReviewGuardRails() {
  const nakedTastePacket = makePassingPacket();
  nakedTastePacket.owner_decision = "blocked_for_design";
  nakedTastePacket.review_items[0] = {
    ...nakedTastePacket.review_items[0],
    decision: "blocked_for_design",
    reason: "не нравится",
    ticket_id: "DESIGN-1",
    owner: "design.owner"
  };
  const nakedTasteReport = evaluateReviewPacket(nakedTastePacket);
  if (nakedTasteReport.status !== "fail" || !nakedTasteReport.failures.some((failure) => failure.includes("NAKED_TASTE"))) {
    throw new Error("G7 guardrail failed: naked taste blocker passed");
  }

  const failedTechPacket = makePassingPacket();
  failedTechPacket.technical_verdict_class = "FAIL";
  const failedTechReport = evaluateReviewPacket(failedTechPacket);
  if (failedTechReport.status !== "fail" || !failedTechReport.failures.includes("G7_TECHNICAL_PASS_PENDING_SIGNOFF_REQUIRED")) {
    throw new Error("G7 guardrail failed: review accepted failed technical gate");
  }
}

function writeReport(out, report) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--packet") parsed.packet = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
