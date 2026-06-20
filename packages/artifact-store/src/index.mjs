import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

export const retentionPolicy = Object.freeze({
  schema_version: "1.2.0",
  classes: Object.freeze({
    raw_png_frame: { retain_days: 90, description: "Raw PNG frame" },
    raw_frame_sequence: { retain_days: 90, description: "Raw frame sequence member" },
    normalized_buffer: { retain_days: 365, description: "Color-normalized working buffer" },
    metric_json: { retain_days: 365, description: "Metric JSON report" },
    verdict_report: { retain_days: 365, description: "G8 verdict report" },
    power_trace: { retain_days: 180, description: "Instruments/MetricKit/power trace" },
    baseline: { retain_days: null, description: "Immutable baseline namespace" },
    g7_review_artifact: { retain_days: 365, description: "G7 review artifact retained with verdict report" },
    failed_pr_artifact: { retain_days: 365, description: "Failed PR evidence" },
    release_candidate_artifact: { retain_days: null, description: "Release-candidate evidence" }
  }),
  hash_manifest_immutable: true,
  deletion_never_removes_hash_manifest: true
});

export function writeArtifactStore({ files, storeRoot, retentionClass, generatedAt = new Date().toISOString() }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("artifact store requires at least one file");
  }
  const policy = retentionPolicy.classes[retentionClass];
  if (!policy) throw new Error(`unknown retention class: ${retentionClass}`);

  const root = resolve(storeRoot);
  const blobsRoot = join(root, "blobs");
  const manifestPath = join(root, "hash-manifest.jsonl");
  mkdirSync(blobsRoot, { recursive: true });

  const existingIndex = readIndexIfPresent(join(root, "index.json"));
  const entries = [...existingIndex.entries];
  const processedEntries = [];
  const addedEntries = [];

  for (const rawFile of files) {
    const sourcePath = resolve(rawFile);
    const stat = statSync(sourcePath);
    if (!stat.isFile()) throw new Error(`${sourcePath}: artifact store only writes files`);

    const sha256 = sha256File(sourcePath);
    const extension = safeExtension(sourcePath);
    const blobPath = join(blobsRoot, retentionClass, sha256.slice(0, 2), `${sha256}${extension}`);
    mkdirSync(dirname(blobPath), { recursive: true });
    if (!existsSync(blobPath)) copyFileSync(sourcePath, blobPath);

    const logicalId = logicalIdForFile(sourcePath);
    enforceImmutableLogicalBinding(entries, retentionClass, logicalId, sha256);
    const existingEntry = entries.find((entry) =>
      entry.retention_class === retentionClass &&
      entry.logical_id === logicalId &&
      entry.sha256 === sha256
    );
    if (existingEntry) {
      processedEntries.push({
        ...existingEntry,
        already_indexed: true
      });
      continue;
    }

    const entry = {
      schema_version: "1.2.0",
      kind: "artifact_store_entry",
      artifact_store_id: `${retentionClass}:${sha256}`,
      logical_id: logicalId,
      retention_class: retentionClass,
      retention_days: policy.retain_days,
      sha256,
      size_bytes: stat.size,
      source_path: sourcePath,
      blob_path: blobPath,
      blob_path_relative: relative(root, blobPath).replaceAll("\\", "/"),
      first_seen_at: generatedAt,
      expires_at: expiresAt(generatedAt, policy.retain_days),
      immutable_hash_manifest: true
    };
    entries.push(entry);
    addedEntries.push(entry);
    processedEntries.push(entry);
    appendFileSync(manifestPath, `${JSON.stringify(entry)}\n`);
  }

  const index = {
    schema_version: "1.2.0",
    kind: "artifact_store_index",
    generated_at: generatedAt,
    store_root: root,
    entry_count: entries.length,
    entries,
    immutability: {
      hash_manifest_path: manifestPath,
      hash_manifest_sha256: sha256File(manifestPath),
      artifact_hashes_are_immutable: true,
      deletion_never_removes_hash_manifest: true
    },
    retention_policy: retentionPolicy
  };
  writeJson(join(root, "index.json"), index);

  return {
    schema_version: "1.2.0",
    kind: "artifact_store_write_report",
    status: "pass",
    generated_at: generatedAt,
    store_root: root,
    index_path: join(root, "index.json"),
    hash_manifest_path: manifestPath,
    requested_count: files.length,
    written_count: addedEntries.length,
    existing_count: processedEntries.length - addedEntries.length,
    entries: processedEntries,
    retention_policy: retentionPolicy
  };
}

