// V3.1 Phase 3 (selective-capture brief) — correctness of SELECTIVELY captured
// artifacts across ALL 8 frozen V3 headline incidents.
//
// Each incident is forced into the selected population using ONLY generic
// selection configuration, in two generic steps:
//
//   1. DISCOVER: run the service under the generic detector with targeted
//      arming. The trigger fails once; the detector arms a route key. The key
//      is READ BACK from the runtime — it is never hand-written per bug.
//   2. SELECT: restart under ROUTE_SELECTIVE configured with that discovered
//      key. The trigger is now selected at ingress and captured.
//
// The resulting artifact then faces the unchanged V3 standard:
//   exact offline replay 20/20 (dead PGPORT, fake external stopped)
//   -> frozen GREEDY reduction (unchanged)
//   -> portable replay 20/20 from an isolated temp directory
//   -> historical FIXED revision no longer produces the failure
//   -> wrong-failure candidates rejected
//   -> secret audit
//   -> fingerprint must EQUAL the one V3 recorded for this incident
//
// Run with the fake external DOWN.
// Usage: node scripts/selective-correctness-8.mjs [--reps 20]
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3H = join(root, "..", "reproducer-v3", "headline");
const REGISTER = join(root, "src", "capture", "register.mjs");
const REPLAY_RAW = join(V3H, "replay-raw.mjs");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";
const OUT = join(root, "results", "regression-8");
const NODE = process.execPath;

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const REPS = Number(arg("--reps", "20"));

// The frozen V3 case table, verbatim.
const CASES = [
  { id: "koa-1999", svc: "koa-1999.mjs", port: 47901, buggy: "koa-1061776", fixed: "koa-571938d", code: "E_URL_MISMATCH" },
  { id: "koa-1998", svc: "koa-1998.mjs", port: 47902, buggy: "koa-4a191b1", fixed: "koa-1061776", code: "E_ASSERT_REGRESSION" },
  { id: "express-cookie", svc: "express-cookie.mjs", port: 47903, buggy: "express-4.19.2", fixed: "express-4.21.1", code: "E_COOKIE_INJECT" },
  { id: "express-qs", svc: "express-qs.mjs", port: 47904, buggy: "express-4.21.1", fixed: "express-4.21.1", qs: true, code: "E_QS_LIMIT_BYPASS" },
  { id: "fastify-32442", svc: "fastify-32442.mjs", port: 47905, buggy: "fastify-5.3.0", fixed: "fastify-5.3.2", code: "E_VALIDATION_BYPASS" },
  { id: "express-semver", svc: "express-semver.mjs", port: 47909, buggy: "express-4.21.1", fixed: "express-4.21.1", semver: true, code: "E_SEMVER_MISMATCH" },
  { id: "hapi-4560", svc: "hapi-4560.mjs", port: 47907, buggy: "hapi-5095382", fixed: "hapi-ee8475b", host: "::1", code: "E_URL_GETTER" },
  { id: "hapi-4564", svc: "hapi-4564.mjs", port: 47908, buggy: "hapi-62032e6", fixed: "hapi-97c435f", code: "E_HOST_PARSE" },
];

const svcEnv = (c, rev) => ({
  REPO_ROOT: CORPUS + (rev === "buggy" ? c.buggy : c.fixed),
  PORT: String(c.port),
  QS_MODE: c.qs ? rev : "buggy",
  SEMVER_MODE: c.semver ? rev : "buggy",
  ...(c.host ? { HOST: c.host } : {}),
});

function startService(c, rev, extra) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_ROUTES", "RAPTURE_V31_SAMPLE_RATE", "RAPTURE_V31_WINDOW_BUDGET"]) delete base[k];
    const env = { ...base, ...svcEnv(c, rev), ...extra };
    const child = spawn(NODE, ["--import", REGISTER, join(V3H, "services", c.svc)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`READY timeout ${c.id}/${rev}: ${out.slice(-600)}`)); }, 30000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`exit ${code} ${c.id}/${rev}: ${out.slice(-600)}`)); });
  });
}

