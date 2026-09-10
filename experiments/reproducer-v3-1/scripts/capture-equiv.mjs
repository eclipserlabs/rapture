// V3 / V3.1 capture equivalence.
//
// A request SELECTED by V3.1 must produce exactly the document frozen V3
// produced, modulo run-volatile fields. This is what lets V3.1 inherit V3's
// correctness evidence: selective deployment changes WHICH requests are
// captured, never HOW a captured request is recorded.
//
// Compares three documents on the same failing request:
//   1. frozen V3 register           (always-on capture)
//   2. V3.1 register, always-on     (selector selects everything)
//   3. V3.1 register, sampling@1.0  (selector selects via Bernoulli draw)
//
// Uses a V3 CALIBRATION service (never a headline service).
// Usage: node scripts/capture-equiv.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const V3_REGISTER = join(V3, "src", "capture", "register.mjs");
const V31_REGISTER = join(root, "src", "capture", "register.mjs");
const SVC_PORT = 47311;
const FAKE_PORT = 47319;

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
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code}: ${out.slice(-600)}`));
    });
  });
}

async function captureOnce(register, outDir, extraEnv, tag) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const fake = spawn(process.execPath, [join(V3, "perf", "fake-external.mjs")], {
    env: { ...process.env, PORT: String(FAKE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);
  const env = { ...process.env };
  delete env["RAPTURE_V3_MODE"];
  delete env["RAPTURE_V31_STRATEGY"];
  const svc = spawn(process.execPath, ["--import", register, join(V3, "perf", "service-a.mjs")], {
    env: {
      ...env,
      PORT: String(SVC_PORT),
      FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
      SHOP_API_KEY: "shop-test-key",
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_MODE: "capture",
      RAPTURE_V2_OUT: outDir,
      ...extraEnv,
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
    } catch {
      // already gone
    }
    try {
      fake.kill("SIGKILL");
    } catch {
      // already gone
    }
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

function normalizeRunVolatile(text) {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<ID>")
    .replace(/\b(1[0-9]{12}|[2-9][0-9]{12})\b/g, "<TS>")
    .replace(
      /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g,
      "<DATE>",
    );
}

const canon = (doc) => normalizeRunVolatile(JSON.stringify(stripVolatile(doc), null, 2));
const tmp = (n) => join(root, "results", "tmp-equiv", n);

const v3 = await captureOnce(V3_REGISTER, tmp("v3"), {}, "v3");
const v31Always = await captureOnce(
  V31_REGISTER,
  tmp("v31-always"),
  { RAPTURE_V31_STRATEGY: "always-on" },
  "v31-always-on",
);
const v31Sampled = await captureOnce(
  V31_REGISTER,
  tmp("v31-sampled"),
  { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1", RAPTURE_V31_SEED: "12345" },
  "v31-sampling",
);

const a = canon(v3);
const b = canon(v31Always);
const c = canon(v31Sampled);
const failures = [];
if (a !== b) failures.push("v3 vs v3.1 always-on");
if (a !== c) failures.push("v3 vs v3.1 sampling@1.0");
if (failures.length) {
  console.log("V3  :", a.slice(0, 2500));
  console.log("V31 :", b.slice(0, 2500));
  throw new Error(`capture documents differ materially: ${failures.join(", ")}`);
}
console.log(
  `EQUIVALENT (v3 == v3.1 always-on == v3.1 sampled): fingerprint=${v3.fingerprint.fingerprint_hash.slice(0, 12)} events=${v3.events.length}`,
);
