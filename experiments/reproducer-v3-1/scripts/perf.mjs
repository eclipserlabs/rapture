// V3.1 deployment-strategy performance harness.
//
// Measures success-path cost for every preregistered mode on the same three
// service shapes V3 used for headline perf (express-qs, koa-1999,
// fastify-32442 at FIXED revisions, success workloads with pg + outbound
// fetch on the path). Methodology mirrors V3 so the numbers are comparable:
// warmed, fixed workload, concurrency 16, raw latency arrays retained, mode
// order rotated per repetition.
//
// Usage:
//   node scripts/perf.mjs --phase 3 [--reps 10] [--requests 5000]
//   node scripts/perf.mjs --phase 4 [--reps 10] [--requests 5000]
//   node scripts/perf.mjs --phase calib --services a,b [--reps 3]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const V31_REGISTER = join(root, "src", "capture", "register.mjs");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const PHASE = arg("--phase", "3");
const REPS = Number(arg("--reps", "10"));
const N = Number(arg("--requests", "5000"));
const CONC = 16;
const WARM = 500;
const SEED = Number(arg("--seed", "20260909"));

// ---------------------------------------------------------------------------
// Services. Headline shapes are used for MEASUREMENT only, exactly as V3 did;
// no optimization decision is taken against them (see manifest freeze rule).
// ---------------------------------------------------------------------------

const HEADLINE = {
  "express-qs": {
    file: join(V3, "headline", "services", "express-qs.mjs"),
    env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" },
    port: 47611,
    statsPath: "/__stats",
    req: (i) => ({ path: `/parse?q=a%5B%5D%3D${i % 3},${(i % 3) + 1}` }),
  },
  "koa-1999": {
    file: join(V3, "headline", "services", "koa-1999.mjs"),
    env: { REPO_ROOT: `${CORPUS}koa-571938d` },
    port: 47612,
    statsPath: "/__stats",
    req: (i) => ({ path: `/u?q=${i % 7}` }),
  },
  "fastify-32442": {
    file: join(V3, "headline", "services", "fastify-32442.mjs"),
    env: { REPO_ROOT: `${CORPUS}fastify-5.3.2` },
    port: 47613,
    statsPath: "/__stats",
    req: (i) => ({
      method: "POST",
      path: "/v",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: true, n: i % 11 }),
    }),
  },
};

const CALIB = {
  a: {
    file: join(V3, "perf", "service-a.mjs"),
    env: { SHOP_API_KEY: "shop-test-key" },
    port: 47614,
    statsPath: "/__v3stats",
    req: (i) => {
      const k = i % 5;
      if (k === 0) return { path: "/products" };
      if (k === 3) {
        return {
          method: "POST",
          path: "/orders",
          headers: { "content-type": "application/json", "x-api-key": "shop-test-key" },
          body: JSON.stringify({ sku: "sku-1", qty: (i % 3) + 1 }),
        };
      }
      return { path: `/products/sku-${(k % 3) + 1}` };
    },
  },
  b: {
    file: join(V3, "perf", "service-b.mjs"),
    env: {},
    port: 47615,
    statsPath: "/__v3stats",
    req: (i) => {
      const k = i % 5;
      const headers = { cookie: "sid=sess-alice" };
      if (k === 1) return { path: "/search?q=ali", headers };
      if (k === 2) return { path: "/config", headers };
      if (k === 3) {
        return {
          method: "POST",
          path: "/events",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "click", payload: { n: i } }),
        };
      }
      return { path: `/users/u-${(k % 2) + 1}`, headers };
    },
  },
};

// ---------------------------------------------------------------------------
// Modes. Each maps to the exact environment a deployment would set.
// ---------------------------------------------------------------------------

const MODE_ENV = {
  // No Rapture at all.
  OFF: null,
  // Detector-only, unarmed: the proposed steady state.
  DETECTOR_ONLY_UNARMED: { RAPTURE_V31_STRATEGY: "detector-only" },
  // Diagnostic only (not gated): same fast path, but ALS quiescence disabled
  // and the ALS forced on, to attribute the async_hooks share of the cost.
  DETECTOR_ONLY_ALS_ENABLED: {
    RAPTURE_V31_STRATEGY: "detector-only",
    RAPTURE_V31_ALS_QUIESCE: "0",
    RAPTURE_V31_FORCE_ALS: "1",
  },
  // Frozen V3 always-on capture: the control.
  V3_ALWAYS_ON_FULL: { RAPTURE_V31_STRATEGY: "always-on", RAPTURE_V2_MODE: "capture" },
  SAMPLE_1: { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.01", RAPTURE_V2_MODE: "capture" },
  SAMPLE_5: { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.05", RAPTURE_V2_MODE: "capture" },
  SAMPLE_10: { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.1", RAPTURE_V2_MODE: "capture" },
  SAMPLE_25: { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.25", RAPTURE_V2_MODE: "capture" },
};

const PHASE_MODES = {
  "3": ["OFF", "DETECTOR_ONLY_UNARMED", "DETECTOR_ONLY_ALS_ENABLED", "V3_ALWAYS_ON_FULL"],
  "4": ["OFF", "SAMPLE_1", "SAMPLE_5", "SAMPLE_10", "SAMPLE_25", "V3_ALWAYS_ON_FULL"],
  calib: ["OFF", "DETECTOR_ONLY_UNARMED", "DETECTOR_ONLY_ALS_ENABLED", "V3_ALWAYS_ON_FULL"],
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startService(def, mode, seed) {
  return new Promise((resolve, reject) => {
    const outDir = join("/tmp", `v31perf-${mode}`);
    mkdirSync(outDir, { recursive: true });
    const modeEnv = MODE_ENV[mode];
    const base = { ...process.env };
    for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_ALS_QUIESCE", "RAPTURE_V31_FORCE_ALS"]) {
      delete base[k];
    }
    const env = {
      ...base,
      ...def.env,
      PORT: String(def.port),
      FAKE_ORIGIN: `http://localhost:47109`,
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_OUT: outDir,
      RAPTURE_V31_SEED: String(seed),
      ...(modeEnv ?? {}),
    };
    const args = modeEnv == null ? [def.file] : ["--import", V31_REGISTER, def.file];
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`READY timeout ${mode}: ${out.slice(-800)}`));
    }, 30000);
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exit ${code} ${mode}: ${out.slice(-800)}`));
    });
  });
}

async function doRequest(port, spec) {
  const t0 = performance.now();
  const res = await fetch(`http://localhost:${port}${spec.path}`, {
    method: spec.method ?? "GET",
    headers: spec.headers,
    body: spec.body,
    signal: AbortSignal.timeout(15000),
  });
  await res.arrayBuffer();
  return { ms: performance.now() - t0, status: res.status };
}

