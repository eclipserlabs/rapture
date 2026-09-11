// V3.2 Phase 3, part 2 — the ACTUAL V3.1 gate failure.
//
// The 16/20 two-class result is gone (see parse-server-diagnosis.json: 300/300
// exact, one class, across all three arms). But that diagnostic ran with the
// database reachable AT STARTUP. The primary V3.1 failure was different and is
// untouched by it: offline replay was 0/20 because parse-server performs
// Postgres schema work during BOOT, outside any request, where the frozen
// capture never looks.
//
// This measures whether that unsupported condition behaves DETERMINISTICALLY:
// it must fail closed every time and never emit a false pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SLOWBOOT = join(root, "large-app", "replay-raw-slowboot.mjs");
const APP = join(root, "large-app", "server.mjs");
const CAPTURE = join(root, "results", "large-app", "capture.json");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const RUNS = Number(arg("--runs", "20"));

// True offline: the connection string itself points at a dead port, because
// PGPORT has no effect on an application that connects via DATABASE_URI.
const OFFLINE_ENV = JSON.stringify({
  PARSE_ROOT: "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3-1/parse-server/buggy",
  DATABASE_URI: "postgres://wira@localhost:54399/parse_v31_buggy",
  APP_ID: "v31app", MASTER_KEY: "v31master", REPLAY_HOST: "127.0.0.1",
});
const expected = JSON.parse(readFileSync(CAPTURE, "utf8")).fingerprint?.fingerprint_hash ?? null;

let port = 49700;
const runs = [];
process.stdout.write("offline replays: ");
for (let i = 0; i < RUNS; i++) {
  port += 1;
  const r = spawnSync(process.execPath, [SLOWBOOT, "--app", APP, "--capture", CAPTURE, "--port", String(port), "--env", OFFLINE_ENV],
    { encoding: "utf8", timeout: 90000, env: { ...process.env, RAPTURE_REGISTER: join(root, "src", "capture", "register.mjs"),
      REPLAY_BOOT_TIMEOUT_MS: "45000", REPLAY_TOTAL_TIMEOUT_MS: "60000" } });
  const last = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  let j = null; try { j = JSON.parse(last); } catch { /* unparseable */ }
  const row = { pass: j?.pass === true, hash: j?.fingerprint?.fingerprint_hash ?? null,
                error: j?.error ? String(j.error).slice(0, 120) : (j ? null : "UNPARSEABLE"), ms: j?.ms ?? null };
  runs.push(row);
  process.stdout.write(row.pass ? "P" : ".");
}
console.log();
const classes = new Map();
for (const r of runs) {
  const k = r.pass ? `FALSE_PASS:${r.hash?.slice(0, 12)}` : `FAIL_CLOSED:${(r.error ?? "").split(";")[0].slice(0, 70)}`;
  classes.set(k, (classes.get(k) ?? 0) + 1);
}
const falsePasses = runs.filter((r) => r.pass).length;
const doc = {
  schema: "v3-2-parse-server-offline-1",
  generatedAt: new Date().toISOString(), runs: RUNS,
  expected_fingerprint: expected,
  question: "is the unsupported boot-time-dependency condition deterministic and fail-closed?",
  exact_replays: `${runs.filter((r) => r.pass && r.hash === expected).length}/${RUNS}`,
  false_passes: falsePasses,
  outcome_classes: [...classes.entries()].map(([k, n]) => ({ class: k, count: n })).sort((a, b) => b.count - a.count),
  outcome_class_count: classes.size,
  deterministic: classes.size === 1,
  fail_closed: falsePasses === 0,
  raw: runs,
};
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "parse-server-offline.json"), JSON.stringify(doc, null, 2));
console.log(`exact=${doc.exact_replays}  falsePasses=${falsePasses}  classes=${classes.size}  deterministic=${doc.deterministic}  failClosed=${doc.fail_closed}`);
for (const c of doc.outcome_classes) console.log(`  ${String(c.count).padStart(3)}x  ${c.class}`);
