// Incident fixtures for reproducer-v0.
//
// Each scenario models ONE logical backend operation that fails in production.
// The fixture declares:
//   - full capture data (input, config, db rows, scripted + ambient boundary events)
//   - run(ctx, input): the actual application logic executed during replay
//   - expectedFingerprint(): the exact failure the full capture must reproduce
//   - removableInputFields(): input paths the reducer may delete (never causal ones)
//   - causalAtoms(): GROUND TRUTH for scoring only. The reducer never imports this.
//
// Noise taxonomy (every scenario carries intentional noise):
//   ambient events  - recorded incident-window interactions the failing op never requests
//   requested noise - auxiliary calls with graceful degradation (try/catch fallback),
//                     removable because replay still reproduces without them
//   unread db rows / unread config keys / extra input fields
//
// Rules for fixture code: only ctx.* boundary methods + pure computation.
// No Date.now(), Math.random(), fetch, or filesystem access in run().
import { AppError } from "./fingerprint.js";
import { eventKey } from "./replay.js";

function ambientHttp(operation, requestKey, recordedResult, note) {
  return { kind: "http", operation, request_or_key: requestKey, recorded_result: recordedResult, metadata: { ambient: true, note } };
}

function noiseDbRows(count, prefix, table = "audit_log") {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ table, key: `${prefix}_${i}`, value: { index: i, note: `unrelated ${table} row` } });
  }
  return rows;
}

function noiseAmbientEvents(count, prefix) {
  const evts = [];
  for (let i = 0; i < count; i += 1) {
    evts.push(
      ambientHttp(`noisy-op-${prefix}`, { window: i, probe: `${prefix}-${i}` }, { ok: true, index: i }, `ambient incident-window traffic ${i}`),
    );
  }
  return evts;
}

/** Best-effort enrichment read: returns fallback when the event was reduced away. */
function bestEffort(ctx, operation, requestKey, fallback) {
  try {
    return ctx.http(operation, requestKey);
  } catch {
    return fallback;
  }
}

