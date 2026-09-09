// Real-bug case: rb-qs-comma-arraylimit (ljharb/qs, CVE-2026-2391 follow-up).
// Historical wrong behavior: parse('a[]=1,2,3,4',{comma,arrayLimit:3,
// throwOnLimitExceeded:true}) silently returns instead of throwing RangeError.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-qs-comma-arraylimit";
export const IMPL_ENTRY = "lib/index.js";
export const VENDOR = {
  repo: "qs",
  paths: ["lib"],
  transforms: [],
  extraTrees: [{ src: "/tmp/rb-stage/qs-q1-deps/node_modules", dest: "node_modules" }],
};

export function createScenario(implRequire) {
  const qs = implRequire("./index.js");
  return {
    fullInput: () => ({ endpoint: "search", source: "gateway" }),
    removableInputFields: () => ["source"],
    fullConfig: () => ({ PARSER: "qs", LOG_LEVEL: "info", TIMEOUT_MS: 800 }),
    fullDbRows: () => [
      { table: "endpoints", key: "search", value: { limit: 100 } },
      { table: "audit_log", key: "q_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "q_1", value: { index: 1, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "query-capture", { endpoint: "search" }), {
        query: "a[]=1,2,3,4",
        options: { comma: true, arrayLimit: 3, throwOnLimitExceeded: true },
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "query-capture",
        request_or_key: { endpoint: "other" },
        recorded_result: { query: "b=1", options: {} },
        metadata: { ambient: true, note: "other endpoint query" },
      },
      {
        kind: "http",
        operation: "schema-fetch",
        request_or_key: { endpoint: "search" },
        recorded_result: { fields: ["a"] },
        metadata: { ambient: true, note: "ambient schema read" },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("query-capture", { endpoint: input.endpoint });
      let parsed;
      try {
        parsed = qs.parse(f.query, f.options);
      } catch (err) {
        if (err instanceof RangeError && /Array limit exceeded/.test(err.message)) {
          return { ok: true, rejected: true };
        }
        throw err;
      }
      void parsed;
      throw new AppError({
        code: "E_REAL_QS_LIMIT",
        messageClass: "QS_LIMIT_BYPASS",
        frame: "qs-parse",
      });
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_QS_LIMIT",
      message_class: "QS_LIMIT_BYPASS",
      top_frame: "qs-parse",
    }),
  };
}
