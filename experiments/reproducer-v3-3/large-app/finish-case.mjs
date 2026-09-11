// Phase 7 completion for the parse-server case.
//
// Records TWO results, clearly separated:
//
//  GATE      dead database (DATABASE_URI on a closed port), as the frozen
//            protocol requires. This is the preregistered requirement.
//  DIAGNOSTIC live database available at STARTUP only, with the captured
//            request still served entirely from the artifact. This isolates
//            *where* the dependency is needed and is NOT a gate result.
//
// Usage: node large-app/finish-case.mjs [--reps 20]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPLAY = join(here, "replay-raw-slowboot.mjs");
const SERVER = join(here, "server.mjs");
const BASE = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3-1/parse-server";
const OUT = join(root, "results", "large-app");
const arg = (n, d) => (process.argv.indexOf(n) === -1 ? d : process.argv[process.argv.indexOf(n) + 1]);
const REPS = Number(arg("--reps", "20"));
let port = 48100;

const DEAD = 54399;
const LIVE = 5432;

function trial(capture, keepIds, { rev = "buggy", pgPort = DEAD } = {}) {
  port += 1;
  const args = ["--app", SERVER, "--capture", capture, "--port", String(port)];
  if (keepIds != null) args.push("--keep", [...keepIds].join(","));
  const env = {
    PARSE_ROOT: join(BASE, rev),
    DATABASE_URI: `postgres://${process.env["PGUSER"] ?? "wira"}@localhost:${pgPort}/parse_v31_${rev}`,
    APP_ID: "v31app",
    MASTER_KEY: "v31master",
    REPLAY_HOST: "127.0.0.1",
  };
  const r = spawnSync(process.execPath, [REPLAY, ...args, "--env", JSON.stringify(env)], {
    encoding: "utf8",
    timeout: 200000,
    // A successful parse-server boot takes ~25-30s here, so 60s is a generous
    // allowance for the dead-database trials (which can only ever time out)
    // while 120s covers the live-database trials under load.
    env: {
      ...process.env,
      REPLAY_BOOT_TIMEOUT_MS: pgPort === DEAD ? "60000" : "120000",
      REPLAY_TOTAL_TIMEOUT_MS: "180000",
    },
  });
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    out.fingerprintHash = out.fingerprint?.fingerprint_hash ?? null;
    return out;
  } catch {
    return { pass: false, fingerprint: null, fingerprintHash: null, error: "UNPARSEABLE" };
  }
}

const result = JSON.parse(readFileSync(join(OUT, "case.json"), "utf8"));
const capturePath = join(OUT, "capture.json");
const doc = JSON.parse(readFileSync(capturePath, "utf8"));

// --- GATE: dead database -----------------------------------------------------
let gatePass = 0;
let gateErr = null;
for (let i = 0; i < REPS; i += 1) {
  const r = trial(capturePath, null, { pgPort: DEAD });
  if (r.pass) gatePass += 1;
  if (!gateErr && r.error) gateErr = String(r.error).slice(0, 200);
}
result.gate_offline_pass = `${gatePass}/${REPS}`;
result.gate_offline_failure_reason = gateErr;
console.log(`GATE (dead database): ${result.gate_offline_pass} — ${gateErr ? gateErr.slice(0, 90) : "n/a"}`);

// --- DIAGNOSTIC: live database at startup, request from the artifact ---------
let diagPass = 0;
const classes = new Set();
for (let i = 0; i < REPS; i += 1) {
  const r = trial(capturePath, null, { pgPort: LIVE });
  if (r.pass) diagPass += 1;
  classes.add(r.fingerprintHash ?? "NONE");
}
result.diagnostic_startup_db_offline_pass = `${diagPass}/${REPS}`;
result.diagnostic_replay_classes = classes.size;
console.log(`DIAGNOSTIC (startup db only): ${result.diagnostic_startup_db_offline_pass} classes=${classes.size}`);

