// Capture overhead: same fixed workload across three modes.
// Usage: node measure-overhead.mjs
// Modes: off (no bootstrap), capture-discard (capture on, all-success workload),
// capture-persist (capture on, workload includes failures).
// Metrics: median/p95 latency, throughput, server RSS, bytes recorded/persisted.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const SERVICE_PORT = 4895;
const FAKE_PORT = 4896;
const WARMUP = 20;
const N = 150;

const HEALTHY = ["/orders/ord-ok", "/profile?user=u-ok", "/price?sku=sku-1", "/store", "/checkout?sku=sku-noise&qty=1"];
const MIXED = [...HEALTHY, "/orders/ord-bad", "/price?sku=FAIL"];

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function startProc(entry, env, label) {
  return new Promise((resolve, reject) => {
    const args = entry === "fake" ? [join(root, "calibration", "service", "fake-runner.mjs")] : ["--import", join(root, "src", "capture", "register.mjs"), join(root, "calibration", "service", "server.mjs")];
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error(`${label} boot timeout`)), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", () => {});
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited ${c}`));
    });
  });
}

async function workload(paths) {
  const lat = [];
  const t0 = Date.now();
  for (let i = 0; i < paths.length; i += 1) {
    const t = Date.now();
    const res = await fetch(`http://localhost:${SERVICE_PORT}${paths[i]}`);
    await res.text();
    lat.push(Date.now() - t);
  }
  const total = Date.now() - t0;
  lat.sort((a, b) => a - b);
  return { median: percentile(lat, 50), p95: percentile(lat, 95), totalMs: total, rps: (paths.length / total) * 1000 };
}

async function stats() {
  const res = await fetch(`http://localhost:${SERVICE_PORT}/__v2stats`);
  return res.json();
}

async function runMode(name, useCapture, paths, extraEnv = {}) {
  const fake = await startProc("fake", { ...process.env, PORT: String(FAKE_PORT) }, "fake");
  const env = {
    ...process.env,
    PORT: String(SERVICE_PORT),
    FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
    REGION: "us",
    TIER: "standard",
    TOKEN_TTL_MS: "60000",
    CAPTURE_CONFIG: "REGION,TIER,TOKEN_TTL_MS",
    ...extraEnv,
  };
  if (useCapture) {
    env.RAPTURE_V2_MODE = "capture";
    env.RAPTURE_V2_OUT = join(root, "results", "overhead-tmp");
  }
  mkdirSync(join(root, "results", "overhead-tmp"), { recursive: true });
  const svc = await startProc("svc", env, `svc-${name}`);
  await workload(paths.slice(0, WARMUP));
  const before = await stats();
  const w = await workload(paths);
  const after = await stats();
  svc.kill();
  fake.kill();
  await new Promise((r) => setTimeout(r, 300));
  return {
    mode: name,
    median_ms: w.median,
    p95_ms: w.p95,
    rps: Math.round(w.rps * 10) / 10,
    rss_before: before.rss,
    rss_after: after.rss,
    rss_delta: after.rss - before.rss,
    last_request_bytes_recorded: after.lastBytesRecorded ?? 0,
    persisted: after.requestsPersisted - before.requestsPersisted,
  };
}

async function main() {
  const healthy = Array.from({ length: N }, (_, i) => HEALTHY[i % HEALTHY.length]);
  const mixed = Array.from({ length: N }, (_, i) => MIXED[i % MIXED.length]);
  const off = await runMode("off", false, healthy);
  const discard = await runMode("capture-discard", true, healthy);
  const persist = await runMode("capture-persist", true, mixed);
  const pct = (a, b) => (b === 0 ? 0 : Math.round(((a - b) / b) * 1000) / 10);
  const rows = [off, discard, persist];
  const out = {
    rows,
    overhead_discard_vs_off: { median_pct: pct(discard.median_ms, off.median_ms), p95_pct: pct(discard.p95_ms, off.p95_ms) },
    overhead_persist_vs_off: { median_pct: pct(persist.median_ms, off.median_ms), p95_pct: pct(persist.p95_ms, off.p95_ms) },
  };
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "results", "overhead.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

await main();
