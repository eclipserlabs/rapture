// Transparent node:http capture: wraps request listeners (covers bare
// node:http and frameworks built on it, e.g. express apps passed to
// createServer or server.on('request')). Records request/response; on finish,
// persists iff the frozen failure rule matches.
import http from "node:http";
import { isCaptureEnabled, fullIntercept, runInRequest, summarizeRequest, appendRequestBody } from "./context.mjs";
import { currentRequest, state } from "./state.mjs";
import { maybePersist } from "./persist.mjs";

const PATCHED = Symbol.for("rapture.v2.httpPatched");
const RESP_CAP = 1024 * 1024;

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
    // Capture-exempt telemetry prefix (frozen rule): never recorded.
    if ((req.url ?? "/").startsWith("/__")) return listener.call(this, req, res);
    const summary = summarizeRequest(req);
    return runInRequest(summary, () => {
      const rec = currentRequest();
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
        void maybePersist(rec);
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
