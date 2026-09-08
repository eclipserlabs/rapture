// V2 real-bug wrapper: v2-lru-evict (isaacs/node-lru-cache, oversize guard).
// Historical bug: setting an oversized entry wipes the ENTIRE cache on buggy
// rev 7ef678e4; fixed rev a3eadb1d refuses the item and keeps entries.
// HTTP mapping: wipe observed (size 0, a missing) -> 500 E_CACHE_WIPE;
// intact (size 2, a present) -> 200.
// Boundary use: pg noise + randomness noise (reduced away if irrelevant).
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env["IMPL_MODE"] ?? "buggy";
const IMPL_SUB = MODE === "fixed" ? "post" : "buggy";
const IMPL_PKG = join(here, "..", "..", "..", "reproducer-v1", "real-bugs", "rb-lru-oversize-evict", "impl", IMPL_SUB, "package.json");
const requireImpl = createRequire(IMPL_PKG);
const LRU = requireImpl("./index.js");

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
    if (url.pathname === "/cache/sequence") {
      await pool.query("SELECT * FROM flags WHERE name = $1", ["noise-flag"]);
      await fetch(`${FAKE}/api/health`);
      void Math.random();
      const cache = new LRU({ maxSize: 10, sizeCalculation: (v) => (typeof v === "number" ? v : 1) });
      cache.set("a", 5);
      cache.set("b", 5);
      cache.set("big", 50);
      if (cache.size === 0 && !cache.has("a")) {
        send(res, 500, { error: "cache wiped by oversize set", code: "E_CACHE_WIPE" });
        return;
      }
      send(res, 200, { ok: true, size: cache.size, hasA: cache.has("a") });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_HANDLER_THROW" });
  }
});

server.listen(Number(process.env["PORT"] ?? 4905), () => console.log(`READY ${process.env["PORT"] ?? 4905}`));
