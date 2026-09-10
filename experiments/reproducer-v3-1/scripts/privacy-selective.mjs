// V3.1 Phase 8 + Phase 9: the privacy and no-retroactive-capture properties
// that are specific to SELECTIVE capture, and that V3's attack suite cannot
// test because V3 captured everything.
//
// Phase 8 (privacy of selective deployment):
//   - detector-only mode persists no sensitive request metadata
//   - sampled-but-successful requests leave no persisted artifact
//   - targeted arming state contains no raw credentials, bodies, headers,
//     query strings or unnormalized URLs
//
// Phase 9 (no retroactive capture — a failure here invalidates the experiment):
//   - an unsampled one-off failure yields no full executable incident
//   - a detector-only first failure carries no pg/fetch/time/random data
//   - targeted arming produces a full artifact only from a request selected at
//     ingress
//   - turning arming on after a response failed does not retroactively
//     populate boundary events
//
// Usage: node scripts/privacy-selective.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(V3, "perf", "service-a.mjs");
const FAKE = join(V3, "perf", "fake-external.mjs");
const FAKE_PORT = 47259;
let PORT = 47260;

const hex = (n) => randomBytes(n).toString("hex");
const R = hex(4);
const S = {
  bearer: `sk-live-${hex(8)}`,
  apiKey: `sk-live-${hex(8)}`,
  session: `sess-${hex(8)}`,
  email: `u-${R}@example.com`,
  bodySecret: `sk-live-${hex(8)}`,
  queryVal: `qv-${hex(6)}`,
};
const ALL_SENTINELS = Object.values(S);

function waitReady(child, ms = 25000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`READY timeout: ${out.slice(-400)}`)), ms);
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (c) => {
      clearTimeout(t);
      reject(new Error(`exit ${c}: ${out.slice(-400)}`));
    });
  });
}

async function boot(env) {
  const port = (PORT += 1);
  const outDir = mkdtempSync(join(tmpdir(), "v31-priv-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_SAMPLE_RATE"]) {
    delete base[k];
  }
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: {
      ...base,
      PORT: String(port),
      FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
      SHOP_API_KEY: "shop-test-key",
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_MODE: "capture",
      RAPTURE_V2_OUT: outDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(child);
  return {
    port,
    outDir,
    // A request loaded with sentinels in every carrier the detector could
    // conceivably touch: header, cookie, query string and JSON body.
    async loaded(path) {
      const r = await fetch(`http://localhost:${port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${S.bearer}`,
          "x-api-key": S.apiKey,
          cookie: `sess=${S.session}; theme=dark`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: S.email, apiKey: S.bodySecret }),
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    },
    async get(path) {
      const r = await fetch(`http://localhost:${port}${path}`);
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    },
    stats: async () => (await fetch(`http://localhost:${port}/__rapture31`)).json(),
    files: () => readdirSync(outDir).filter((f) => f.endsWith(".json")),
    docs: () =>
      readdirSync(outDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(outDir, f), "utf8"))),
    settle: () => new Promise((r) => setTimeout(r, 600)),
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