const SCENARIOS = [
  {
    id: "upstream-503-fallback",
    title: "Upstream 503 with broken express fallback",
    description:
      "Pricing upstream returns 503; the express fallback path throws. Causal: the pricing " +
      "response plus input.express. Noise: profile/inventory enrichment calls, unrelated config, " +
      "unused db rows, ambient upstream calls.",
    fullInput: () => ({
      orderId: "ord_1001",
      sku: "SKU-42",
      express: true,
      locale: "en-GB",
      debug: false,
      coupon: "SAVE10",
    }),
    removableInputFields: () => ["express", "locale", "debug", "coupon"],
    fullConfig: () => ({ PRICING_TIMEOUT_MS: 1500, LOG_LEVEL: "info", CURRENCY: "USD", RETRY_MAX: 3 }),
    fullDbRows: () => [
      { table: "products", key: "SKU-42", value: { name: "Widget", price: 1999 } },
      { table: "products", key: "SKU-43", value: { name: "Gadget", price: 2999 } },
      { table: "users", key: "u_7", value: { name: "Ada" } },
      { table: "users", key: "u_8", value: { name: "Bob" } },
      ...noiseDbRows(2, "order503"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "user-profile", { userId: "u_7" }), { tier: "standard" });
      m.set(eventKey("http", "inventory", { sku: "SKU-42" }), { stock: 12 });
      m.set(eventKey("http", "pricing", { sku: "SKU-42", express: true }), { status: 503, body: "Service Unavailable" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("shipping-quote", { sku: "SKU-42" }, { cost: 499 }, "quote service call from incident window"),
      ambientHttp("tax-estimate", { region: "us" }, { rate: 0.07 }, "unrelated tax call"),
      ambientHttp("inventory", { sku: "SKU-99" }, { stock: 3 }, "different sku"),
      { kind: "clock", operation: "now", request_or_key: "deploy-tick", recorded_result: "2026-09-01T00:00:00Z", metadata: { ambient: true } },
      { kind: "random", operation: "draw", request_or_key: "ab-test", recorded_result: 0.12, metadata: { ambient: true } },
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "user-profile", { userId: "u_7" }, { tier: "unknown" });
      bestEffort(ctx, "inventory", { sku: input.sku }, { stock: 0 });
      const price = ctx.http("pricing", { sku: input.sku, express: input.express });
      if (price.status === 503) {
        if (input.express === true) {
          throw new AppError({ code: "E_FALLBACK_NO_EXPRESS", messageClass: "FALLBACK_FAILED", frame: "fallback-price" });
        }
        return { ok: true, fallback: "standard" };
      }
      return { ok: true, price: price.body };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_FALLBACK_NO_EXPRESS",
      message_class: "FALLBACK_FAILED",
      top_frame: "fallback-price",
    }),
    causalAtoms: () => ({
      events: [eventKey("http", "pricing", { sku: "SKU-42", express: true })],
      db: [],
      config: [],
      input: ["express"],
    }),
  },

  {
    id: "malformed-upstream-payload",
    title: "Syntactically valid but structurally unexpected upstream payload",
    description:
      "Entitlements API returns seats as a string instead of a number; strict parsing throws. " +
      "Causal: the single entitlements response. Noise: enrichment calls, ambient traffic, db, config.",
    fullInput: () => ({ userId: "u_99", feature: "seats", requestId: "req_5", locale: "de-DE" }),
    removableInputFields: () => ["requestId", "locale"],
    fullConfig: () => ({ ENTITLEMENTS_VERSION: "v2", LOG_LEVEL: "debug", CACHE_TTL_S: 60 }),
    fullDbRows: () => [
      { table: "users", key: "u_99", value: { name: "Cara" } },
      ...noiseDbRows(4, "ent"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "user-profile", { userId: "u_99" }), { tier: "pro" });
      m.set(eventKey("http", "entitlements", { user: "u_99" }), { plan: "pro", seats: "unlimited", renewed: "2026-01-01" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("entitlements", { user: "u_100" }, { plan: "free", seats: 1 }, "different user"),
      ambientHttp("feature-flags", { user: "u_99" }, { flags: ["a", "b"] }, "unrelated flags call"),
      ambientHttp("audit-write", { event: "login" }, { stored: true }, "ambient write record"),
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "user-profile", { userId: input.userId }, { tier: "unknown" });
      const ent = ctx.http("entitlements", { user: input.userId });
      if (typeof ent.seats !== "number") {
        throw new AppError({ code: "E_ENTITLEMENT_SHAPE", messageClass: "SCHEMA_MISMATCH", frame: "parse-entitlements" });
      }
      return { ok: true, seats: ent.seats };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_ENTITLEMENT_SHAPE",
      message_class: "SCHEMA_MISMATCH",
      top_frame: "parse-entitlements",
    }),
    causalAtoms: () => ({
      events: [eventKey("http", "entitlements", { user: "u_99" })],
      db: [],
      config: [],
      input: [],
    }),
  },

  {
    id: "database-state-edge",
    title: "Small subset of recorded db rows creates the failure",
    description:
      "Charge authorization fails only when account ac_123 is suspended AND the fraud_review flag " +
      "is set; 22 unrelated rows are present. Causal: the two db rows. Noise: everything else.",
    fullInput: () => ({ accountId: "ac_123", amount: 5000, currency: "USD", note: "retry-2" }),
    removableInputFields: () => ["currency", "note"],
    fullConfig: () => ({ AUTH_MODE: "strict", LOG_LEVEL: "info", RETRY_MAX: 2 }),
    fullDbRows: () => [
      { table: "accounts", key: "ac_123", value: { status: "suspended", balance: 120 } },
      { table: "flags", key: "fraud_review", value: { value: true } },
      { table: "accounts", key: "ac_124", value: { status: "active", balance: 900 } },
      { table: "accounts", key: "ac_125", value: { status: "active", balance: 10 } },
      { table: "flags", key: "holiday_mode", value: { value: false } },
      ...noiseDbRows(19, "dbstate"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "risk-score", { account: "ac_123" }), { score: 0.2 });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("risk-score", { account: "ac_124" }, { score: 0.05 }, "different account"),
      ambientHttp("ledger-read", { account: "ac_123" }, { entries: 4 }, "ambient ledger read"),
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "risk-score", { account: input.accountId }, { score: 0 });
      const acct = ctx.dbGet("accounts", input.accountId);
      if (acct === undefined) {
        throw new AppError({ code: "E_UNKNOWN_ACCOUNT", messageClass: "UNKNOWN_ACCOUNT", frame: "authorize-charge" });
      }
      const flag = ctx.dbGet("flags", "fraud_review");
      if (acct.status === "suspended" && flag !== undefined && flag.value === true) {
        throw new AppError({ code: "E_ACCOUNT_FROZEN", messageClass: "ACCOUNT_FROZEN", frame: "authorize-charge" });
      }
      return { ok: true, authorized: input.amount };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_ACCOUNT_FROZEN",
      message_class: "ACCOUNT_FROZEN",
      top_frame: "authorize-charge",
    }),
    causalAtoms: () => ({
      events: [],
      db: ["accounts:ac_123", "flags:fraud_review"],
      config: [],
      input: [],
    }),
  },

  {
    id: "expired-time-boundary",
    title: "Captured clock value crosses an expiry boundary",
    description:
      "Token validation fails because the captured now crosses iat+TTL. Causal: the clock event " +
      "plus TOKEN_TTL_S. Noise: other config, ambient events, db rows.",
    fullInput: () => ({ token: { id: "tok_1", iat: "2026-08-01T00:00:00Z" }, actor: "svc-billing", trace: "t-1" }),
    removableInputFields: () => ["token.iat", "actor", "trace"],
    fullConfig: () => ({ TOKEN_TTL_S: 86400, LOG_LEVEL: "info", CLOCK_SKEW_S: 0, REGION: "us-east" }),
    fullDbRows: () => [
      { table: "tokens", key: "tok_1", value: { revoked: false } },
      ...noiseDbRows(5, "exp"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("clock", "now", "now"), "2026-09-07T00:00:00Z");
      return m;
    },
    ambientEvents: () => [
      { kind: "clock", operation: "now", request_or_key: "deploy-tick", recorded_result: "2026-09-01T00:00:00Z", metadata: { ambient: true } },
      ambientHttp("revocation-list", { shard: 3 }, { count: 0 }, "ambient revocation poll"),
      ambientHttp("metrics-push", { service: "auth" }, { accepted: true }, "ambient metrics"),
    ],
    run: (ctx, input) => {
      const nowMs = Date.parse(ctx.clock("now"));
      const ttlS = ctx.getConfig("TOKEN_TTL_S");
      const expMs = Date.parse(input.token.iat) + ttlS * 1000;
      if (nowMs > expMs) {
        throw new AppError({ code: "E_TOKEN_EXPIRED", messageClass: "TOKEN_EXPIRED", frame: "check-expiry" });
      }
      return { ok: true, subject: input.token.id };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_TOKEN_EXPIRED",
      message_class: "TOKEN_EXPIRED",
      top_frame: "check-expiry",
    }),
    causalAtoms: () => ({
      events: [eventKey("clock", "now", "now")],
      db: [],
      config: ["TOKEN_TTL_S"],
      input: ["token.iat"],
    }),
  },

  {
    id: "random-idempotency-path",
    title: "Captured random value selects the faulty branch",
    description:
      "A captured random draw >= 0.5 routes into the dedupe-write path where an existing " +
      "idempotency row triggers a conflict. Causal: the draw plus the idempotency row.",
    fullInput: () => ({ orderId: "ord_555", key: "idem_abc", attempt: 1 }),
    removableInputFields: () => ["attempt"],
    fullConfig: () => ({ DEDUPE_ENABLED: true, LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "idempotency", key: "idem_abc", value: { order: "ord_555", status: "committed" } },
      { table: "idempotency", key: "idem_old", value: { order: "ord_001", status: "expired" } },
      ...noiseDbRows(6, "idem"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("random", "draw", "idempotency-draw"), 0.87);
      return m;
    },
    ambientEvents: () => [
      { kind: "random", operation: "draw", request_or_key: "ab-test", recorded_result: 0.12, metadata: { ambient: true } },
      { kind: "random", operation: "draw", request_or_key: "sampling", recorded_result: 0.44, metadata: { ambient: true } },
      ambientHttp("order-read", { order: "ord_555" }, { total: 100 }, "ambient order read"),
    ],
    run: (ctx, input) => {
      const draw = ctx.random("idempotency-draw");
      if (draw >= 0.5) {
        const existing = ctx.dbGet("idempotency", input.key);
        if (existing !== undefined && existing.status === "committed") {
          throw new AppError({ code: "E_IDEMPOTENCY_CONFLICT", messageClass: "IDEMPOTENCY_CONFLICT", frame: "dedupe-write" });
        }
        return { ok: true, deduped: true };
      }
      return { ok: true, deduped: false };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_IDEMPOTENCY_CONFLICT",
      message_class: "IDEMPOTENCY_CONFLICT",
      top_frame: "dedupe-write",
    }),
    causalAtoms: () => ({
      events: [eventKey("random", "draw", "idempotency-draw")],
      db: ["idempotency:idem_abc"],
      config: [],
      input: [],
    }),
  },

  {
    id: "config-region-combination",
    title: "Only a small combination of config values fails",
    description:
      "Store selection throws only for REGION=eu-west AND DATA_TIER=standard. Causal: the two " +
      "config keys. Noise: eight other config keys, ambient events, db rows.",
    fullInput: () => ({ dataset: "events", window: "7d", format: "json" }),
    removableInputFields: () => ["format"],
    fullConfig: () => ({
      REGION: "eu-west",
      DATA_TIER: "standard",
      LOG_LEVEL: "info",
      RETRY_MAX: 3,
      TIMEOUT_MS: 2000,
      CACHE_TTL_S: 300,
      FEATURE_X: false,
      AUDIT_SINK: "local",
      PAGE_SIZE: 50,
      CONCURRENCY: 4,
    }),
    fullDbRows: () => [
      { table: "datasets", key: "events", value: { shards: 6 } },
      ...noiseDbRows(5, "cfg"),
    ],
    script: () => new Map(),
    ambientEvents: () => [
      ambientHttp("shard-list", { dataset: "events" }, { shards: 6 }, "ambient shard list"),
      ambientHttp("quota-check", { dataset: "events" }, { remaining: 1000 }, "ambient quota"),
    ],
    run: (ctx, _input) => {
      const region = ctx.getConfig("REGION");
      const tier = ctx.getConfig("DATA_TIER");
      if (region === "eu-west" && tier === "standard") {
        throw new AppError({ code: "E_REGION_TIER_UNSUPPORTED", messageClass: "REGION_UNSUPPORTED", frame: "select-store" });
      }
      return { ok: true, store: `${region}-${tier}` };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REGION_TIER_UNSUPPORTED",
      message_class: "REGION_UNSUPPORTED",
      top_frame: "select-store",
    }),
    causalAtoms: () => ({
      events: [],
      db: [],
      config: ["REGION", "DATA_TIER"],
      input: [],
    }),
  },

  {
    id: "ordered-two-call-sequence",
    title: "Failure depends on two boundary calls in recorded sequence",
    description:
      "Reserve then commit: the commit conflicts only against the reservation made by the " +
      "preceding reserve call. Both events in order are causal. Noise: seat-map enrichment, " +
      "ambient calls, db rows, config.",
    fullInput: () => ({ seat: "A12", show: "sh_9", promo: "EARLY" }),
    removableInputFields: () => ["promo"],
    fullConfig: () => ({ SEAT_HOLD_S: 300, LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "shows", key: "sh_9", value: { title: " opener" } },
      ...noiseDbRows(4, "seq"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "seat-map", { show: "sh_9" }), { seats: 200, free: 11 });
      m.set(eventKey("http", "reserve", { seat: "A12", show: "sh_9" }), { reservation: "rsv_9" });
      m.set(eventKey("http", "commit", { reservation: "rsv_9" }), { status: "CONFLICT_ALREADY_COMMITTED" });
      return m;
    },
    ambientEvents: () => [
      ambientHttp("seat-map", { show: "sh_10" }, { seats: 200, free: 190 }, "different show"),
      ambientHttp("reserve", { seat: "B01", show: "sh_9" }, { reservation: "rsv_other" }, "different seat"),
      ambientHttp("pricing", { seat: "A12" }, { price: 4500 }, "ambient pricing"),
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "seat-map", { show: input.show }, { seats: 0, free: 0 });
      const r = ctx.http("reserve", { seat: input.seat, show: input.show });
      const c = ctx.http("commit", { reservation: r.reservation });
      if (c.status === "CONFLICT_ALREADY_COMMITTED") {
        throw new AppError({ code: "E_DOUBLE_COMMIT", messageClass: "DOUBLE_COMMIT", frame: "commit-seat" });
      }
      return { ok: true, committed: r.reservation };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_DOUBLE_COMMIT",
      message_class: "DOUBLE_COMMIT",
      top_frame: "commit-seat",
    }),
    causalAtoms: () => ({
      events: [
        eventKey("http", "reserve", { seat: "A12", show: "sh_9" }),
        eventKey("http", "commit", { reservation: "rsv_9" }),
      ],
      db: [],
      config: [],
      input: [],
    }),
  },

  {
    id: "noise-heavy-incident",
    title: "Deliberately large capture, tiny causal core",
    description:
      "Stress case: ~120 capture atoms, only 3 causal (billing-charge response, input.amount, " +
      "the overdue account row). Measures reduction ratio and reducer search cost.",
    fullInput: () => ({
      orderId: "ord_9000",
      amount: 9900,
      currency: "USD",
      locale: "en-US",
      debug: false,
      coupon: "NONE",
      channel: "web",
      campaign: "fall",
      notes: "priority",
    }),
    removableInputFields: () => ["amount", "currency", "locale", "debug", "coupon", "channel", "campaign", "notes"],
    fullConfig: () => ({
      SETTLE_MODE: "strict",
      HIGH_VALUE_THRESHOLD: 5000,
      LOG_LEVEL: "info",
      RETRY_MAX: 3,
      TIMEOUT_MS: 2000,
      CACHE_TTL_S: 120,
      FEATURE_Y: true,
      AUDIT_SINK: "local",
      PAGE_SIZE: 25,
      CONCURRENCY: 2,
      REGION: "us-east",
      CURRENCY_DEFAULT: "USD",
      WEBHOOK_URL: "https://hooks.example.invalid/x",
      DRY_RUN: false,
      BATCH_SIZE: 100,
    }),
    fullDbRows: () => [
      { table: "accounts", key: "ac_9", value: { status: "overdue", balance: -40 } },
      { table: "accounts", key: "ac_10", value: { status: "active", balance: 500 } },
      ...noiseDbRows(38, "heavy"),
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "fraud-check", { order: "ord_9000" }), { risk: "low" });
      m.set(
        eventKey("http", "billing-charge", { order: "ord_9000", amount: 9900 }),
        { declined: true, code: "INSUFFICIENT_FUNDS" },
      );
      return m;
    },
    ambientEvents: () => noiseAmbientEvents(60, "heavy"),
    run: (ctx, input) => {
      bestEffort(ctx, "fraud-check", { order: input.orderId }, { risk: "unknown" });
      const charge = ctx.http("billing-charge", { order: input.orderId, amount: input.amount });
      const acct = ctx.dbGet("accounts", "ac_9");
      const threshold = ctx.getConfig("HIGH_VALUE_THRESHOLD");
      if (charge.declined === true && input.amount > threshold && acct !== undefined && acct.status === "overdue") {
        throw new AppError({ code: "E_CHARGE_DECLINED_HIGH_VALUE", messageClass: "CHARGE_DECLINED", frame: "settle-charge" });
      }
      return { ok: true, settled: input.orderId };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_CHARGE_DECLINED_HIGH_VALUE",
      message_class: "CHARGE_DECLINED",
      top_frame: "settle-charge",
    }),
    causalAtoms: () => ({
      events: [eventKey("http", "billing-charge", { order: "ord_9000", amount: 9900 })],
      db: ["accounts:ac_9"],
      config: ["HIGH_VALUE_THRESHOLD"],
      input: ["amount"],
    }),
  },
];

export function getScenario(id) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`unknown scenario: ${id}`);
  return s;
}

export function listScenarios() {
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title, description: s.description }));
}

export { eventKey };
