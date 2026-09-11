// Automatic failure oracle: FailureFingerprintV2 inferred from the incident.
// No hand-authored assertions. Infra-coded errors (missing mock, live attempt,
// replay mismatch, syntax/timeout crashes outside app identity) map to an
// infra fingerprint that can never equal an incident fingerprint.
import { createHash } from "node:crypto";
import { isInfraError } from "../capture/events.mjs";
import { normalizeStackLineOffsets, normalizeVolatile, stableAppFrame } from "./normalize.mjs";

export const KIND_APP = "app";
export const KIND_INFRA = "infra";

function fingerprintHash(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function errorClassFromBody(body) {
  if (body == null) return null;
  let parsed = body;
  if (typeof body === "string") {
    const t = body.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    try {
      parsed = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const code = parsed.code ?? parsed.errorCode;
    if (code != null) return `ERR:${normalizeVolatile(String(code))}`;
    const name = parsed.error ?? parsed.name;
    if (name != null) return `ERR:${normalizeVolatile(String(name))}`;
  }
  return null;
}

/**
 * Infer the incident fingerprint from a finished request record.
 * rec: {request{method,path}, response{status,body}|null, appError{name,code,message,stack}|null}
 */
export function inferFingerprint(rec) {
  const method = rec.request.method;
  const route = rec.request.path;
  const status = rec.response?.status ?? 0;
  if (rec.appError && !isInfraError(rec.appError)) {
    const ae = rec.appError;
    const fields = {
      kind: KIND_APP,
      request_method: method,
      route_or_operation: route,
      http_status: status,
      error_name_or_code: String(ae.code ?? ae.name ?? "UnknownError"),
      normalized_class: `ERR:${normalizeVolatile(String(ae.code ?? ae.name ?? "UnknownError"))}`,
      stable_frame: stableAppFrame(ae.stack),
    };
    return { ...fields, fingerprint_hash: fingerprintHash(fields) };
  }
  const bodyClass = errorClassFromBody(rec.response?.body);
  const fields = {
    kind: KIND_APP,
    request_method: method,
    route_or_operation: route,
    http_status: status,
    error_name_or_code: bodyClass ?? null,
    normalized_class: bodyClass ?? `HTTP_${status}`,
    stable_frame: null,
  };
  return { ...fields, fingerprint_hash: fingerprintHash(fields) };
}

/** Fingerprint for a replay outcome that is NOT the incident (fail-closed). */
export function infraFingerprint(reason, detail) {
  const fields = {
    kind: KIND_INFRA,
    request_method: null,
    route_or_operation: null,
    http_status: 0,
    error_name_or_code: String(reason),
    normalized_class: `INFRA:${normalizeVolatile(String(reason))}`,
    stable_frame: null,
    detail: normalizeVolatile(String(detail ?? "")).slice(0, 200),
  };
  return { ...fields, fingerprint_hash: fingerprintHash(fields) };
}

/**
 * Classify a replay run outcome for reducer pass/fail.
 * outcome: {response{status,body}|null, appError|null}
 */
export function classifyReplayOutcome(outcome, expectedHash) {
  if (outcome.appError && isInfraError(outcome.appError)) {
    return { pass: false, fingerprint: infraFingerprint(outcome.appError.code ?? "INFRA", outcome.appError.message) };
  }
  if (!outcome.response && !outcome.appError) {
    return { pass: false, fingerprint: infraFingerprint("NO_OUTCOME", "replay produced neither response nor error") };
  }
  const fp = inferFingerprint({
    request: outcome.request,
    response: outcome.response ?? null,
    appError: outcome.appError ?? null,
  });
  // A non-5xx response or a different failure can never satisfy the incident.
  return { pass: fp.fingerprint_hash === expectedHash, fingerprint: fp };
}
