// V2 real-bug wrapper: v2-cron-dow (harrisiirak/cron-parser, PR #438).
// Historical bug: parse('0 0 * * 2/2') includes Sunday in the DOW set, so
// next() from Sat 2024-06-01 is Sunday 2024-06-02 on buggy rev 8410d371
// instead of Tuesday 2024-06-04 (fixed rev b48a355b).
// HTTP mapping: app compares against DB-seeded expectation (v2_expect/cron-dow
// = '2024-06-04T00:00:00.000Z'); mismatch -> 500 E_CRON_MISMATCH; match -> 200.
// Boundary use: pg causal + fetch noise.
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env["IMPL_MODE"] ?? "buggy";
const IMPL_SUB = MODE === "fixed" ? "post" : "buggy";
const IMPL_PKG = join(here, "..", "..", "..", "reproducer-v1", "real-bugs", "rb-cron-dow-step", "impl", IMPL_SUB, "package.json");
const requireImpl = createRequire(IMPL_PKG);
const { CronExpressionParser } = requireImpl("./dist/index.js");

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:4892";

try {
  await pool.query("CREATE TABLE IF NOT EXISTS v2_expect (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await pool.query(
    "INSERT INTO v2_expect (key, value) VALUES ('cron-dow', '2024-06-04T00:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value = '2024-06-04T00:00:00.000Z'",
  );
} catch (err) {
  // Replay mode has no live Postgres (fail-closed mocks serve reads instead).
  console.warn(`[v2-cron-dow] seed skipped: ${err?.message ?? err}`);
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://svc.invalid");
  try {
    if (url.pathname === "/next") {
      const expr = url.searchParams.get("expr") ?? "0 0 * * 2/2";
      const exp = await pool.query("SELECT value FROM v2_expect WHERE key = $1", ["cron-dow"]);
      await fetch(`${FAKE}/api/health`);
      const it = CronExpressionParser.parse(expr, { currentDate: "2024-06-01T00:00:00Z", tz: "UTC" });
      const next = it.next().toISOString();
      const want = exp.rows[0]?.value;
      if (next !== want) {
        send(res, 500, { error: "wrong next fire time", code: "E_CRON_MISMATCH" });
        return;
      }
      send(res, 200, { ok: true, next });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_HANDLER_THROW" });
  }
});

server.listen(Number(process.env["PORT"] ?? 4906), () => console.log(`READY ${process.env["PORT"] ?? 4906}`));
