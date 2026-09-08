// Request-scoped capture context (AsyncLocalStorage).
import { MODES, currentRequest, newRequestRecord, state } from "./state.mjs";
import { redactHeaders, redactTextBody } from "./redact.mjs";

const BODY_CAP = 1024 * 1024;

export function summarizeRequest(req) {
  const headers = redactHeaders(req.headers ?? {});
  const host = headers["host"] ?? "localhost";
  const url = req.url ?? "/";
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: url.split("?")[0],
    query: url.includes("?") ? url.slice(url.indexOf("?")) : "",
    headers,
    host,
    body: null,
  };
}

/** Run fn inside a fresh request record; returns {rec, result} or throws with rec attached. */
export function runInRequest(reqSummary, fn) {
  state.reqCounter += 1;
  const reqId = `req-${process.pid}-${Date.now()}-${state.reqCounter}`;
  const rec = newRequestRecord(reqId, reqSummary);
  state.stats.requestsSeen += 1;
  return state.als.run(rec, fn);
}

export function getRequest() {
  return currentRequest();
}

export function isCaptureEnabled() {
  return state.mode === MODES.CAPTURE || state.mode === MODES.REPLAY;
}

/** Accumulate (capped) request body text for the capture record. */
export function appendRequestBody(rec, chunk) {
  if (rec.request.body == null) rec.request.body = "";
  if (rec.request.body.length >= BODY_CAP) return;
  const text = chunk.toString("utf8");
  rec.request.body = redactTextBody((rec.request.body + text).slice(0, BODY_CAP));
}
