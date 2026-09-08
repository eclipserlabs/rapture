// Failure identity for reproducer-v0.
// A reduction candidate is accepted ONLY if it reproduces this exact
// fingerprint. Any other outcome (different error, crash, missing-mock,
// live-effect refusal, or success) is a rejection.
import { hashJson } from "./canonical.js";

export const FAILURE_KIND_APPLICATION = "APPLICATION";
export const FAILURE_KIND_SETUP = "SETUP";
export const FAILURE_KIND_CRASH = "CRASH";
export const FAILURE_KIND_NO_FAILURE = "NO_FAILURE";

/** Application failure thrown by fixture logic. Carries stable identity fields. */
export class AppError extends Error {
  constructor({ code, messageClass, frame, detail }) {
    super(`[${code}] ${messageClass}${detail !== undefined ? ` (${detail})` : ""}`);
    this.name = "AppError";
    this.code = code;
    this.messageClass = messageClass;
    this.frame = frame;
  }
}

/** Replay-harness error: the candidate capture lacks a boundary result the app requested. */
export class MissingMockError extends Error {
  constructor(message) {
    super(message);
    this.name = "MissingMockError";
    this.code = "E_MISSING_MOCK";
  }
}

/** Replay-harness error: the app attempted a forbidden live effect. */
export class LiveEffectError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveEffectError";
    this.code = "E_LIVE_EFFECT_BLOCKED";
  }
}

/**
 * Convert a replay outcome into a FailureFingerprint.
 * outcome: { status: "threw", error } | { status: "returned", value }
 */
export function fingerprintOfOutcome(outcome) {
  let fp;
  if (outcome.status === "returned") {
    fp = {
      failure_kind: FAILURE_KIND_NO_FAILURE,
      error_code: "E_NO_FAILURE",
      message_class: "NO_FAILURE",
      top_frame: "none",
    };
  } else {
    const err = outcome.error;
    if (err instanceof AppError) {
      fp = {
        failure_kind: FAILURE_KIND_APPLICATION,
        error_code: err.code,
        message_class: err.messageClass,
        top_frame: err.frame,
      };
    } else if (err instanceof MissingMockError || err instanceof LiveEffectError) {
      fp = {
        failure_kind: FAILURE_KIND_SETUP,
        error_code: err.code,
        message_class: err.name.toUpperCase(),
        top_frame: "replay-harness",
      };
    } else {
      fp = {
        failure_kind: FAILURE_KIND_CRASH,
        error_code: "E_UNEXPECTED",
        message_class: err instanceof Error ? err.name.toUpperCase() : "NON_ERROR_THROW",
        top_frame: "unknown",
      };
    }
  }
  return { ...fp, fingerprint_hash: hashJson(fp) };
}

export function sameFingerprint(a, b) {
  return a.fingerprint_hash === b.fingerprint_hash;
}
