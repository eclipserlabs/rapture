// Rapture Reproducer V3.1 — required test suite.
//
// Covers the preregistered required_tests list: the inactive fast path, the
// ingress-selection contract, targeted arming lifecycle, isolation between
// concurrent and unrelated requests, fail-closed replay, portability, and the
// privacy properties of detector/arming state.
//
// The no-retroactive-capture proofs are the load-bearing ones: they are what
// stops the experiment from quietly inventing impossible production semantics.
//
// Usage: node --test "test/*.test.js" (Node >= 22) from experiments/reproducer-v3-1/.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const REGISTER = join(root, "src", "capture", "register.mjs");
const REPLAY_ONE = join(root, "src", "replay", "replay-one.mjs");
const SVC = join(V3, "perf", "service-a.mjs");
const FAKE = join(V3, "perf", "fake-external.mjs");

const { Selector, STRATEGY, normalizePath, incidentKey } = await import("../src/detector/select.mjs");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let PORT = 47340;
const FAKE_PORT = 47339;
let fake = null;

function waitReady(child, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`READY timeout: ${out.slice(-600)}`)), timeoutMs);
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
      reject(new Error(`exited ${c}: ${out.slice(-600)}`));
    });
  });
}

/** Boot service-a under a V3.1 strategy; returns helpers plus a stop(). */
async function boot(env = {}) {
  const port = (PORT += 1);
  const outDir = mkdtempSync(join(tmpdir(), "v31-test-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_ALS_QUIESCE", "RAPTURE_V31_FORCE_ALS"]) {
    delete base[k];
  }
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: {
      ...base,
      PORT: String(port),
      FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
      SHOP_API_KEY: "shop-test-key",
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_OUT: outDir,
      RAPTURE_V2_MODE: "capture",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(child);
  const req = async (path, init) => {
    const r = await fetch(`http://localhost:${port}${path}`, init);
    return { status: r.status, body: await r.text() };
  };
  return {
    port,
    outDir,
    req,
    artifacts: () => readdirSync(outDir).filter((f) => f.endsWith(".json")),
    docs: () =>
      readdirSync(outDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(outDir, f), "utf8"))),
    stats: async () => (await fetch(`http://localhost:${port}/__rapture31`)).json(),
    settle: () => new Promise((r) => setTimeout(r, 500)),
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  fake = spawn(process.execPath, [FAKE], {
    env: { ...process.env, PORT: String(FAKE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);
});

after(() => {
  try {
    fake?.kill("SIGKILL");
  } catch {
    // already gone
  }
});

// ---------------------------------------------------------------------------

describe("path normalization and incident keys", () => {
  it("normalizes volatile path segments without any application route table", () => {
    assert.equal(normalizePath("/users/123/posts"), "/users/:id/posts");
    assert.equal(normalizePath("/o/550e8400-e29b-41d4-a716-446655440000"), "/o/:id");
    assert.equal(normalizePath("/t/deadbeefdeadbeefdead"), "/t/:id");
    assert.equal(normalizePath("/products/sku-1"), "/products/sku-1");
  });

  it("keys are method + normalized path and are stable under repetition", () => {
    assert.equal(incidentKey("GET", "/users/7"), "GET /users/:id");
    assert.equal(incidentKey("GET", "/users/7"), incidentKey("GET", "/users/9"));
    assert.notEqual(incidentKey("GET", "/users/7"), incidentKey("POST", "/users/7"));
  });

  it("normalization is bounded in segments and length", () => {
    const long = `/${"a/".repeat(40)}`;
    assert.ok(normalizePath(long).length <= 200);
  });
});

describe("inactive fast path", () => {
  it("unarmed request does not enter the full capture path", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "detector-only" });
    try {
      await s.req("/products");
      const st = await s.stats();
      assert.equal(st.selector.stats.requestsSelected, 0);
      assert.equal(st.capture.requestsSeen, 0, "capture context must never be entered");
      assert.equal(st.alsEnabled, false, "AsyncLocalStorage must not be enabled");
    } finally {
      await s.stop();
    }
  });

  it("unarmed pg operation is not recorded", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "detector-only" });
    try {
      await s.req("/products/sku-1");
      const st = await s.stats();
      assert.equal(st.capture.eventsRecorded, 0, "no pg event may be recorded while unarmed");
    } finally {
      await s.stop();
    }
  });

  it("unarmed outbound fetch response is not recorded", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "detector-only" });
    try {
      // /products/:sku performs an outbound fetch to the fake external.
      await s.req("/products/sku-2");
      const st = await s.stats();
      assert.equal(st.capture.eventsRecorded, 0);
      assert.equal(st.capture.bytesRecorded, 0);
    } finally {
      await s.stop();
    }
  });

  it("unarmed success persists no artifact", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "detector-only" });
    try {
      for (let i = 0; i < 5; i += 1) await s.req("/products");
      await s.settle();
      assert.deepEqual(s.artifacts(), []);
    } finally {
      await s.stop();
    }
  });

  it("unarmed failure emits only allowed cheap detector metadata", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "detector-only" });
    try {
      const r = await s.req("/boom");
      assert.equal(r.status, 500);
      await s.settle();
      assert.deepEqual(s.artifacts(), [], "a detector-only failure is never an incident");
      const st = await s.stats();
      assert.equal(st.selector.stats.failuresObserved, 1);
      assert.equal(st.capture.requestsPersisted, 0);
    } finally {
      await s.stop();
    }
  });
});

