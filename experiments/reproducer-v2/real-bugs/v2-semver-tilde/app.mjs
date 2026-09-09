// V2 real-bug wrapper: v2-semver-tilde (npm/node-semver, PR #878 closes #512).
// Historical bug: satisfies('1.2.0-rc','~1.2',{includePrerelease:true}) is false
// on buggy rev 8640bd68, true on fixed rev 9c8692ae.
// HTTP mapping: app compares against DB-seeded expectation (v2_expect/semver-tilde
// = 'true'); mismatch -> 500 E_SEMVER_MISMATCH; match -> 200.
// Boundary use: pg causal (expectation lookup) + fetch noise.
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env["IMPL_MODE"] ?? "buggy";
const IMPL_SUB = MODE === "fixed" ? "post" : "buggy";
const IMPL_PKG = join(here, "..", "..", "..", "reproducer-v1", "real-bugs", "rb-semver-tilde-prerelease", "impl", IMPL_SUB, "package.json");
const requireImpl = createRequire(IMPL_PKG);
const semver = requireImpl("./index.js");

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:4892";

try {
  await pool.query("CREATE TABLE IF NOT EXISTS v2_expect (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await pool.query("INSERT INTO v2_expect (key, value) VALUES ('semver-tilde', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'");
} catch (err) {
  // Replay mode has no live Postgres (fail-closed mocks serve reads instead).
  console.warn(`[v2-semver-tilde] seed skipped: ${err?.message ?? err}`);
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://svc.invalid");
  try {
    if (url.pathname === "/check") {
      const version = url.searchParams.get("version") ?? "1.2.0-rc";
      const range = url.searchParams.get("range") ?? "~1.2";
      const exp = await pool.query("SELECT value FROM v2_expect WHERE key = $1", ["semver-tilde"]);
      await fetch(`${FAKE}/api/health`);
      const got = semver.satisfies(version, range, { includePrerelease: true });
      const want = exp.rows[0]?.value === "true";
      if (got !== want) {
        send(res, 500, { error: "semver range mismatch", code: "E_SEMVER_MISMATCH" });
        return;
      }
      send(res, 200, { ok: true, satisfies: got });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_HANDLER_THROW" });
  }
});

server.listen(Number(process.env["PORT"] ?? 4902), () => console.log(`READY ${process.env["PORT"] ?? 4902}`));
