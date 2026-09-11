// Postgres capture through the pg package (Pool + Client query paths).
// Interception: single CJS Module._load hook — verified to fire for both
// require('pg') and ESM `import ... from 'pg'` (hook receives resolved path).
// Capture mode calls through and records; replay mode serves recorded results
// by key and fails closed (connect() throws; unrecorded queries throw).
import Module from "node:module";
import { closeCaptureOp, currentRequest, noteBootDependencyOp, openCaptureOp, state } from "./state.mjs";
import { consumeReplayEvent, eventKey, infraError, LIVE_ATTEMPT, normalizeSql, recordEvent, replayActive, interceptActive } from "./events.mjs";

const HOOKED = Symbol.for("rapture.v2.pgHooked");
const PATCHED_PROTO = Symbol.for("rapture.v2.pgProtoPatched");

function normalizeQueryArgs(args) {
  let text = "";
  let values = [];
  let callback = null;
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null && !(args[0] instanceof String)) {
    text = args[0].text ?? "";
    values = args[0].values ?? [];
    if (typeof args[args.length - 1] === "function") callback = args[args.length - 1];
  } else {
    text = args[0] ?? "";
    if (args.length > 1 && Array.isArray(args[1])) values = args[1];
    if (typeof args[args.length - 1] === "function") callback = args[args.length - 1];
  }
  return { text: String(text), values, callback, hadCallback: callback != null };
}

function stripResult(result) {
  if (!result || typeof result !== "object") return { rows: [], rowCount: 0, command: null, fields: [] };
  return {
    command: result.command ?? null,
    rowCount: result.rowCount ?? (Array.isArray(result.rows) ? result.rows.length : 0),
    rows: Array.isArray(result.rows) ? result.rows : [],
    fields: Array.isArray(result.fields)
      ? result.fields.map((f) => ({ name: f.name ?? null, dataTypeID: f.dataTypeID ?? null }))
      : [],
  };
}

function stripError(err) {
  if (!err || typeof err !== "object") return { message: String(err) };
  return { message: String(err.message ?? err), code: err.code ?? null };
}

function keySpecFor(text, values, counter) {
  return { parts: { text: normalizeSql(text), values }, counter };
}

function replayKeyFor(text, values, counter) {
  return eventKey("pg", { text: normalizeSql(text), values }, counter);
}

function wrapQueryMethod(proto, methodName) {
  const orig = proto[methodName];
  if (typeof orig !== "function" || orig[HOOKED]) return;
  const wrapped = function v2Query(...args) {
    const rec = state.suspended ? null : currentRequest();
    // Outside a request, or capture disabled: pure passthrough.
    if (!rec || (!interceptActive() && !replayActive())) {
      if (!rec) noteBootDependencyOp();
      return orig.apply(this, args);
    }
    const { text, values, callback, hadCallback } = normalizeQueryArgs(args);
    if (replayActive()) {
      const key = replayKeyFor(text, values, rec.pgIndex = (rec.pgIndex ?? 0));
      const evt = consumeReplayEvent(state.replayQueues, "pg", key);
      rec.pgIndex += 1;
      const fake = { command: evt.result.command, rowCount: evt.result.rowCount, rows: evt.result.rows, fields: evt.result.fields ?? [] };
      if (hadCallback) {
        queueMicrotask(() => callback(null, fake));
        return undefined;
      }
      return Promise.resolve(fake);
    }
    // Capture mode (V3 deferred design): retain raw text/values; param
    // redaction and replay-key computation happen once at persist time.
    const spec = keySpecFor(text, values, rec.pgIndex = (rec.pgIndex ?? 0));
    rec.pgIndex += 1;
    const requestRaw = { text: normalizeSql(text), values };
    // V3.3: this query is capture-owned from here until its event is recorded.
    // The storage must not be disabled in between, however long the driver
    // takes and whether or not the HTTP response has already finished.
    openCaptureOp();
    if (hadCallback) {
      const userCb = callback;
      const newArgs = [...args];
      newArgs[newArgs.length - 1] = function v2PgCallback(err, result) {
        try {
          if (err) recordEvent(rec, "pg", "query", spec, requestRaw, null, stripError(err));
          else recordEvent(rec, "pg", "query", spec, requestRaw, stripResult(result), null);
        } finally {
          closeCaptureOp();
        }
        return userCb.call(this, err, result);
      };
      try {
        return orig.apply(this, newArgs);
      } catch (err) {
        closeCaptureOp();
        throw err;
      }
    }
    let ret;
    try {
      ret = orig.apply(this, args);
    } catch (err) {
      recordEvent(rec, "pg", "query", spec, requestRaw, null, stripError(err));
      closeCaptureOp();
      throw err;
    }
    if (ret && typeof ret.then === "function") {
      return ret.then(
        (result) => {
          recordEvent(rec, "pg", "query", spec, requestRaw, stripResult(result), null);
          closeCaptureOp();
          return result;
        },
        (err) => {
          recordEvent(rec, "pg", "query", spec, requestRaw, null, stripError(err));
          closeCaptureOp();
          throw err;
        },
      );
    }
    recordEvent(rec, "pg", "query", spec, requestRaw, stripResult(ret), null);
    closeCaptureOp();
    return ret;
  };
  wrapped[HOOKED] = true;
  proto[methodName] = wrapped;
}