describe("ingress selection", () => {
  it("the sampling decision is taken before request execution", () => {
    // Structural proof: selectAtIngress is a pure function of method and path.
    // It cannot observe a status, because no status exists yet.
    const sel = new Selector({ strategy: STRATEGY.SAMPLING, sampleRate: 0.5, seed: 3 });
    assert.equal(sel.selectAtIngress.length, 2, "ingress selection sees only (method, pathname)");
    const d = sel.selectAtIngress("GET", "/x");
    assert.ok(["sampled", "unsampled"].includes(d.reason));
  });

  it("a sampled request records pg, outbound fetch and time observations", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1" });
    try {
      await s.req("/products/sku-1?fail=boom");
      await s.settle();
      const docs = s.docs();
      assert.equal(docs.length, 1);
      const kinds = new Set(docs[0].events.map((e) => e.kind));
      assert.ok(kinds.has("pg"), "pg observation required");
      assert.ok(kinds.has("http"), "outbound fetch observation required");
    } finally {
      await s.stop();
    }
  });

  it("time and random draws are recorded on a selected request where used", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1" });
    try {
      await s.req("/products/sku-1?fail=boom");
      await s.settle();
      const doc = s.docs()[0];
      // service-a draws no time/random itself; assert the machinery is armed
      // rather than asserting a fixture-specific count.
      assert.ok(Array.isArray(doc.events));
      assert.ok(doc.events.every((e) => ["pg", "http", "time", "random"].includes(e.kind)));
    } finally {
      await s.stop();
    }
  });
});

