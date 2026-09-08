// Adversarial reduction bench for reproducer-v1 (12 scenarios).
//
// Each scenario implements the V0 capture interface (fullInput,
// removableInputFields, fullConfig, fullDbRows, script, ambientEvents, run,
// expectedFingerprint) so the FROZEN V0 substrate (record/replay, reducers,
// artifacts) is reused unchanged. Added per scenario:
//   topology: one of the 12 required topology names.
//   groundTruth(): { must: [atomIds], anyOf: [[atomIds]], trigger?: [atomIds] }
//     Declared BEFORE reducer execution; used ONLY for post-hoc scoring.
//     The reducer never imports this module (asserted by test).
//
// Atom id grammar (same as V0): `evt:<key>` `db:<table>:<key>` `cfg:<KEY>` `in:<path>`
import { AppError } from "../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../reproducer-v0/src/replay.js";

function ambientHttp(operation, requestKey, recordedResult, note) {
  return {
    kind: "http",
    operation,
    request_or_key: requestKey,
    recorded_result: recordedResult,
    metadata: { ambient: true, note },
  };
}

function noiseDbRows(count, prefix, table = "audit_log") {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ table, key: `${prefix}_${i}`, value: { index: i, note: "unrelated" } });
  }
  return rows;
}

function noiseAmbientEvents(count, prefix) {
  const evts = [];
  for (let i = 0; i < count; i += 1) {
    evts.push(
      ambientHttp(`noisy-${prefix}`, { probe: `${prefix}-${i}` }, { ok: true, index: i }, `ambient ${i}`),
    );
  }
  return evts;
}

function bestEffort(ctx, operation, requestKey, fallback) {
  try {
    return ctx.http(operation, requestKey);
  } catch {
    return fallback;
  }
}

const T = (code, messageClass, frame) => ({ code, messageClass, frame });
const FP = (failure_kind, error_code, message_class, top_frame) => ({
  failure_kind,
  error_code,
  message_class,
  top_frame,
});

