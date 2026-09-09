// FailureFingerprint stability + strictness tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError, MissingMockError, LiveEffectError, fingerprintOfOutcome, sameFingerprint } from "../src/fingerprint.js";

function threw(error) {
  return fingerprintOfOutcome({ status: "threw", error });
}

describe("FailureFingerprint", () => {
  it("is stable for equivalent failures", () => {
    const a = threw(new AppError({ code: "E_X", messageClass: "BROKEN", frame: "op", detail: "id 1" }));
    const b = threw(new AppError({ code: "E_X", messageClass: "BROKEN", frame: "op", detail: "id 2" }));
    assert.equal(a.fingerprint_hash, b.fingerprint_hash);
    assert.ok(sameFingerprint(a, b));
  });

  it("differs for a different failure class", () => {
    const a = threw(new AppError({ code: "E_X", messageClass: "BROKEN", frame: "op" }));
    const b = threw(new AppError({ code: "E_Y", messageClass: "BROKEN", frame: "op" }));
    const c = threw(new AppError({ code: "E_X", messageClass: "OTHER", frame: "op" }));
    const d = threw(new AppError({ code: "E_X", messageClass: "BROKEN", frame: "other-op" }));
    assert.notEqual(a.fingerprint_hash, b.fingerprint_hash);
    assert.notEqual(a.fingerprint_hash, c.fingerprint_hash);
    assert.notEqual(a.fingerprint_hash, d.fingerprint_hash);
  });

  it("missing-mock/setup errors cannot satisfy an application fingerprint", () => {
    const app = threw(new AppError({ code: "E_X", messageClass: "BROKEN", frame: "op" }));
    const missing = threw(new MissingMockError("no retained boundary event"));
    const live = threw(new LiveEffectError("live network is forbidden"));
    const crash = threw(new TypeError("cannot read property of undefined"));
    const success = fingerprintOfOutcome({ status: "returned", value: { ok: true } });
    for (const other of [missing, live, crash, success]) {
      assert.notEqual(other.fingerprint_hash, app.fingerprint_hash, `setup outcome must not match: ${other.failure_kind}/${other.error_code}`);
      assert.ok(!sameFingerprint(other, app));
    }
    assert.equal(missing.failure_kind, "SETUP");
    assert.equal(missing.error_code, "E_MISSING_MOCK");
  });
});
