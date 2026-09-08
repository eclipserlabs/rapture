// V2 real-bug wrapper: v2-jwt-maxage (auth0/node-jsonwebtoken).
// Historical bug: verify() with numeric maxAge never expires (seconds/ms +
// type confusion), so a 400s-old token with maxAge 300 is ACCEPTED on buggy
// rev 67550492 instead of rejected with TokenExpiredError (fixed b61cc343).
// HTTP mapping: fail-closed age check — accepted-but-expired -> 500
// E_JWT_MAXAGE_BYPASS; TokenExpiredError -> 401 (no 5xx).
// Boundary use: time causal (Date.now) + fetch noise. Test secret is fixture.
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env["IMPL_MODE"] ?? "buggy";
const IMPL_SUB = MODE === "fixed" ? "post" : "buggy";
const IMPL_PKG = join(here, "..", "..", "..", "reproducer-v1", "real-bugs", "rb-jwt-maxage", "impl", IMPL_SUB, "package.json");
const requireImpl = createRequire(IMPL_PKG);
const jwt = requireImpl("./index.js");

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:4892";
const SECRET = "reproducer-test-secret";

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://svc.invalid");
  try {
    if (url.pathname === "/verify") {
      const ageSec = Number(url.searchParams.get("ageSec") ?? "400");
      const maxAge = Number(url.searchParams.get("maxAge") ?? "300");
      await pool.query("SELECT * FROM flags WHERE name = $1", ["noise-flag"]);
      await fetch(`${FAKE}/api/health`);
      const nowSec = Math.floor(Date.now() / 1000);
      const token = jwt.sign({ sub: "svc", iat: nowSec - ageSec }, SECRET);
      let payload;
      try {
        payload = jwt.verify(token, SECRET, { maxAge, clockTimestamp: nowSec });
      } catch (err) {
        if (err && err.name === "TokenExpiredError") {
          send(res, 401, { error: "token expired", code: "E_JWT_EXPIRED_OK" });
          return;
        }
        throw err;
      }
      const age = nowSec - (payload.iat ?? nowSec);
      if (age > maxAge) {
        send(res, 500, { error: "expired token accepted", code: "E_JWT_MAXAGE_BYPASS" });
        return;
      }
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_HANDLER_THROW" });
  }
});

server.listen(Number(process.env["PORT"] ?? 4904), () => console.log(`READY ${process.env["PORT"] ?? 4904}`));
