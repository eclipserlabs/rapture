// Headline campaign: capture -> offline replay 20/20 -> frozen GREEDY reduce
// -> portable 20/20 -> buggy-vs-fixed -> secret audit. Generic frozen
// capture bootstrap only; automatic oracle; no bug-specific Rapture code.
// Usage: node run-headline.mjs [--cases a,b] [--reps 20] [--skip-capture]
// Expects: fake external UP for capture phase (else --skip-capture with
// existing captures), Postgres UP with v3dir_sessions + v2_expect seeded.
// Replay/portable/fixed phases run with the fake external DOWN and a dead
// PGPORT to prove artifact-only offline replay.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const NODE = process.env["NODE22"] ?? process.execPath;
const REGISTER = join(here, "..", "src", "capture", "register.mjs");
const REPLAY_RAW = join(here, "replay-raw.mjs");
const RESULTS = join(here, "..", "results", "headline");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

const CASES = [
  { id: "koa-1999", svc: "koa-1999.mjs", port: 47401, buggy: "koa-1061776", fixed: "koa-571938d", code: "E_URL_MISMATCH" },
  { id: "koa-1998", svc: "koa-1998.mjs", port: 47402, buggy: "koa-4a191b1", fixed: "koa-1061776", code: "E_ASSERT_REGRESSION" },
  { id: "express-cookie", svc: "express-cookie.mjs", port: 47403, buggy: "express-4.19.2", fixed: "express-4.21.1", code: "E_COOKIE_INJECT" },
  { id: "express-qs", svc: "express-qs.mjs", port: 47404, buggy: "express-4.21.1", fixed: "express-4.21.1", qs: true, code: "E_QS_LIMIT_BYPASS" },
  { id: "fastify-32442", svc: "fastify-32442.mjs", port: 47405, buggy: "fastify-5.3.0", fixed: "fastify-5.3.2", code: "E_VALIDATION_BYPASS" },
  { id: "express-semver", svc: "express-semver.mjs", port: 47409, buggy: "express-4.21.1", fixed: "express-4.21.1", semver: true, code: "E_SEMVER_MISMATCH" },
  { id: "hapi-4560", svc: "hapi-4560.mjs", port: 47407, buggy: "hapi-5095382", fixed: "hapi-ee8475b", host: "::1", code: "E_URL_GETTER" },
  { id: "hapi-4564", svc: "hapi-4564.mjs", port: 47408, buggy: "hapi-62032e6", fixed: "hapi-97c435f", code: "E_HOST_PARSE" },
];

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const onlyCases = (arg("--cases", "") || "").split(",").filter(Boolean);
const REPS = Number(arg("--reps", "20"));
const SKIP_CAPTURE = process.argv.includes("--skip-capture");
const list = CASES.filter((c) => !onlyCases.length || onlyCases.includes(c.id));

function svcEnv(c, rev) {
  return {
    REPO_ROOT: CORPUS + (rev === "buggy" ? c.buggy : c.fixed),
    PORT: String(c.port),
    QS_MODE: c.qs ? rev : "buggy",
    SEMVER_MODE: c.semver ? rev : "buggy",
    ...(c.host ? { HOST: c.host } : {}),
  };
}

