const requiredArtifactRoles = ["R0", "R1", "C1", "DOM_C"];
const validMaskIds = new Set([
  "core",
  "edge_band",
  "highlight",
  "text",
  "text_halo",
  "background_control",
  "motion_path",
  "compositor_region",
  "product_focus"
]);
const validConcernCategories = new Set([
  "premium_perception",
  "material_hierarchy",
  "surface_consistency",
  "readability",
  "interaction_clarity",
  "edge_case_acceptability"
]);
const validDecisions = new Set([
  "pass",
  "non_blocking_concern",
  "blocked_for_design",
  "legibility_block"
]);
const nakedTastePattern = /^(looks off|does not feel right|bad|ugly|meh|не нравится|не заходит|хуйня)$/i;

export function evaluateReviewPacket(packet, options = {}) {
  const failures = [];
  if (packet.schema_version !== "1.2.0") failures.push("G7_SCHEMA_VERSION_NOT_1_2_0");
  if (packet.kind !== "g7_review_packet") failures.push("G7_PACKET_KIND_INVALID");
  if (packet.technical_verdict_class !== "TECH_PASS_PENDING_SIGNOFF") {
    failures.push("G7_TECHNICAL_PASS_PENDING_SIGNOFF_REQUIRED");
  }
  if (!nonEmptyString(packet.design_reviewer)) failures.push("G7_DESIGN_REVIEWER_REQUIRED");
  if (!nonEmptyString(packet.product_reviewer)) failures.push("G7_PRODUCT_REVIEWER_REQUIRED");

  const artifactRoles = new Set((packet.artifacts ?? []).map((artifact) => artifact.role));
  for (const role of requiredArtifactRoles) {
    if (!artifactRoles.has(role)) failures.push(`G7_REVIEW_PACKET_MISSING_${role}`);
  }

  if (!Array.isArray(packet.review_items) || packet.review_items.length === 0) {
    failures.push("G7_REVIEW_ITEMS_REQUIRED");
  }

  const itemDecisions = [];
  for (const [index, item] of (packet.review_items ?? []).entries()) {
    validateReviewItem(failures, item, index, packet.artifacts ?? []);
    if (validDecisions.has(item?.decision)) itemDecisions.push(item.decision);
  }

  const designClass = designClassFromDecisions(itemDecisions);
  const ownerDecision = packet.owner_decision ?? "";
  if (ownerDecision !== ownerDecisionForDesignClass(designClass)) {
    failures.push("G7_OWNER_DECISION_MISMATCH");
  }

  return {
    schema_version: "1.2.0",
    kind: "g7_review_report",
    gate: "G7",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    design_class: failures.length === 0 ? designClass : "INVALID",
    verdict_class: failures.length === 0 ? verdictClassFromDesignClass(designClass) : "FAIL",
    reviewer_contract: {
      design_reviewer: packet.design_reviewer ?? null,
      product_reviewer: packet.product_reviewer ?? null,
      no_naked_taste_verdict: true,
      required_artifact_roles: requiredArtifactRoles
    },
    review_packet_id: packet.id ?? null,
    artifact_count: Array.isArray(packet.artifacts) ? packet.artifacts.length : 0,
    item_count: Array.isArray(packet.review_items) ? packet.review_items.length : 0,
    blocking_items: (packet.review_items ?? []).filter((item) =>
      item.decision === "blocked_for_design" || item.decision === "legibility_block"
    )
  };
}

export function makeReviewPacketSeed({ reference, candidate, gateReports = [] }) {
  const artifacts = [
    artifactRef("R0", reference),
    artifactRef("R1", reference),
    artifactRef(candidate?.rig_id === "DOM_C" ? "DOM_C" : "C1", candidate),
    artifactRef(candidate?.rig_id === "DOM_C" ? "C1" : "DOM_C", candidate)
  ];

  return {
    schema_version: "1.2.0",
    kind: "g7_review_packet",
    id: `g7-review-seed-${candidate?.id ?? "candidate"}`,
    technical_verdict_class: "TECH_PASS_PENDING_SIGNOFF",
    design_reviewer: "",
    product_reviewer: "",
    owner_decision: "prod_pass",
    artifacts,
    metrics_summary: Object.fromEntries(gateReports.map((report) => [report.gate ?? report.kind, report.status])),
    review_items: [
      {
        scene_id: candidate?.scene_id ?? reference?.scene_id ?? "S01_SEARCH",
        state_id: candidate?.state_id ?? reference?.state_id ?? "rest",
        mask_id: "product_focus",
        artifact_role: artifacts[2]?.role ?? "C1",
        artifact_id: candidate?.id ?? "",
        artifact_path: "",
        media_kind: "screenshot",
        reviewer_category: "design",
        concern_category: "premium_perception",
        decision: "pass",
        reason: ""
      }
    ]
  };
}

