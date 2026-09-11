// Transparent node:http capture: wraps request listeners (covers bare
// node:http and frameworks built on it, e.g. express apps passed to
// createServer or server.on('request')). Records request/response; on finish,
// persists iff the frozen failure rule matches.
import http from "node:http";
import { isCaptureEnabled, fullIntercept, runInRequest, summarizeRequest, appendRequestBody } from "./context.mjs";
import { currentRequest, releaseSelected, state } from "./state.mjs";
import { maybePersist } from "./persist.mjs";

const PATCHED = Symbol.for("rapture.v2.httpPatched");
const SELECTED_KEY = Symbol.for("rapture.v31.selectedKey");
const RESP_CAP = 1024 * 1024;

const V31_STATS_PATH = "/__rapture31";

/**
 * Serve selective-capture counters. Deliberately limited to numbers plus the
 * normalized incident keys the detector already holds; the privacy regression
 * test asserts no header, body, query string or raw URL can reach here.
 */
function serveV31Stats(res) {
  const body = JSON.stringify({
    mode: state.mode,
    alsEnabled: state.alsEnabled,
    inFlightSelected: state.inFlightSelected,
    capture: { ...state.stats },
    attrib: { ...state.attrib },
    lifecycle: {
      alsEnabled: state.alsEnabled,
      alsEnableCount: state.alsEnableCount,
      alsDisableCount: state.alsDisableCount,
      activeSelectedContexts: state.inFlightSelected,
      outstandingCaptureOps: state.outstandingCaptureOps,
      // Active time including any interval still open right now.
      alsActiveMs: state.alsActiveMs + (state.alsEnabledAt != null ? Date.now() - state.alsEnabledAt : 0),
      processUptimeMs: Date.now() - state.processStartMs,
    },
    selector: state.selector?.snapshot() ?? null,
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
  });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function trackChunk(store, chunk) {
  if (!chunk) return;
  if (store.len >= RESP_CAP) return;
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (store.chunks == null) store.chunks = [];
  store.chunks.push(buf);
  store.len += buf.length;
}

function wrapListener(listener) {
  if (listener[PATCHED]) return listener;
  const wrapped = function v2RequestListener(req, res) {
    if (!isCaptureEnabled()) return listener.call(this, req, res);
    const rawUrl = req.url ?? "/";
    // Experiment telemetry endpoint, served by the capture layer itself so
    // selective-capture counters can be read from an application whose source
    // must not be touched (the large-application case). Capture-exempt, and
    // it exposes counters and normalized keys ONLY — never request content.
    if (rawUrl.startsWith(V31_STATS_PATH)) return serveV31Stats(res);
    // Capture-exempt telemetry prefix (frozen rule): never recorded.
    if (rawUrl.startsWith("/__")) return listener.call(this, req, res);

    // ---------------------------------------------------------------------
    // V3.1 INGRESS SELECTION. Decided here, before the application listener
    // runs, and never revised. A request that is not selected now can never
    // become an executable incident, however it ends.
    // ---------------------------------------------------------------------
    // The first inbound request ends the boot phase. Everything a boundary
    // wrapper saw before this point happened outside any request.
    state.bootPhaseOver = true;

    const selector = state.selector;
    if (selector != null) {
      const qi = rawUrl.indexOf("?");
      const pathname = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
      const decision = selector.selectAtIngress(
        (req.method ?? "GET").toUpperCase(),
        pathname,
      );
      if (!decision.selected) {
        // ------- inactive fast path -------
        // No ALS entry, no body buffering, no res.write/res.end wrapping, no
        // serialization, no redaction, no hashing, no persistence. The only
        // work is one 'finish' listener that reads res.statusCode.
        if (selector.detects) {
          res.on("finish", () => selector.observeOutcome(decision.key, res.statusCode, false));
          try {
            return listener.call(this, req, res);
          } catch (err) {
            selector.observeOutcome(decision.key, 500, false);
            throw err;
          }
        }
        return listener.call(this, req, res);
      }
      req[SELECTED_KEY] = decision.key;
    }

    const summary = summarizeRequest(req);
    return runInRequest(summary, () => {
      const rec = currentRequest();
      // A selected request holds the ALS open until its response finishes.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseSelected();
      };
      res.on("close", release);
      // CONTEXT_ONLY: ALS context without any body tracking or persistence.
      if (!fullIntercept()) {
        try {
          return listener.call(this, req, res);
        } catch (err) {
          rec.appError = serializeAppError(err);
          throw err;
        }
      }
      req.on("data", (chunk) => appendRequestBody(rec, chunk));
      // Attaching 'data' switches the stream to flowing mode, which loses
      // body/'end' for apps that await (auth, session lookup, …) before
      // attaching their own body readers — a pre-existing V2 flaw (all V2
      // triggers were GETs, so it never fired). Pause immediately, and
      // resume the moment the app subscribes to 'data': buffered bytes are
      // then delivered to both listeners with no loss. (Verified: in Node
      // 22 a second 'data' attach alone does NOT resume a paused stream,
      // so the resume must be explicit.)
      try {
        req.pause?.();
      } catch {
        // ignore pause failures; passthrough behavior unchanged
      }
      for (const m of ["on", "addListener", "once", "prependListener"]) {
        const orig = req[m]?.bind(req);
        if (typeof orig !== "function") continue;
        req[m] = function v2ReqSub(ev, listener, ...rest) {
          if (ev === "data") {
            try {
              req.resume?.();
            } catch {
              // ignore resume failures
            }
          }
          return orig(ev, listener, ...rest);
        };
      }
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      const store = { chunks: null, len: 0 };
      res.write = (chunk, ...args) => {
        trackChunk(store, chunk);
        return origWrite(chunk, ...args);
      };
      res.end = (chunk, ...args) => {
        trackChunk(store, chunk);
        const out = origEnd(chunk, ...args);
        return out;
      };
      res.on("finish", () => {
        // V3 deferred design: raw response retained; redaction/serialization
        // happen once at persist time (failures only).
        rec.responseRaw = {
          status: res.statusCode,
          headersRaw: res.getHeaders?.() ?? {},
          bodyChunks: store.chunks,
          bodyLen: store.len,
        };
        const path = maybePersist(rec);
        // V3.1: tell the detector what happened. A persisted incident is the
        // only success termination of an arming window.
        const selector = state.selector;
        if (selector != null) {
          const key = req[SELECTED_KEY] ?? null;
          if (path != null) selector.noteIncidentCaptured(key, path);
          else if (selector.detects) selector.observeOutcome(key, res.statusCode, true);
        }
      });
      try {
        return listener.call(this, req, res);
      } catch (err) {
        rec.appError = serializeAppError(err);
        throw err;
      }
    });
  };
  wrapped[PATCHED] = true;
  return wrapped;
}

function serializeAppError(err) {
  if (!err || typeof err !== "object") return { name: "UnknownThrow", message: String(err), stack: null };
  return { name: err.name ?? "Error", code: err.code ?? null, message: String(err.message ?? err), stack: typeof err.stack === "string" ? err.stack : null };
}

let installed = false;

export function installHttpPatch() {
  if (installed) return;
  installed = true;
  const origCreateServer = http.createServer;
  http.createServer = function v2CreateServer(...args) {
    const last = args[args.length - 1];
    if (typeof last === "function") args[args.length - 1] = wrapListener(last);
    return origCreateServer.apply(this, args);
  };
  const ServerProto = http.Server.prototype;
  for (const method of ["on", "addListener", "prependListener"]) {
    const orig = ServerProto[method];
    ServerProto[method] = function v2On(event, listener, ...rest) {
      if (event === "request" && typeof listener === "function") {
        return orig.call(this, event, wrapListener(listener), ...rest);
      }
      return orig.call(this, event, listener, ...rest);
    };
  }
}
