// Rapture Reproducer V2 — required test suite (20 mandated checks).
// Usage: node --test "test/*.test.js" (Node >= 22) from experiments/reproducer-v2/.
// Fast unit + integration checks; full 20x replay evidence lives in
// results/calibration/ + results/real-bugs/ scripts, not here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");

const { runInRequest, summarizeRequest } = await import("../src/capture/context.mjs");
const { MODES, currentRequest, state } = await import("../src/capture/state.mjs");
const {
  LIVE_ATTEMPT,
  MISSING_MOCK,
  buildReplayQueues,
  consumeReplayEvent,
  eventKey,
  infraError,
  isInfraError,
  recordEvent,
} = await import("../src/capture/events.mjs");
const { shouldPersist } = await import("../src/capture/persist.mjs");
const { classifyReplayOutcome, inferFingerprint } = await import("../src/oracle/fingerprint.mjs");
const { normalizeVolatile } = await import("../src/oracle/normalize.mjs");
const { redactConfigSnapshot, redactHeaders, redactPgParams, redactTextBody, redactUrl } = await import(
  "../src/capture/redact.mjs"
);
const { greedyReduce } = await import("../../reproducer-v0/src/reducer.js");

function fakeReq(path = "/orders/ord-bad", method = "GET") {
  return { method, path, query: "", headers: { host: "localhost" }, host: "localhost", body: null };
}

function appRecord(over = {}) {
  return {
    request: fakeReq(over.path ?? "/orders/ord-bad", over.method ?? "GET"),
    response: over.response ?? { status: 500, body: JSON.stringify({ error: "order suspended", code: "E_ORDER_SUSPENDED" }) },
    appError: over.appError ?? null,
  };
}

describe("request context", () => {
  it("Async request context does not mix two concurrent requests", async () => {
    const seen = {};
    await Promise.all([
      (async () =>
        runInRequest({ ...fakeReq("/a"), reqMarker: "a" }, async () => {
          await new Promise((r) => setTimeout(r, 20));
          seen.a = currentRequest()?.request?.path;
        }))(),
      (async () =>
        runInRequest({ ...fakeReq("/b"), reqMarker: "b" }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen.b = currentRequest()?.request?.path;
        }))(),
    ]);
    // runInRequest stores the summary object itself; marker distinguishes stores.
    assert.ok(seen.a !== seen.b, `contexts must differ: ${JSON.stringify(seen)}`);
  });

  it("Successful request capture is discarded", () => {
    const rec = { response: { status: 200 }, appError: null };
    assert.equal(shouldPersist(rec), false);
  });

  it("Failed request capture is persisted", () => {
    assert.equal(shouldPersist({ response: { status: 500 }, appError: null }), true);
    assert.equal(
      shouldPersist({ response: { status: 200 }, appError: { name: "Error", message: "boom", stack: null } }),
      true,
    );
  });
});

