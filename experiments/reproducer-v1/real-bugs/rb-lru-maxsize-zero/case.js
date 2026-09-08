// Real-bug case: rb-lru-maxsize-zero (isaacs/node-lru-cache, fixes #257).
// Historical wrong behavior: with maxEntrySize set but maxSize left 0
// (unbounded), every set() evicts everything because the eviction guard treats
// maxSize 0 as a real bound instead of unlimited.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-lru-maxsize-zero";
export const IMPL_ENTRY = "index.js";
export const VENDOR = { repo: "lru-cache", paths: ["index.js"], transforms: [], extraTrees: [] };

const SIZE_CALC = { "const-1": () => 1 };

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
      session: "s_2",
      ops: [
        { op: "set", key: "a", value: 1 },
        { op: "set", key: "b", value: 2 },
      ],
      label: "edge",
      batch: "b8",
    }),
    removableInputFields: () => ["label", "batch"],
    fullConfig: () => ({
      MAX: 10,
      MAX_ENTRY_SIZE: 5,
      SIZE_CALC: "const-1",
      EVICTION: "lru",
      LOG_LEVEL: "debug",
    }),
    fullDbRows: () => [
      { table: "sessions", key: "s_2", value: { owner: "api" } },
      { table: "audit_log", key: "z_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "z_1", value: { index: 1, note: "unrelated" } },
      { table: "audit_log", key: "z_2", value: { index: 2, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "cache-stat", { key: "a" }), { size: 0 });
      m.set(eventKey("http", "observed-state", { session: "s_2" }), { size: 1, keys: ["b"] });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "cache-op",
        request_or_key: { session: "other", seq: "o1", op: "set" },
        recorded_result: { ok: true },
        metadata: { ambient: true, note: "other session write" },
      },
      {
        kind: "http",
        operation: "cache-op",
        request_or_key: { session: "other", seq: "o2", op: "get" },
        recorded_result: { ok: true },
        metadata: { ambient: true, note: "other session read" },
      },
      {
        kind: "random",
        operation: "draw",
        request_or_key: "sampling",
        recorded_result: 0.31,
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      bestEffort(ctx, "cache-stat", { key: "a" }, { size: 0 });
      const cache = new LRU({
        max: ctx.getConfig("MAX"),
        maxEntrySize: ctx.getConfig("MAX_ENTRY_SIZE"),
        sizeCalculation: SIZE_CALC[ctx.getConfig("SIZE_CALC")],
      });
      for (const o of input.ops) {
        if (o.op === "set") cache.set(o.key, o.value);
        else if (o.op === "delete") cache.delete(o.key);
        else if (o.op === "get") cache.get(o.key);
      }
      const observed = ctx.http("observed-state", { session: input.session });
      const actual = { size: cache.size, keys: [...cache.keys()] };
      if (
        actual.size === observed.size &&
        JSON.stringify(actual.keys) === JSON.stringify(observed.keys) &&
        observed.size === 1
      ) {
        throw new AppError({
          code: "E_REAL_CACHE_EVICT",
          messageClass: "CACHE_EVICTION_ANOMALY",
          frame: "lru-session",
        });
      }
      return { ok: true, actual };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_CACHE_EVICT",
      message_class: "CACHE_EVICTION_ANOMALY",
      top_frame: "lru-session",
    }),
  };
}
