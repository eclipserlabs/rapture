// V2 real-bug wrapper: v2-qs-limit (ljharb/qs, CVE-2026-2391 follow-up).
// Historical bug: parse('a[]=1,2,3,4',{comma,arrayLimit:3,throwOnLimitExceeded:true})
// silently returns on buggy rev 8079adc7; throws RangeError on fixed rev 8859c374.
// HTTP mapping: silent bypass violates the app invariant -> 500 E_QS_LIMIT_BYPASS;
// fixed rev throws -> caught -> 400 (no 5xx, fingerprint absent).
// Boundary use: pg noise query + outbound fetch noise (local fake).
// Generic bootstrap only: node --import <v2>/src/capture/register.mjs app.mjs
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env["IMPL_MODE"] ?? "buggy";
const IMPL_SUB = MODE === "fixed" ? "post" : "buggy";
const IMPL_PKG = join(here, "..", "..", "..", "reproducer-v1", "real-bugs", "rb-qs-comma-arraylimit", "impl", IMPL_SUB, "package.json");
const requireImpl = createRequire(IMPL_PKG);
const qs = requireImpl("./lib/index.js");

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:4892";

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://svc.invalid");
  try {
    if (url.pathname === "/parse") {
      const q = url.searchParams.get("q") ?? "a[]=1,2,3,4";
      await pool.query("SELECT * FROM flags WHERE name = $1", ["noise-flag"]);
      await fetch(`${FAKE}/api/health`);
      let parsed;
      try {
        parsed = qs.parse(q, { comma: true, arrayLimit: 3, throwOnLimitExceeded: true });
      } catch (err) {
        if (err instanceof RangeError) {
          send(res, 400, { error: "limit enforced", code: "E_QS_LIMIT_OK" });
          return;
        }
        throw err;
      }
      const arr = parsed?.a;
      const flat = Array.isArray(arr) ? arr.flat(Infinity) : [];
      if (flat.length > 3) {
        send(res, 500, { error: "array limit bypassed", code: "E_QS_LIMIT_BYPASS" });
        return;
      }
      send(res, 200, { ok: true, parsed });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_HANDLER_THROW" });
  }
});

server.listen(Number(process.env["PORT"] ?? 4901), () => console.log(`READY ${process.env["PORT"] ?? 4901}`));
