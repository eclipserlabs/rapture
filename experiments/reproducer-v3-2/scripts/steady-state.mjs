// V3.2 Phase 1 — steady-state route-targeted mixed traffic.
//
// The V3.1 question was "does an unselected request do any capture work?"
// (answer: none). The V3.2 question is different and harder: once the process
// has ALREADY been capturing targeted requests for a while -- so the
// AsyncLocalStorage is enabled and async_hooks is live -- does the unmatched
// traffic sharing that process still run at OFF speed?
//
// Workload equivalence is the whole game here. Each V3.2 service fixture
// registers the SAME handler at two paths, so the armed and unmatched
// populations do byte-identical application work (pg lookup + outbound fetch +
// framework routing). OFF_MIXED runs the IDENTICAL two-route mix. Unmatched
// latency is therefore never compared against a different OFF workload.
//
// Usage: node scripts/steady-state.mjs [--reps 10] [--requests 20000]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot, evaluate, CRITERIA } from "./quiescence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVCDIR = join(root, "services");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const REPS = Number(arg("--reps", "10"));
const N = Number(arg("--requests", "20000"));
const CONC = 16;
const WARM = 1000;
const ACTIVATION = 150;          // forced selected captures before measurement
const SEED = Number(arg("--seed", "20260911"));
const ATTRIB = arg("--attrib", "0") === "1";

// armedReq / unmatchedReq are the SAME handler at two paths.
const SERVICES = {
  "express-qs": {
    file: join(SVCDIR, "express-qs.mjs"),
    env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" },
    port: 48611, armedKey: "GET /parse",
    armedReq: (i) => ({ path: `/parse?q=a%5B%5D%3D${i % 3},${(i % 3) + 1}` }),
    unmatchedReq: (i) => ({ path: `/parse-b?q=a%5B%5D%3D${i % 3},${(i % 3) + 1}` }),
  },
  "koa-1999": {
    file: join(SVCDIR, "koa-1999.mjs"),
    env: { REPO_ROOT: `${CORPUS}koa-571938d` },
    port: 48612, armedKey: "GET /u",
    armedReq: (i) => ({ path: `/u?q=${i % 7}` }),
    unmatchedReq: (i) => ({ path: `/u-b?q=${i % 7}` }),
  },
  "fastify-32442": {
    file: join(SVCDIR, "fastify-32442.mjs"),
    env: { REPO_ROOT: `${CORPUS}fastify-5.3.2` },
    port: 48613, armedKey: "POST /v",
    armedReq: (i) => ({ method: "POST", path: "/v", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow: true, n: i % 11 }) }),
    unmatchedReq: (i) => ({ method: "POST", path: "/v-b", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow: true, n: i % 11 }) }),
  },
};

// armedFraction: how much of the MEASURED mix hits the armed route.
const MODES = {
  OFF_MIXED:            { armedFraction: 0.10, capture: false },
  ARMED_UNMATCHED_ONLY: { armedFraction: 0.00, capture: true },
  ARMED_MIXED_1:        { armedFraction: 0.01, capture: true },
  ARMED_MIXED_10:       { armedFraction: 0.10, capture: true },
  ARMED_MIXED_25:       { armedFraction: 0.25, capture: true },
};
const MODE_LIST = Object.keys(MODES);

function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = (arr, rand) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function start(def, mode) {
  const cfg = MODES[mode];
  const outDir = join("/tmp", `v32ss-${mode}`);
  mkdirSync(outDir, { recursive: true });
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_SAMPLE_RATE","RAPTURE_V31_WINDOW_BUDGET","RAPTURE_V31_ATTRIB"]) delete base[k];
  const capEnv = cfg.capture
    ? { RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir, RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: def.armedKey, ...(ATTRIB ? { RAPTURE_V31_ATTRIB: "1" } : {}) }
    : {};
  const env = { ...base, ...def.env, PORT: String(def.port), FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN", ...capEnv };
  const args = cfg.capture ? ["--import", REGISTER, def.file] : [def.file];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout ${mode}: ${out.slice(-400)}`)); }, 30000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exit ${c} ${mode}: ${out.slice(-400)}`)); });
  });
}

