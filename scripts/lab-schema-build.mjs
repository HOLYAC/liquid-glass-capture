#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256File } from "./lib/lab-png.mjs";

const schemaPath = resolve("packages/capture-schema/capture-artifact.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const required = [
  "schema_version",
  "id",
  "rig_id",
  "scene_id",
  "state_id",
  "git_commit",
  "capture_kind",
  "device_info",
  "environment",
  "color",
  "frame_pack",
  "integrity"
];

const missing = required.filter((key) => !schema.required?.includes(key));
if (schema.properties?.schema_version?.const !== "1.2.0") {
  throw new Error("schema_version const must be 1.2.0");
}
if (missing.length > 0) {
  throw new Error(`schema missing required keys: ${missing.join(", ")}`);
}

console.log(`schema=1.2.0 sha256=${sha256File(schemaPath)}`);

