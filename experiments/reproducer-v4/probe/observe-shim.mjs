// Host-side observability shim used ONLY to build CONTROL evidence packs.
// Never enters a subject workspace.
//
// Generic, not bug-specific: it records every Error constructed while the
// process runs, plus pg/fetch operation metadata and durations -- the same
// surface an error-tracking SDK and an APM agent expose. It records NO
// database result rows and NO outbound response bodies, matching the frozen
// control_evidence_pack exclusion list.
import fs from "node:fs";

const OUT = process.env["OBS_OUT"];
const rec = { errors: [], ops: [], logs: [] };

const OriginalError = globalThis.Error;
class RecordingError extends OriginalError {
  constructor(...args) {
    super(...args);
    try {
      rec.errors.push({
        at: Date.now(),
        name: this.name ?? null,
        // Derived from the stack's construction frame, not from new.target:
        // the recorder itself must never appear in the reported evidence.
        constructor_name: (String(this.stack ?? "").match(/\n\s*at new ([A-Za-z0-9_$]+)/) || [null, null])[1],
        message: String(this.message ?? "").slice(0, 400),
        status: this.status ?? this.statusCode ?? null,
        expose: this.expose ?? null,
        code: this.code ?? null,
        stack: String(this.stack ?? "").split("\n").slice(0, 24).join("\n"),
      });
    } catch {
      // never break the application
    }
  }
}
RecordingError.captureStackTrace = OriginalError.captureStackTrace;
RecordingError.prepareStackTrace = OriginalError.prepareStackTrace;
RecordingError.stackTraceLimit = OriginalError.stackTraceLimit;
globalThis.Error = RecordingError;

// Outbound HTTP: destination, operation, status, duration. No response body.
const origFetch = globalThis.fetch;
globalThis.fetch = async function observedFetch(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = String(init?.method ?? "GET").toUpperCase();
  const t0 = Date.now();
  try {
    const res = await origFetch(input, init);
    rec.ops.push({ kind: "http", method, url: String(url), status: res.status, ms: Date.now() - t0 });
    return res;
  } catch (err) {
    rec.ops.push({ kind: "http", method, url: String(url), status: 0, ms: Date.now() - t0,
                   error: String(err?.message ?? err).slice(0, 200) });
    throw err;
  }
};

// Database: operation name, query text, row COUNT, duration. Never the rows.
const { createRequire } = await import("node:module");
try {
  const req = createRequire(process.env["OBS_PG_ENTRY"]);
  const pg = req("pg");
  for (const cls of [pg.Pool, pg.Client]) {
    const orig = cls?.prototype?.query;
    if (typeof orig !== "function") continue;
    cls.prototype.query = function observedQuery(...args) {
      const text = typeof args[0] === "object" && args[0] ? args[0].text : args[0];
      const t0 = Date.now();
      const done = (status, rowCount) =>
        rec.ops.push({ kind: "db", operation: "query", statement: String(text ?? "").slice(0, 400),
                       status, row_count: rowCount ?? null, ms: Date.now() - t0 });
      const ret = orig.apply(this, args);
      if (ret && typeof ret.then === "function") {
        return ret.then((r) => { done("ok", r?.rowCount); return r; },
                        (e) => { done("error", null); throw e; });
      }
      done("ok", ret?.rowCount);
      return ret;
    };
  }
} catch {
  // pg not resolvable in this configuration; recorded as no db ops
}

const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
console.log = (...a) => { rec.logs.push({ level: "info", at: Date.now(), msg: a.map(String).join(" ").slice(0, 400) }); origLog(...a); };
console.error = (...a) => { rec.logs.push({ level: "error", at: Date.now(), msg: a.map(String).join(" ").slice(0, 400) }); origErr(...a); };

const flush = () => { try { fs.writeFileSync(OUT, JSON.stringify(rec)); } catch { /* ignore */ } };
process.on("exit", flush);
process.on("SIGTERM", () => { flush(); process.exit(0); });
process.on("SIGINT", () => { flush(); process.exit(0); });
setInterval(flush, 500).unref();
