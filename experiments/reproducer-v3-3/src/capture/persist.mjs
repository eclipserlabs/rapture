// Failure-triggered persistence: successful requests are discarded.
// V3 deferred design: the live request record holds RAW data; redaction,
// replay-key computation, and serialization happen here, once, for failed
// requests only. The emitted document is byte-identical in shape to V2.
import { mkdirSync, writeFileSync } from "node:fs";
import { safeArtifactPath, sha256 } from "../../../../packages/kernel/dist/index.js";
import { MODES, state } from "./state.mjs";
import {
  drainBlockedCredentials,
  finalizePending,
  finalizeRequest,
  finalizeResponse,
  redactConfigSnapshot,
} from "./redact.mjs";
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
  // Anything left over from a previous request must not be attributed here.
  drainBlockedCredentials();
  const request = finalizeRequest(rec.request);
  const response = rec.responseRaw != null ? finalizeResponse(rec.responseRaw) : (rec.response ?? null);
  const events = (rec.events ?? []).map((p) => finalizePending(p, eventKey));
  let bytes = 0;
  for (const e of events) bytes += Buffer.byteLength(JSON.stringify(e), "utf8");
  rec.bytesRecorded = bytes;
  state.stats.bytesRecorded += bytes;
  // V3.2 fail-closed session-credential rule.
  //
  // A signature-bearing credential (JWT-shaped, or a signed cookie) cannot be
  // replaced by a surrogate: the application verifies it, so substitution
  // would change application behaviour and the replay would reproduce a
  // DIFFERENT failure. Persisting it raw is equally unacceptable. The only
  // honest outcome is to refuse to emit a trustworthy reproducer and say so.
  const blocked = drainBlockedCredentials();
  if (blocked.length > 0) {
    const marker = {
      schema: "incident-capture-v2",
      captured_at: new Date().toISOString(),
      req_id: rec.reqId,
      status: "PRIVACY_BLOCKED_SESSION_CREDENTIAL",
      blocked_credential_classes: blocked,
      reason:
        "the request carried a signature-bearing session credential; it cannot be surrogated without changing application behaviour and must not be persisted raw",
      executable: false,
      request: { method: request.method, path: request.path },
    };
    const blockedName = `blocked-${Date.now()}-${process.pid}-${state.reqCounter}.json`;
    const blockedPath = safeArtifactPath(state.outDir, blockedName);
    mkdirSync(state.outDir, { recursive: true });
    writeFileSync(blockedPath, JSON.stringify(marker, null, 2));
    state.stats.requestsPersisted += 1;
    return blockedPath;
  }
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
  // V3.2: an application that performed dependency work during startup cannot
  // be replayed with its dependencies down, because those observations were
  // never inside a request and therefore were never recorded. Say so on the
  // artifact rather than emitting a reproducer that silently cannot honour
  // offline replay.
  doc.boundary_ops_outside_request = state.bootBoundaryOps;
  doc.offline_replay_supported = state.bootBoundaryOps === 0;
  if (state.bootBoundaryOps > 0) {
    doc.unsupported_condition = "BOOT_TIME_DEPENDENCY_ACCESS";
    doc.unsupported_reason =
      "the application performed " + state.bootBoundaryOps +
      " boundary operation(s) during startup, outside any request; those observations are not captured, so this artifact is not portable to an environment with the dependency unavailable";
  }
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