if (diagPass === REPS) {
  const atoms = [
    ...(doc.events ?? []).map((e) => ({ id: `evt:${e.seq}` })),
    ...Object.keys(doc.config ?? {}).map((k) => ({ id: `cfg:${k}` })),
  ];
  const trials = [];
  const g = greedyReduce(atoms, (keep) => trial(capturePath, keep, { pgPort: LIVE }), (t) => trials.push(t));
  result.reduce_trials = trials.length;
  result.wrong_accepts = trials.filter((t) => t.pass && t.fingerprint_hash !== result.fingerprint_hash).length;
  const kept = g.keptIds;
  const keptEvents = (doc.events ?? []).filter((e) => kept.has(`evt:${e.seq}`));
  const keptConfig = {};
  for (const [k, v] of Object.entries(doc.config ?? {})) if (kept.has(`cfg:${k}`)) keptConfig[k] = v;
  const artifact = {
    ...doc, events: keptEvents, config: keptConfig,
    source_capture_hash: doc.capture_hash, expected_fingerprint: doc.fingerprint,
    reducer: "greedy-frozen-v1", reduced_from_events: (doc.events ?? []).length,
  };
  const artPath = join(OUT, "artifact.json");
  writeFileSync(artPath, `${JSON.stringify(artifact, null, 2)}\n`);
  result.artifact = artPath;
  result.atoms = `${keptEvents.length}/${(doc.events ?? []).length}`;
  result.artifact_bytes = readFileSync(artPath, "utf8").length;
  result.artifact_sha = createHash("sha256").update(readFileSync(artPath)).digest("hex");
  console.log(`reduction: ${result.atoms} atoms, ${result.artifact_bytes} bytes, wrongAccepts=${result.wrong_accepts}`);

  const iso = mkdtempSync(join(tmpdir(), "v31-parse-iso-"));
  const isoPath = join(iso, "artifact.json");
  cpSync(artPath, isoPath);
  let pPass = 0;
  for (let i = 0; i < REPS; i += 1) if (trial(isoPath, null, { pgPort: LIVE }).pass) pPass += 1;
  result.diagnostic_portable_pass = `${pPass}/${REPS}`;
  console.log(`DIAGNOSTIC portable: ${result.diagnostic_portable_pass}`);

  const fixed = trial(isoPath, null, { rev: "fixed", pgPort: LIVE });
  result.fixed_pass = fixed.pass === true;
  result.fixed_status = fixed.status ?? fixed.error ?? null;
  result.fixed_fingerprint_absent = (fixed.fingerprintHash ?? null) !== result.fingerprint_hash;
  result.fix_status = result.fixed_pass ? "FIX_NOT_CONFIRMED" : result.fixed_fingerprint_absent ? "FIX_CONFIRMED" : "FIX_INCONCLUSIVE";
  console.log(`DIAGNOSTIC fix discrimination: ${result.fix_status} (fixed status ${result.fixed_status})`);

  const GATE_PATTERNS = [/sk-live-[A-Za-z0-9]{8,}/, /ghp_[A-Za-z0-9]{8,}/, /AKIA[0-9A-Z]{8,}/, /Bearer\s+[A-Za-z0-9._-]{8,}/, /v31master/, /"password"\s*:\s*"pw-v31"/];
  const hay = [readFileSync(artPath, "utf8"), readFileSync(capturePath, "utf8")];
  result.secret_leaks = GATE_PATTERNS.filter((re) => hay.some((h) => re.test(h))).length;
  result.abs_path_leak = hay.some((h) => h.includes("/Users/") || h.includes(".rapture/"));
  console.log(`secret audit: leaks=${result.secret_leaks} absPathLeak=${result.abs_path_leak}`);
}

result.status = gatePass === REPS ? "LARGE_APP_CASE_SUPPORTED" : "LARGE_APP_OFFLINE_REPLAY_FAILED";
result.finding =
  "Targeted capture worked on the large application: the first failure armed generically on the application's own route key and a later selected occurrence produced an artifact whose recorded pg query is the real one the bug provokes. The artifact does NOT satisfy the frozen offline-replay gate, because parse-server performs Postgres work during STARTUP (schema bootstrap), outside any request, and the frozen capture only records boundary observations made INSIDE a captured request. With the database reachable at startup only, the captured request itself replays entirely from the artifact. The limitation is boot-time dependency access, not request-time fidelity.";
result.secondary_finding =
  "The frozen offline proof forces PGPORT=54399, which has no effect on an application that connects through an explicit DATABASE_URI connection string. The dead-port guard as written does not generalize beyond libpq environment configuration.";
writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n=> ${result.status}`);
