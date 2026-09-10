// V3.1 Phase 2 (selective-capture brief) — performance at the preregistered
// 10000 measured requests per repetition, including the two deployment modes
// the prior campaign never implemented: ROUTE_SELECTIVE and ARMED_WINDOW.
//
// Methodology mirrors the prior campaign exactly (same services, fixed
// revisions, warmup, concurrency 16, randomized mode order per repetition,
// full raw latency arrays retained) so numbers stay comparable. The only
// deliberate differences are the request count (10000, per this brief) and
// the added modes.
//
// Usage: node scripts/perf-brief.mjs [--reps 10] [--requests 10000]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const REGISTER = join(root, "src", "capture", "register.mjs");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const REPS = Number(arg("--reps", "10"));
const N = Number(arg("--requests", "10000"));
const CONC = 16;
const WARM = 500;
const SEED = Number(arg("--seed", "20260910"));
const ARMED_FRACTION = 0.1;

const SERVICES = {
  "express-qs": {
    file: join(V3, "headline", "services", "express-qs.mjs"),
    env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" },
    port: 47811, statsPath: "/__stats", key: "GET /parse",
    req: (i) => ({ path: `/parse?q=a%5B%5D%3D${i % 3},${(i % 3) + 1}` }),
  },
  "koa-1999": {
    file: join(V3, "headline", "services", "koa-1999.mjs"),
    env: { REPO_ROOT: `${CORPUS}koa-571938d` },
    port: 47812, statsPath: "/__stats", key: "GET /u",
    req: (i) => ({ path: `/u?q=${i % 7}` }),
  },
  "fastify-32442": {
    file: join(V3, "headline", "services", "fastify-32442.mjs"),
    env: { REPO_ROOT: `${CORPUS}fastify-5.3.2` },
    port: 47813, statsPath: "/__stats", key: "POST /v",
    req: (i) => ({
      method: "POST", path: "/v",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: true, n: i % 11 }),
    }),
  },
};

// Mode -> env factory (per service, because armed routes are service-specific
// CONFIGURATION, not code: the same generic RAPTURE_V31_ROUTES knob).
const MODES = {
  OFF: () => null,
  V3_ALWAYS_ON_FULL: () => ({ RAPTURE_V31_STRATEGY: "always-on", RAPTURE_V2_MODE: "capture" }),
  SAMPLE_1: () => ({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.01", RAPTURE_V2_MODE: "capture" }),
  SAMPLE_5: () => ({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.05", RAPTURE_V2_MODE: "capture" }),
  SAMPLE_10: () => ({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.1", RAPTURE_V2_MODE: "capture" }),
  // A route IS armed, but the measured workload never matches it. This is the
  // population the deployment gate governs: traffic on other routes while
  // Rapture is armed somewhere in the process.
  ROUTE_SELECTIVE_UNMATCHED: () => ({
    RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "POST /never-matched", RAPTURE_V2_MODE: "capture",
  }),
  // A bounded incident window on THIS service's own route, sized so ~10% of
  // the measured requests are selected. Reports both global cost and the
  // latency of the definitely-unselected tail.
  ARMED_WINDOW_10PCT: (def) => ({
    RAPTURE_V31_STRATEGY: "armed-window", RAPTURE_V31_ROUTES: def.key,
    // Warmup consumes budget 1:1, so cover it explicitly; exactly
    // ARMED_FRACTION of the MEASURED requests are then selected.
    RAPTURE_V31_WINDOW_BUDGET: String(WARM + Math.round(N * ARMED_FRACTION)),
    RAPTURE_V2_MODE: "capture",
  }),
  // The window has already closed. Does the process return to the fast path?
  ARMED_WINDOW_CLOSED: (def) => ({
    RAPTURE_V31_STRATEGY: "armed-window", RAPTURE_V31_ROUTES: def.key,
    RAPTURE_V31_WINDOW_BUDGET: "0", RAPTURE_V2_MODE: "capture",
  }),
};
const MODE_LIST = Object.keys(MODES);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, rand) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function start(def, mode, seed) {
  const modeEnv = MODES[mode](def);
  const outDir = join("/tmp", `v31brief-${mode}`);
  mkdirSync(outDir, { recursive: true });
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_ROUTES", "RAPTURE_V31_SAMPLE_RATE", "RAPTURE_V31_WINDOW_BUDGET", "RAPTURE_V31_WINDOW_MS", "RAPTURE_V31_ATTRIB"]) delete base[k];
  const env = { ...base, ...def.env, PORT: String(def.port), FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN", RAPTURE_V2_OUT: outDir, RAPTURE_V31_SEED: String(seed), ...(modeEnv ?? {}) };
  const args = modeEnv == null ? [def.file] : ["--import", REGISTER, def.file];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout ${mode}: ${out.slice(-500)}`)); }, 30000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exit ${c} ${mode}: ${out.slice(-500)}`)); });
  });
}

