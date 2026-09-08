// Secret handling for V2 capture. Reuses Rapture kernel redaction for
// string bodies and adds structural rules for headers, URLs, pg params,
// and config values. Raw secret values must never reach persisted artifacts.
import {
  redactSecrets as kernelRedactSecrets,
  sha256 as kernelSha256,
} from "../../../../packages/kernel/dist/index.js";

const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|api-key|.*token.*|.*secret.*)$/iu;
const SENSITIVE_PARAM = /^(token|access_token|api[_-]?key|secret|password|signature|auth)$/iu;
const SECRET_VALUE = /\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[A-Za-z0-9_-]{8,}\b/u;
const SECRET_NAME = /secret|password|token|private[_-]?key|api[_-]?key/iu;

export function sha256Hex(value) {
  return kernelSha256(value);
}

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADER.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

/** Redact userinfo password + sensitive query params; keep shape. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw, "http://capture.invalid");
    if (u.password) u.password = "[REDACTED]";
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) u.searchParams.set(key, "[REDACTED]");
    }
    return u.pathname + u.search;
  } catch {
    return kernelRedactSecrets(String(raw));
  }
}

export function redactTextBody(body) {
  if (typeof body !== "string") return body;
  // Kernel rules miss some key shapes (e.g. sk-live-*); scrub V2 secret
  // values first, then apply kernel redaction for its own patterns.
  const scrubbed = body.replace(new RegExp(SECRET_VALUE.source, "gu"), "[REDACTED]");
  return kernelRedactSecrets(scrubbed);
}

export function redactPgParams(params) {
  if (!Array.isArray(params)) return params;
  return params.map((p) => {
    if (typeof p === "string") {
      if (SECRET_VALUE.test(p)) return "[REDACTED]";
      return kernelRedactSecrets(p);
    }
    return p;
  });
}

/**
 * Config snapshot for persistence: secret-looking names/values become
 * {redacted:true, sha256} placeholders; everything else stays plaintext.
 */
export function redactConfigSnapshot(snapshot) {
  const out = {};
  for (const [k, v] of Object.entries(snapshot ?? {})) {
    if (v == null) {
      out[k] = null;
      continue;
    }
    const s = String(v);
    if (SECRET_NAME.test(k) || SECRET_VALUE.test(s)) {
      out[k] = { redacted: true, sha256: kernelSha256(s) };
    } else {
      out[k] = s;
    }
  }
  return out;
}
