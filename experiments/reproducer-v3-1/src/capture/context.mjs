// Request-scoped capture context (AsyncLocalStorage).
import { MODES, currentRequest, newRequestRecord, runSelected, state } from "./state.mjs";

const BODY_CAP = 1024 * 1024;

export function summarizeRequest(req) {
  // V3 deferred design: headers/body stay raw here; redaction happens once
  // at persist time (finalizeRequest). Host falls back the same way.
  const headersRaw = req.headers ?? {};
  const host = headersRaw["host"] ?? "localhost";
  const url = req.url ?? "/";
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: url.split("?")[0],
    query: url.includes("?") ? url.slice(url.indexOf("?")) : "",
    headersRaw,
    host,
    bodyChunks: null,
    bodyLen: 0,
  };
}

/** Run fn inside a fresh request record; returns {rec, result} or throws with rec attached. */
export function runInRequest(reqSummary, fn) {
  state.reqCounter += 1;
  const reqId = `req-${process.pid}-${Date.now()}-${state.reqCounter}`;
  const rec = newRequestRecord(reqId, reqSummary);
  state.stats.requestsSeen += 1;
  // V3.1: only requests SELECTED at ingress ever enter the ALS context.
  return runSelected(rec, fn);
}

export function getRequest() {
  return currentRequest();
}

export function isCaptureEnabled() {
  return (
    state.mode === MODES.CAPTURE ||
    state.mode === MODES.REPLAY ||
    state.mode === MODES.CONTEXT_ONLY ||
    state.mode === MODES.INTERCEPT_DISCARD
  );
}

/** True only when full interception (body tracking, event retention) runs. */
export function fullIntercept() {
  return (
    state.mode === MODES.CAPTURE || state.mode === MODES.REPLAY || state.mode === MODES.INTERCEPT_DISCARD
  );
}

/** Buffer raw request body chunks (capped); decode/redact deferred to persist. */
export function appendRequestBody(rec, chunk) {
  if (rec.request.bodyLen >= BODY_CAP) return;
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (rec.request.bodyChunks == null) rec.request.bodyChunks = [];
  rec.request.bodyChunks.push(buf);
  rec.request.bodyLen += buf.length;
}