async function runPool(port, items) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      const it = items[i];
      const t0 = performance.now();
      try {
        const res = await fetch(`http://localhost:${port}${it.path}`, { method: it.method ?? "GET", headers: it.headers, body: it.body, signal: AbortSignal.timeout(20000) });
        await res.arrayBuffer();
        out[i] = { ms: performance.now() - t0, status: res.status, armed: it.armed };
      } catch (e) { out[i] = { ms: -1, status: 0, armed: it.armed, error: String(e?.message ?? e).slice(0, 60) }; }
    }
  }));
  return out;
}

const q = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
const summ = (lat) => ({ n: lat.length, p50: q(lat, 0.5), p90: q(lat, 0.9), p95: q(lat, 0.95), p99: q(lat, 0.99) });

/** Deterministic interleave: armed requests spread evenly through the mix. */
function buildMix(def, fraction, count, offset) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const armed = fraction > 0 && Math.floor(i * fraction) !== Math.floor((i - 1) * fraction);
    items.push(armed ? { ...def.armedReq(i + offset), armed: true } : { ...def.unmatchedReq(i + offset), armed: false });
  }
  return items;
}

async function measure(name, def, mode, rep) {
  const cfg = MODES[mode];
  const bootT0 = Date.now();
  const child = await start(def, mode);
  const bootMs = Date.now() - bootT0;
  try {
    const stats = async () => { if (!cfg.capture) return null; try { return await (await fetch(`http://localhost:${def.port}/__rapture31`)).json(); } catch { return null; } };
    // --- ACTIVATION: force >=150 selected captures so async_hooks is live and
    //     the capture machinery has already been exercised before measurement.
    let activated = 0;
    if (cfg.capture) {
      await runPool(def.port, Array.from({ length: ACTIVATION }, (_, i) => ({ ...def.armedReq(i), armed: true })));
      activated = (await stats())?.selector?.stats?.requestsSelected ?? 0;
      if (activated < 100) throw new Error(`activation failed: only ${activated} selected`);
    }
    // --- WARMUP at the measured mix
    await runPool(def.port, buildMix(def, cfg.armedFraction, WARM, 0));
    const s0 = await stats();
    // --- MEASURED INTERVAL
    const items = buildMix(def, cfg.armedFraction, N, WARM);
    const w0 = Date.now();
    const res = await runPool(def.port, items);
    const wallMs = Date.now() - w0;
    const s1 = await stats();

    const ok = res.filter((r) => r.ms >= 0);
    const un = ok.filter((r) => !r.armed).map((r) => r.ms).sort((a, b) => a - b);
    const ar = ok.filter((r) => r.armed).map((r) => r.ms).sort((a, b) => a - b);
    const d = (a, b, path) => (a == null || b == null) ? null : path(b) - path(a);
    return {
      service: name, mode, rep, requests: N, concurrency: CONC, bootMs, wallMs,
      armedFractionConfigured: cfg.armedFraction,
      armedFractionActual: ok.length ? ar.length / ok.length : 0,
      activationSelected: activated,
      unmatched: summ(un), selected: summ(ar),
      throughputRps: (ok.length / Math.max(1, wallMs)) * 1000,
      errors: res.filter((r) => r.ms < 0).length,
      failedCount: res.filter((r) => r.status >= 500).length,
      unmatchedLatencies: un.map((v) => Math.round(v * 1000) / 1000),
      selectedLatencies: ar.map((v) => Math.round(v * 1000) / 1000),
      counters: s1 == null ? null : {
        alsEnabled: s1.alsEnabled,
        requestsSeen: d(s0, s1, (x) => x.selector.stats.requestsSeen),
        requestsSelected: d(s0, s1, (x) => x.selector.stats.requestsSelected),
        unmatchedByRoute: d(s0, s1, (x) => x.selector.stats.unmatchedByRoute),
        eventsRecorded: d(s0, s1, (x) => x.capture.eventsRecorded),
        requestsPersisted: d(s0, s1, (x) => x.capture.requestsPersisted),
        attribAlsStores: ATTRIB ? d(s0, s1, (x) => x.attrib.alsStoresCreated) : null,
        attribEventBuffers: ATTRIB ? d(s0, s1, (x) => x.attrib.eventBuffersAllocated) : null,
        attribBoundaryHits: ATTRIB ? d(s0, s1, (x) => x.attrib.boundaryContextHits) : null,
        attribBoundaryMisses: ATTRIB ? d(s0, s1, (x) => x.attrib.boundaryContextMisses) : null,
      },
      resources: s1 == null ? null : { rss: s1.memory?.rss ?? null, heapUsed: s1.memory?.heapUsed ?? null, cpuUser: s1.cpu?.user ?? null, cpuSystem: s1.cpu?.system ?? null },
      machine: { node: process.version, platform: process.platform, arch: process.arch },
    };
  } finally { child.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 700)); }
}

