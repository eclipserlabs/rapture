// Stable canonicalization + hashing for reproducer-v0.
// Standalone (no kernel dependency): the experiment must stay decoupled from
// product primitives so the workspace build/typecheck surface is untouched.
import { createHash } from "node:crypto";

/** Deterministic JSON serialization: object keys sorted, no whitespace. */
export function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonicalizable");
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`value of type ${t} is not canonicalizable`);
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}

/** Byte size of the canonical serialization (the reduction metric). */
export function canonicalBytes(value) {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Returns true if the path existed and was deleted. */
export function deletePath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur === null || cur === undefined || typeof cur !== "object") return false;
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (cur !== null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, last)) {
    delete cur[last];
    return true;
  }
  return false;
}
