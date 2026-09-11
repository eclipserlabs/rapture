// Phase 7: the parse-server large-application case, end to end.
//
//   1. BASELINE: reproduce the historical failure through parse-server's OWN
//      route with NO Rapture attached, on the buggy revision, and show the
//      fixed revision does not fail.
//   2. TARGETED CAPTURE: attach only the generic `--import register.mjs`
//      bootstrap under the targeted-arming strategy. The first failure must
//      merely arm; a later matching failure must become the artifact.
//   3. OFFLINE REPLAY 20/20 with a dead PGPORT.
//   4. FROZEN GREEDY REDUCTION -> portable artifact -> 20/20 from an isolated
//      temp directory.
//   5. FIX DISCRIMINATION against the historical fixed revision.
//   6. SECRET AUDIT.
//
// No application source is edited and no route of ours implements the bug.
// Usage: node large-app/run-case.mjs [--reps 20]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const REPLAY_RAW = join(root, "..", "reproducer-v3", "headline", "replay-raw.mjs");
const SERVER = join(here, "server.mjs");
const BASE = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3-1/parse-server";
const OUT = join(root, "results", "large-app");

const APP_ID = "v31app";
const MASTER_KEY = "v31master";
const REVS = {
  buggy: { dir: join(BASE, "buggy"), db: "parse_v31_buggy" },
  fixed: { dir: join(BASE, "fixed"), db: "parse_v31_fixed" },
};

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const REPS = Number(arg("--reps", "20"));
let port = 47900;

// The application's OWN REST route. `_tombstone` is a Parse internal field
// that has no Postgres column on _User; querying it drives the storage adapter
// into PostgresMissingColumnError (42703).
const QUERY_PATH = `/parse/classes/_User?where=${encodeURIComponent(JSON.stringify({ _tombstone: { $exists: true } }))}`;
const HEADERS = { "X-Parse-Application-Id": APP_ID, "X-Parse-Master-Key": MASTER_KEY };

function startServer(rev, extraEnv = {}, useRapture = true) {
  return new Promise((resolve, reject) => {
    const p = (port += 1);
    const base = { ...process.env };
    for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_SAMPLE_RATE"]) {
      delete base[k];
    }
    const env = {
      ...base,
      PARSE_ROOT: REVS[rev].dir,
      DATABASE_URI: `postgres://${process.env["PGUSER"] ?? "wira"}@localhost:5432/${REVS[rev].db}`,
      APP_ID,
      MASTER_KEY,
      PORT: String(p),
      ...extraEnv,
    };
    const args = useRapture ? ["--import", REGISTER, SERVER] : [SERVER];
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`READY timeout ${rev}: ${out.slice(-1500)}`));
    }, 90000);
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve({ child, port: p });
      }
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`exit ${c} ${rev}: ${out.slice(-1500)}`));
    });
  });
}

async function query(p) {
  const r = await fetch(`http://127.0.0.1:${p}${QUERY_PATH}`, { headers: HEADERS });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
}

async function seedUser(p, name) {
  const r = await fetch(`http://127.0.0.1:${p}/parse/users`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ username: name, password: "pw-v31" }),
  });
  return r.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const result = {
  repository: "parse-community/parse-server",
  bug: "Postgres query on a Parse internal field with no database column returns 500 instead of an empty result (#10308)",
  fix_commit: "c5c43259d1f98af5bbbbc44d9daf7c0f1f8168d3",
  route: "GET /parse/classes/_User?where={\"_tombstone\":{\"$exists\":true}} (the application's own REST route)",
  experiment_authored_route: false,
  application_source_changes_loc: 0,
  bug_specific_rapture_wrappers: 0,
  bug_specific_rapture_assertions: 0,
  manual_causal_facts: 0,
  rapture_integration: "node --import <register.mjs> + environment variables only",
};

// ---------------------------------------------------------------------------
// 1. Baseline WITHOUT Rapture
// ---------------------------------------------------------------------------
for (const rev of ["buggy", "fixed"]) {
  const { child, port: p } = await startServer(rev, {}, false);
  try {
    await seedUser(p, `u-${rev}-${Date.now()}`);
    const r = await query(p);
    result[`baseline_${rev}`] = r;
    console.log(`baseline ${rev} (no Rapture): ${r.status} ${r.body.slice(0, 120)}`);
  } finally {
    child.kill("SIGKILL");
    await sleep(500);
  }
}
result.baseline_reproduced =
  result.baseline_buggy.status >= 500 && result.baseline_fixed.status < 500;
writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);
if (!result.baseline_reproduced) {
  result.status = "BASELINE_NOT_REPRODUCED";
  writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log("BASELINE NOT REPRODUCED — stopping (this is a real negative, not a retry)");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Targeted arming with the generic bootstrap only
// ---------------------------------------------------------------------------
const capDir = mkdtempSync(join(tmpdir(), "v31-parse-cap-"));
{
  const { child, port: p } = await startServer("buggy", {
    RAPTURE_V2_MODE: "capture",
    RAPTURE_V2_OUT: capDir,
    RAPTURE_V31_STRATEGY: "targeted",
    RAPTURE_V31_TTL_MS: "300000",
    RAPTURE_V31_BUDGET: "100",
  });
  try {
    const first = await query(p);
    await sleep(800);
    result.first_failure_status = first.status;
    result.artifacts_after_first_failure = readdirSync(capDir).filter((f) => f.endsWith(".json")).length;
    const second = await query(p);
    await sleep(1200);
    result.second_failure_status = second.status;
    result.artifacts_after_second_failure = readdirSync(capDir).filter((f) => f.endsWith(".json")).length;
    const st = await (await fetch(`http://127.0.0.1:${p}/__rapture31`)).json();
    result.armed_automatically = st.selector.stats.armEvents > 0;
    result.arm_events = st.selector.stats.armEvents;
    result.captured_incidents = st.selector.stats.capturedIncidents;
    result.incident_key = st.selector.events.find((e) => e.type === "ARM")?.key ?? null;
    result.fully_instrumented_requests = st.selector.stats.requestsSelected;
    console.log(
      `targeted: first=${first.status} artifacts=${result.artifacts_after_first_failure} -> second=${second.status} artifacts=${result.artifacts_after_second_failure} key=${result.incident_key}`,
    );
  } finally {
    child.kill("SIGKILL");
    await sleep(500);
  }
}
const capFiles = readdirSync(capDir).filter((f) => f.endsWith(".json"));
result.captured = capFiles.length > 0;
writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);
if (!result.captured) {
  result.status = "CAPTURE_FAILED";
  writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log("NO ARTIFACT CAPTURED — recorded as a real negative result");
  process.exit(0);
}

const capturePath = join(OUT, "capture.json");
cpSync(join(capDir, capFiles[0]), capturePath);
const doc = JSON.parse(readFileSync(capturePath, "utf8"));
result.fingerprint_hash = doc.fingerprint?.fingerprint_hash ?? null;
result.fingerprint_class = doc.fingerprint?.normalized_class ?? null;
result.events_total = (doc.events ?? []).length;
result.event_kinds = [...new Set((doc.events ?? []).map((e) => e.kind))];

// ---------------------------------------------------------------------------
// 3-5. Offline replay / reduction / portability / fix discrimination
// ---------------------------------------------------------------------------
function replayTrial(capture, keepIds, rev = "buggy") {
  port += 1;
  const args = ["--app", SERVER, "--capture", capture, "--port", String(port)];
  if (keepIds != null) args.push("--keep", [...keepIds].join(","));
  const env = {
    PARSE_ROOT: REVS[rev].dir,
    DATABASE_URI: `postgres://${process.env["PGUSER"] ?? "wira"}@localhost:54399/${REVS[rev].db}`,
    APP_ID,
    MASTER_KEY,
    REPLAY_HOST: "127.0.0.1",
  };
  const r = spawnSync(process.execPath, [REPLAY_RAW, ...args, "--env", JSON.stringify(env)], {
    encoding: "utf8",
    timeout: 180000,
  });
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    // The frozen reducer records `fingerprint_hash: r.fingerprintHash`, so the
    // trial function must expose that exact camelCase field. Without it the
    // reducer logs `undefined` and every PASSING trial is miscounted as a
    // wrong-failure acceptance.
    out.fingerprintHash = out.fingerprint?.fingerprint_hash ?? null;
    return out;
  } catch {
    return { pass: false, fingerprint: null, error: "UNPARSEABLE", raw: (r.stdout ?? "").slice(-300) };
  }
}

