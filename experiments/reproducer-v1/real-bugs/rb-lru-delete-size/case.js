// Real-bug case: rb-lru-delete-size (isaacs/node-lru-cache, PR #229).
// Historical wrong behavior (incident definition from the issue): after
// set/set/set/delete, calculatedSize goes NEGATIVE (-5) instead of 15 because
// delete() deducts the size twice.
// Oracle rule below encodes the reported wrong observable only; the reducer
// never sees revisions, diffs, or labels.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-lru-delete-size";
export const IMPL_ENTRY = "index.js";
export const VENDOR = { repo: "lru-cache", paths: ["index.js"], transforms: [], extraTrees: [] };

const SIZE_CALC = {
  "by-length": (v) => (typeof v === "string" ? v.length : 1),
  identity: () => 1,
};

function ambientOp(key, op, note) {
  return {
    kind: "http",
    operation: "cache-op",
    request_or_key: { session: "other", seq: key, op },
    recorded_result: { ok: true },
    metadata: { ambient: true, note },
  };
}

function bestEffort(ctx, operation, requestKey, fallback) {
  try {
    return ctx.http(operation, requestKey);
  } catch {
    return fallback;
  }
}

export function createScenario(implRequire) {
  const LRU = implRequire("./index.js");
  return {
    fullInput: () => ({
      session: "s_1",
      ops: [
        { op: "set", key: 5, value: "xxxxx" },
        { op: "set", key: 10, value: "xxxxxxxxxx" },
        { op: "set", key: 20, value: "xxxxxxxxxxxxxxxxxxxx" },
        { op: "delete", key: 20 },
      ],
      label: "nightly",
      debug: false,
      batch: "b7",
    }),
    removableInputFields: () => ["label", "debug", "batch"],
    fullConfig: () => ({
      MAX_SIZE: 100,
      SIZE_CALC: "by-length",
      EVICTION: "lru",
      LOG_LEVEL: "info",
      RETRY_MAX: 3,
    }),
    fullDbRows: () => [
      { table: "sessions", key: "s_1", value: { owner: "etl" } },
      { table: "sessions", key: "s_2", value: { owner: "api" } },
      { table: "audit_log", key: "w_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "w_1", value: { index: 1, note: "unrelated" } },
      { table: "audit_log", key: "w_2", value: { index: 2, note: "unrelated" } },
      { table: "audit_log", key: "w_3", value: { index: 3, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "cache-stat", { key: 5 }), { size: 5 });
      m.set(eventKey("http", "observed-state", { session: "s_1" }), { calculatedSize: -5 });
      return m;
    },
    ambientEvents: () => [
      ambientOp("o1", "get", "other session read"),
      ambientOp("o2", "set", "other session write"),
      ambientOp("o3", "has", "other session check"),
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: "2026-01-01T00:00:00Z",
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "cache-stat", { key: 5 }, { size: 0 });
      const calc = SIZE_CALC[ctx.getConfig("SIZE_CALC")];
      const cache = new LRU({ maxSize: ctx.getConfig("MAX_SIZE"), sizeCalculation: calc });
      for (const o of input.ops) {
        if (o.op === "set") cache.set(o.key, o.value);
        else if (o.op === "delete") cache.delete(o.key);
        else if (o.op === "get") cache.get(o.key);
      }
      const observed = ctx.http("observed-state", { session: input.session });
      const actual = cache.calculatedSize;
      if (actual === observed.calculatedSize && observed.calculatedSize === -5) {
        throw new AppError({
          code: "E_REAL_CACHE_SIZE",
          messageClass: "CACHE_SIZE_ANOMALY",
          frame: "lru-session",
        });
      }
      return { ok: true, actual };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_CACHE_SIZE",
      message_class: "CACHE_SIZE_ANOMALY",
      top_frame: "lru-session",
    }),
  };
}
