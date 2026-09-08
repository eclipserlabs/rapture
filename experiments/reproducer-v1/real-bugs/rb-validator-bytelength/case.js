// Real-bug case: rb-validator-bytelength (validatorjs/validator.js, #2822).
// Historical wrong behavior: isByteLength(loneSurrogate,{min:3,max:3}) throws
// URIError (via encodeURI) instead of returning true.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-validator-bytelength";
export const IMPL_ENTRY = "src/lib/isByteLength.js";
export const VENDOR = {
  repo: "validator",
  paths: ["src/lib/isByteLength.js", "src/lib/util/assertString.js"],
  transforms: [
    {
      path: "src/lib/isByteLength.js",
      search: "import assertString from './util/assertString';",
      replace: "const assertString = require('./util/assertString.js');",
    },
    {
      path: "src/lib/isByteLength.js",
      search: "export default function isByteLength",
      replace: "module.exports = function isByteLength",
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
  const isByteLength = implRequire("./isByteLength.js");
  return {
    fullInput: () => ({ field: "name", form: "signup" }),
    removableInputFields: () => ["form"],
    fullConfig: () => ({ VALIDATION: "strict", LOG_LEVEL: "info", TIMEOUT_MS: 300 }),
    fullDbRows: () => [
      { table: "forms", key: "signup", value: { fields: 3 } },
      { table: "audit_log", key: "s_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "s_1", value: { index: 1, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "field-value", { field: "name" }), {
        value: "\ud800",
        options: { min: 3, max: 3 },
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "field-value",
        request_or_key: { field: "email" },
        recorded_result: { value: "a@b.co", options: {} },
        metadata: { ambient: true, note: "other field" },
      },
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: "2026-04-01T00:00:00Z",
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("field-value", { field: input.field });
      try {
        const ok = isByteLength(f.value, f.options);
        void ok;
      } catch (err) {
        if (err instanceof URIError) {
          throw new AppError({
            code: "E_REAL_VALIDATOR_CRASH",
            messageClass: "VALIDATOR_CRASH_ANOMALY",
            frame: "validate-field",
          });
        }
        throw err;
      }
      return { ok: true };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_VALIDATOR_CRASH",
      message_class: "VALIDATOR_CRASH_ANOMALY",
      top_frame: "validate-field",
    }),
  };
}
