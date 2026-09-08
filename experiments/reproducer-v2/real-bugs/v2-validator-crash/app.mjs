// V2 real-bug wrapper: v2-validator-crash (validatorjs/validator.js, #2822).
// Historical bug: isByteLength(loneSurrogate,{min:3,max:3}) throws URIError on
// buggy rev d563b158; returns true on fixed rev 7d42ed2d.
// HTTP mapping: throw -> 500 E_VALIDATOR_CRASH; true -> 200.
// Boundary use: pg noise + fetch noise.
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env["IMPL_MODE"] ?? "buggy";
const IMPL_SUB = MODE === "fixed" ? "post" : "buggy";
const IMPL_DIR = join(
  here, "..", "..", "..", "reproducer-v1", "real-bugs", "rb-validator-bytelength", "impl", IMPL_SUB,
);
const requireImpl = createRequire(join(IMPL_DIR, "package.json"));
const isByteLength = requireImpl("./src/lib/isByteLength.js");

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
    if (url.pathname === "/signup") {
      // Frozen edge trigger: lone surrogate cannot survive URL decoding
      // (becomes U+FFFD), so the historical edge value is used directly.
      // The request path itself is the trigger; ?name= is accepted noise.
      const name = String.fromCharCode(0xd800);
      await pool.query("SELECT * FROM users WHERE id = $1", ["u-ok"]);
      await fetch(`${FAKE}/api/health`);
      let ok;
      try {
        ok = isByteLength(name, { min: 3, max: 3 });
      } catch (err) {
        send(res, 500, { error: "name validation crashed", code: "E_VALIDATOR_CRASH" });
        return;
      }
      send(res, 200, { ok: true, valid: ok });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_HANDLER_THROW" });
  }
});

server.listen(Number(process.env["PORT"] ?? 4903), () => console.log(`READY ${process.env["PORT"] ?? 4903}`));
