// Real-bug case: rb-lru-oversize-evict (isaacs/node-lru-cache).
// Historical wrong behavior: setting an oversized entry evicts the ENTIRE
// cache (and retains nothing) instead of refusing the oversized item while
// keeping existing entries.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-lru-oversize-evict";
export const IMPL_ENTRY = "index.js";
export const VENDOR = { repo: "lru-cache", paths: ["index.js"], transforms: [], extraTrees: [] };

const SIZE_CALC = { identity: (v) => (typeof v === "number" ? v : 1) };

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
      session: "s_3",
      ops: [
        { op: "set", key: "a", value: 5 },
        { op: "set", key: "b", value: 5 },
        { op: "set", key: "big", value: 50 },
      ],
      label: "edge",
      priority: 1,
    }),
    removableInputFields: () => ["label", "priority"],
    fullConfig: () => ({
      MAX_SIZE: 10,
      SIZE_CALC: "identity",
      EVICTION: "lru",
      LOG_LEVEL: "info",
      TIMEOUT_MS: 500,
    }),
    fullDbRows: () => [
      { table: "sessions", key: "s_3", value: { owner: "worker" } },
      { table: "audit_log", key: "y_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "y_1", value: { index: 1, note: "unrelated" } },
      { table: "audit_log", key: "y_2", value: { index: 2, note: "unrelated" } },
      { table: "audit_log", key: "y_3", value: { index: 3, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "cache-stat", { key: "a" }), { size: 5 });
      m.set(eventKey("http", "observed-state", { session: "s_3" }), {
        size: 0,
        hasA: false,
        hasBig: false,
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "cache-op",
        request_or_key: { session: "other", seq: "o1", op: "delete" },
        recorded_result: { ok: true },
        metadata: { ambient: true, note: "other session delete" },
      },
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: "2026-02-01T00:00:00Z",
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "cache-stat", { key: "a" }, { size: 0 });
      const cache = new LRU({
        maxSize: ctx.getConfig("MAX_SIZE"),
        sizeCalculation: SIZE_CALC[ctx.getConfig("SIZE_CALC")],
      });
      for (const o of input.ops) {
        if (o.op === "set") cache.set(o.key, o.value);
        else if (o.op === "delete") cache.delete(o.key);
        else if (o.op === "get") cache.get(o.key);
      }
      const observed = ctx.http("observed-state", { session: input.session });
      const actual = { size: cache.size, hasA: cache.has("a"), hasBig: cache.has("big") };
      if (
        actual.size === observed.size &&
        actual.hasA === observed.hasA &&
        actual.hasBig === observed.hasBig &&
        observed.size === 0 &&
        observed.hasA === false
      ) {
        throw new AppError({
          code: "E_REAL_CACHE_WIPE",
          messageClass: "CACHE_WIPE_ANOMALY",
          frame: "lru-session",
        });
      }
      return { ok: true, actual };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_CACHE_WIPE",
      message_class: "CACHE_WIPE_ANOMALY",
      top_frame: "lru-session",
    }),
  };
}