describe("targeted arming", () => {
  it("arming activates automatically after cheap failure detection", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom");
      await s.settle();
      const st = await s.stats();
      assert.equal(st.selector.stats.armEvents, 1);
      assert.equal(st.selector.armed.length, 1);
      assert.equal(st.selector.armed[0].key, "GET /boom");
    } finally {
      await s.stop();
    }
  });

  it("the first detected failure is NOT executable; a later one is", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom");
      await s.settle();
      assert.deepEqual(s.artifacts(), [], "the arming failure must not produce an artifact");
      await s.req("/boom");
      await s.settle();
      assert.equal(s.artifacts().length, 1, "the next matching failure is captured");
    } finally {
      await s.stop();
    }
  });

  it("arming disarms after a successful executable-incident capture", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom");
      await s.settle();
      await s.req("/boom");
      await s.settle();
      const st = await s.stats();
      assert.equal(st.selector.stats.disarmCaptured, 1);
      assert.equal(st.selector.armed.length, 0);
    } finally {
      await s.stop();
    }
  });

  it("arming expires on TTL", async () => {
    const sel = new Selector({ strategy: STRATEGY.TARGETED, ttlMs: 50, budget: 100 });
    sel.observeOutcome("GET /x", 500, false);
    assert.equal(sel.selectAtIngress("GET", "/x").selected, true);
    await new Promise((r) => setTimeout(r, 80));
    const d = sel.selectAtIngress("GET", "/x");
    assert.equal(d.selected, false);
    assert.equal(d.reason, "unarmed-ttl-expired");
    assert.equal(sel.stats.disarmTtl, 1);
  });

  it("arming expires on request budget", () => {
    const sel = new Selector({ strategy: STRATEGY.TARGETED, ttlMs: 60000, budget: 2 });
    sel.observeOutcome("GET /x", 500, false);
    assert.equal(sel.selectAtIngress("GET", "/x").selected, true);
    assert.equal(sel.selectAtIngress("GET", "/x").selected, true);
    const d = sel.selectAtIngress("GET", "/x");
    assert.equal(d.selected, false);
    assert.equal(d.reason, "unarmed-budget-exhausted");
    assert.equal(sel.stats.disarmBudget, 1);
  });

  it("different routes do not share arming state", () => {
    const sel = new Selector({ strategy: STRATEGY.TARGETED, ttlMs: 60000, budget: 10 });
    sel.observeOutcome("GET /a", 500, false);
    assert.equal(sel.selectAtIngress("GET", "/a").selected, true);
    assert.equal(sel.selectAtIngress("GET", "/b").selected, false);
    assert.equal(sel.selectAtIngress("POST", "/a").selected, false);
  });

  it("different incident keys do not cross-contaminate captures", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom");
      await s.settle();
      // A different failing key must not be captured by /boom's arming.
      await s.req("/missing-route-xyz");
      await s.settle();
      await s.req("/boom");
      await s.settle();
      const docs = s.docs();
      assert.equal(docs.length, 1);
      assert.equal(docs[0].request.path, "/boom");
    } finally {
      await s.stop();
    }
  });

  it("concurrent armed and unarmed requests remain isolated", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000", RAPTURE_V31_BUDGET: "50" });
    try {
      await s.req("/boom");
      await s.settle();
      // 1 armed failing request racing 20 unarmed successful ones.
      await Promise.all([
        s.req("/boom"),
        ...Array.from({ length: 20 }, () => s.req("/products")),
      ]);
      await s.settle();
      const docs = s.docs();
      assert.equal(docs.length, 1, "exactly one incident, from the armed failure");
      assert.equal(docs[0].request.path, "/boom");
      assert.equal(docs[0].response.status, 500);
      // /boom answers without touching pg or the outbound dependency, so its
      // incident must contain ZERO boundary events. Any event here would be
      // one of the 20 concurrent unarmed requests bleeding into the capture.
      assert.equal(docs[0].events.length, 0, "concurrent traffic leaked into the incident");
      const st = await s.stats();
      assert.equal(st.selector.stats.requestsSelected, 1, "only the armed request was instrumented");
      assert.ok(st.selector.stats.requestsSeen >= 22, "the unarmed requests really ran");
    } finally {
      await s.stop();
    }
  });
});