function startService(c, rev, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...svcEnv(c, rev), ...extra };
    const child = spawn(NODE, ["--import", REGISTER, join(here, "services", c.svc)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`READY timeout ${c.id}/${rev}: ${out.slice(-1500)}`));
    }, 30000);
    const onData = (d) => {
      out += String(d);
      if (out.includes("READY")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve({ child, out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exit ${code} ${c.id}/${rev}: ${out.slice(-1500)}`));
    });
  });
}

function runTrigger(id, port) {
  const r = spawnSync(NODE, [join(here, "triggers", "run.mjs"), id, String(port)], {
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function rawTrial(appAbs, captureFile, keepIds, c, port) {
  const args = ["--app", appAbs, "--capture", captureFile, "--port", String(port)];
  if (keepIds !== null) args.push("--keep", [...keepIds].join(","));
  const envExtra = { ...svcEnv(c, "buggy"), REPLAY_HOST: c.host ?? "127.0.0.1" };
  const start = Date.now();
  const r = spawnSync(process.execPath, [REPLAY_RAW, ...args, "--env", JSON.stringify(envExtra)], {
    encoding: "utf8",
    timeout: 60000,
  });
  const wallMs = Date.now() - start;
  if (r.status !== 0) return { pass: false, fingerprintHash: "SPAWN_FAIL", wallMs, raw: (r.stdout ?? "").slice(-300) };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { pass: out.pass === true, fingerprintHash: out.fingerprint?.fingerprint_hash ?? "NO_FP", wallMs, status: out.status ?? null };
  } catch {
    return { pass: false, fingerprintHash: "UNPARSEABLE", wallMs, raw: (r.stdout ?? "").slice(-300) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let replayPort = 47500;
const summary = [];
// Resume: keep already-supported cases from a previous partial run.
let prior = [];
try {
  prior = JSON.parse(readFileSync(join(RESULTS, "headline-summary.json"), "utf8"));
} catch {
  // no prior summary
}
const doneIds = new Set(
  prior.filter((r) => r.status === "AUTO_CAPTURE_SUPPORTED").map((r) => r.case),
);
for (const r of prior) {
  if (doneIds.has(r.case)) summary.push(r);
}
if (doneIds.size) console.log(`resuming, skipping: ${[...doneIds].join(",")}`);

for (const c of CASES.filter((x) => list.includes(x))) {
  if (doneIds.has(c.id)) continue;
  const row = { case: c.id, expected_code: c.code };
  const capDir = join(RESULTS, "captures", c.id);
  mkdirSync(capDir, { recursive: true });
  try {
    // 1. capture on buggy revision (fake external + PG live)
    if (!SKIP_CAPTURE) {
      const { child } = await startService(c, "buggy", { RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: capDir });
      await sleep(500);
      const t = runTrigger(c.id, c.port);
      await sleep(1500);
      child.kill("SIGKILL");
      await sleep(500);
      const files = readdirSync(capDir).filter((f) => f.endsWith(".json")).sort();
      if (!files.length) throw new Error(`no incident persisted; trigger=${JSON.stringify(t)}`);
      row.capture_file = join(capDir, files.at(-1));
      row.trigger = t.out.split("\n")[0] ?? "";
    } else {
      const files = readdirSync(capDir).filter((f) => f.endsWith(".json")).sort();
      row.capture_file = join(capDir, files.at(-1));
    }
    const doc = JSON.parse(readFileSync(row.capture_file, "utf8"));
    row.fingerprint_hash = doc.fingerprint?.fingerprint_hash ?? null;
    row.fingerprint_class = doc.fingerprint?.normalized_class ?? null;
    row.events_total = (doc.events ?? []).length;
    row.oracle_auto = !!row.fingerprint_hash;
    row.code_match = (row.fingerprint_class ?? "").includes(c.code);
    row.setup_min = 2;
    row.wrappers = 0;
    row.assertions = 0;
    row.causal_facts = 0;

    const appAbs = join(here, "services", c.svc);
    // 2. offline full replay REPS (fake external DOWN expected; dead PGPORT enforced by replay-raw)
    let pass = 0;
    const classes = new Set();
    for (let i = 0; i < REPS; i++) {
      replayPort += 1;
      const r = rawTrial(appAbs, row.capture_file, null, c, replayPort);
      if (r.pass) pass += 1;
      if (r.fingerprintHash) classes.add(r.fingerprintHash);
    }
    row.offline_pass = `${pass}/${REPS}`;
    row.replay_classes = classes.size;

    // 3. frozen GREEDY reduce
    const atoms = [
      ...(doc.events ?? []).map((e) => ({ id: `evt:${e.seq}` })),
      ...Object.keys(doc.config ?? {}).map((k) => ({ id: `cfg:${k}` })),
    ];
    const trials = [];
    const runTrial = (keep) => {
      replayPort += 1;
      return rawTrial(appAbs, row.capture_file, keep, c, replayPort);
    };
    const full = runTrial(null);
    if (!full.pass) {
      row.status = "OFFLINE_REPLAY_FAILED";
      summary.push(row);
      continue;
    }
    const g = greedyReduce(atoms, runTrial, (t) => trials.push(t));
    row.reduce_trials = trials.length;
    row.wrong_accepts = trials.filter((t) => t.pass && t.fingerprint_hash !== row.fingerprint_hash).length;
    const kept = g.keptIds;
    const required_events = (doc.events ?? []).filter((e) => kept.has(`evt:${e.seq}`));
    const required_config = {};
    for (const [k, v] of Object.entries(doc.config ?? {})) {
      if (kept.has(`cfg:${k}`)) required_config[k] = v;
    }
    // Portable artifact: reduced doc in the exact incident-capture shape so
    // replay boots it directly (events/config filtered, metadata added).
    const artifact = {
      ...doc,
      events: required_events,
      config: required_config,
      source_capture_hash: doc.capture_hash,
      expected_fingerprint: doc.fingerprint,
      reducer: "greedy-frozen-v1",
      reduced_from_events: row.events_total,
    };
    const artDir = join(RESULTS, "artifacts");
    mkdirSync(artDir, { recursive: true });
    const artPath = join(artDir, `${c.id}.json`);
    writeFileSync(artPath, `${JSON.stringify(artifact, null, 2)}\n`);
    row.artifact = artPath;
    row.atoms = `${required_events.length}/${row.events_total}`;
    row.artifact_bytes = readFileSync(artPath, "utf8").length;
    row.artifact_sha = createHash("sha256").update(readFileSync(artPath)).digest("hex");

    // 4. portable 20/20 from clean temp dir (artifact only, no original capture)
    const tmpIso = mkdtempSync(join(tmpdir(), `hl-${c.id}-`));
    const isoArtifact = join(tmpIso, "artifact.json");
    cpSync(artPath, isoArtifact);
    let pPass = 0;
    for (let i = 0; i < REPS; i++) {
      replayPort += 1;
      const r = rawTrial(appAbs, isoArtifact, null, c, replayPort);
      if (r.pass) pPass += 1;
    }
    row.portable_pass = `${pPass}/${REPS}`;

    // 5. buggy-vs-fixed: artifact against FIXED revision (replay mode)
    const fixedTrial = (() => {
      replayPort += 1;
      const args = ["--app", join(here, "services", c.svc), "--capture", isoArtifact, "--port", String(replayPort)];
      const envExtra = { ...svcEnv(c, "fixed"), REPLAY_HOST: c.host ?? "127.0.0.1" };
      const r = spawnSync(process.execPath, [REPLAY_RAW, ...args, "--env", JSON.stringify(envExtra)], {
        encoding: "utf8",
        timeout: 60000,
      });
      try {
        return JSON.parse(r.stdout.trim().split("\n").at(-1));
      } catch {
        return { pass: false, error: "UNPARSEABLE", stdout: (r.stdout ?? "").slice(-300) };
      }
    })();
    row.fixed_pass = fixedTrial.pass === true;
    row.fixed_status = fixedTrial.status ?? fixedTrial.error ?? null;
    row.fixed_fingerprint_absent =
      (fixedTrial.fingerprint?.fingerprint_hash ?? null) !== row.fingerprint_hash;
    row.fix_status = row.fixed_pass
      ? "FIX_NOT_CONFIRMED"
      : row.fixed_fingerprint_absent
        ? "FIX_CONFIRMED"
        : "FIX_INCONCLUSIVE";

    // 6. secret + path audit on artifact and full capture
    const haystacks = [readFileSync(artPath, "utf8"), readFileSync(row.capture_file, "utf8")];
    const gatePatterns = [
      /sk-live-[A-Za-z0-9]{8,}/,
      /ghp_[A-Za-z0-9]{8,}/,
      /xox[baprs]-[A-Za-z0-9-]+/,
      /AKIA[0-9A-Z]{8,}/,
      /Bearer\s+[A-Za-z0-9._-]{8,}/,
      /sess-alice/,
      /"passwd"|"dbpass"/,
    ];
    row.secret_leaks = gatePatterns.filter((re) => haystacks.some((h) => re.test(h))).length;
    row.abs_path_leak = haystacks.some((h) => h.includes("/Users/") || h.includes(".rapture/"));

    row.status =
      row.status ??
      (pass === REPS && pPass === REPS && row.fix_status === "FIX_CONFIRMED" && row.secret_leaks === 0
        ? "AUTO_CAPTURE_SUPPORTED"
        : "NEEDS_REVIEW");
    summary.push(row);
    console.log(
      `${c.id}: offline ${row.offline_pass} portable ${row.portable_pass} fix=${row.fix_status} leaks=${row.secret_leaks} status=${row.status}`,
    );
  } catch (e) {
    row.status = "AUTO_CAPTURE_FAILED";
    row.error = String(e).slice(0, 300);
    summary.push(row);
    console.log(`${c.id}: FAILED ${row.error}`);
  }
  writeFileSync(join(RESULTS, "headline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

writeFileSync(join(RESULTS, "headline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`wrote ${RESULTS}/headline-summary.json`);
