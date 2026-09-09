// Outbound HTTP capture via the global fetch boundary.
// Capture mode calls through and records; replay serves recorded responses
// by key and fails closed on anything unrecorded.
import { currentRequest } from "./state.mjs";
import { consumeReplayEvent, eventKey, LIVE_ATTEMPT, recordEvent, replayActive, interceptActive } from "./events.mjs";
import { state } from "./state.mjs";

const BODY_CAP = 1024 * 1024;
const PATCHED = Symbol.for("rapture.v2.fetchPatched");

/**
 * V3 deferred design: consume the tee'd clone as RAW bytes (no UTF-8 decode,
 * no redaction, no copy beyond the stream machinery itself). Decode +
 * redact happen once at persist time for failures only.
 */
async function readBodyRaw(res) {
  try {
    const clone = res.clone();
    const buf = Buffer.from(await clone.arrayBuffer());
    const capped = buf.length > BODY_CAP;
    return { bodyBuf: capped ? buf.subarray(0, BODY_CAP) : buf, truncated: capped, unreadable: false };
  } catch {
    return { bodyBuf: null, truncated: false, unreadable: true };
  }
}

function parseInput(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const fromInput = typeof input === "object" && input !== null ? input.method : undefined;
  const method = String(init?.method ?? fromInput ?? "GET").toUpperCase();
  let body = null;
  const rawBody = init?.body ?? (typeof input === "object" ? input?.body : undefined);
  if (typeof rawBody === "string") body = rawBody;
  else if (rawBody != null) {
    try {
      body = String(rawBody);
    } catch {
      body = null;
    }
  }
  return { url: String(url), method, body };
}

let installed = false;
let origFetch = null;

export function installFetchPatch() {
  if (installed) return;
  installed = true;
  origFetch = globalThis.fetch.bind(globalThis);
  const wrapped = async function v2Fetch(input, init) {
    const rec = state.suspended ? null : currentRequest();
    if (!rec || (!interceptActive() && !replayActive())) {
      return origFetch(input, init);
    }
    const { url, method, body } = parseInput(input, init);
    if (replayActive()) {
      const key = eventKey("http", { method, url, body }, 0);
      const evt = consumeReplayEvent(state.replayQueues, "http", key);
      return new Response(evt.result.body ?? "", {
        status: evt.result.status ?? 200,
        headers: evt.result.headers ?? {},
      });
    }
    const keySpec = { parts: { method, url, body }, counter: 0 };
    const requestRaw = { method, url, body, bodyCap: BODY_CAP };
    let res;
    try {
      res = await origFetch(input, init);
    } catch (err) {
      recordEvent(rec, "http", "fetch", keySpec, requestRaw, null, {
        message: String(err?.message ?? err),
        code: err?.code ?? null,
      });
      throw err;
    }
    const { bodyBuf, truncated, unreadable } = await readBodyRaw(res);
    const headersRaw = {};
    try {
      res.headers.forEach((v, k) => {
        headersRaw[k] = v;
      });
    } catch {
      // ignore header read failures
    }
    recordEvent(
      rec,
      "http",
      "fetch",
      keySpec,
      requestRaw,
      { status: res.status, headersRaw, bodyBuf, truncated: !!truncated, unreadable: !!unreadable },
      null,
    );
    return res;
  };
  wrapped[PATCHED] = true;
  globalThis.fetch = wrapped;
}

export function uninstallFetchPatch() {
  if (installed && origFetch) {
    globalThis.fetch = origFetch;
    installed = false;
    origFetch = null;
  }
}

/** Fail-closed guard used by tests: unrecorded fetch in replay throws. */
export function assertLiveAttemptError(err) {
  return err?.code === LIVE_ATTEMPT;
}