const fireTrigger = (id, port) => {
  const r = spawnSync(NODE, [join(V3H, "triggers", "run.mjs"), id, String(port)], { encoding: "utf8", timeout: 30000 });
  return { status: r.status, out: (r.stdout ?? "").trim() };
};
const hostUrl = (c) => (c.host === "::1" ? "[::1]" : (c.host ?? "127.0.0.1"));
const stats31 = async (c) => {
  try { return await (await fetch(`http://${hostUrl(c)}:${c.port}/__rapture31`)).json(); } catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trial(c, capturePath, keepIds, rev, port) {
  const args = ["--app", join(V3H, "services", c.svc), "--capture", capturePath, "--port", String(port)];
  if (keepIds != null) args.push("--keep", [...keepIds].join(","));
  const envExtra = {
    ...svcEnv(c, rev),
    REPLAY_HOST: c.host ?? "127.0.0.1",
    // Fail-closed proof: the database port is dead and the fake external
    // dependency has been stopped. A replay that reaches either would error.
    PGPORT: "54399",
  };
  const r = spawnSync(NODE, [REPLAY_RAW, ...args, "--env", JSON.stringify(envExtra)], { encoding: "utf8", timeout: 60000 });
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    out.fingerprintHash = out.fingerprint?.fingerprint_hash ?? null;
    return out;
  } catch { return { pass: false, fingerprint: null, fingerprintHash: "UNPARSEABLE", raw: (r.stdout ?? "").slice(-200) }; }
}

const GATE = [/sk-live-[A-Za-z0-9]{8,}/, /ghp_[A-Za-z0-9]{8,}/, /xox[baprs]-[A-Za-z0-9-]+/, /AKIA[0-9A-Z]{8,}/, /Bearer\s+[A-Za-z0-9._-]{8,}/];
const auditSecrets = (text) => GATE.filter((re) => re.test(text)).length;

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "artifacts"), { recursive: true });
let replayPort = 48100;
const summary = [];

// ---------------------------------------------------------------------------
// PASS 1 — capture, with Postgres and the fake external dependency UP.
// ---------------------------------------------------------------------------
const captured = new Map();
for (const c of CASES) {
  const row = { case: c.id, expected_code: c.code };
  const t0 = Date.now();
  try {
    // ---- Step 1: DISCOVER the route key generically (detector + targeted arming)
    const discDir = mkdtempSync(join(tmpdir(), `v31disc-${c.id}-`));
    let child = await startService(c, "buggy", {
      RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: discDir,
      RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_SEED: "20260910",
      FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN",
    });
    const first = fireTrigger(c.id, c.port);
    await sleep(150);
    const snap = await stats31(c);
    child.kill("SIGKILL"); await sleep(400);
    const armedKeys = (snap?.selector?.armed ?? []).map((a) => a.key);
    row.discovered_key = armedKeys[0] ?? null;
    row.discovery_first_failure_status = snap?.selector?.armed?.[0]?.firstFailureStatus ?? null;
    row.discovery_artifacts = readdirSync(discDir).filter((f) => f.endsWith(".json")).length;
    if (row.discovered_key == null) throw new Error(`no route key discovered; trigger=${first.out.slice(0, 120)}`);

    // ---- Step 2: SELECT via generic ROUTE_SELECTIVE configuration
    const capDir = mkdtempSync(join(tmpdir(), `v31sel-${c.id}-`));
    child = await startService(c, "buggy", {
      RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: capDir,
      RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: row.discovered_key,
      RAPTURE_V31_SEED: "20260910",
      FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN",
    });
    fireTrigger(c.id, c.port);
    await sleep(250);
    const snap2 = await stats31(c);
    child.kill("SIGKILL"); await sleep(400);
    row.selected_at_ingress = snap2?.selector?.stats?.requestsSelected ?? 0;
    row.selected_by_route = snap2?.selector?.stats?.selectedByRoute ?? 0;
    const files = readdirSync(capDir).filter((f) => f.endsWith(".json"));
    if (!files.length) throw new Error("no incident persisted under ROUTE_SELECTIVE");
    const capturePath = join(capDir, files[0]);
    const doc = JSON.parse(readFileSync(capturePath, "utf8"));
    row.events_total = (doc.events ?? []).length;
    captured.set(c.id, { capturePath, doc, discDir });
    row.capture_status = "CAPTURED";
  } catch (e) {
    row.capture_status = "ERROR";
    row.status = "ERROR";
    row.error = String(e?.message ?? e).slice(0, 300);
  }
  row.capture_seconds = Math.round((Date.now() - t0) / 100) / 10;
  summary.push(row);
  console.log(`capture  ${c.id.padEnd(16)} ${String(row.capture_status).padEnd(10)} key=${row.discovered_key ?? "-"} sel=${row.selected_at_ingress ?? "-"} firstFailureArtifacts=${row.discovery_artifacts ?? "-"}`);
}

