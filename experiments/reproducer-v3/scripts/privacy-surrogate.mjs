// Surrogate feasibility experiment (H3): can retained PII be replaced by
// equality-preserving deterministic surrogates without breaking exact replay?
// Takes the /db sentinel capture (PII email in query, pg rows, error text),
// maps every email to pii-<sha8>@redacted.invalid consistently across the
// whole document (recomputing pg replay keys with the frozen eventKey), then
// replays 20x offline expecting the ORIGINAL fingerprint. No capture-code
// changes: the app propagates inbound surrogates to its outbound calls, so
// live keying aligns with transformed stored keys by construction.
// Usage: node scripts/privacy-surrogate.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eventKey } from "../src/capture/events.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPLAY_ONE = join(root, "src", "replay", "replay-one.mjs");
const REPLAYS = 20;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function surrogate(email, map) {
  if (!map.has(email)) {
    map.set(email, `pii-${createHash("sha256").update(email).digest("hex").slice(0, 8)}@redacted.invalid`);
  }
  return map.get(email);
}

function replayOnce(app, captureFile, port) {
  const r = spawnSync(process.execPath, [REPLAY_ONE, "--app", app, "--capture", captureFile, "--port", String(port)], {
    encoding: "utf8",
    timeout: 90000,
  });
  if (r.status !== 0) return { ok: false, pass: false };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, pass: out.pass === true, hash: out.fingerprint?.fingerprint_hash ?? null };
  } catch {
    return { ok: false, pass: false };
  }
}

async function main() {
  const dir = join(root, "results", "privacy", "captures");
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, doc: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .find(({ doc }) => doc.fingerprint?.normalized_class === "ERR:E_PRIV_DB");
  if (!file) throw new Error("no /db capture found; run privacy-attack.mjs first");
  const { doc } = file;
  const rawBlob = JSON.stringify(doc);
  // PII may sit URL-encoded in query strings (%40 for @): collect from both
  // raw and decoded views so no form escapes the mapping.
  let decodedBlob = rawBlob;
  try {
    decodedBlob = decodeURIComponent(rawBlob);
  } catch {
    // keep raw view only
  }
  const emails = new Set([...(rawBlob.match(EMAIL_RE) ?? []), ...(decodedBlob.match(EMAIL_RE) ?? [])]);
  console.log(`found ${emails.size} distinct emails: ${[...emails].join(", ")}`);
  // Pre-populate the full mapping BEFORE transforming anything: the query
  // string (encoded form) may transform before any raw email is encountered.
  const map = new Map();
  for (const m of emails) surrogate(m, map);
  const T = (s) => {
    if (typeof s !== "string") return s;
    let out = s.replace(EMAIL_RE, (m) => surrogate(m, map));
    for (const [raw, sub] of map) {
      const enc = encodeURIComponent(raw);
      if (enc !== raw) out = out.split(enc).join(sub);
    }
    return out;
  };
  const deep = (v) => {
    if (typeof v === "string") return T(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v != null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  const tdoc = JSON.parse(JSON.stringify(doc));
  tdoc.request.query = T(tdoc.request.query);
  if (tdoc.request.body) tdoc.request.body = T(tdoc.request.body);
  // Response envelope code is unchanged, but its text carries PII: transform.
  if (typeof tdoc.response?.body === "string") tdoc.response.body = T(tdoc.response.body);
  for (const e of tdoc.events) {
    if (e.kind === "pg") {
      e.request = deep(e.request);
      e.result = deep(e.result);
      e.key = eventKey("pg", { text: e.request.text, values: e.request.values }, 0);
    } else if (e.kind === "http") {
      // Only key inputs (request url/body) constrain surrogacy; result
      // bodies are served verbatim and safe to transform.
      const keyInputs = JSON.stringify({ url: e.request?.url, body: e.request?.body });
      if (keyInputs.match(EMAIL_RE)) throw new Error(`http key inputs carry PII, cannot surrogate safely: evt ${e.seq}`);
      e.request = deep(e.request);
      e.result = deep(e.result);
    } else {
      e.request = deep(e.request);
      e.result = deep(e.result);
    }
  }
  const blob = JSON.stringify(tdoc);
  const leftover = [...emails].filter((m) => blob.includes(m));
  const outDir = join(root, "results", "privacy");
  mkdirSync(outDir, { recursive: true });
  const tfile = join(outDir, "surrogate-db.json");
  writeFileSync(tfile, JSON.stringify(tdoc, null, 2));
  const app = resolve(join(root, "privacy", "sentinel-app.mjs"));
  let passes = 0;
  let port = 47300;
  for (let i = 0; i < REPLAYS; i += 1) {
    port += 1;
    const r = replayOnce(app, tfile, port);
    if (r.ok && r.pass && r.hash === doc.fingerprint.fingerprint_hash) passes += 1;
  }
  const result = {
    source: file.f,
    emails: [...emails],
    surrogates: [...map.entries()].map(([k, v]) => `${k} -> ${v}`),
    raw_emails_remaining: leftover,
    replay: `${passes}/${REPLAYS}`,
    expected_hash: doc.fingerprint.fingerprint_hash,
    status: passes === REPLAYS && leftover.length === 0 ? "PASS" : "FAIL",
  };
  writeFileSync(join(outDir, "surrogate.json"), JSON.stringify(result, null, 2));
  console.log(`surrogate replay ${passes}/${REPLAYS}, leftover raws: ${leftover.length}, status=${result.status}`);
  if (result.status !== "PASS") process.exitCode = 1;
}

await main();