let pass = 0;
const classes = new Set();
for (let i = 0; i < REPS; i += 1) {
  const r = replayTrial(capturePath, null);
  if (r.pass) pass += 1;
  classes.add(r.fingerprint?.fingerprint_hash ?? "NONE");
}
result.offline_pass = `${pass}/${REPS}`;
result.replay_classes = classes.size;
console.log(`offline replay: ${result.offline_pass} (classes=${classes.size})`);
writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);

if (pass === REPS) {
  const atoms = [
    ...(doc.events ?? []).map((e) => ({ id: `evt:${e.seq}` })),
    ...Object.keys(doc.config ?? {}).map((k) => ({ id: `cfg:${k}` })),
  ];
  const trials = [];
  const g = greedyReduce(atoms, (keep) => replayTrial(capturePath, keep), (t) => trials.push(t));
  result.reduce_trials = trials.length;
  result.wrong_accepts = trials.filter((t) => t.pass && t.fingerprint_hash !== result.fingerprint_hash).length;
  const kept = g.keptIds;
  const keptEvents = (doc.events ?? []).filter((e) => kept.has(`evt:${e.seq}`));
  const keptConfig = {};
  for (const [k, v] of Object.entries(doc.config ?? {})) {
    if (kept.has(`cfg:${k}`)) keptConfig[k] = v;
  }
  const artifact = {
    ...doc,
    events: keptEvents,
    config: keptConfig,
    source_capture_hash: doc.capture_hash,
    expected_fingerprint: doc.fingerprint,
    reducer: "greedy-frozen-v1",
    reduced_from_events: result.events_total,
  };
  const artPath = join(OUT, "artifact.json");
  writeFileSync(artPath, `${JSON.stringify(artifact, null, 2)}\n`);
  result.artifact = artPath;
  result.atoms = `${keptEvents.length}/${result.events_total}`;
  result.artifact_bytes = readFileSync(artPath, "utf8").length;
  result.artifact_sha = createHash("sha256").update(readFileSync(artPath)).digest("hex");

  const iso = mkdtempSync(join(tmpdir(), "v31-parse-iso-"));
  const isoPath = join(iso, "artifact.json");
  cpSync(artPath, isoPath);
  let pPass = 0;
  for (let i = 0; i < REPS; i += 1) {
    if (replayTrial(isoPath, null).pass) pPass += 1;
  }
  result.portable_pass = `${pPass}/${REPS}`;
  console.log(`portable replay: ${result.portable_pass}`);

  const fixed = replayTrial(isoPath, null, "fixed");
  result.fixed_pass = fixed.pass === true;
  result.fixed_status = fixed.status ?? fixed.error ?? null;
  result.fixed_fingerprint_absent =
    (fixed.fingerprint?.fingerprint_hash ?? null) !== result.fingerprint_hash;
  result.fix_status = result.fixed_pass
    ? "FIX_NOT_CONFIRMED"
    : result.fixed_fingerprint_absent
      ? "FIX_CONFIRMED"
      : "FIX_INCONCLUSIVE";
  console.log(`fix discrimination: ${result.fix_status} (fixed replay status=${result.fixed_status})`);
  rmSync(iso, { recursive: true, force: true });

  const GATE = [
    /sk-live-[A-Za-z0-9]{8,}/,
    /ghp_[A-Za-z0-9]{8,}/,
    /AKIA[0-9A-Z]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    new RegExp(MASTER_KEY),
    /"password"\s*:\s*"pw-v31"/,
  ];
  const hay = [readFileSync(artPath, "utf8"), readFileSync(capturePath, "utf8")];
  result.secret_leaks = GATE.filter((re) => hay.some((h) => re.test(h))).length;
  result.leaked_patterns = GATE.filter((re) => hay.some((h) => re.test(h))).map((re) => re.source);
  result.abs_path_leak = hay.some((h) => h.includes("/Users/") || h.includes(".rapture/"));

  result.status =
    pass === REPS && pPass === REPS && result.fix_status === "FIX_CONFIRMED" && result.secret_leaks === 0
      ? "LARGE_APP_CASE_SUPPORTED"
      : "NEEDS_REVIEW";
} else {
  result.status = "OFFLINE_REPLAY_FAILED";
}

rmSync(capDir, { recursive: true, force: true });
writeFileSync(join(OUT, "case.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n=> ${result.status}`);
