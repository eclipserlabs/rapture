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
    const body = typeof parts.body === "string" && parts.body.length > 4096 ? `#sha:${sha256Hex(parts.body)}` : (parts.body ?? "");
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

export function recordEvent(rec, kind, op, key, request, result, error) {
  const seq = nextSeq(rec);
  const evt = { seq, kind, op, key, request, result: result ?? null, error: error ?? null };
  rec.events.push(evt);
  const delta = Buffer.byteLength(JSON.stringify(evt), "utf8");
  rec.bytesRecorded += delta;
  state.stats.bytesRecorded += delta;
  return evt;
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
