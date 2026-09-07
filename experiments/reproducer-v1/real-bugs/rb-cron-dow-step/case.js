// Real-bug case: rb-cron-dow-step (harrisiirak/cron-parser, PR #438).
// Historical wrong behavior: parse('0 0 * * 2/2') includes Sunday in the
// day-of-week set, so next() from Sat 2024-06-01 returns Sunday 2024-06-02
// instead of Tuesday 2024-06-04.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-cron-dow-step";
export const IMPL_ENTRY = "dist/index.js";
export const VENDOR = {
  repo: "cron-parser",
  paths: [],
  transforms: [],
  extraTreesBuggy: [
    { src: "/tmp/rb-stage/cron-c1-buggy/dist", dest: "dist" },
    { src: "/tmp/rb-stage/luxon-trim/node_modules", dest: "node_modules" },
  ],
};

export function createScenario(implRequire) {
  const { CronExpressionParser } = implRequire("./index.js");
  return {
    fullInput: () => ({ schedule: "nightly-sync", owner: "etl" }),
    removableInputFields: () => ["owner"],
    fullConfig: () => ({ SCHEDULER: "cron", LOG_LEVEL: "info", TIMEOUT_MS: 900 }),
    fullDbRows: () => [
      { table: "schedules", key: "nightly-sync", value: { enabled: true } },
      { table: "audit_log", key: "d_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "d_1", value: { index: 1, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "schedule-request", { schedule: "nightly-sync" }), {
        expression: "0 0 * * 2/2",
        currentDate: "2024-06-01T00:00:00Z",
        tz: "UTC",
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "schedule-request",
        request_or_key: { schedule: "other" },
        recorded_result: { expression: "0 12 * * *", currentDate: "2024-06-01T00:00:00Z", tz: "UTC" },
        metadata: { ambient: true, note: "other schedule" },
      },
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: "2024-06-01T00:00:00Z",
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("schedule-request", { schedule: input.schedule });
      let next;
      try {
        const it = CronExpressionParser.parse(f.expression, { currentDate: f.currentDate, tz: f.tz });
        next = it.next().toISOString();
      } catch (err) {
        throw err;
      }
      if (next === "2024-06-02T00:00:00.000Z") {
        throw new AppError({
          code: "E_REAL_CRON_NEXT",
          messageClass: "CRON_NEXT_ANOMALY",
          frame: "cron-next",
        });
      }
      return { ok: true, next };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_CRON_NEXT",
      message_class: "CRON_NEXT_ANOMALY",
      top_frame: "cron-next",
    }),
  };
}
