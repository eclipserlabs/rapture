// Boundary event model: recording + keyed replay consumption.
// Replay matches by (kind, key) with per-key FIFO queues; anything unmatched
// fails closed with an infra-coded error that can never equal an incident
// fingerprint.
import { redactPgParams, redactTextBody, redactUrl, sha256Hex } from "./redact.mjs";
import { MODES, nextSeq, state } from "./state.mjs";

export const LIVE_ATTEMPT = "RAPTURE_V2_LIVE_ATTEMPT";
export const MISSING_MOCK = "RAPTURE_V2_MISSING_MOCK";
export const REPLAY_MISMATCH = "RAPTURE_V2_REPLAY_MISMATCH";

export function infraError(code, message) {
  const err = new Error(message);
  err.code = code;
  err[V2_INFRA] = true;
  return err;
}

export const V2_INFRA = Symbol.for("rapture.v2.infra");

export function isInfraError(err) {
  return !!err && (err[V2_INFRA] === true || [LIVE_ATTEMPT, MISSING_MOCK, REPLAY_MISMATCH].includes(err?.code));
}

export function normalizeSql(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function stableJson(value) {
  return JSON.stringify(value) ?? "null";
}

/** Deterministic replay key for a boundary call. Counter holds per-kind consumption index. */
export function eventKey(kind, parts, counter) {
  if (kind === "pg") {
    return `pg:${normalizeSql(parts.text)}:${stableJson(redactPgParams(parts.values ?? []))}`;
  }
  if (kind === "http") {
    // Privacy fix (Phase 4): small bodies used to embed RAW secret values in
    // replay keys. Redact first, symmetrically: capture-finalize and
    // replay-live both key on redacted bodies, so matching is preserved while
    // raw secrets never reach keys, captures, or artifacts.
    const clean = typeof parts.body === "string" ? redactTextBody(parts.body) : (parts.body ?? "");
    const body = typeof clean === "string" && clean.length > 4096 ? `#sha:${sha256Hex(clean)}` : clean;
    return `http:${parts.method}:${redactUrl(parts.url)}:${body}`;
  }
  if (kind === "time" || kind === "random") {
    return `${kind}:${counter}`;
  }
  if (kind === "config") {
    return `config:${parts.name}`;
  }
  return `${kind}:${stableJson(parts)}`;
}

/**
 * Record a boundary observation as RAW data (V3 deferred design).
 * No serialization, no redaction, no hashing here: success-path requests
 * only retain small raw references that are freed on discard. Redaction,
 * replay-key computation, and byte accounting all happen once, at persist
 * time, for failed requests only (see finalizePending / persist.mjs).
 * keySpec: { parts, counter } — the exact inputs eventKey needs later.
 */
export function recordEvent(rec, kind, op, keySpec, requestRaw, resultRaw, error) {
  state.stats.eventsRecorded += 1;
  if (state.noRetain) return null;
  const seq = nextSeq(rec);
  const evt = { seq, kind, op, keySpec, requestRaw, resultRaw, error: error ?? null };
  rec.events.push(evt);
  return evt;
}

/** Compute the deterministic replay key for a retained pending event. */
export function pendingKey(pending) {
  return eventKey(pending.kind, pending.keySpec.parts, pending.keySpec.counter);
}

/** Build per-key FIFO queues from a loaded capture for replay. */
export function buildReplayQueues(doc) {
  const queues = new Map();
  for (const evt of doc.events ?? []) {
    const list = queues.get(evt.key) ?? [];
    list.push(evt);
    queues.set(evt.key, list);
  }
  return queues;
}

/** Consume next recorded event for key; throws fail-closed infra errors. */
export function consumeReplayEvent(queues, kind, key) {
  const list = queues.get(key);
  if (!list || list.length === 0) {
    throw infraError(MISSING_MOCK, `no recorded ${kind} boundary for key: ${key}`);
  }
  const evt = list.shift();
  if (evt.kind !== kind) {
    throw infraError(REPLAY_MISMATCH, `replay kind mismatch for key: ${key}`);
  }
  if (evt.error) {
    const err = new Error(evt.error.message ?? "recorded boundary error");
    if (evt.error.code) err.code = evt.error.code;
    throw err;
  }
  return evt;
}

export function replayActive() {
  return state.mode === MODES.REPLAY;
}

export function captureActive() {
  return state.mode === MODES.CAPTURE;
}

/**
 * Wrapper-engagement gate: capture-mode boundary wrappers run in CAPTURE and
 * INTERCEPT_DISCARD (the latter retains nothing). REPLAY has its own path.
 */
export function interceptActive() {
  return state.mode === MODES.CAPTURE || state.mode === MODES.INTERCEPT_DISCARD;
}