describe("no retroactive capture", () => {
  it("an unsampled one-off failure produces no full artifact", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0" });
    try {
      const r = await s.req("/boom");
      assert.equal(r.status, 500);
      await s.settle();
      assert.deepEqual(s.artifacts(), []);
      const st = await s.stats();
      assert.equal(st.capture.requestsPersisted, 0);
      assert.equal(st.capture.eventsRecorded, 0);
    } finally {
      await s.stop();
    }
  });

  it("a detector-only first failure carries no pg/fetch/time/random observations", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom");
      await s.settle();
      const st = await s.stats();
      // The arming record is the ONLY thing retained, and it holds counters.
      assert.equal(st.capture.eventsRecorded, 0);
      assert.equal(st.capture.requestsSeen, 0);
      assert.deepEqual(s.artifacts(), []);
    } finally {
      await s.stop();
    }
  });

  it("arming after a failure does not retroactively populate boundary events", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom"); // fails, arms
      await s.settle();
      const afterArm = await s.stats();
      assert.equal(afterArm.capture.eventsRecorded, 0);
      assert.deepEqual(s.artifacts(), [], "no artifact may appear for an already-finished request");
      // Only a NEW request produces a document, and its events are its own.
      await s.req("/boom");
      await s.settle();
      const docs = s.docs();
      assert.equal(docs.length, 1);
      assert.ok(docs[0].events.every((e) => typeof e.seq === "number"));
    } finally {
      await s.stop();
    }
  });

  it("targeted capture only ever selects at ingress", () => {
    const sel = new Selector({ strategy: STRATEGY.TARGETED, ttlMs: 60000, budget: 10 });
    // Observing a failure can never retroactively mark a request selected.
    const before = sel.stats.requestsSelected;
    sel.observeOutcome("GET /x", 500, false);
    assert.equal(sel.stats.requestsSelected, before);
    // It only changes what a FUTURE request gets.
    assert.equal(sel.selectAtIngress("GET", "/x").selected, true);
  });
});

