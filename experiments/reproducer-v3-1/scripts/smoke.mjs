// V3.1 calibration smoke: boots a V3 CALIBRATION service (never a headline
// service) under each strategy and checks the selective-capture contract
// end to end. Not a gate; a fast development check before the real phases.
// Usage: node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(V3, "perf", "service-a.mjs");
const FAKE = join(V3, "perf", "fake-external.mjs");
const SVC_PORT = 47301;
const FAKE_PORT = 47309;

function waitReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting READY")), timeoutMs);
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`service exited ${c}: ${out.slice(-800)}`));
    });
  });
}

const get = async (path) => {
  const r = await fetch(`http://localhost:${SVC_PORT}${path}`);
  return { status: r.status, body: await r.text() };
};
const stats = async () => (await fetch(`http://localhost:${SVC_PORT}/__rapture31`)).json();

async function scenario(name, env, steps) {
  const outDir = mkdtempSync(join(tmpdir(), "v31-smoke-"));
  const svc = spawn(
    process.execPath,
    ["--import", REGISTER, SVC],
    {
      env: {
        ...process.env,
        PORT: String(SVC_PORT),
        FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
        SHOP_API_KEY: "shop-test-key",
        CAPTURE_CONFIG: "FAKE_ORIGIN",
        RAPTURE_V2_OUT: outDir,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await waitReady(svc);
    const result = await steps(outDir);
    console.log(`${name}: ${result}`);
  } finally {
    svc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 250));
    rmSync(outDir, { recursive: true, force: true });
  }
}

const fake = spawn(process.execPath, [FAKE], {
  env: { ...process.env, PORT: String(FAKE_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
await waitReady(fake);

try {
  // 1. detector-only: failures observed, nothing captured, ALS never enabled.
  await scenario("detector-only", { RAPTURE_V31_STRATEGY: "detector-only" }, async (out) => {
    await get("/products");
    const boom = await get("/boom");
    const s = await stats();
    const files = readdirSync(out).length;
    return `boom=${boom.status} seen=${s.selector.stats.requestsSeen} selected=${s.selector.stats.requestsSelected} failuresObserved=${s.selector.stats.failuresObserved} alsEnabled=${s.alsEnabled} artifacts=${files} (expect selected=0 alsEnabled=false artifacts=0)`;
  });

  // 2. targeted: first failure arms, a LATER failure is captured.
  await scenario(
    "targeted",
    { RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V2_MODE: "capture", RAPTURE_V31_TTL_MS: "60000", RAPTURE_V31_BUDGET: "50" },
    async (out) => {
      const first = await get("/boom");
      const afterFirst = readdirSync(out).length;
      await get("/products");
      const second = await get("/boom");
      await new Promise((r) => setTimeout(r, 400));
      const s = await stats();
      const afterSecond = readdirSync(out).length;
      return `first=${first.status} artifactsAfterFirst=${afterFirst} second=${second.status} artifactsAfterSecond=${afterSecond} armEvents=${s.selector.stats.armEvents} captured=${s.selector.stats.capturedIncidents} disarmCaptured=${s.selector.stats.disarmCaptured} (expect afterFirst=0 afterSecond=1)`;
    },
  );

  // 3. sampling at 100%: every request selected, failure captured immediately.
  await scenario(
    "sampling-1.0",
    { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1", RAPTURE_V2_MODE: "capture" },
    async (out) => {
      await get("/products");
      await get("/boom");
      await new Promise((r) => setTimeout(r, 400));
      const s = await stats();
      return `seen=${s.selector.stats.requestsSeen} selected=${s.selector.stats.requestsSelected} artifacts=${readdirSync(out).length} (expect selected=seen artifacts=1)`;
    },
  );

  // 4. sampling at 0%: a one-off failure yields NO artifact (no retroactivity).
  await scenario(
    "sampling-0.0",
    { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0", RAPTURE_V2_MODE: "capture" },
    async (out) => {
      await get("/boom");
      await new Promise((r) => setTimeout(r, 400));
      const s = await stats();
      return `selected=${s.selector.stats.requestsSelected} artifacts=${readdirSync(out).length} (expect selected=0 artifacts=0)`;
    },
  );
} finally {
  fake.kill("SIGKILL");
}
