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
    if (!SENSITIVE_HEADER.test(k)) {
      out[k] = v;
      continue;
    }
    // Cookies are structured (k=v pairs the app decomposes into keyed
    // calls): scrub values shape- and session-wise, preserving structure so
    // replay derives identical keys. All other credential headers stay
    // wholesale-redacted (opaque tokens).
    if ((k.toLowerCase() === "cookie" || k.toLowerCase() === "set-cookie") && typeof v === "string") {
      out[k] = v
        .split(";")
        .map((pair) => {
          const i = pair.indexOf("=");
          if (i === -1) return scrubSensitiveValues(pair);
          return `${pair.slice(0, i + 1)}${scrubSensitiveValues(pair.slice(i + 1))}`;
        })
        .join(";");
      continue;
    }
    out[k] = "[REDACTED]";
  }
  return out;
}

/** Scrub provider-key-shaped secrets inside an arbitrary string value. */
export function scrubSecretShapes(text) {
  if (typeof text !== "string") return text;
  return text.replace(new RegExp(SECRET_VALUE.source, "gu"), "[REDACTED]");
}

// Session-pair pattern: cookie/query/body fragments like sess=<id> whose
// values flow into keyed DB/HTTP calls. Values are replaced by deterministic
// surrogates so (a) raw session ids never persist and (b) capture-finalize
// and replay-live compute identical keys. Markers ([SESS:…], [REDACTED])
// are never re-mapped, making the transform a fixed point.
const SESSION_PAIR = /(^|[;,&?\s"'])((?:sess|session|sid)=)([^;\s&,"'}[\]]+)/giu;

function surrogateSessionValue(text) {
  return text.replace(SESSION_PAIR, (_m, pre, name, value) => {
    if (value.startsWith("[")) return `${pre}${name}${value}`;
    return `${pre}${name}[SESS:${kernelSha256(value).slice(0, 12)}]`;
  });
}

/**
 * Full sensitive-value scrub for free-text strings: provider-key shapes,
 * then session-pair surrogates. Idempotent: scrub(scrub(x)) === scrub(x),
 * which is what lets capture-time (raw) and replay-time (redacted-derived)
 * key computation agree.
 */
export function scrubSensitiveValues(text) {
  if (typeof text !== "string") return text;
  return surrogateSessionValue(scrubSecretShapes(text));
}

/** Redact an inbound query string: sensitive names by rule, secret-shaped values by shape. */
export function redactQueryString(query) {
  if (query == null || query === "") return query;
  const q = String(query).startsWith("?") ? String(query).slice(1) : String(query);
  if (q === "") return query;
  return (
    (String(query).startsWith("?") ? "?" : "") +
    q
      .split("&")
      .map((pair) => {
        const i = pair.indexOf("=");
        const k = i === -1 ? pair : pair.slice(0, i);
        const v = i === -1 ? null : pair.slice(i + 1);
        let name = k;
        try {
          name = decodeURIComponent(k.replace(/\+/g, " "));
        } catch {
          // keep raw name on decode failure
        }
        if (SENSITIVE_PARAM.test(name)) return `${k}=[REDACTED]`;
        return v == null ? k : `${k}=${scrubSensitiveValues(v)}`;
      })
      .join("&")
  );
}

/**
 * Deep-scrub provider-key shapes inside structured values (pg result rows).
 * Strings are scrubbed, arrays/objects recursed, primitives passed through.
 * Applied at persist time only (never on the hot path).
 */
export function scrubStructured(value, seen = new Set()) {
  if (typeof value === "string") return scrubSensitiveValues(value);
  if (Array.isArray(value)) return value.map((v) => scrubStructured(v, seen));
  if (value != null && typeof value === "object") {
    if (seen.has(value)) return "[CYCLE]";
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubStructured(v, seen);
    return out;
  }
  return value;
}

/** Redact userinfo password + sensitive query params + secret-shaped values; keep shape. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw, "http://capture.invalid");
    if (u.password) u.password = "[REDACTED]";
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) {
        u.searchParams.set(key, "[REDACTED]");
      } else {
        // Non-sensitive names can still carry secret-shaped values
        // (?debug=sk-live-…): scrub by shape so keys and stored URLs match
        // on both capture (raw) and replay (redacted-inbound) sides.
        u.searchParams.set(key, scrubSecretShapes(u.searchParams.get(key) ?? ""));
      }
    }
    return u.pathname + u.search;
  } catch {
    return kernelRedactSecrets(String(raw));
  }
}

export function redactTextBody(body) {
  if (typeof body !== "string") return body;
  // Kernel rules miss some key shapes (e.g. sk-live-*); scrub sensitive
  // values first, then apply kernel redaction for its own patterns.
  return kernelRedactSecrets(scrubSensitiveValues(body));
}

export function redactPgParams(params) {
  if (!Array.isArray(params)) return params;
  // Privacy fix (Phase 4): scrub secret SUBSTRINGS instead of mapping the
  // whole param to [REDACTED]. Whole-value mapping is not a fixed point:
  // replay-live values derived from redacted inbound data would key
  // differently from capture-time raw values and break offline matching.
  // Substring scrubbing is idempotent (verified: kernel is stable on
  // scrubbed output), so both sides key identically.
  return params.map((p) => {
    if (typeof p === "string") {
      return kernelRedactSecrets(scrubSensitiveValues(p));
    }
    return p;
  });
}

const BODY_CAP = 1024 * 1024;

function cappedTextFromChunks(chunks) {
  if (!chunks || chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("utf8").slice(0, BODY_CAP);
}

/**
 * Persist-time finalization (V3 deferred design). Converts one raw pending
 * event into the exact persisted shape V2 produced eagerly: replay key plus
 * redacted request/result. Must remain byte-identical to V2 eager output
 * for the same raw inputs (verified by the V2/V3 equivalence test).
 */
export function finalizePending(pending, eventKey) {
  const key = eventKey(pending.kind, pending.keySpec.parts, pending.keySpec.counter);
  const raw = pending.requestRaw ?? {};
  const res = pending.resultRaw;
  if (pending.kind === "http" && pending.op === "fetch") {
    const body = raw.body == null ? null : redactTextBody(String(raw.body).slice(0, raw.bodyCap ?? BODY_CAP));
    return {
      seq: pending.seq,
      kind: pending.kind,
      op: pending.op,
      key,
      request: { method: raw.method, url: redactUrl(raw.url), body },
      result: res == null
        ? null
        : {
          status: res.status,
          headers: redactHeaders(res.headersRaw ?? {}),
          body: res.bodyBuf == null ? null : redactTextBody(res.bodyBuf.toString("utf8").slice(0, BODY_CAP)),
          truncated: !!res.truncated,
          unreadable: !!res.unreadable,
        },
      error: pending.error,
    };
  }
  if (pending.kind === "pg") {
    // Stored text/rows are shape-scrubbed; the replay KEY is computed from
    // raw values (see finalizePending caller), so live-key matching is
    // unaffected by scrubbing.
    const storedResult =
      res == null ? null : { ...res, rows: Array.isArray(res.rows) ? scrubStructured(res.rows) : res.rows };
    return {
      seq: pending.seq,
      kind: pending.kind,
      op: pending.op,
      key,
      request: { text: scrubSensitiveValues(raw.text), values: redactPgParams(raw.values) },
      result: storedResult,
      error: pending.error,
    };
  }
  // time / random: no sensitive content, stored as observed.
  return {
    seq: pending.seq,
    kind: pending.kind,
    op: pending.op,
    key,
    request: {},
    result: res,
    error: pending.error,
  };
}

/** Finalize a raw inbound request summary (headers + buffered body chunks). */
export function finalizeRequest(rawSummary) {
  const chunks = rawSummary.bodyChunks;
  return {
    method: rawSummary.method,
    path: rawSummary.path,
    query: redactQueryString(rawSummary.query),
    headers: redactHeaders(rawSummary.headersRaw ?? {}),
    host: rawSummary.host,
    body: !chunks || chunks.length === 0 ? null : redactTextBody(cappedTextFromChunks(chunks)),
  };
}

/** Finalize a raw outbound response record (headers + buffered body chunks). */
export function finalizeResponse(rawResponse) {
  return {
    status: rawResponse.status,
    headers: redactHeaders(rawResponse.headersRaw ?? {}),
    body: redactTextBody(cappedTextFromChunks(rawResponse.bodyChunks)),
  };
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
