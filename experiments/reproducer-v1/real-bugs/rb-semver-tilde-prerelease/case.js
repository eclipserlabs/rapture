// Real-bug case: rb-semver-tilde-prerelease (npm/node-semver, PR #878).
// Historical wrong behavior: satisfies('1.2.0-rc','~1.2',{includePrerelease:true})
// returns false (tilde lower bound drops prereleases) instead of true.
import { AppError } from "../../../reproducer-v0/src/fingerprint.js";
import { eventKey } from "../../../reproducer-v0/src/replay.js";

export const CASE_ID = "rb-semver-tilde-prerelease";
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
    fullInput: () => ({ pkg: "demo", channel: "stable", verbose: false }),
    removableInputFields: () => ["channel", "verbose"],
    fullConfig: () => ({ APP_MODE: "check", LOG_LEVEL: "info", TIMEOUT_MS: 1000 }),
    fullDbRows: () => [
      { table: "packages", key: "demo", value: { pinned: false } },
      { table: "audit_log", key: "v_0", value: { index: 0, note: "unrelated" } },
      { table: "audit_log", key: "v_1", value: { index: 1, note: "unrelated" } },
      { table: "audit_log", key: "v_2", value: { index: 2, note: "unrelated" } },
    ],
    script: () => {
      const m = new Map();
      m.set(eventKey("http", "version-check", { pkg: "demo" }), {
        version: "1.2.0-rc",
        range: "~1.2",
        options: { includePrerelease: true },
      });
      return m;
    },
    ambientEvents: () => [
      {
        kind: "http",
        operation: "version-check",
        request_or_key: { pkg: "other" },
        recorded_result: { version: "2.0.0", range: "*", options: {} },
        metadata: { ambient: true, note: "other package check" },
      },
      {
        kind: "http",
        operation: "registry-meta",
        request_or_key: { pkg: "demo" },
        recorded_result: { etag: "abc" },
        metadata: { ambient: true, note: "ambient registry read" },
      },
      {
        kind: "clock",
        operation: "now",
        request_or_key: "deploy-tick",
        recorded_result: "2026-03-01T00:00:00Z",
        metadata: { ambient: true },
      },
    ],
    run: (ctx, input) => {
      const f = ctx.http("version-check", { pkg: input.pkg });
      const ok = S.satisfies(f.version, f.range, f.options);
      if (ok === false) {
        throw new AppError({
          code: "E_REAL_RANGE",
          messageClass: "RANGE_ANOMALY",
          frame: "semver-check",
        });
      }
      return { ok: true, satisfies: ok };
    },
    expectedFingerprint: () => ({
      failure_kind: "APPLICATION",
      error_code: "E_REAL_RANGE",
      message_class: "RANGE_ANOMALY",
      top_frame: "semver-check",
    }),
  };
}