export const SCENARIOS = [
  {
    id: "adv-joint-pair",
    topology: "jointly-removable-pair",
    title: "Jointly removable config pair with default-deny",
    description:
      "STRICT_A and STRICT_B together throw E_POLICY_CONFLICT before any boundary call. " +
      "Removing exactly one diverts into a poisoned single-policy path (wrong failure); " +
      "removing both reaches the same target via default-deny. Naive single-deletion " +
      "sees each flag as required; only joint deletion succeeds.",
    fullInput: () => ({ userId: "u_1", a: 1, b: 2 }),
    removableInputFields: () => ["a", "b"],
    fullConfig: () => ({ STRICT_A: true, STRICT_B: true, LOG_LEVEL: "info", TIMEOUT_MS: 1000 }),
    fullDbRows: () => [...noiseDbRows(4, "jp")],
    script: () => new Map(),
    ambientEvents: () => [
      ambientHttp("policy-check", { user: "u_1" }, { verdict: "poisoned" }, "single-policy path evidence"),
      ...noiseAmbientEvents(4, "jp"),
    ],
    run: (ctx, input) => {
      const a = ctx.getConfig("STRICT_A") === true;
      const b = ctx.getConfig("STRICT_B") === true;
      if (a && b) throw new AppError({ ...T("E_POLICY_CONFLICT", "POLICY_CONFLICT", "validate-policy") });
      if (a || b) {
        const r = ctx.http("policy-check", { user: input.userId });
        if (r.verdict === "poisoned") {
          throw new AppError({ ...T("E_POLICY_UPSTREAM", "POLICY_UPSTREAM", "validate-policy") });
        }
        return { ok: true };
      }
      throw new AppError({ ...T("E_POLICY_CONFLICT", "POLICY_CONFLICT", "validate-policy") });
    },
    expectedFingerprint: () =>
      FP("APPLICATION", "E_POLICY_CONFLICT", "POLICY_CONFLICT", "validate-policy"),
    groundTruth: () => ({ must: [], anyOf: [["cfg:STRICT_A", "cfg:STRICT_B"], []] }),
  },

  {
    id: "adv-alt-sets",
    topology: "alternative-causal-sets",
    title: "Two independent sustaining ban pairs",
    description:
      "Either {users:ban_a, users:ban_b} or {legacy:ban_c, legacy:ban_d} (both banned) " +
      "sustains E_ACCESS_REVOKED. Multiple valid reduced reproducers exist; greedy keeps " +
      "whichever pair survives its deletion order.",
    fullInput: () => ({ userId: "u_2", note: "n" }),
    removableInputFields: () => ["note"],
    fullConfig: () => ({ MODE: "strict", LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "users", key: "ban_a", value: { banned: true } },
      { table: "users", key: "ban_b", value: { banned: true } },
      { table: "legacy", key: "ban_c", value: { banned: true } },
      { table: "legacy", key: "ban_d", value: { banned: true } },
      ...noiseDbRows(6, "as"),
    ],
    script: () => new Map(),
    ambientEvents: () => [...noiseAmbientEvents(3, "as")],
    run: (ctx) => {
      const A = ctx.dbGet("users", "ban_a");
      const B = ctx.dbGet("users", "ban_b");
      const C = ctx.dbGet("legacy", "ban_c");
      const D = ctx.dbGet("legacy", "ban_d");
      if (A?.banned === true && B?.banned === true) {
        throw new AppError({ ...T("E_ACCESS_REVOKED", "ACCESS_REVOKED", "check-ban") });
      }
      if (C?.banned === true && D?.banned === true) {
        throw new AppError({ ...T("E_ACCESS_REVOKED", "ACCESS_REVOKED", "check-ban") });
      }
      return { ok: true };
    },
    expectedFingerprint: () => FP("APPLICATION", "E_ACCESS_REVOKED", "ACCESS_REVOKED", "check-ban"),
    groundTruth: () => ({
      must: [],
      anyOf: [
        ["db:users:ban_a", "db:users:ban_b"],
        ["db:legacy:ban_c", "db:legacy:ban_d"],
      ],
    }),
  },

  {
    id: "adv-one-of-n",
    topology: "at-least-one-of-n",
    title: "Five interchangeable stale credentials",
    description:
      "Any one of five stale credential rows triggers E_ROTATION_REQUIRED. No specific " +
      "row is individually mandatory; the reducer must retain at least one.",
    fullInput: () => ({ tenant: "t_1", trace: "x" }),
    removableInputFields: () => ["trace"],
    fullConfig: () => ({ ROTATION: "enforce", LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "creds", key: "k1", value: { stale: true } },
      { table: "creds", key: "k2", value: { stale: true } },
      { table: "creds", key: "k3", value: { stale: true } },
      { table: "creds", key: "k4", value: { stale: true } },
      { table: "creds", key: "k5", value: { stale: true } },
      ...noiseDbRows(5, "oon"),
    ],
    script: () => new Map(),
    ambientEvents: () => [...noiseAmbientEvents(3, "oon")],
    run: (ctx) => {
      const rows = ["k1", "k2", "k3", "k4", "k5"].map((k) => ctx.dbGet("creds", k));
      if (rows.some((r) => r?.stale === true)) {
        throw new AppError({ ...T("E_ROTATION_REQUIRED", "ROTATION_REQUIRED", "check-creds") });
      }
      return { ok: true };
    },
    expectedFingerprint: () =>
      FP("APPLICATION", "E_ROTATION_REQUIRED", "ROTATION_REQUIRED", "check-creds"),
    groundTruth: () => ({
      must: [],
      anyOf: [["db:creds:k1"], ["db:creds:k2"], ["db:creds:k3"], ["db:creds:k4"], ["db:creds:k5"]],
    }),
  },

  {
    id: "adv-sequence",
    topology: "sequence-dependent",
    title: "Chained auth-refresh-finalize with decoys",
    description:
      "E_FINALIZE_CONFLICT requires the data chain auth->refresh->finalize; decoy " +
      "responses for the same operations with different keys must be dropped while the " +
      "ordered chain is preserved.",
    fullInput: () => ({ userId: "u_4", doc: "d_1", trace: "t" }),
    removableInputFields: () => ["doc", "trace"],
    fullConfig: () => ({ CHAIN: "on", LOG_LEVEL: "info" }),
    fullDbRows: () => [...noiseDbRows(4, "sq")],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "auth", { user: "u_4" }), { t: "t1" });
      m.set(eventKey("http", "refresh", { t: "t1" }), { t: "t2" });
      m.set(eventKey("http", "finalize", { t: "t2" }), { status: "CONFLICT" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("refresh", { t: "t9" }, { error: "expired" }, "decoy refresh"),
      ambientHttp("finalize", { t: "tX" }, { status: "OK" }, "decoy finalize"),
      ambientHttp("auth", { user: "u_99" }, { t: "tZ" }, "decoy auth"),
      ...noiseAmbientEvents(2, "sq"),
    ],
    run: (ctx, input) => {
      const a = ctx.http("auth", { user: input.userId });
      const r = ctx.http("refresh", { t: a.t });
      const f = ctx.http("finalize", { t: r.t });
      if (f.status === "CONFLICT") {
        throw new AppError({ ...T("E_FINALIZE_CONFLICT", "FINALIZE_CONFLICT", "commit-doc") });
      }
      return { ok: true };
    },
    expectedFingerprint: () =>
      FP("APPLICATION", "E_FINALIZE_CONFLICT", "FINALIZE_CONFLICT", "commit-doc"),
    groundTruth: () => ({
      must: [
        `evt:${eventKey("http", "auth", { user: "u_4" })}`,
        `evt:${eventKey("http", "refresh", { t: "t1" })}`,
        `evt:${eventKey("http", "finalize", { t: "t2" })}`,
      ],
      anyOf: [],
    }),
  },

  {
    id: "adv-nonmonotonic",
    topology: "non-monotonic-removal",
    title: "Fast/slow read paths with context-dependent relevance",
    description:
      "FAST_PATH selects between a poisoned cache row and a poisoned store row (both " +
      "lead to E_DATA_POISONED). The store row is removable while FAST_PATH holds but " +
      "becomes required once FAST_PATH is gone: predicate non-monotonicity the search " +
      "must survive.",
    fullInput: () => ({ key: "k_fast", note: "n" }),
    removableInputFields: () => ["note"],
    fullConfig: () => ({ FAST_PATH: true, LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "cache", key: "k_fast", value: { poisoned: true } },
      { table: "store", key: "k_slow", value: { poisoned: true } },
      ...noiseDbRows(4, "nm"),
    ],
    script: () => new Map(),
    ambientEvents: () => [...noiseAmbientEvents(3, "nm")],
    run: (ctx, input) => {
      if (ctx.getConfig("FAST_PATH") === true) {
        const r = ctx.dbGet("cache", input.key);
        if (r?.poisoned === true) {
          throw new AppError({ ...T("E_DATA_POISONED", "DATA_POISONED", "read-path") });
        }
        return { ok: true, cached: true };
      }
      const s = ctx.dbGet("store", "k_slow");
      if (s?.poisoned === true) {
        throw new AppError({ ...T("E_DATA_POISONED", "DATA_POISONED", "read-path") });
      }
      return { ok: true, cached: false };
    },
    expectedFingerprint: () => FP("APPLICATION", "E_DATA_POISONED", "DATA_POISONED", "read-path"),
    groundTruth: () => ({
      must: [],
      anyOf: [["cfg:FAST_PATH", "db:cache:k_fast"], ["db:store:k_slow"]],
    }),
  },

  {
    id: "adv-nested",
    topology: "nested-payload-interaction",
    title: "Nested role+status combination inside one payload",
    description:
      "E_ACCOUNT_SUSPENDED needs role=admin AND status=suspended within a single profile " +
      "payload. Deletion-level reduction keeps the whole event; field-level shrinking is " +
      "out of scope for the headline comparison (exploratory only).",
    fullInput: () => ({ userId: "u_6", req: "r" }),
    removableInputFields: () => ["req"],
    fullConfig: () => ({ PROFILE: "v3", LOG_LEVEL: "info" }),
    fullDbRows: () => [...noiseDbRows(4, "np")],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "profile", { user: "u_6" }), {
        user: { role: "admin", status: "suspended", dept: "eng" },
      });
      return m;
    },
    ambientEvents: () => [
      ambientHttp(
        "profile",
        { user: "u_7" },
        { user: { role: "admin", status: "active", dept: "eng" } },
        "near-miss payload",
      ),
      ...noiseAmbientEvents(3, "np"),
    ],
    run: (ctx, input) => {
      const p = ctx.http("profile", { user: input.userId });
      if (p.user?.role === "admin" && p.user?.status === "suspended") {
        throw new AppError({ ...T("E_ACCOUNT_SUSPENDED", "ACCOUNT_SUSPENDED", "load-profile") });
      }
      return { ok: true };
    },
    expectedFingerprint: () =>
      FP("APPLICATION", "E_ACCOUNT_SUSPENDED", "ACCOUNT_SUSPENDED", "load-profile"),
    groundTruth: () => ({ must: [`evt:${eventKey("http", "profile", { user: "u_6" })}`], anyOf: [] }),
  },

  {
    id: "adv-config-3way",
    topology: "config-interaction",
    title: "Three-way region/tier/mode interaction",
    description:
      "E_STORE_UNSUPPORTED requires REGION=eu AND TIER=std AND MODE=strict jointly; " +
      "removing any one diverts to a working store. Six unrelated keys are noise.",
    fullInput: () => ({ q: "x", fmt: "json" }),
    removableInputFields: () => ["fmt"],
    fullConfig: () => ({
      REGION: "eu",
      TIER: "std",
      MODE: "strict",
      LOG_LEVEL: "info",
      RETRY_MAX: 3,
      TIMEOUT_MS: 2000,
      CACHE_TTL_S: 300,
      PAGE_SIZE: 50,
      CONCURRENCY: 4,
    }),
    fullDbRows: () => [...noiseDbRows(4, "c3")],
    script: () => new Map(),
    ambientEvents: () => [...noiseAmbientEvents(3, "c3")],
    run: (ctx) => {
      const r = ctx.getConfig("REGION");
      const t = ctx.getConfig("TIER");
      const m = ctx.getConfig("MODE");
      if (r === "eu" && t === "std" && m === "strict") {
        throw new AppError({ ...T("E_STORE_UNSUPPORTED", "STORE_UNSUPPORTED", "select-store") });
      }
      return { ok: true, store: `${r}-${t}-${m}` };
    },
    expectedFingerprint: () =>
      FP("APPLICATION", "E_STORE_UNSUPPORTED", "STORE_UNSUPPORTED", "select-store"),
    groundTruth: () => ({ must: ["cfg:REGION", "cfg:TIER", "cfg:MODE"], anyOf: [] }),
  },

  {
    id: "adv-dupe-responses",
    topology: "duplicate-equivalent-responses",
    title: "One requested quote among interchangeable recordings",
    description:
      "Three ambient quote responses look interchangeable with the requested one; only " +
      "the requested key sustains E_PRICE_BREACH under keyed replay.",
    fullInput: () => ({ item: "it_1", tag: "g" }),
    removableInputFields: () => ["tag"],
    fullConfig: () => ({ QUOTE: "live", LOG_LEVEL: "info" }),
    fullDbRows: () => [...noiseDbRows(4, "dq")],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "quote", { item: "it_1" }), { price: 999 });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("quote", { item: "it_2" }, { price: 950 }, "interchangeable-looking"),
      ambientHttp("quote", { item: "it_3" }, { price: 980 }, "interchangeable-looking"),
      ambientHttp("quote", { item: "it_4" }, { price: 10 }, "interchangeable-looking"),
      ...noiseAmbientEvents(2, "dq"),
    ],
    run: (ctx, input) => {
      const q = ctx.http("quote", { item: input.item });
      if (q.price > 500) {
        throw new AppError({ ...T("E_PRICE_BREACH", "PRICE_BREACH", "check-quote") });
      }
      return { ok: true };
    },
    expectedFingerprint: () => FP("APPLICATION", "E_PRICE_BREACH", "PRICE_BREACH", "check-quote"),
    groundTruth: () => ({ must: [`evt:${eventKey("http", "quote", { item: "it_1" })}`], anyOf: [] }),
  },

  {
    id: "adv-error-paths",
    topology: "multiple-error-paths",
    title: "Order pipeline where every bad cut raises a different error",
    description:
      "Removing the user, item, merchant, or charge evidence each triggers a distinct " +
      "wrong application exception (plus setup failures), stressing fingerprint " +
      "strictness: only the exact E_CHARGE_FAILED may be accepted.",
    fullInput: () => ({ user: "u_9", item: "it_9", coupon: "C" }),
    removableInputFields: () => ["coupon"],
    fullConfig: () => ({ MERCHANT_ID: "m_1", LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "users", key: "u_9", value: { name: "Zed" } },
      { table: "stock", key: "it_9", value: { left: 0 } },
      ...noiseDbRows(4, "ep"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "charge", { user: "u_9", item: "it_9" }), { declined: true, code: "LIMIT" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("charge", { user: "u_9", item: "it_8" }, { declined: false }, "different item"),
      ...noiseAmbientEvents(3, "ep"),
    ],
    run: (ctx, input) => {
      const u = ctx.dbGet("users", input.user);
      if (u === undefined) {
        throw new AppError({ ...T("E_UNKNOWN_USER", "UNKNOWN_USER", "validate-order") });
      }
      const s = ctx.dbGet("stock", input.item);
      if (s === undefined) {
        throw new AppError({ ...T("E_UNKNOWN_ITEM", "UNKNOWN_ITEM", "validate-order") });
      }
      if (s.left > 0) return { ok: true, shipped: true };
      const merch = ctx.getConfig("MERCHANT_ID");
      if (merch === undefined) {
        throw new AppError({ ...T("E_NO_MERCHANT", "NO_MERCHANT", "settle-order") });
      }
      const c = ctx.http("charge", { user: input.user, item: input.item });
      if (c.declined === true) {
        throw new AppError({ ...T("E_CHARGE_FAILED", "CHARGE_FAILED", "settle-order") });
      }
      return { ok: true };
    },
    expectedFingerprint: () => FP("APPLICATION", "E_CHARGE_FAILED", "CHARGE_FAILED", "settle-order"),
    groundTruth: () => ({
      must: [
        "db:users:u_9",
        "db:stock:it_9",
        "cfg:MERCHANT_ID",
        `evt:${eventKey("http", "charge", { user: "u_9", item: "it_9" })}`,
      ],
      anyOf: [],
    }),
  },

  {
    id: "adv-large-interact",
    topology: "large-noisy-interaction",
    title: "Large capture with interacting core",
    description:
      "About 150 atoms: a jointly-removable flag pair plus a mandatory two-event " +
      "ticket chain, buried in ambient/db/config/input noise. Tests whether chunk " +
      "deletion materially beats single-pass greedy on trials and size.",
    fullInput: () => ({ userId: "u_10", seat: "A1", w1: 1, w2: 2, w3: 3, w4: 4, w5: 5 }),
    removableInputFields: () => ["w1", "w2", "w3", "w4", "w5"],
    fullConfig: () => ({
      FLAG_P: true,
      FLAG_Q: true,
      LOG_LEVEL: "info",
      RETRY_MAX: 3,
      TIMEOUT_MS: 2000,
      CACHE_TTL_S: 120,
      PAGE_SIZE: 25,
      AUDIT_SINK: "local",
      REGION: "us",
      CONCURRENCY: 2,
    }),
    fullDbRows: () => [
      { table: "seats", key: "A1", value: { held: false } },
      ...noiseDbRows(25, "li"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "ticket", { seat: "A1" }), { id: "k1" });
      m.set(eventKey("http", "redeem", { id: "k1" }), { status: "CONFLICT_DUPE" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("single-check", { user: "u_10" }, { verdict: "poisoned" }, "single-flag path evidence"),
      ...noiseAmbientEvents(100, "li"),
    ],
    run: (ctx, input) => {
      const t = ctx.http("ticket", { seat: input.seat });
      const r = ctx.http("redeem", { id: t.id });
      if (r.status !== "CONFLICT_DUPE") return { ok: true, redeemed: t.id };
      const p = ctx.getConfig("FLAG_P") === true;
      const q = ctx.getConfig("FLAG_Q") === true;
      if (p && q) {
        throw new AppError({ ...T("E_POLICY_CONFLICT", "POLICY_CONFLICT", "validate-policy") });
      }
      if (p || q) {
        const c = ctx.http("single-check", { user: input.userId });
        if (c.verdict === "poisoned") {
          throw new AppError({ ...T("E_POLICY_UPSTREAM", "POLICY_UPSTREAM", "validate-policy") });
        }
        return { ok: true };
      }
      throw new AppError({ ...T("E_POLICY_CONFLICT", "POLICY_CONFLICT", "validate-policy") });
    },
    expectedFingerprint: () => FP("APPLICATION", "E_POLICY_CONFLICT", "POLICY_CONFLICT", "validate-policy"),
    groundTruth: () => ({
      must: [
        `evt:${eventKey("http", "ticket", { seat: "A1" })}`,
        `evt:${eventKey("http", "redeem", { id: "k1" })}`,
      ],
      anyOf: [[ "cfg:FLAG_P", "cfg:FLAG_Q" ], []],
    }),
  },

  {
    id: "adv-repeat-poll",
    topology: "ordered-repeated-boundary",
    title: "Repeated polls where only the third occurrence triggers",
    description:
      "The same poll operation is recorded five times; attempts 1-2 are path-necessary " +
      "(pending), attempt 3 triggers E_JOB_FAILED, attempts 4-5 are ambient window " +
      "traffic. The reducer must keep the ordered prefix through the trigger.",
    fullInput: () => ({ job: "j_1", client: "c" }),
    removableInputFields: () => ["client"],
    fullConfig: () => ({ POLL_MAX: 5, LOG_LEVEL: "info" }),
    fullDbRows: () => [...noiseDbRows(4, "rp")],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "poll", { job: "j_1", try: 1 }), { status: "pending" });
      m.set(eventKey("http", "poll", { job: "j_1", try: 2 }), { status: "pending" });
      m.set(eventKey("http", "poll", { job: "j_1", try: 3 }), { status: "failed" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("poll", { job: "j_1", try: 4 }, { status: "pending" }, "post-incident window"),
      ambientHttp("poll", { job: "j_1", try: 5 }, { status: "pending" }, "post-incident window"),
      ...noiseAmbientEvents(2, "rp"),
    ],
    run: (ctx, input) => {
      for (let n = 1; n <= 5; n += 1) {
        const r = ctx.http("poll", { job: input.job, try: n });
        if (r.status === "failed") {
          throw new AppError({ ...T("E_JOB_FAILED", "JOB_FAILED", "await-job") });
        }
        if (r.status !== "pending") return { ok: true };
      }
      return { ok: true };
    },
    expectedFingerprint: () => FP("APPLICATION", "E_JOB_FAILED", "JOB_FAILED", "await-job"),
    groundTruth: () => ({
      must: [
        `evt:${eventKey("http", "poll", { job: "j_1", try: 1 })}`,
        `evt:${eventKey("http", "poll", { job: "j_1", try: 2 })}`,
        `evt:${eventKey("http", "poll", { job: "j_1", try: 3 })}`,
      ],
      anyOf: [],
      trigger: [`evt:${eventKey("http", "poll", { job: "j_1", try: 3 })}`],
    }),
  },

  {
    id: "adv-masked-quorum",
    topology: "masked-dependency",
    title: "Two-of-three ban quorum with masked necessity",
    description:
      "Any two of three banned node rows sustain E_QUORUM_BANNED. Each row looks " +
      "removable in the full context (masked by the other two) but becomes required " +
      "once a partner is gone.",
    fullInput: () => ({ cell: "c_1", tag: "g" }),
    removableInputFields: () => ["tag"],
    fullConfig: () => ({ QUORUM: 2, LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "nodes", key: "n1", value: { banned: true } },
      { table: "nodes", key: "n2", value: { banned: true } },
      { table: "nodes", key: "n3", value: { banned: true } },
      ...noiseDbRows(5, "mq"),
    ],
    script: () => new Map(),
    ambientEvents: () => [...noiseAmbientEvents(3, "mq")],
    run: (ctx) => {
      const vs = ["n1", "n2", "n3"].map((n) => ctx.dbGet("nodes", n));
      const count = vs.filter((v) => v?.banned === true).length;
      if (count >= 2) {
        throw new AppError({ ...T("E_QUORUM_BANNED", "QUORUM_BANNED", "check-quorum") });
      }
      return { ok: true };
    },
    expectedFingerprint: () => FP("APPLICATION", "E_QUORUM_BANNED", "QUORUM_BANNED", "check-quorum"),
    groundTruth: () => ({
      must: [],
      anyOf: [
        ["db:nodes:n1", "db:nodes:n2"],
        ["db:nodes:n1", "db:nodes:n3"],
        ["db:nodes:n2", "db:nodes:n3"],
      ],
    }),
  },
];

export function getAdversarialScenario(id) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`unknown adversarial scenario: ${id}`);
  return s;
}

export function listAdversarialScenarios() {
  return SCENARIOS.map((s) => ({ id: s.id, topology: s.topology, title: s.title, description: s.description }));
}

export { eventKey };
