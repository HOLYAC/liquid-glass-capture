import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256File } from "./lab-png.mjs";

export const traceHashMethods = Object.freeze(["sha256_file_v1", "sha256_tree_v1"]);

export function traceHashMethodForPath(path) {
  const stat = statSync(path);
  if (stat.isFile()) return "sha256_file_v1";
  if (stat.isDirectory()) return "sha256_tree_v1";
  throw new Error(`${path}: trace path must be a file or directory`);
}

export function sha256TracePath(path, method) {
  if (method === "sha256_file_v1") {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`${path}: sha256_file_v1 requires a file trace`);
    return sha256File(path);
  }
  if (method === "sha256_tree_v1") {
    const stat = statSync(path);
    if (!stat.isDirectory()) throw new Error(`${path}: sha256_tree_v1 requires a directory trace`);
    return sha256DirectoryTree(path);
  }
  throw new Error(`unknown trace hash method: ${method}`);
}

function sha256DirectoryTree(root) {
  const files = walkFiles(root)
    .map((absolute) => ({
      absolute,
      relative: relative(root, absolute).replace(/\\/g, "/")
    }))
    .sort((a, b) => a.relative.localeCompare(b.relative));

  const tree = createHash("sha256");
  tree.update("sha256_tree_v1\0");
  for (const file of files) {
    const bytes = readFileSync(file.absolute);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    tree.update(file.relative);
    tree.update("\0");
    tree.update(String(bytes.length));
    tree.update("\0");
    tree.update(fileHash);
    tree.update("\0");
  }
  return tree.digest("hex");
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}
