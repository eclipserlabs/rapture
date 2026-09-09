// Real-bug case: rb-qs-combine-overflow (ljharb/qs).
// Historical wrong behavior: parse('a=1,2,3&a=4,5,6',{comma,arrayLimit:5,
// throwOnLimitExceeded:true}) silently converts to an overflow object instead
// of throwing RangeError (cumulative growth across duplicate keys).
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-qs-combine-overflow";
export const IMPL_ENTRY = "lib/index.js";
export const VENDOR = {
  repo: "qs",
  paths: ["lib"],
  transforms: [],
  extraTrees: [{ src: "/tmp/rb-stage/qs-q3-deps/node_modules", dest: "node_modules" }],
};

export function createScenario(implRequire) {
  const qs = implRequire("./index.js");
  return {
    fullInput: () => ({ endpoint: "ingest", source: "batch" }),
    removableInputFields: () => ["source"],
    fullConfig: () => ({ PARSER: "qs", LOG_LEVEL: "debug", RETRY_MAX: 1 }),
    fullDbRows: () => [
      { table: "endpoints", key: "ingest", value: { limit: 50 } },
      { table: "audit_log", key: "c_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "c_1", value: { index: 1, note: "unrelated" } },
      { table: "audit_log", key: "c_2", value: { index: 2, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "query-capture", { endpoint: "ingest" }), {
        query: "a=1,2,3&a=4,5,6",
        options: { comma: true, arrayLimit: 5, throwOnLimitExceeded: true },
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "query-capture",
        request_or_key: { endpoint: "other" },
        recorded_result: { query: "z=9", options: {} },
        metadata: { ambient: true, note: "other endpoint query" },
      },
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: "2026-05-01T00:00:00Z",
        metadata: { ambient: true },
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
        code: "E_REAL_QS_OVERFLOW",
        messageClass: "QS_OVERFLOW_ANOMALY",
        frame: "qs-parse",
      });
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_QS_OVERFLOW",
      message_class: "QS_OVERFLOW_ANOMALY",
      top_frame: "qs-parse",
    }),
  };
}
