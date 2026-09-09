// Failure-triggered persistence: successful requests are discarded.
// V3 deferred design: the live request record holds RAW data; redaction,
// replay-key computation, and serialization happen here, once, for failed
// requests only. The emitted document is byte-identical in shape to V2.
import { mkdirSync, writeFileSync } from "node:fs";
import { safeArtifactPath, sha256 } from "../../../../packages/kernel/dist/index.js";
import { MODES, state } from "./state.mjs";
import { finalizePending, finalizeRequest, finalizeResponse, redactConfigSnapshot } from "./redact.mjs";
import { eventKey } from "./events.mjs";
import { inferFingerprint } from "../oracle/fingerprint.mjs";

function canonical(value) {
  return JSON.stringify(value);
}

export function shouldPersist(rec) {
  const status = rec.responseRaw?.status ?? rec.response?.status ?? 0;
  return status >= 500 || rec.appError != null;
}

/** Persist the incident capture synchronously; returns file path or null. */
export function maybePersist(rec) {
  if (state.mode !== MODES.CAPTURE) return null;
  if (!shouldPersist(rec)) return null;
  if (!state.outDir) return null;
  state.suspended = true;
  try {
    return persistNow(rec);
  } finally {
    state.suspended = false;
  }
}

function persistNow(rec) {
  const request = finalizeRequest(rec.request);
  const response = rec.responseRaw != null ? finalizeResponse(rec.responseRaw) : (rec.response ?? null);
  const events = (rec.events ?? []).map((p) => finalizePending(p, eventKey));
  let bytes = 0;
  for (const e of events) bytes += Buffer.byteLength(JSON.stringify(e), "utf8");
  rec.bytesRecorded = bytes;
  state.stats.bytesRecorded += bytes;
  const doc = {
    schema: "incident-capture-v2",
    captured_at: new Date().toISOString(),
    req_id: rec.reqId,
    request,
    response,
    events,
    config: redactConfigSnapshot(rec.config),
    app_error: rec.appError,
  };
  doc.fingerprint = inferFingerprint({
    request: { method: request.method, path: request.path },
    response,
    appError: rec.appError,
  });
  doc.capture_hash = sha256(canonical({ ...doc, capture_hash: undefined }));
  const name = `incident-${Date.now()}-${process.pid}-${state.reqCounter}.json`;
  const path = safeArtifactPath(state.outDir, name);
  mkdirSync(state.outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  state.stats.requestsPersisted += 1;
  return path;
}
