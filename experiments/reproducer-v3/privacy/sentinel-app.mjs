// Privacy sentinel application: round-trips per-run random sentinels through
// every capture boundary, then fails 500 so generic capture persists.
// Calibration-only fixture (never headline). Secrets use gate-tier shapes
// (provider-key prefixes, credential header/param names); gap-tier shapes
// (JWT/PEM/card/password-values) are exercised as documented probes.
import http from "node:http";
import { state } from "../src/capture/state.mjs";

const PG_URL = new URL("../../reproducer-v2/node_modules/pg/lib/index.js", import.meta.url);
const { default: pg } = await import(PG_URL.href);

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:47129";

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 65536) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://priv.invalid");
  try {
    if (url.pathname === "/__v3stats") {
      const mem = process.memoryUsage();
      send(res, 200, { seen: state.stats.requestsSeen, persisted: state.stats.requestsPersisted, rss: mem.rss });
      return;
    }
    if (url.pathname === "/h") {
      const auth = req.headers["authorization"] ?? "";
      const cookie = req.headers["cookie"] ?? "";
      await pool.query("SELECT * FROM v3priv_kv WHERE k = $1", [cookie.slice(0, 64)]);
      await fetch(`${FAKE}/echo`, { headers: { authorization: String(auth), "x-api-key": "shop-key" } });
      send(res, 500, { error: "priv header incident", code: "E_PRIV_H" });
      return;
    }
    if (url.pathname === "/q") {
      const key = url.searchParams.get("api_key") ?? "";
      const email = url.searchParams.get("email") ?? "";
      await pool.query("SELECT * FROM v3priv_users WHERE id = $1", [email]);
      await fetch(`${FAKE}/echo?debug=${encodeURIComponent(key)}`);
      send(res, 500, { error: "priv query incident", code: "E_PRIV_Q" });
      return;
    }
    if (url.pathname === "/j") {
      const body = await parseBody(req);
      await pool.query("INSERT INTO v3priv_kv(k, v) VALUES ($1, $2)", ["nested", JSON.stringify(body)]);
      await fetch(`${FAKE}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: body.apiKey ?? null, note: body.note ?? null }),
      });
      send(res, 500, { error: "priv json incident", code: "E_PRIV_J" });
      return;
    }
    if (url.pathname === "/db") {
      const r = await pool.query("SELECT id, profile FROM v3priv_users WHERE id = $1", [url.searchParams.get("id") ?? ""]);
      const profile = r.rows[0]?.profile ?? "{}";
      const prof = await (await fetch(`${FAKE}/secret-profile`)).json();
      await pool.query("SELECT * FROM v3priv_kv WHERE k = $1", [String(prof.owner ?? "nobody").slice(0, 64)]);
      send(res, 500, { error: `priv db incident ${String(profile).slice(0, 32)}`, code: "E_PRIV_DB" });
      return;
    }
    if (url.pathname === "/cfg") {
      const present = process.env["SECRET_CONFIG"] != null ? "yes" : "no";
      await pool.query("SELECT * FROM v3priv_kv WHERE k = $1", ["cfg-probe"]);
      send(res, 500, { error: `priv config incident present=${present}`, code: "E_PRIV_CFG" });
      return;
    }
    if (url.pathname === "/same") {
      const s = req.headers["x-api-key"] ?? "";
      await pool.query("SELECT * FROM v3priv_kv WHERE k = $1", [String(s).slice(0, 64)]);
      await fetch(`${FAKE}/echo?debug=${encodeURIComponent(String(s))}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ echo: s, nested: { deep: [s] } }),
      });
      send(res, 500, { error: "priv same-secret incident", code: "E_PRIV_SAME" });
      return;
    }
    if (url.pathname === "/sub") {
      const body = await parseBody(req);
      await pool.query("SELECT * FROM v3priv_kv WHERE k = $1", [String(body.ref ?? "none").slice(0, 64)]);
      send(res, 500, { error: "priv substring incident", code: "E_PRIV_SUB" });
      return;
    }
    if (url.pathname === "/gap") {
      const body = await parseBody(req);
      await pool.query("INSERT INTO v3priv_kv(k, v) VALUES ($1, $2)", ["gap", JSON.stringify(body).slice(0, 2000)]);
      send(res, 500, { error: "priv gap-probe incident", code: "E_PRIV_GAP" });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    const detail = process.env["PRIV_DEBUG"] ? String(err?.message ?? err).slice(0, 300) : undefined;
    send(res, 500, { error: "handler throw", code: "E_PRIV_THROW", detail });
  }
}

const server = http.createServer(handle);
server.listen(Number(process.env["PORT"] ?? 47121), () => console.log(`READY ${process.env["PORT"] ?? 47121}`));

process.on("SIGTERM", async () => {
  try {
    server.closeAllConnections?.();
  } catch {}
  server.close();
  try {
    await pool.end();
  } catch {}
  process.exit(0);
});