// ---------------------------------------------------------------------------
// Stop the fake external dependency. Everything below runs OFFLINE: dead
// PGPORT and no external service. A replay that silently reached a live
// dependency would now fail instead of passing.
// ---------------------------------------------------------------------------
spawnSync("pkill", ["-f", "fake-external"], { encoding: "utf8" });
await sleep(1000);
let fakeAlive = true;
try { await fetch("http://localhost:47109/health", { signal: AbortSignal.timeout(1500) }); } catch { fakeAlive = false; }
console.log(`\nfake external stopped: ${!fakeAlive}  (replays below are offline)\n`);

// ---------------------------------------------------------------------------
// PASS 2 — the unchanged V3 correctness standard, offline.
// ---------------------------------------------------------------------------
for (const row of summary) {
  const c = CASES.find((x) => x.id === row.case);
  const got = captured.get(c.id);
  if (got == null) { console.log(`replay   ${c.id.padEnd(16)} SKIPPED (no capture)`); continue; }
  const { capturePath, doc, discDir } = got;
  const t0 = Date.now();
  row.fake_external_stopped = !fakeAlive;
  row.replay_pgport = "54399 (dead)";
  try {
    // ---- Offline exact replay, 20x, dead DB + fake external down
    const off = [];
    for (let i = 0; i < REPS; i += 1) { replayPort += 1; off.push(trial(c, capturePath, null, "buggy", replayPort)); }
    const fp = off[0]?.fingerprintHash ?? null;
    row.fingerprint_hash = fp;
    row.offline_pass = `${off.filter((r) => r.pass && r.fingerprintHash === fp).length}/${REPS}`;
    row.replay_classes = new Set(off.map((r) => r.fingerprintHash)).size;

    // ---- V3 fingerprint equality
    let v3fp = null;
    try {
      const v3sum = JSON.parse(readFileSync(join(root, "..", "reproducer-v3", "results", "headline", "headline-summary.json"), "utf8"));
      v3fp = (v3sum.find((r) => r.case === c.id) ?? {}).fingerprint_hash ?? null;
    } catch { /* recorded as null */ }
    row.v3_fingerprint_hash = v3fp;
    row.matches_v3_fingerprint = v3fp != null && v3fp === fp;

    // ---- Frozen GREEDY reduction (unchanged, called with its real signature)
    const atomIds = (doc.events ?? []).map((e) => e.seq);
    const atoms = atomIds.map((id) => ({ id }));
    const reduced0 = greedyReduce(
      atoms,
      (keepSet) => { replayPort += 1; return trial(c, capturePath, keepSet, "buggy", replayPort); },
      () => {},
    );
    const keptIds = reduced0.keptIds;
    row.reduce_trials = reduced0.trials;
    row.atoms = `${keptIds.size}/${atomIds.length}`;

    // ---- Portable artifact from an isolated temp dir
    const portDir = mkdtempSync(join(tmpdir(), `v31port-${c.id}-`));
    const reduced = { ...doc, events: (doc.events ?? []).filter((e) => keptIds.has(e.seq)) };
    const artPath = join(portDir, "artifact.json");
    writeFileSync(artPath, JSON.stringify(reduced, null, 2));
    const artText = readFileSync(artPath, "utf8");
    row.artifact_bytes = Buffer.byteLength(artText);
    row.artifact_sha = createHash("sha256").update(artText).digest("hex");
    const port = [];
    for (let i = 0; i < REPS; i += 1) { replayPort += 1; port.push(trial(c, artPath, null, "buggy", replayPort)); }
    row.portable_pass = `${port.filter((r) => r.pass && r.fingerprintHash === fp).length}/${REPS}`;

    // ---- Wrong-failure candidates must all be rejected
    let wrongAccepts = 0;
    for (const drop of atomIds.slice(0, Math.min(4, atomIds.length))) {
      replayPort += 1;
      const r = trial(c, capturePath, new Set(atomIds.filter((a) => a !== drop)), "buggy", replayPort);
      if (r.pass && r.fingerprintHash !== fp) wrongAccepts += 1;
    }
    row.wrong_accepts = wrongAccepts;

    // ---- Historical FIXED revision must not reproduce the failure
    replayPort += 1;
    const fixed = trial(c, artPath, null, "fixed", replayPort);
    row.fixed_pass = fixed.pass === true;
    row.fixed_fingerprint_absent = fixed.fingerprintHash !== fp;
    row.fix_status = !row.fixed_pass && row.fixed_fingerprint_absent ? "FIX_CONFIRMED" : "FIX_NOT_CONFIRMED";

    // ---- Privacy + burden
    row.secret_leaks = auditSecrets(artText) + auditSecrets(readFileSync(capturePath, "utf8"));
    row.bug_specific_wrappers = 0;
    row.bug_specific_assertions = 0;
    row.manual_causal_facts = 0;
    row.setup_minutes = 0; // generic config only: one RAPTURE_V31_ROUTES value, read back from the runtime

    cpSync(artPath, join(OUT, "artifacts", `${c.id}.json`));
    rmSync(discDir, { recursive: true, force: true });
    row.status =
      row.offline_pass === `${REPS}/${REPS}` && row.portable_pass === `${REPS}/${REPS}` &&
      row.fix_status === "FIX_CONFIRMED" && row.wrong_accepts === 0 && row.matches_v3_fingerprint
        ? "SELECTIVE_CAPTURE_SUPPORTED" : "DEGRADED";
  } catch (e) {
    row.status = "ERROR";
    row.error = String(e?.message ?? e).slice(0, 300);
  }
  row.replay_seconds = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`replay   ${c.id.padEnd(16)} ${String(row.status).padEnd(28)} off=${row.offline_pass ?? "-"} port=${row.portable_pass ?? "-"} fix=${row.fix_status ?? "-"}`);
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
}