async function runPool(port, items) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = await doRequest(port, items[i]);
      } catch (e) {
        out[i] = { ms: -1, status: 0, error: String(e?.message ?? e).slice(0, 80) };
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  return out;
}

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;

async function measure(name, def, mode, rep) {
  const seed = SEED + rep * 1000;
  const bootT0 = Date.now();
  const child = await startService(def, mode, seed);
  const bootMs = Date.now() - bootT0;
  try {
    const svcStats = async () => (await fetch(`http://localhost:${def.port}${def.statsPath}`)).json();
    const v31Stats = async () => {
      if (MODE_ENV[mode] == null) return null;
      try {
        return await (await fetch(`http://localhost:${def.port}/__rapture31`)).json();
      } catch {
        return null;
      }
    };
    await runPool(def.port, Array.from({ length: WARM }, (_, i) => def.req(i)));
    const stats0 = await svcStats();
    const v310 = await v31Stats();
    const items = Array.from({ length: N }, (_, i) => def.req(i + WARM));
    const wall0 = Date.now();
    const results = await runPool(def.port, items);
    const wallMs = Date.now() - wall0;
    const stats1 = await svcStats();
    const v311 = await v31Stats();
    const lat = results.filter((r) => r.ms >= 0).map((r) => r.ms).sort((a, b) => a - b);
    return {
      service: name,
      mode,
      rep,
      seed,
      requests: N,
      concurrency: CONC,
      n: lat.length,
      bootMs,
      wallMs,
      p50: quantile(lat, 0.5),
      p90: quantile(lat, 0.9),
      p95: quantile(lat, 0.95),
      p99: quantile(lat, 0.99),
      mean: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
      throughputRps: (lat.length / Math.max(1, wallMs)) * 1000,
      failedCount: results.filter((r) => r.status >= 500).length,
      errors: results.filter((r) => r.ms < 0).length,
      latencies: lat.map((v) => Math.round(v * 1000) / 1000),
      stats0,
      stats1,
      // Selective-capture accounting: how many requests were actually
      // fully instrumented, and whether the ALS ever had to be enabled.
      v31: v311 == null ? null : {
        alsEnabled: v311.alsEnabled,
        requestsSeen: (v311.selector?.stats.requestsSeen ?? 0) - (v310?.selector?.stats.requestsSeen ?? 0),
        requestsSelected: (v311.selector?.stats.requestsSelected ?? 0) - (v310?.selector?.stats.requestsSelected ?? 0),
        failuresObserved: (v311.selector?.stats.failuresObserved ?? 0) - (v310?.selector?.stats.failuresObserved ?? 0),
        armEvents: (v311.selector?.stats.armEvents ?? 0) - (v310?.selector?.stats.armEvents ?? 0),
        capturedIncidents: (v311.selector?.stats.capturedIncidents ?? 0) - (v310?.selector?.stats.capturedIncidents ?? 0),
        requestsPersisted: (v311.capture?.requestsPersisted ?? 0) - (v310?.capture?.requestsPersisted ?? 0),
        eventsRecorded: (v311.capture?.eventsRecorded ?? 0) - (v310?.capture?.eventsRecorded ?? 0),
      },
      machine: { node: process.version, platform: process.platform, arch: process.arch },
    };
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 700));
  }
}

const services = PHASE === "calib" ? CALIB : HEADLINE;
const modes = PHASE_MODES[PHASE];
const outDir = join(root, "results", "perf", PHASE === "calib" ? "calibration" : `phase${PHASE}`);
mkdirSync(outDir, { recursive: true });
const rand = mulberry32(SEED);

for (let rep = 1; rep <= REPS; rep += 1) {
  for (const [name, def] of Object.entries(services)) {
    for (const mode of shuffle(modes, rand)) {
      const row = await measure(name, def, mode, rep);
      writeFileSync(join(outDir, `perf-${name}-${mode}-rep${rep}.json`), `${JSON.stringify(row)}\n`);
      const sel = row.v31 ? ` sel=${row.v31.requestsSelected}/${row.v31.requestsSeen} als=${row.v31.alsEnabled}` : "";
      console.log(
        `${name}/${mode}/rep${rep}: p50=${row.p50.toFixed(2)} p95=${row.p95.toFixed(2)} rps=${row.throughputRps.toFixed(1)} err=${row.errors}${sel}`,
      );
    }
  }
}
console.log(`wrote ${outDir}`);
