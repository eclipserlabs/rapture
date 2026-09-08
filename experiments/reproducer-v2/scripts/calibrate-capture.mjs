// Capture all 8 calibration incidents with the generic bootstrap.
// Usage: node calibrate-capture.mjs [--out <dir>]
// Boots real Postgres-backed service + fake external, fires triggers, verifies
// 8 persisted incidents. No incident-specific instrumentation.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const outIdx = process.argv.indexOf("--out");
const OUT = outIdx === -1 ? join(root, "results", "calibration", "captures") : process.argv[outIdx + 1];
mkdirSync(OUT, { recursive: true });

const SERVICE_PORT = 4891;
const FAKE_PORT = 4892;

function waitReady(child, timeoutMs = 15000) {
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

async function get(path) {
  const res = await fetch(`http://localhost:${SERVICE_PORT}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

async function main() {
  const fake = spawn(process.execPath, [join(root, "calibration", "service", "fake-runner.mjs")], {
    env: { ...process.env, PORT: String(FAKE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);
  const svcEnv = {
    ...process.env,
    PORT: String(SERVICE_PORT),
    FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
    REGION: "eu",
    TIER: "standard",
    TOKEN_TTL_MS: "60000",
    CAPTURE_CONFIG: "REGION,TIER,TOKEN_TTL_MS",
    RAPTURE_V2_MODE: "capture",
    RAPTURE_V2_OUT: OUT,
  };
  const svc = spawn(
    process.execPath,
    ["--import", join(root, "src", "capture", "register.mjs"), join(root, "calibration", "service", "server.mjs")],
    { env: svcEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitReady(svc);
  const now = Date.now();
  const triggers = [
    ["db-edge", `/orders/ord-bad`],
    ["malformed-json", `/profile?user=u-bad-shape`],
    ["upstream-503", `/price?sku=FAIL`],
    ["time-expiry", `/token?iat=${now - 120000}`],
    ["config-combo", `/store`],
    ["db-http-interaction", `/checkout?sku=sku-1&qty=10`],
    ["noise-heavy", `/dashboard`],
  ];
  const results = [];
  for (const [name, path] of triggers) {
    const r = await get(path);
    results.push({ name, path, status: r.status, body: r.body.slice(0, 120) });
    console.log(name, r.status, r.body.slice(0, 100));
  }
  // Random branch: retry until the faulty branch hits (successes discarded).
  let rollout = null;
  for (let i = 0; i < 30 && !rollout; i += 1) {
    const r = await get("/rollout");
    if (r.status >= 500) rollout = r;
  }
  results.push({ name: "random-branch", path: "/rollout", status: rollout?.status ?? 0, body: (rollout?.body ?? "NO FAILURE OBSERVED").slice(0, 120) });
  console.log("random-branch", rollout?.status ?? "MISS", (rollout?.body ?? "").slice(0, 100));
  // Healthy controls (must be discarded, not persisted).
  for (const p of ["/orders/ord-ok", "/store"]) {
    if (p === "/store") continue; // store fails under eu/standard config
    await get(p);
  }
  await new Promise((r) => setTimeout(r, 500));
  svc.kill();
  fake.kill();
  const files = readdirSync(OUT).filter((f) => f.endsWith(".json"));
  console.log(`persisted ${files.length} incident files`);
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(OUT, f), "utf8"));
    console.log(f, d.request.method, d.request.path, d.fingerprint.normalized_class, `events=${d.events.length}`);
  }
  if (files.length < 8) {
    console.error(`expected >=8 incidents, got ${files.length}`);
    process.exitCode = 1;
  }
}

await main();
