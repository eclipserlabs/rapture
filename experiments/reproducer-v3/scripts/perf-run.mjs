// V3 perf single-run harness: boots fake + one calibration service in a given
// mode, warms up, measures a fixed workload, stores raw latencies + service
// telemetry. Mode order rotation and repetition live in perf-campaign.mjs.
// Usage: node scripts/perf-run.mjs --service a|b --mode off|capture|context-only|intercept-discard|failed-persist [--requests 5000] [--concurrency 16] [--rep 1] [--out results/perf/raw] [--cpu-prof-dir <dir>]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");

const PG_URL = new URL("../../reproducer-v2/node_modules/pg/lib/index.js", import.meta.url);
const { default: pg } = await import(PG_URL.href);

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

const SERVICE = arg("--service", "a");
const MODE = arg("--mode", "off");
const N = Number(arg("--requests", "5000"));
const CONC = Number(arg("--concurrency", "16"));
const REP = Number(arg("--rep", "1"));
const OUT = arg("--out", join(root, "results", "perf", "raw"));
const CPU_PROF_DIR = arg("--cpu-prof-dir", null);

const SVC_PORT = SERVICE === "a" ? 47101 : 47102;
const FAKE_PORT = 47109;

function workloadA(i) {
  const k = i % 5;
  if (k === 0) return { method: "GET", path: "/products" };
  if (k === 1) return { method: "GET", path: "/products/sku-1" };
  if (k === 2) return { method: "GET", path: "/products/sku-2" };
  if (k === 3) {
    return {
      method: "POST",
      path: "/orders",
      headers: { "content-type": "application/json", "x-api-key": "shop-test-key" },
      body: JSON.stringify({ sku: "sku-1", qty: (i % 3) + 1 }),
    };
  }
  return { method: "GET", path: "/products/sku-3" };
}

function workloadB(i) {
  const k = i % 5;
  const cookie = { cookie: "sid=sess-alice" };
  if (k === 0) return { method: "GET", path: "/users/u-1", headers: cookie };
  if (k === 1) return { method: "GET", path: "/search?q=ali", headers: cookie };
  if (k === 2) return { method: "GET", path: "/config", headers: cookie };
  if (k === 3) {
    return {
      method: "POST",
      path: "/events",
      headers: { ...cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "click", payload: { n: i } }),
    };
  }
  return { method: "GET", path: "/users/u-2", headers: cookie };
}

function buildWorkload(failed) {
  const base = SERVICE === "a" ? workloadA : workloadB;
  const arr = [];
  for (let i = 0; i < N; i += 1) {
    if (failed && i % 10 === 9) arr.push({ method: "GET", path: "/boom" });
    else arr.push(base(i));
  }
  return arr;
}

async function doRequest(spec) {
  const t0 = performance.now();
  const res = await fetch(`http://localhost:${SVC_PORT}${spec.path}`, {
    method: spec.method,
    headers: spec.headers,
    body: spec.body,
    signal: AbortSignal.timeout(15000),
  });
  await res.arrayBuffer();
  return { ms: performance.now() - t0, status: res.status };
}

async function runPool(items, conc) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = await doRequest(items[i]);
      } catch (e) {
        out[i] = { ms: -1, status: 0, error: String(e?.message ?? e).slice(0, 120) };
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

function waitReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting READY")), timeoutMs);
    child.stdout.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[child] ${d}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code}`));
    });
  });
}

async function stats() {
  const res = await fetch(`http://localhost:${SVC_PORT}/__v3stats`);
  return res.json();
}

async function truncate() {
  const pool = new pg.Pool({
    host: process.env["PGHOST"] ?? "localhost",
    port: Number(process.env["PGPORT"] ?? 5432),
    user: process.env["PGUSER"] ?? "wira",
    database: process.env["PGDATABASE"] ?? "repro_v2",
  });
  await pool.query("TRUNCATE v3shop_orders");
  await pool.query("TRUNCATE v3dir_events");
  await pool.end();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const failed = MODE === "failed-persist";
  const useImport = MODE !== "off";
  await truncate();

  const fake = spawn(process.execPath, [join(root, "perf", "fake-external.mjs")], {
    env: { ...process.env, PORT: String(FAKE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);

  const svcFile = join(root, "perf", SERVICE === "a" ? "service-a.mjs" : "service-b.mjs");
  const svcArgs = useImport ? ["--import", REGISTER, svcFile] : [svcFile];
  if (CPU_PROF_DIR) svcArgs.unshift(`--cpu-prof`, `--cpu-prof-dir=${CPU_PROF_DIR}`, `--cpu-prof-name=svc-${SERVICE}-${MODE}.cpuprofile`);
  const svcEnv = {
    ...process.env,
    PORT: String(SVC_PORT),
    FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
    SHOP_API_KEY: "shop-test-key",
    CAPTURE_CONFIG: "FAKE_ORIGIN",
  };
  if (MODE === "off") {
    delete svcEnv["RAPTURE_V2_MODE"];
    delete svcEnv["RAPTURE_V3_MODE"];
  } else if (MODE === "capture" || failed) {
    svcEnv["RAPTURE_V2_MODE"] = "capture";
    svcEnv["RAPTURE_V2_OUT"] = join(root, "results", "perf", "tmp-persist");
  } else {
    svcEnv["RAPTURE_V3_MODE"] = MODE;
    svcEnv["RAPTURE_V2_OUT"] = join(root, "results", "perf", "tmp-persist");
  }
  mkdirSync(join(root, "results", "perf", "tmp-persist"), { recursive: true });
  const svc = spawn(process.execPath, svcArgs, { env: svcEnv, stdio: ["ignore", "pipe", "pipe"] });
  const finish = async () => {
    // SIGTERM first so --cpu-prof profiles flush on exit; escalate to kill.
    try {
      svc.kill("SIGTERM");
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(r, 5000);
      svc.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
    try {
      svc.kill("SIGKILL");
    } catch {}
    try {
      fake.kill("SIGKILL");
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  };
  try {
    await waitReady(svc);
    const stats0 = await stats();
    // Warmup: fixed 500-request mix, unmeasured.
    await runPool(buildWorkload(false).slice(0, 500), CONC);
    const items = buildWorkload(failed);
    const t0 = Date.now();
    const results = await runPool(items, CONC);
    const wallMs = Date.now() - t0;
    const stats1 = await stats();
    const file = join(OUT, `perf-${SERVICE}-${MODE}-rep${REP}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          service: SERVICE,
          mode: MODE,
          rep: REP,
          requests: N,
          concurrency: CONC,
          failedMix: failed,
          wallMs,
          latencies: results.map((r) => Math.round(r.ms * 1000) / 1000),
          statuses: results.map((r) => r.status),
          errors: results.filter((r) => r.status === 0).length,
          stats0,
          stats1,
          machine: { node: process.version, platform: process.platform, arch: process.arch },
        },
      ),
    );
    const ok = results.filter((r) => r.status >= 200 && r.status < 500).length;
    console.log(`${SERVICE}/${MODE}/rep${REP}: n=${N} ok=${ok} wall=${wallMs}ms file=${file}`);
  } finally {
    await finish();
  }
}

await main();
