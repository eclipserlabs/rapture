// Headline perf: success-path overhead on 3 real headline services
// (express-qs, koa-1999, fastify-32442 at FIXED revisions, success triggers
// with pg+fetch on the path). 5 modes x 5 reps x 5000 requests, rotated
// order, warmed, concurrency 16. Mirrors calibration methodology.
// Usage: node perf-headline.mjs [--reps 5] [--requests 5000]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const NODE = process.env["NODE22"] ?? process.execPath;
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const REPS = Number(arg("--reps", "5"));
const N = Number(arg("--requests", "5000"));
const CONC = 16;
const WARM = 500;
const OUT = join(root, "results", "headline", "perf");

const SERVICES = {
  "express-qs": {
    svc: "express-qs.mjs",
    env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" },
    port: 47601,
    req: (i) => ({ path: `/parse?q=a%5B%5D%3D${i % 3},${(i % 3) + 1}` }),
  },
  "koa-1999": {
    svc: "koa-1999.mjs",
    env: { REPO_ROOT: `${CORPUS}koa-571938d` },
    port: 47602,
    req: (i) => ({ path: `/u?q=${i % 7}` }),
  },
  "fastify-32442": {
    svc: "fastify-32442.mjs",
    env: { REPO_ROOT: `${CORPUS}fastify-5.3.2` },
    port: 47603,
    req: (i) => ({
      method: "POST",
      path: "/v",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: true, n: i % 11 }),
    }),
  },
};

const MODES = ["off", "context-only", "intercept-discard", "capture", "failed-persist"];
const MODE_ENV = {
  off: "off",
  "context-only": "context-only",
  "intercept-discard": "intercept-discard",
  capture: "capture",
  "failed-persist": "capture",
};

function startService(svc, mode, port) {
  return new Promise((resolve, reject) => {
    const outDir = join("/tmp", `hlperf-${svc}-${mode}-out`);
    mkdirSync(outDir, { recursive: true });
    const env = {
      ...process.env,
      ...SERVICES[svc].env,
      PORT: String(port),
      RAPTURE_V3_MODE: MODE_ENV[mode],
      RAPTURE_V2_OUT: outDir,
    };
    const child = spawn(NODE, ["--import", REGISTER, join(here, "services", SERVICES[svc].svc)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`READY timeout ${svc}/${mode}: ${out.slice(-1000)}`));
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
      reject(new Error(`exit ${code} ${svc}/${mode}: ${out.slice(-1000)}`));
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

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function measure(svc, mode, rep) {
  const { port } = SERVICES[svc];
  const child = await startService(svc, mode, port);
  try {
    const stats = async () =>
      (await (await fetch(`http://localhost:${port}/__stats`)).json());
    const build = (i) => SERVICES[svc].req(i);
    await runPool(port, Array.from({ length: WARM }, (_, i) => build(i)));
    const stats0 = await stats();
    const items = Array.from({ length: N }, (_, i) => build(i + WARM));
    const wall0 = Date.now();
    const results = await runPool(port, items);
    const wallMs = Date.now() - wall0;
    const stats1 = await stats();
    const lat = results.filter((r) => r.ms >= 0).map((r) => r.ms).sort((a, b) => a - b);
    const failed = results.filter((r) => r.status >= 500).length;
    const errors = results.filter((r) => r.ms < 0).length;
    return {
      svc,
      mode,
      rep,
      n: lat.length,
      requests: N,
      concurrency: CONC,
      p50: quantile(lat, 0.5),
      p90: quantile(lat, 0.9),
      p95: quantile(lat, 0.95),
      p99: quantile(lat, 0.99),
      mean: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
      throughputRps: (lat.length / Math.max(1, wallMs)) * 1000,
      wallMs,
      failedCount: failed,
      errors,
      latencies: lat.map((v) => Math.round(v * 1000) / 1000),
      statuses: results.map((r) => r.status),
      stats0,
      stats1,
      machine: { node: process.version, platform: process.platform, arch: process.arch },
    };
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 800));
  }
}

mkdirSync(OUT, { recursive: true });
// Rotated order per rep to reduce order bias.
const orders = [];
for (let rep = 1; rep <= REPS; rep++) {
  const rotated = MODES.map((_, i) => MODES[(i + rep) % MODES.length]);
  for (const svc of Object.keys(SERVICES)) orders.push({ svc, rep, modes: rotated });
}
for (const { svc, rep, modes } of orders) {
  for (const mode of modes) {
    const row = await measure(svc, mode, rep);
    writeFileSync(join(OUT, `perf-${svc}-${mode}-rep${rep}.json`), `${JSON.stringify(row, null, 2)}\n`);
    console.log(`${svc}/${mode}/rep${rep}: p50=${row.p50.toFixed(2)} p95=${row.p95.toFixed(2)} rps=${row.throughputRps.toFixed(1)} failed=${row.failedCount} err=${row.errors}`);
  }
}
console.log(`wrote ${OUT}`);