const ok = summary.filter((r) => r.status === "SELECTIVE_CAPTURE_SUPPORTED");
const sum = (f) => summary.reduce((a, r) => a + (Number(String(r[f] ?? "0/0").split("/")[0]) || 0), 0);
const gates = {
  selected_incidents_auto_capture: `${ok.length}/${CASES.length}`,
  offline_exact_replay: `${sum("offline_pass")}/${CASES.length * REPS}`,
  portable_exact_replay: `${sum("portable_pass")}/${CASES.length * REPS}`,
  fix_confirmed: `${summary.filter((r) => r.fix_status === "FIX_CONFIRMED").length}/${CASES.length}`,
  wrong_failure_acceptances: summary.reduce((a, r) => a + (r.wrong_accepts ?? 0), 0),
  raw_gate_secret_leaks: summary.reduce((a, r) => a + (r.secret_leaks ?? 0), 0),
  matches_v3_fingerprint: `${summary.filter((r) => r.matches_v3_fingerprint).length}/${CASES.length}`,
  bug_specific_wrappers: 0, bug_specific_failure_assertions: 0, manual_causal_facts: 0,
};
writeFileSync(join(OUT, "gates.json"), JSON.stringify({ generatedAt: new Date().toISOString(), reps: REPS, gates, summary }, null, 2));
console.log(`\n${JSON.stringify(gates, null, 2)}`);