export function verifyArtifactStoreIndex(index) {
  const failures = [];
  if (index.schema_version !== "1.2.0") failures.push("ARTIFACT_STORE_SCHEMA_VERSION_NOT_1_2_0");
  if (index.kind !== "artifact_store_index") failures.push("ARTIFACT_STORE_INDEX_KIND_INVALID");
  if (!Array.isArray(index.entries)) failures.push("ARTIFACT_STORE_INDEX_ENTRIES_REQUIRED");

  const manifestPath = index.immutability?.hash_manifest_path;
  if (!manifestPath || !existsSync(manifestPath)) {
    failures.push("ARTIFACT_STORE_HASH_MANIFEST_MISSING");
  }

  const manifestLines = manifestPath && existsSync(manifestPath)
    ? readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
  const manifestIds = new Set(manifestLines.map((line) => {
    try {
      const entry = JSON.parse(line);
      return `${entry.retention_class}:${entry.sha256}:${entry.logical_id}`;
    } catch {
      failures.push("ARTIFACT_STORE_HASH_MANIFEST_LINE_INVALID");
      return "";
    }
  }));

  for (const entry of index.entries ?? []) {
    if (entry.kind !== "artifact_store_entry") failures.push(`${entry.logical_id}:ARTIFACT_STORE_ENTRY_KIND_INVALID`);
    if (!retentionPolicy.classes[entry.retention_class]) failures.push(`${entry.logical_id}:ARTIFACT_STORE_RETENTION_CLASS_INVALID`);
    if (!entry.immutable_hash_manifest) failures.push(`${entry.logical_id}:ARTIFACT_STORE_ENTRY_NOT_IMMUTABLE`);
    if (!entry.blob_path || !existsSync(entry.blob_path)) {
      failures.push(`${entry.logical_id}:ARTIFACT_STORE_BLOB_MISSING`);
    } else {
      const actual = sha256File(entry.blob_path);
      if (actual !== entry.sha256) failures.push(`${entry.logical_id}:ARTIFACT_STORE_BLOB_HASH_MISMATCH`);
    }
    const manifestId = `${entry.retention_class}:${entry.sha256}:${entry.logical_id}`;
    if (!manifestIds.has(manifestId)) failures.push(`${entry.logical_id}:ARTIFACT_STORE_HASH_MANIFEST_ENTRY_MISSING`);
  }

  return {
    schema_version: "1.2.0",
    kind: "artifact_store_verify_report",
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    entry_count: index.entries?.length ?? 0,
    hash_manifest_path: manifestPath ?? null,
    retention_policy: retentionPolicy
  };
}

export function buildRetentionPlan({ index, now = new Date().toISOString() }) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid retention plan timestamp: ${now}`);

  const deleteCandidates = [];
  const retained = [];
  for (const entry of index.entries ?? []) {
    if (!entry.expires_at) {
      retained.push({ ...entry, retention_decision: "retain_indefinitely" });
      continue;
    }
    const expiresMs = Date.parse(entry.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      deleteCandidates.push({
        ...entry,
        retention_decision: "delete_blob_keep_hash_manifest",
        tombstone: {
          schema_version: "1.2.0",
          kind: "artifact_store_tombstone",
          artifact_store_id: entry.artifact_store_id,
          logical_id: entry.logical_id,
          sha256: entry.sha256,
          retention_class: entry.retention_class,
          planned_at: now,
          reason: "retention_expired",
          hash_manifest_preserved: true
        }
      });
    } else {
      retained.push({ ...entry, retention_decision: "retain_until_expiry" });
    }
  }

  return {
    schema_version: "1.2.0",
    kind: "artifact_store_retention_plan",
    status: "pass",
    generated_at: now,
    store_root: index.store_root,
    delete_candidate_count: deleteCandidates.length,
    retained_count: retained.length,
    delete_candidates: deleteCandidates,
    retained,
    invariant: {
      deletion_never_removes_hash_manifest: true,
      this_command_does_not_delete_blobs: true
    }
  };
}

export function retentionSummaryForHash(index, sha256) {
  const entry = (index.entries ?? []).find((candidate) => candidate.sha256 === sha256);
  if (!entry) {
    return {
      status: "not_indexed",
      sha256
    };
  }
  return {
    status: "indexed",
    class: entry.retention_class,
    retention_days: entry.retention_days,
    expires_at: entry.expires_at,
    artifact_store_id: entry.artifact_store_id,
    blob_path: entry.blob_path,
    hash_manifest_preserved: true
  };
}

export function readArtifactStoreIndex(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function readIndexIfPresent(indexPath) {
  if (!existsSync(indexPath)) {
    return {
      entries: []
    };
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  return {
    entries: Array.isArray(index.entries) ? index.entries : []
  };
}

function enforceImmutableLogicalBinding(entries, retentionClass, logicalId, sha256) {
  if (retentionClass !== "baseline" && retentionClass !== "release_candidate_artifact") return;
  const prior = entries.find((entry) => entry.retention_class === retentionClass && entry.logical_id === logicalId);
  if (prior && prior.sha256 !== sha256) {
    throw new Error(`${logicalId}: ${retentionClass} logical id already bound to immutable hash ${prior.sha256}`);
  }
}

function logicalIdForFile(path) {
  try {
    if (extname(path).toLowerCase() === ".json") {
      const json = JSON.parse(readFileSync(path, "utf8"));
      if (typeof json.id === "string" && json.id.length > 0) return json.id;
      if (typeof json.baseline_namespace === "string" && json.baseline_namespace.length > 0) return json.baseline_namespace;
      if (typeof json.kind === "string" && typeof json.generated_at === "string") return `${json.kind}:${json.generated_at}`;
    }
  } catch {
    // Fall back to the filename; validation remains a separate gate.
  }
  return basename(path);
}

function expiresAt(generatedAt, days) {
  if (days === null) return null;
  const start = Date.parse(generatedAt);
  if (!Number.isFinite(start)) throw new Error(`invalid generated_at: ${generatedAt}`);
  return new Date(start + days * 24 * 60 * 60 * 1000).toISOString();
}

function safeExtension(path) {
  const extension = extname(path).toLowerCase();
  return extension && extension.length <= 12 ? extension : ".bin";
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