async function runPool(port, items) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      const t0 = performance.now();
      try {
        const res = await fetch(`http://localhost:${port}${items[i].path}`, {
          method: items[i].method ?? "GET",
          headers: items[i].headers,
          body: items[i].body,
          signal: AbortSignal.timeout(15000),
        });
        await res.arrayBuffer();
        out[i] = { ms: performance.now() - t0, status: res.status, idx: i };
      } catch (e) { out[i] = { ms: -1, status: 0, idx: i, error: String(e?.message ?? e).slice(0, 80) }; }
    }
  }));
  return out;
}

const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const summarize = (lat) => ({ p50: q(lat, 0.5), p90: q(lat, 0.9), p95: q(lat, 0.95), p99: q(lat, 0.99) });

async function measure(name, def, mode, rep) {
  const seed = SEED + rep * 1000;
  const bootT0 = Date.now();
  const child = await start(def, mode, seed);
  const bootMs = Date.now() - bootT0;
  try {
    const v31 = async () => { if (MODES[mode](def) == null) return null; try { return await (await fetch(`http://localhost:${def.port}/__rapture31`)).json(); } catch { return null; } };
    await runPool(def.port, Array.from({ length: WARM }, (_, i) => def.req(i)));
    const a0 = await v31();
    const items = Array.from({ length: N }, (_, i) => def.req(i + WARM));
    const w0 = Date.now();
    const results = await runPool(def.port, items);
    const wallMs = Date.now() - w0;
    const a1 = await v31();
    const ok = results.filter((r) => r.ms >= 0);
    const lat = ok.map((r) => r.ms).sort((x, y) => x - y);
    // Definitely-unselected tail: for the armed-window mode the budget is
    // consumed by the earliest requests, so the tail is guaranteed unselected.
    const budget = mode === "ARMED_WINDOW_10PCT" ? Math.round(N * ARMED_FRACTION) : 0;
    const tail = ok.filter((r) => r.idx >= budget).map((r) => r.ms).sort((x, y) => x - y);
    return {
      service: name, mode, rep, seed, requests: N, concurrency: CONC, n: lat.length, bootMs, wallMs,
      ...summarize(lat),
      mean: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
      throughputRps: (lat.length / Math.max(1, wallMs)) * 1000,
      unselectedTail: { n: tail.length, ...summarize(tail) },
      failedCount: results.filter((r) => r.status >= 500).length,
      errors: results.filter((r) => r.ms < 0).length,
      latencies: lat.map((v) => Math.round(v * 1000) / 1000),
      v31: a1 == null ? null : {
        alsEnabled: a1.alsEnabled,
        requestsSeen: (a1.selector?.stats.requestsSeen ?? 0) - (a0?.selector?.stats.requestsSeen ?? 0),
        requestsSelected: (a1.selector?.stats.requestsSelected ?? 0) - (a0?.selector?.stats.requestsSelected ?? 0),
        requestsPersisted: (a1.capture?.requestsPersisted ?? 0) - (a0?.capture?.requestsPersisted ?? 0),
        eventsRecorded: (a1.capture?.eventsRecorded ?? 0) - (a0?.capture?.eventsRecorded ?? 0),
        windowOpen: a1.selector?.windowOpen ?? null,
        windowClosedReason: a1.selector?.windowClosedReason ?? null,
      },
      machine: { node: process.version, platform: process.platform, arch: process.arch },
    };
  } finally { child.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 700)); }
}

const outDir = join(root, "results", "perf", "brief");
mkdirSync(outDir, { recursive: true });
const rand = mulberry32(SEED);
for (let rep = 1; rep <= REPS; rep += 1) {
  for (const [name, def] of Object.entries(SERVICES)) {
    for (const mode of shuffle(MODE_LIST, rand)) {
      const row = await measure(name, def, mode, rep);
      writeFileSync(join(outDir, `perf-${name}-${mode}-rep${rep}.json`), `${JSON.stringify(row)}\n`);
      const s = row.v31 ? ` sel=${row.v31.requestsSelected}/${row.v31.requestsSeen} als=${row.v31.alsEnabled}` : "";
      console.log(`${name}/${mode}/rep${rep}: p50=${row.p50.toFixed(2)} p95=${row.p95.toFixed(2)} rps=${row.throughputRps.toFixed(1)} err=${row.errors}${s}`);
    }
  }
}
console.log(`wrote ${outDir}`);
