// Real-bug case: rb-semver-xrange-numeric (npm/node-semver).
// Historical wrong behavior: new Range('1.x.5') silently accepts (yields a
// comparator range) instead of throwing 'Invalid comparator'.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-semver-xrange-numeric";
export const IMPL_ENTRY = "index.js";
export const VENDOR = {
  repo: "semver",
  paths: ["index.js", "classes", "functions", "ranges", "internal"],
  transforms: [],
  extraTrees: [],
};

export function createScenario(implRequire) {
  const S = implRequire("./index.js");
  return {
    fullInput: () => ({ pkg: "demo", source: "lockfile" }),
    removableInputFields: () => ["source"],
    fullConfig: () => ({ APP_MODE: "parse", LOG_LEVEL: "debug", RETRY_MAX: 2 }),
    fullDbRows: () => [
      { table: "packages", key: "demo", value: { pinned: true } },
      { table: "audit_log", key: "x_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "x_1", value: { index: 1, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "range-parse", { pkg: "demo" }), { range: "1.x.5" });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "range-parse",
        request_or_key: { pkg: "other" },
        recorded_result: { range: "^2.0.0" },
        metadata: { ambient: true, note: "other package range" },
      },
      {
        kind: "random",
        operation: "draw",
        request_or_key: "sampling",
        recorded_result: 0.77,
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("range-parse", { pkg: input.pkg });
      try {
        const r = new S.Range(f.range);
        void r;
      } catch (err) {
        if (err instanceof Error && /Invalid comparator/.test(err.message)) {
          return { ok: true, rejected: true };
        }
        throw err;
      }
      throw new AppError({
        code: "E_REAL_RANGE_ACCEPT",
        messageClass: "RANGE_ACCEPT_ANOMALY",
        frame: "semver-parse",
      });
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_RANGE_ACCEPT",
      message_class: "RANGE_ACCEPT_ANOMALY",
      top_frame: "semver-parse",
    }),
  };
}
