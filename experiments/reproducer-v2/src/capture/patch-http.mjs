// Transparent node:http capture: wraps request listeners (covers bare
// node:http and frameworks built on it, e.g. express apps passed to
// createServer or server.on('request')). Records request/response; on finish,
// persists iff the frozen failure rule matches.
import http from "node:http";
import { isCaptureEnabled, runInRequest, summarizeRequest, appendRequestBody } from "./context.mjs";
import { currentRequest, state } from "./state.mjs";
import { redactHeaders, redactTextBody } from "./redact.mjs";
import { maybePersist } from "./persist.mjs";

const PATCHED = Symbol.for("rapture.v2.httpPatched");
const RESP_CAP = 1024 * 1024;

function wrapListener(listener) {
  if (listener[PATCHED]) return listener;
  const wrapped = function v2RequestListener(req, res) {
    if (!isCaptureEnabled()) return listener.call(this, req, res);
    // Capture-exempt telemetry prefix (frozen rule): never recorded.
    if ((req.url ?? "/").startsWith("/__")) return listener.call(this, req, res);
    const summary = summarizeRequest(req);
    return runInRequest(summary, () => {
      const rec = currentRequest();
      req.on("data", (chunk) => appendRequestBody(rec, chunk));
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      let body = "";
      res.write = (chunk, ...args) => {
        if (chunk && body.length < RESP_CAP) {
          body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          body = body.slice(0, RESP_CAP);
        }
        return origWrite(chunk, ...args);
      };
      res.end = (chunk, ...args) => {
        if (chunk && body.length < RESP_CAP) {
          body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          body = body.slice(0, RESP_CAP);
        }
        const out = origEnd(chunk, ...args);
        return out;
      };
      res.on("finish", () => {
        state.lastBytesRecorded = rec.bytesRecorded;
        rec.response = {
          status: res.statusCode,
          headers: redactHeaders(res.getHeaders?.() ?? {}),
          body: redactTextBody(body),
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
