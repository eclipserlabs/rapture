// Secret-leak audit: scan every persisted capture + artifact for raw secrets.
// Fails (exit 1) on any leak. Writes results/secret-audit.json.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const KNOWN_RAW = [
  "reproducer-test-secret", // fixture HMAC secret (documented test-only; must still never persist raw)
  "hunter2",
  "sk-live-0123456789abcdef",
];
const PATTERNS = [
  /"authorization"\s*:\s*"(?!\[REDACTED\])(Bearer|Basic|sk-)[^"]+"/gi,
  /"cookie"\s*:\s*"(?!\[REDACTED\])[^"]*session=[^"]*"/gi,
  /"x-api-key"\s*:\s*"(?!\[REDACTED\])[^"]+"/gi,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{8,}/,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/,
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "overhead-tmp") continue;
      walk(p, out);
    } else if (e.name.endsWith(".json") && !e.name.startsWith(".verify-")) {
      out.push(p);
    }
  }
  return out;
}

const files = [...walk(join(root, "results", "calibration")), ...walk(join(root, "results", "real-bugs"))];
const leaks = [];
let scanned = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  for (const raw of KNOWN_RAW) {
    if (text.includes(raw)) leaks.push({ file: f, kind: "known-raw", match: raw.slice(0, 12) });
  }
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) leaks.push({ file: f, kind: "pattern", match: String(m[0]).slice(0, 60) });
  }
}
// Fixture-secret exemption check: the jwt fixture secret must appear ONLY as a
// sha256 placeholder, never raw (already covered above — raw presence = leak).
const out = { scanned_files: scanned, leak_count: leaks.length, leaks, fixture_note: "reproducer-test-secret is test-only fixture data; raw presence counts as a leak" };
writeFileSync(join(root, "results", "secret-audit.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`scanned ${scanned} files, leaks: ${leaks.length}`);
for (const l of leaks) console.log("LEAK", l.file, l.kind, l.match);
process.exitCode = leaks.length ? 1 : 0;