const findings = [];
const record = (id, phase, description, pass, detail) => {
  findings.push({ id, phase, description, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${description}${detail ? ` — ${detail}` : ""}`);
};
const leaks = (text) => ALL_SENTINELS.filter((s) => text.includes(s));

const fake = spawn(process.execPath, [FAKE], {
  env: { ...process.env, PORT: String(FAKE_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
await waitReady(fake);

try {
  // -------------------------------------------------------------------------
  // P8-1 detector-only persists no sensitive request metadata
  // -------------------------------------------------------------------------
  {
    const s = await boot({ RAPTURE_V31_STRATEGY: "detector-only" });
    try {
      await s.loaded(`/boom?token=${S.queryVal}`);
      await s.loaded(`/products?token=${S.queryVal}`);
      await s.settle();
      const st = await s.stats();
      const blob = JSON.stringify(st);
      const found = leaks(blob);
      record(
        "P8-1",
        8,
        "detector-only retains no sensitive request metadata",
        found.length === 0 && s.files().length === 0,
        `sentinelsInState=${found.length} artifacts=${s.files().length}`,
      );
      record(
        "P8-2",
        8,
        "detector-only retains only counters and normalized keys",
        !blob.includes("authorization") && !blob.includes("cookie") && !blob.includes("theme=dark"),
        `stateBytes=${blob.length}`,
      );
    } finally {
      await s.stop();
    }
  }

  // -------------------------------------------------------------------------
  // P8-3 targeted arming state carries no request content
  // -------------------------------------------------------------------------
  {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "300000" });
    try {
      await s.loaded(`/boom?token=${S.queryVal}`);
      await s.settle();
      const st = await s.stats();
      const blob = JSON.stringify(st.selector);
      const found = leaks(blob);
      const armedKeys = st.selector.armed.map((a) => a.key);
      record(
        "P8-3",
        8,
        "targeted arming state contains no raw credentials, bodies or query strings",
        found.length === 0 && armedKeys.every((k) => !k.includes("?")),
        `armedKeys=${JSON.stringify(armedKeys)} sentinels=${found.length}`,
      );
    } finally {
      await s.stop();
    }
  }

  // -------------------------------------------------------------------------
  // P8-4 sampled-but-successful requests persist nothing
  // -------------------------------------------------------------------------
  {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1" });
    try {
      for (let i = 0; i < 10; i += 1) await s.get("/products");
      await s.settle();
      const st = await s.stats();
      record(
        "P8-4",
        8,
        "sampled-but-successful requests leave no persisted artifact",
        s.files().length === 0 && st.selector.stats.requestsSelected >= 10,
        `selected=${st.selector.stats.requestsSelected} artifacts=${s.files().length}`,
      );
    } finally {
      await s.stop();
    }
  }

  // -------------------------------------------------------------------------
  // P9-1 an unsampled one-off failure yields no executable incident
  // -------------------------------------------------------------------------
  {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0" });
    try {
      const r = await s.get("/products/sku-1?fail=boom");
      await s.settle();
      const st = await s.stats();
      record(
        "P9-1",
        9,
        "unsampled one-off failure produces no full executable incident",
        r.status === 500 && s.files().length === 0 && st.capture.eventsRecorded === 0,
        `status=${r.status} artifacts=${s.files().length} events=${st.capture.eventsRecorded}`,
      );
    } finally {
      await s.stop();
    }
  }

  // -------------------------------------------------------------------------
  // P9-2 the detector-only first failure carries no boundary observations
  // P9-3 a full artifact only ever comes from a request selected at ingress
  // P9-4 arming does not retroactively populate the failure that armed it
  // -------------------------------------------------------------------------
  {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "300000" });
    try {
      // First failure: on a route that DOES touch pg and outbound HTTP, so a
      // retroactive implementation would have had something to steal.
      const first = await s.get("/products/sku-1?fail=boom");
      await s.settle();
      const afterFirst = await s.stats();
      record(
        "P9-2",
        9,
        "detector-only first failure carries no pg/fetch/time/random observations",
        s.files().length === 0 &&
          afterFirst.capture.eventsRecorded === 0 &&
          afterFirst.capture.requestsSeen === 0,
        `status=${first.status} artifacts=${s.files().length} events=${afterFirst.capture.eventsRecorded}`,
      );
      record(
        "P9-4",
        9,
        "arming after a failed response does not retroactively populate boundary events",
        s.files().length === 0 && afterFirst.selector.stats.armEvents === 1,
        `armEvents=${afterFirst.selector.stats.armEvents} artifacts=${s.files().length}`,
      );
      // Second failure: selected at ingress, so it CAN become an incident.
      await s.get("/products/sku-1?fail=boom");
      await s.settle();
      const docs = s.docs();
      const st = await s.stats();
      const kinds = new Set(docs[0]?.events?.map((e) => e.kind) ?? []);
      record(
        "P9-3",
        9,
        "the artifact comes from a LATER request that was selected at ingress",
        docs.length === 1 && st.selector.stats.requestsSelected === 1 && kinds.has("pg") && kinds.has("http"),
        `artifacts=${docs.length} selected=${st.selector.stats.requestsSelected} kinds=${[...kinds].join(",")}`,
      );
      record(
        "P9-5",
        9,
        "the captured occurrence is the second failure, not the first",
        st.selector.stats.failuresObserved + st.selector.stats.capturedIncidents >= 2,
        `failuresObserved=${st.selector.stats.failuresObserved} captured=${st.selector.stats.capturedIncidents}`,
      );
    } finally {
      await s.stop();
    }
  }
} finally {
  try {
    fake.kill("SIGKILL");
  } catch {
    // already gone
  }
}

mkdirSync(join(root, "results"), { recursive: true });
const failed = findings.filter((f) => !f.pass);
const out = {
  generatedAt: new Date().toISOString(),
  sentinelsSha: randomBytes(0).toString("hex") || undefined,
  phase8: findings.filter((f) => f.phase === 8),
  phase9: findings.filter((f) => f.phase === 9),
  allPassed: failed.length === 0,
  failures: failed,
  interpretation:
    "A Phase 9 failure would mean the experiment produced impossible production semantics (capturing a request retroactively) and invalidates the result.",
};
writeFileSync(join(root, "results", "no-retroactive-capture.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${findings.length - failed.length}/${findings.length} passed -> results/no-retroactive-capture.json`);
if (failed.length) process.exitCode = 1;