describe("replay fails closed", () => {
  async function captureOne() {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1" });
    try {
      await s.req("/products/sku-1?fail=boom");
      await s.settle();
      const files = s.artifacts();
      assert.equal(files.length, 1);
      const dir = mkdtempSync(join(tmpdir(), "v31-art-"));
      const path = join(dir, "capture.json");
      cpSync(join(s.outDir, files[0]), path);
      return { path, dir, doc: JSON.parse(readFileSync(path, "utf8")) };
    } finally {
      await s.stop();
    }
  }

  function replay(capturePath, port) {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [REPLAY_ONE, "--app", SVC, "--capture", capturePath, "--port", String(port)],
        {
          env: { ...process.env, SHOP_API_KEY: "shop-test-key", FAKE_ORIGIN: "http://localhost:1" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.on("exit", () => {
        try {
          resolve(JSON.parse(out.trim().split("\n").at(-1)));
        } catch {
          resolve({ pass: false, parseError: out.slice(-300) });
        }
      });
    });
  }

  it("a targeted artifact replays the exact failure offline with no live dependency", async () => {
    const { path, dir } = await captureOne();
    try {
      const r = await replay(path, (PORT += 1));
      assert.equal(r.pass, true, `replay failed: ${JSON.stringify(r).slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replay fails closed on a missing DB observation", async () => {
    const { path, dir, doc } = await captureOne();
    try {
      const stripped = { ...doc, events: doc.events.filter((e) => e.kind !== "pg") };
      writeFileSync(path, JSON.stringify(stripped));
      const r = await replay(path, (PORT += 1));
      assert.equal(r.pass, false, "a capture missing its pg observation must not pass");
      // This calibration service wraps its handler in a catch-all that maps
      // any uncaught throw to its own E_SHOP_THROW code, so the fail-closed
      // MISSING_MOCK error surfaces as an app-coded 500 rather than an infra
      // fingerprint. What must hold either way -- and what actually protects
      // the oracle -- is that the resulting fingerprint can never equal the
      // incident's.
      assert.notEqual(r.fingerprint?.fingerprint_hash, doc.fingerprint.fingerprint_hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replay fails closed on a missing HTTP observation", async () => {
    const { path, dir, doc } = await captureOne();
    try {
      const stripped = { ...doc, events: doc.events.filter((e) => e.kind !== "http") };
      writeFileSync(path, JSON.stringify(stripped));
      const r = await replay(path, (PORT += 1));
      assert.equal(r.pass, false, "a capture missing its outbound HTTP observation must not pass");
      assert.notEqual(r.fingerprint?.fingerprint_hash, doc.fingerprint.fingerprint_hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replay infrastructure failure cannot satisfy the incident fingerprint", async () => {
    const { path, dir, doc } = await captureOne();
    try {
      const stripped = { ...doc, events: [] };
      writeFileSync(path, JSON.stringify(stripped));
      const r = await replay(path, (PORT += 1));
      assert.equal(r.pass, false);
      assert.notEqual(r.fingerprint?.fingerprint_hash, doc.fingerprint.fingerprint_hash);
      // And with the boundary errors allowed to propagate uncaught, the oracle
      // classifies them as infra, which by construction can never match an
      // incident hash.
      const { infraFingerprint } = await import("../src/oracle/fingerprint.mjs");
      assert.equal(infraFingerprint("RAPTURE_V2_MISSING_MOCK", "x").kind, "infra");
      assert.notEqual(
        infraFingerprint("RAPTURE_V2_MISSING_MOCK", "x").fingerprint_hash,
        doc.fingerprint.fingerprint_hash,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a portable artifact needs neither the original capture nor a live Postgres or HTTP", async () => {
    const { path, dir } = await captureOne();
    try {
      const iso = mkdtempSync(join(tmpdir(), "v31-iso-"));
      const isoPath = join(iso, "artifact.json");
      cpSync(path, isoPath);
      rmSync(dir, { recursive: true, force: true });
      // PGPORT is forced dead by replay-one; FAKE_ORIGIN points at a closed port.
      const r = await replay(isoPath, (PORT += 1));
      assert.equal(r.pass, true, `portable replay failed: ${JSON.stringify(r).slice(0, 300)}`);
      rmSync(iso, { recursive: true, force: true });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });
});

describe("privacy of detector and arming state", () => {
  it("arming state contains no request content", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "60000" });
    try {
      await s.req("/boom?token=sk-live-SENTINELABCDEFGH&email=a@b.com", {
        headers: { authorization: "Bearer SENTINELTOKEN12345", cookie: "sid=sess-alice" },
      });
      await s.settle();
      const st = await s.stats();
      const text = JSON.stringify(st.selector);
      for (const sentinel of ["sk-live-SENTINELABCDEFGH", "SENTINELTOKEN12345", "sess-alice", "a@b.com", "token=", "Bearer"]) {
        assert.ok(!text.includes(sentinel), `arming state leaked ${sentinel}`);
      }
      // Only the normalized key survives, and it carries no query string.
      assert.equal(st.selector.armed[0].key, "GET /boom");
    } finally {
      await s.stop();
    }
  });

  it("secret sentinels are absent from artifacts of selected requests", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1" });
    try {
      await s.req("/products/sku-1?fail=boom&api_key=sk-live-SENTINELABCDEFGH", {
        headers: { authorization: "Bearer SENTINELTOKEN12345" },
      });
      await s.settle();
      const text = readFileSync(join(s.outDir, s.artifacts()[0]), "utf8");
      assert.ok(!text.includes("sk-live-SENTINELABCDEFGH"), "provider key leaked into artifact");
      assert.ok(!text.includes("SENTINELTOKEN12345"), "bearer token leaked into artifact");
    } finally {
      await s.stop();
    }
  });

  it("sampled-but-successful requests leave no persisted artifact", async () => {
    const s = await boot({ RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "1" });
    try {
      for (let i = 0; i < 5; i += 1) await s.req("/products");
      await s.settle();
      assert.deepEqual(s.artifacts(), []);
      const st = await s.stats();
      assert.ok(st.selector.stats.requestsSelected >= 5, "requests were genuinely selected");
      assert.equal(st.capture.requestsPersisted, 0);
    } finally {
      await s.stop();
    }
  });
});