function validateReviewItem(failures, item, index, artifacts) {
  const prefix = `G7_ITEM_${index}`;
  if (!item || typeof item !== "object") {
    failures.push(`${prefix}_INVALID`);
    return;
  }

  for (const key of ["scene_id", "state_id", "artifact_id", "artifact_path"]) {
    if (!nonEmptyString(item[key])) failures.push(`${prefix}_${key.toUpperCase()}_REQUIRED`);
  }
  if (!validMaskIds.has(item.mask_id)) failures.push(`${prefix}_MASK_ID_INVALID`);
  if (!["screenshot", "frame_sequence"].includes(item.media_kind)) failures.push(`${prefix}_MEDIA_KIND_INVALID`);
  if (!["design", "product"].includes(item.reviewer_category)) failures.push(`${prefix}_REVIEWER_CATEGORY_INVALID`);
  if (!validConcernCategories.has(item.concern_category)) failures.push(`${prefix}_CONCERN_CATEGORY_INVALID`);
  if (!validDecisions.has(item.decision)) failures.push(`${prefix}_DECISION_INVALID`);
  if (!artifacts.some((artifact) => artifact.role === item.artifact_role && artifact.id === item.artifact_id)) {
    failures.push(`${prefix}_ARTIFACT_POINTER_NOT_IN_PACKET`);
  }

  if (item.decision !== "pass") {
    if (!nonEmptyString(item.reason) || item.reason.trim().length < 8) failures.push(`${prefix}_REASON_REQUIRED`);
    if (nakedTastePattern.test(String(item.reason ?? "").trim())) failures.push(`${prefix}_NAKED_TASTE_REASON`);
  }
  if (item.decision === "blocked_for_design" || item.decision === "legibility_block") {
    if (!nonEmptyString(item.ticket_id)) failures.push(`${prefix}_BLOCK_TICKET_REQUIRED`);
    if (!nonEmptyString(item.owner)) failures.push(`${prefix}_BLOCK_OWNER_REQUIRED`);
  }
}

function artifactRef(role, artifact) {
  return {
    role,
    id: artifact?.id ?? "",
    rig_id: artifact?.rig_id ?? role,
    scene_id: artifact?.scene_id ?? "",
    state_id: artifact?.state_id ?? "",
    png_sha256: artifact?.png_sha256 ?? artifact?.frame_pack?.base_png_sha256 ?? ""
  };
}

function designClassFromDecisions(decisions) {
  if (decisions.includes("legibility_block")) return "LEGIBILITY_BLOCK";
  if (decisions.includes("blocked_for_design")) return "BLOCKED_FOR_DESIGN";
  if (decisions.includes("non_blocking_concern")) return "PASS_WITH_REVIEW";
  return "PASS";
}

function ownerDecisionForDesignClass(designClass) {
  return {
    PASS: "prod_pass",
    PASS_WITH_REVIEW: "pass_with_review",
    BLOCKED_FOR_DESIGN: "blocked_for_design",
    LEGIBILITY_BLOCK: "legibility_block"
  }[designClass] ?? "fail";
}

function verdictClassFromDesignClass(designClass) {
  return {
    PASS: "PROD_PASS",
    PASS_WITH_REVIEW: "PASS_WITH_REVIEW",
    BLOCKED_FOR_DESIGN: "BLOCKED_FOR_DESIGN",
    LEGIBILITY_BLOCK: "LEGIBILITY_BLOCK"
  }[designClass] ?? "FAIL";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
