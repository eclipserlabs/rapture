// Real-bug case: rb-validator-iso-week (validatorjs/validator.js, #2774).
// Historical wrong behavior: isISO8601('2009-W00') returns true (week 00 is
// impossible) instead of false.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-validator-iso-week";
export const IMPL_ENTRY = "src/lib/isISO8601.js";
export const VENDOR = {
  repo: "validator",
  paths: ["src/lib/isISO8601.js", "src/lib/util/assertString.js"],
  transforms: [
    {
      path: "src/lib/isISO8601.js",
      search: "import assertString from './util/assertString';",
      replace: "const assertString = require('./util/assertString.js');",
    },
    {
      path: "src/lib/isISO8601.js",
      search: "export default function isISO8601",
      replace: "module.exports = function isISO8601",
    },
    {
      path: "src/lib/util/assertString.js",
      search: "export default function assertString",
      replace: "module.exports = function assertString",
    },
  ],
  extraTrees: [],
};

export function createScenario(implRequire) {
  const isISO8601 = implRequire("./isISO8601.js");
  return {
    fullInput: () => ({ field: "week", strict: false }),
    removableInputFields: () => ["strict"],
    fullConfig: () => ({ VALIDATION: "lenient", LOG_LEVEL: "info" }),
    fullDbRows: () => [
      { table: "forms", key: "report", value: { fields: 1 } },
      { table: "audit_log", key: "w_0", value: { index: 0, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "field-value", { field: "week" }), { value: "2009-W00" });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "field-value",
        request_or_key: { field: "other" },
        recorded_result: { value: "2009-W01" },
        metadata: { ambient: true, note: "valid control week" },
      },
      {
        kind: "random",
        operation: "draw",
        request_or_key: "sampling",
        recorded_result: 0.5,
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("field-value", { field: input.field });
      const ok = isISO8601(f.value);
      if (ok === true) {
        throw new AppError({
          code: "E_REAL_VALIDATOR_FP",
          messageClass: "VALIDATOR_FALSE_POSITIVE",
          frame: "validate-field",
        });
      }
      return { ok: true, valid: ok };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_VALIDATOR_FP",
      message_class: "VALIDATOR_FALSE_POSITIVE",
      top_frame: "validate-field",
    }),
  };
}
