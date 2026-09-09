// Real-bug case: rb-jwt-maxage (auth0/node-jsonwebtoken).
// Historical wrong behavior: verify() with numeric maxAge never expires the
// token (seconds/ms + type confusion), so a 400s-old token with maxAge 300 is
// ACCEPTED instead of rejected with TokenExpiredError.
// Test secret below is fixture data, never a production credential.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-jwt-maxage";
export const IMPL_ENTRY = "index.js";
export const VENDOR = {
  repo: "jsonwebtoken",
  paths: ["index.js", "sign.js", "verify.js", "decode.js", "lib"],
  transforms: [],
  extraTrees: [{ src: "/tmp/rb-stage/jwt-deps/node_modules", dest: "node_modules" }],
};

export function createScenario(implRequire) {
  const jwt = implRequire("./index.js");
  return {
    fullInput: () => ({
      subject: "svc",
      request: {
        payload: { foo: "bar", iat: 1500000000 },
        maxAge: 300,
        secret: "reproducer-test-secret",
      },
      lane: "primary",
    }),
    removableInputFields: () => ["lane"],
    fullConfig: () => ({ AUTH_MODE: "jwt", LOG_LEVEL: "info", RETRY_MAX: 2 }),
    fullDbRows: () => [
      { table: "subjects", key: "svc", value: { active: true } },
      { table: "audit_log", key: "j_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "j_1", value: { index: 1, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("clock", "now", "verify-now"), 1500000400);
      return m;
    },
    ambientEvents: () => [
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: 1500000000,
        metadata: { ambient: true },
      },
      {
        kind: "http",
        operation: "jwks-fetch",
        request_or_key: { kid: "k1" },
        recorded_result: { keys: [] },
        metadata: { ambient: true, note: "ambient key fetch" },
      },
    ],
    run: (ctx, input) => {
      const now = ctx.clock("verify-now");
      const token = jwt.sign(input.request.payload, input.request.secret);
      let payload;
      try {
        payload = jwt.verify(token, input.request.secret, {
          maxAge: input.request.maxAge,
          clockTimestamp: now,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TokenExpiredError" && /maxAge/.test(err.message)) {
          return { ok: true, rejected: true };
        }
        throw err;
      }
      void payload;
      throw new AppError({
        code: "E_REAL_JWT_MAXAGE",
        messageClass: "JWT_MAXAGE_BYPASS",
        frame: "jwt-verify",
      });
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_JWT_MAXAGE",
      message_class: "JWT_MAXAGE_BYPASS",
      top_frame: "jwt-verify",
    }),
  };
}
