import { createHash } from "node:crypto";

export const canonicalArtifactHashMethod = "canonical_json_zeroed_integrity_v1";
export const zeroArtifactSha256 = "0".repeat(64);

export function finalizeCaptureArtifactIntegrity(artifact) {
  artifact.integrity = {
    ...(artifact.integrity ?? {}),
    artifact_hash_method: canonicalArtifactHashMethod,
    artifact_sha256: zeroArtifactSha256
  };
  artifact.integrity.artifact_sha256 = captureArtifactSha256(artifact);
  return artifact;
}

export function captureArtifactSha256(artifact) {
  return sha256Hex(stableStringify(canonicalArtifactPayload(artifact)));
}

export function validateCaptureArtifactIntegrity(artifact) {
  const failures = [];
  const integrity = artifact?.integrity;
  if (!integrity || typeof integrity !== "object") {
    return ["INTEGRITY_MISSING"];
  }
  if (!isSha256Hex(integrity.artifact_sha256)) {
    failures.push("INTEGRITY_ARTIFACT_SHA256_NOT_HEX");
  }
  if (integrity.artifact_hash_method === undefined) return failures;
  if (integrity.artifact_hash_method !== canonicalArtifactHashMethod) {
    failures.push(`INTEGRITY_ARTIFACT_HASH_METHOD_UNKNOWN:${integrity.artifact_hash_method}`);
    return failures;
  }
  if (isSha256Hex(integrity.artifact_sha256)) {
    const expected = captureArtifactSha256(artifact);
    if (integrity.artifact_sha256.toLowerCase() !== expected) {
      failures.push("INTEGRITY_ARTIFACT_SHA256_MISMATCH");
    }
  }
  return failures;
}

export function isSha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function canonicalArtifactPayload(artifact) {
  return {
    ...artifact,
    integrity: {
      ...(artifact.integrity ?? {}),
      artifact_hash_method: canonicalArtifactHashMethod,
      artifact_sha256: zeroArtifactSha256
    }
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) =>
      `${JSON.stringify(key)}:${stableStringify(entryValue)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}
