// Real-bug case: rb-cron-loop-limit (harrisiirak/cron-parser, PR #415).
// Historical wrong behavior: parse('0 0 0 31 4,6 *') (unsatisfiable: day 31
// never occurs in April/June) returns a bogus 2051 date instead of throwing
// 'loop limit exceeded'.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-cron-loop-limit";
export const IMPL_ENTRY = "dist/index.js";
export const VENDOR = {
  repo: "cron-parser",
  paths: [],
  transforms: [],
  extraTreesBuggy: [
    { src: "/tmp/rb-stage/cron-c4-buggy/dist", dest: "dist" },
    { src: "/tmp/rb-stage/luxon-trim/node_modules", dest: "node_modules" },
  ],
};

export function createScenario(implRequire) {
  const { CronExpressionParser } = implRequire("./index.js");
  return {
    fullInput: () => ({ schedule: "month-end", owner: "billing" }),
    removableInputFields: () => ["owner"],
    fullConfig: () => ({ SCHEDULER: "cron", LOG_LEVEL: "debug", RETRY_MAX: 1 }),
    fullDbRows: () => [
      { table: "schedules", key: "month-end", value: { enabled: true } },
      { table: "audit_log", key: "e_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "e_1", value: { index: 1, note: "unrelated" } },
      { table: "audit_log", key: "e_2", value: { index: 2, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "schedule-request", { schedule: "month-end" }), {
        expression: "0 0 0 31 4,6 *",
        currentDate: "2024-01-01T00:00:00Z",
        tz: "UTC",
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "schedule-request",
        request_or_key: { schedule: "other" },
        recorded_result: { expression: "0 9 * * 1", currentDate: "2024-01-01T00:00:00Z", tz: "UTC" },
        metadata: { ambient: true, note: "other schedule" },
      },
      {
        kind: "random",
        operation: "draw",
        request_or_key: "jitter",
        recorded_result: 0.05,
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("schedule-request", { schedule: input.schedule });
      try {
        const it = CronExpressionParser.parse(f.expression, { currentDate: f.currentDate, tz: f.tz });
        const next = it.next().toISOString();
        void next;
      } catch (err) {
        if (err instanceof Error && /loop limit exceeded/.test(err.message)) {
          return { ok: true, rejected: true };
        }
        throw err;
      }
      throw new AppError({
        code: "E_REAL_CRON_LOOP",
        messageClass: "CRON_LOOP_ANOMALY",
        frame: "cron-next",
      });
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_CRON_LOOP",
      message_class: "CRON_LOOP_ANOMALY",
      top_frame: "cron-next",
    }),
  };
}