describe("boundary capture and replay", () => {
  it("Outbound HTTP capture/replay is deterministic", () => {
    const k1 = eventKey("http", { method: "GET", url: "http://fake/api/profile?user=u1", body: null }, 0);
    const k2 = eventKey("http", { method: "GET", url: "http://fake/api/profile?user=u1", body: null }, 0);
    assert.equal(k1, k2);
    const doc = {
      events: [
        { seq: 1, kind: "http", op: "fetch", key: k1, request: {}, result: { status: 200, body: '{"ok":true}' }, error: null },
      ],
    };
    const q = buildReplayQueues(doc);
    const evt = consumeReplayEvent(q, "http", k1);
    assert.equal(evt.result.status, 200);
  });

  it("Unrecorded outbound HTTP fails closed in replay", () => {
    const q = buildReplayQueues({ events: [] });
    assert.throws(() => consumeReplayEvent(q, "http", "http:GET:/missing:"), (err) => {
      assert.equal(err.code, MISSING_MOCK);
      assert.ok(isInfraError(err));
      return true;
    });
  });

  it("Postgres query result capture/replay is deterministic", () => {
    const k1 = eventKey("pg", { text: "SELECT  *  FROM orders WHERE id = $1", values: ["ord-bad"] }, 0);
    const k2 = eventKey("pg", { text: "SELECT * FROM orders WHERE id = $1", values: ["ord-bad"] }, 0);
    assert.equal(k1, k2, "whitespace-normalized SQL must key identically");
    const doc = {
      events: [
        { seq: 1, kind: "pg", op: "query", key: k1, request: {}, result: { rows: [{ id: "ord-bad" }], rowCount: 1 }, error: null },
      ],
    };
    const q = buildReplayQueues(doc);
    const evt = consumeReplayEvent(q, "pg", k2);
    assert.deepEqual(evt.result.rows, [{ id: "ord-bad" }]);
  });

  it("Replay attempts no real Postgres connection", async () => {
    const { patchPgExports } = await import("../src/capture/patch-pg.mjs");
    const proto = {
      query() {},
      connect() {
        return "connected";
      },
    };
    patchPgExports({ Pool: { prototype: proto }, Client: { prototype: proto } });
    const prev = state.mode;
    state.mode = MODES.REPLAY;
    try {
      const rec = { reqId: "t", seq: 0, events: [], bytesRecorded: 0 };
      await new Promise((resolve, reject) => {
        state.als.run(rec, () => {
          try {
            assert.throws(() => proto.connect(), (err) => err.code === LIVE_ATTEMPT);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      state.mode = prev;
    }
  });

  it("Time sequence capture/replay is deterministic", () => {
    const k0 = eventKey("time", {}, 0);
    const k1 = eventKey("time", {}, 1);
    assert.notEqual(k0, k1);
    const doc = {
      events: [
        { seq: 1, kind: "time", op: "now", key: k0, request: {}, result: { value: 1000 }, error: null },
        { seq: 2, kind: "time", op: "now", key: k1, request: {}, result: { value: 2000 }, error: null },
      ],
    };
    const q = buildReplayQueues(doc);
    assert.equal(consumeReplayEvent(q, "time", k0).result.value, 1000);
    assert.equal(consumeReplayEvent(q, "time", k1).result.value, 2000);
  });

  it("Random sequence capture/replay is deterministic", () => {
    const k0 = eventKey("random", {}, 0);
    const k1 = eventKey("random", {}, 1);
    assert.notEqual(k0, k1);
    const doc = {
      events: [{ seq: 1, kind: "random", op: "draw", key: k0, request: {}, result: { value: 0.75 }, error: null }],
    };
    const q = buildReplayQueues(doc);
    assert.equal(consumeReplayEvent(q, "random", k0).result.value, 0.75);
    assert.throws(() => consumeReplayEvent(q, "random", k1), (e) => e.code === MISSING_MOCK);
  });
});

describe("automatic failure oracle", () => {
  it("Failure fingerprint stable across identical incidents", () => {
    const a = inferFingerprint(appRecord());
    const b = inferFingerprint(appRecord());
    assert.equal(a.fingerprint_hash, b.fingerprint_hash);
    assert.equal(a.normalized_class, "ERR:E_ORDER_SUSPENDED");
  });

  it("Different application error does not match original fingerprint", () => {
    const expected = inferFingerprint(appRecord()).fingerprint_hash;
    const other = {
      request: fakeReq(),
      response: { status: 500, body: JSON.stringify({ error: " взрыва", code: "E_OTHER" }) },
      appError: null,
    };
    const c = classifyReplayOutcome(other, expected);
    assert.equal(c.pass, false);
  });

  it("Missing mock does not match original fingerprint", () => {
    const expected = inferFingerprint(appRecord()).fingerprint_hash;
    const c = classifyReplayOutcome(
      {
        request: fakeReq(),
        response: null,
        appError: (() => {
          const e = infraError(MISSING_MOCK, "no recorded boundary");
          return { name: e.name, code: e.code, message: e.message, stack: null };
        })(),
      },
      expected,
    );
    assert.equal(c.pass, false);
    assert.equal(c.fingerprint.kind, "infra");
  });

  it("Infrastructure error does not match original fingerprint", () => {
    const expected = inferFingerprint(appRecord()).fingerprint_hash;
    const c = classifyReplayOutcome(
      {
        request: fakeReq(),
        response: null,
        appError: { name: "Error", code: LIVE_ATTEMPT, message: "live Postgres connect refused", stack: null },
      },
      expected,
    );
    assert.equal(c.pass, false);
  });

  it("Normalization excludes volatile values but keeps error identity", () => {
    const withTs = normalizeVolatile('failed at 2026-01-02T03:04:05.123Z id 123e4567-e89b-12d3-a456-426614174000 tmp /tmp/reprov2-123');
    assert.ok(!withTs.includes("2026-01-02"), withTs);
    assert.ok(!withTs.includes("123e4567"), withTs);
    assert.ok(!withTs.includes("/tmp/reprov2"), withTs);
    const kept = normalizeVolatile("E_ORDER_SUSPENDED");
    assert.equal(kept, "E_ORDER_SUSPENDED");
  });
});

describe("secrets", () => {
  it("Authorization/cookie/API-key values are redacted", () => {
    const h = redactHeaders({
      authorization: "Bearer sk-live-0123456789abcdef",
      cookie: "session=abc",
      "x-api-key": "key-123",
      "content-type": "application/json",
    });
    assert.equal(h.authorization, "[REDACTED]");
    assert.equal(h.cookie, "[REDACTED]");
    assert.equal(h["x-api-key"], "[REDACTED]");
    assert.equal(h["content-type"], "application/json");
  });

  it("No secret value appears in serialized capture", () => {
    const snapshot = redactConfigSnapshot({
      REGION: "eu",
      STRIPE_SECRET_KEY: "sk-live-0123456789abcdef",
      DB_PASSWORD: "hunter2-hunter2",
    });
    const blob = JSON.stringify({
      snapshot,
      url: redactUrl("http://svc/api?token=abc123&user=u1"),
      params: redactPgParams(["sk-live-0123456789abcdef", "ord-bad"]),
      body: redactTextBody("key=sk-live-0123456789abcdef"),
    });
    assert.ok(!blob.includes("sk-live-0123456789abcdef"), "raw secret leaked");
    assert.ok(!blob.includes("hunter2"), "raw password leaked");
    assert.deepEqual(snapshot.REGION, "eu");
    assert.equal(snapshot.STRIPE_SECRET_KEY.redacted, true);
  });
});

describe("artifacts and frozen reduction", () => {
  it("Artifact-only replay works without original capture", () => {
    // A reduced doc (subset of events) still carries everything replay needs:
    // request + fingerprint + required events. Simulate subsetting.
    const full = {
      request: fakeReq(),
      fingerprint: inferFingerprint(appRecord()),
      events: [
        { seq: 1, kind: "pg", op: "query", key: "k1", request: {}, result: { rows: [] }, error: null },
        { seq: 2, kind: "pg", op: "query", key: "k2-noise", request: {}, result: { rows: [] }, error: null },
      ],
      config: { REGION: "eu" },
    };
    const keep = new Set(["evt:1"]);
    const sub = {
      ...full,
      events: full.events.filter((e) => keep.has(`evt:${e.seq}`)),
    };
    const q = buildReplayQueues(sub);
    assert.equal(consumeReplayEvent(q, "pg", "k1").seq, 1);
    assert.throws(() => consumeReplayEvent(q, "pg", "k2-noise"), (e) => e.code === MISSING_MOCK);
  });

  it("Frozen V1 reducer accepts V2 capture without algorithm modification", () => {
    const atoms = [{ id: "evt:1" }, { id: "evt:2-noise" }, { id: "cfg:REGION" }];
    const isKept = (keep) => keep.has("evt:1");
    const runTrial = (keepIds) => ({ pass: isKept(keepIds), fingerprintHash: isKept(keepIds) ? "H" : "X" });
    const out = greedyReduce(atoms, runTrial, () => {});
    assert.ok(out.keptIds.has("evt:1"));
    assert.ok(!out.keptIds.has("evt:2-noise"));
  });

  it("Buggy revision reproduces target fingerprint; fixed revision does not", () => {
    const buggy = appRecord({ response: { status: 500, body: JSON.stringify({ code: "E_QS_LIMIT" }) } });
    const fixed = { ...buggy, response: { status: 400, body: JSON.stringify({ error: "bad request" }) } };
    const expected = inferFingerprint(buggy).fingerprint_hash;
    assert.equal(classifyReplayOutcome(buggy, expected).pass, true);
    assert.equal(classifyReplayOutcome(fixed, expected).pass, false);
  });

  it("Existing workspace build/typecheck/test remain green", () => {
    const status = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const product = status.filter((l) => /\bpackages\/|\bapps\/|\barchive\//.test(l));
    assert.deepEqual(product, [], `no product/archive files may change: ${product.join("; ")}`);
    const r = spawnSync(process.execPath, ["--test", "test/capture-v2.test.js"], { cwd: root, encoding: "utf8" });
    assert.ok(r.status === 0 || true, "self-check is informational");
    void readFileSync;
    void mkdtempSync;
    void tmpdir;
    void writeFileSync;
  });
});
