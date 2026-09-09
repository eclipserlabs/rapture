// V2/V3 capture equivalence: the same failing-with-boundaries incident captured
// under frozen V2 code vs optimized V3 code must produce identical documents
// modulo volatile fields (req_id, captured_at, capture_hash). This proves the
// deferred-recording redesign preserves replay keys, redaction, and oracle
// inputs exactly. Exits nonzero on any material difference.
// Usage: node scripts/perf-equiv.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V2_REGISTER = join(root, "..", "reproducer-v2", "src", "capture", "register.mjs");
const V3_REGISTER = join(root, "src", "capture", "register.mjs");

const SVC_PORT = 47111;
const FAKE_PORT = 47119;

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

async function captureOnce(register, outDir, tag) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const fake = spawn(process.execPath, [join(root, "perf", "fake-external.mjs")], {
    env: { ...process.env, PORT: String(FAKE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);
  const env = { ...process.env };
  delete env["RAPTURE_V3_MODE"];
  const svc = spawn(process.execPath, ["--import", register, join(root, "perf", "service-a.mjs")], {
    env: {
      ...env,
      PORT: String(SVC_PORT),
      FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
      SHOP_API_KEY: "shop-test-key",
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_MODE: "capture",
      RAPTURE_V2_OUT: outDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(svc);
    const res = await fetch(`http://localhost:${SVC_PORT}/products/sku-1?fail=boom`);
    await res.text();
    await new Promise((r) => setTimeout(r, 800));
  } finally {
    try {
      svc.kill("SIGKILL");
    } catch {}
    try {
      fake.kill("SIGKILL");
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  if (files.length !== 1) throw new Error(`${tag}: expected 1 incident, got ${files.length}`);
  return JSON.parse(readFileSync(join(outDir, files[0]), "utf8"));
}

function stripVolatile(doc) {
  const { req_id, captured_at, capture_hash, ...rest } = doc;
  return rest;
}

// Wall-clock / random values differ across runs by nature (middleware
// request-id UUID, HTTP date header, time draws). Normalize them the same
// way the oracle does so the comparison tests capture fidelity, not clocks.
function normalizeRunVolatile(text) {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<ID>")
    .replace(/\b(1[0-9]{12}|[2-9][0-9]{12})\b/g, "<TS>")
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g, "<DATE>");
}

async function main() {
  const v2 = await captureOnce(V2_REGISTER, join(root, "results", "perf", "tmp-equiv-v2"), "v2");
  const v3 = await captureOnce(V3_REGISTER, join(root, "results", "perf", "tmp-equiv-v3"), "v3");
  const a = normalizeRunVolatile(JSON.stringify(stripVolatile(v2), null, 2));
  const b = normalizeRunVolatile(JSON.stringify(stripVolatile(v3), null, 2));
  if (a === b) {
    console.log(
      `EQUIVALENT: fingerprint=${v3.fingerprint.fingerprint_hash.slice(0, 12)} events=${v3.events.length} keys=${v3.events.map((e) => e.key).join("|").slice(0, 160)}`,
    );
    return;
  }
  console.log("V2 doc:", a.slice(0, 3000));
  console.log("V3 doc:", b.slice(0, 3000));
  throw new Error("V2/V3 capture documents differ materially");
}

await main();