function wrapConnect(proto) {
  const orig = proto.connect;
  if (typeof orig !== "function" || orig[HOOKED]) return;
  const wrapped = function v2Connect(...args) {
    // In replay, any real connect attempt fails closed immediately.
    if (replayActive() && currentRequest()) {
      throw infraError(LIVE_ATTEMPT, "live Postgres connect attempt refused in replay");
    }
    // V3.2 context-pinning correction (generic, not driver- or bug-specific).
    //
    // A pooled connection request that cannot be served immediately is queued.
    // The queued callback is later invoked synchronously from the stack of
    // whichever request RELEASES a connection -- not from the stack of the
    // request that asked for one. AsyncLocalStorage therefore reports the
    // releasing request context, so the nested Client.query records this
    // query into a DIFFERENT request incident (and, when no request was
    // selected at all, records it into a selected one that has nothing to do
    // with it).
    //
    // Binding the caller context to the callback restores the invariant the
    // whole capture model rests on: a boundary observation belongs to the
    // request that issued it, whatever dispatches it.
    const bound = state.suspended ? null : currentRequest();
    const last = args.length - 1;
    if (last >= 0 && typeof args[last] === "function") {
      const cb = args[last];
      args[last] = function pinnedConnectCallback(...cbArgs) {
        return state.als.run(bound ?? undefined, () => cb.apply(this, cbArgs));
      };
    }
    return orig.apply(this, args);
  };
  wrapped[HOOKED] = true;
  proto.connect = wrapped;
}

export function patchPgExports(exports) {
  if (!exports || exports[PATCHED_PROTO]) return;
  for (const cls of [exports.Pool, exports.Client]) {
    if (cls && cls.prototype) {
      wrapQueryMethod(cls.prototype, "query");
      wrapConnect(cls.prototype);
    }
  }
  try {
    Object.defineProperty(exports, PATCHED_PROTO, { value: true, configurable: true });
  } catch {
    // ignore non-extensible edge cases
  }
}

let hookInstalled = false;

export function installPgHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  const OrigLoad = Module._load;
  const OrigResolve = Module._resolveFilename;
  Module._load = function v2ModuleLoad(request, parent, isMain) {
    const loaded = OrigLoad.call(this, request, parent, isMain);
    try {
      let filename = null;
      try {
        filename = OrigResolve.call(this, request, parent, isMain, {});
      } catch {
        filename = null;
      }
      const isPg = typeof filename === "string" && /node_modules[/\\]pg[/\\]/.test(filename);
      if (isPg && loaded && typeof loaded === "object" && (loaded.Pool || loaded.Client)) {
        patchPgExports(loaded);
      }
    } catch {
      // never break application loading
    }
    return loaded;
  };
}