const outDir = join(root, "results", ATTRIB ? "steady-state-attrib" : "steady-state");
mkdirSync(outDir, { recursive: true });
// Environment snapshot before the campaign (preregistered requirement).
const envBefore = { ...snapshot() };
envBefore.evaluation = evaluate(envBefore);
writeFileSync(join(outDir, "_environment-before.json"), JSON.stringify({ criteria: CRITERIA, snapshot: envBefore }, null, 2));
if (!envBefore.evaluation.pass) {
  console.error("REFUSING TO MEASURE: host is not quiescent — " + envBefore.evaluation.failures.join("; "));
  process.exit(2);
}
console.log("environment OK: load1/cpu=" + envBefore.load1_per_cpu + " avail=" + envBefore.available_mem_mb + "MB orphans=" + envBefore.orphaned_experiment_processes.length);
const envSamples = [];
const rand = mulberry32(SEED);
for (let rep = 1; rep <= REPS; rep++) {
  for (const [name, def] of Object.entries(SERVICES)) {
    for (const mode of shuffle(MODE_LIST, rand)) {
      const envPre = { ...snapshot() }; envPre.evaluation = evaluate(envPre);
      const row = await measure(name, def, mode, rep);
      const envPost = { ...snapshot() }; envPost.evaluation = evaluate(envPost);
      row.environment = { before: envPre, after: envPost };
      // Objective host evidence only. A repetition is NEVER invalidated for
      // its Rapture outcome.
      // A repetition is invalidated by FOREIGN contention only. The load a
      // benchmark generates is the workload under test, not interference:
      // driving 16-way concurrency at a service necessarily raises the load
      // average, so applying the pre-campaign IDLE gate here invalidates every
      // repetition by construction (it did: 150/150, all on load thresholds,
      // with zero foreign contention observed).
      //
      // The pre-campaign gate is unchanged and still governs whether the
      // campaign may start at all.
      const foreignOf = (e) => e.evaluation.failures.filter((f) => !f.startsWith("load"));
      const fPre = foreignOf(envPre);
      const fPost = foreignOf(envPost);
      const orphans = envPre.orphaned_experiment_processes.length + envPost.orphaned_experiment_processes.length;
      row.invalidEnvironment = fPre.length > 0 || fPost.length > 0 || orphans > 0;
      if (row.invalidEnvironment) {
        row.invalidEnvironmentReason = [...fPre, ...fPost];
        if (orphans > 0) row.invalidEnvironmentReason.push("orphaned experiment processes: " + orphans);
      }
      row.benchmarkLoad = { before: envPre.load1_per_cpu, after: envPost.load1_per_cpu };
      envSamples.push({ rep, service: name, mode, invalid: row.invalidEnvironment });
      writeFileSync(join(outDir, `ss-${name}-${mode}-rep${rep}.json`), `${JSON.stringify(row)}\n`);
      const c = row.counters;
      console.log(`${name}/${mode}/rep${rep}: unmP95=${row.unmatched.p95.toFixed(2)} selP95=${row.selected.p95 ? row.selected.p95.toFixed(2) : "-"} rps=${row.throughputRps.toFixed(1)} armed=${(row.armedFractionActual * 100).toFixed(1)}% err=${row.errors}${c ? ` sel=${c.requestsSelected} ev=${c.eventsRecorded}` : ""}`);
    }
  }
}
writeFileSync(join(outDir, "_environment-log.json"), JSON.stringify(envSamples, null, 2));
const bad = envSamples.filter((e) => e.invalid);
console.log(`wrote ${outDir}`);
console.log(`repetitions marked INVALID_ENVIRONMENT: ${bad.length}/${envSamples.length}`);
if (bad.length) console.log("  these must be rerun, not discarded: " + bad.map((b) => `${b.service}/${b.mode}/rep${b.rep}`).join(", "));
