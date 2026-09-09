// Calibration service: real node:http app with 8 incident routes.
// Every handler catches errors into a stable 500 JSON envelope {error, code}.
// Reads PORT (service), FAKE_ORIGIN (fake external base URL), REGION, TIER,
// TOKEN_TTL_MS (config). Also serves /__v2stats (capture-exempt telemetry).
import http from "node:http";
import { createPool } from "./db.mjs";
import { state } from "../../src/capture/state.mjs";

const pool = createPool();
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:4892";

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function fail(res, code, message) {
  send(res, 500, { error: message, code });
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://svc.invalid");
  const path = url.pathname;
  try {
    if (path === "/__v2stats") {
      const mem = process.memoryUsage();
      send(res, 200, {
        requestsSeen: state.stats.requestsSeen,
        requestsPersisted: state.stats.requestsPersisted,
        lastBytesRecorded: state.lastBytesRecorded ?? 0,
        rss: mem.rss,
        cpu: process.cpuUsage(),
      });
      return;
    }
    if (path.startsWith("/orders/")) {
      const id = decodeURIComponent(path.slice("/orders/".length));
      const r = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
      await pool.query("SELECT * FROM products WHERE sku = $1", ["sku-noise"]);
      await pool.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 5");
      const row = r.rows[0];
      if (!row) {
        fail(res, "E_ORDER_UNKNOWN", "order not found");
        return;
      }
      if (row.status === "suspended") {
        fail(res, "E_ORDER_SUSPENDED", "order suspended");
        return;
      }
      send(res, 200, { id: row.id, total: row.total });
      return;
    }
    if (path === "/profile") {
      const user = url.searchParams.get("user") ?? "";
      const r = await fetch(`${FAKE}/api/profile?user=${encodeURIComponent(user)}`);
      const body = await r.json();
      await fetch(`${FAKE}/api/health`);
      if (typeof body.email !== "string") {
        fail(res, "E_PROFILE_SHAPE", "profile shape invalid");
        return;
      }
      send(res, 200, { id: body.id, email: body.email });
      return;
    }
    if (path === "/price") {
      const sku = url.searchParams.get("sku") ?? "";
      const r = await fetch(`${FAKE}/api/price?sku=${encodeURIComponent(sku)}`);
      if (r.status === 503) {
        // Broken fallback: cache lookup that always misses, then throws.
        const cached = await pool.query("SELECT * FROM products WHERE sku = $1", [`cache:${sku}`]);
        if (cached.rows.length === 0) {
          fail(res, "E_PRICE_FALLBACK", "price fallback failed");
          return;
        }
      }
      const body = await r.json();
      send(res, 200, body);
      return;
    }
    if (path === "/token") {
      const iat = Number(url.searchParams.get("iat") ?? "0");
      const ttl = Number(process.env["TOKEN_TTL_MS"] ?? "60000");
      const now = Date.now();
      await pool.query("SELECT * FROM flags WHERE name = $1", ["region-ok"]);
      if (now > iat + ttl) {
        fail(res, "E_TOKEN_EXPIRED", "token expired");
        return;
      }
      send(res, 200, { ok: true });
      return;
    }
    if (path === "/rollout") {
      const r = Math.random();
      const id = globalThis.crypto?.randomUUID?.() ?? `fallback-${String(r).slice(2)}`;
      await pool.query("SELECT * FROM flags WHERE name = $1", ["noise-flag"]);
      if (r >= 0.5) {
        fail(res, "E_ROLLOUT", `rollout fault ${id}`);
        return;
      }
      send(res, 200, { ok: true, variant: id });
      return;
    }
    if (path === "/store") {
      const region = process.env["REGION"] ?? "us";
      const tier = process.env["TIER"] ?? "standard";
      await pool.query("SELECT * FROM flags WHERE name = $1", ["noise-flag"]);
      await fetch(`${FAKE}/api/health`);
      if (region === "eu" && tier === "standard") {
        fail(res, "E_STORE_CONFIG", "store unsupported for region/tier");
        return;
      }
      send(res, 200, { region, tier });
      return;
    }
    if (path === "/checkout") {
      const sku = url.searchParams.get("sku") ?? "";
      const qty = Number(url.searchParams.get("qty") ?? "1");
      const inv = await pool.query("SELECT * FROM inventory WHERE sku = $1", [sku]);
      const ship = await fetch(`${FAKE}/api/shipping?qty=${qty}`);
      const quote = await ship.json();
      const row = inv.rows[0];
      if (row && row.qty < qty && quote.cost > 100) {
        fail(res, "E_CHECKOUT", "cannot fulfill");
        return;
      }
      send(res, 200, { ok: true });
      return;
    }
    if (path === "/dashboard") {
      await pool.query("SELECT * FROM orders WHERE id = $1", ["ord-noise"]);
      await pool.query("SELECT * FROM products WHERE sku = $1", ["sku-noise"]);
      await pool.query("SELECT * FROM inventory WHERE sku = $1", ["sku-noise"]);
      const users = await pool.query("SELECT * FROM users WHERE id = $1", ["u-bad"]);
      await pool.query("SELECT * FROM flags WHERE name = $1", ["noise-flag"]);
      await pool.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 5");
      await fetch(`${FAKE}/api/health`);
      await fetch(`${FAKE}/api/profile?user=u-ok`);
      await fetch(`${FAKE}/api/price?sku=sku-1`);
      await fetch(`${FAKE}/api/shipping?qty=1`);
      const row = users.rows[0];
      if (row && row.role === "banned") {
        fail(res, "E_DASHBOARD", "dashboard forbidden");
        return;
      }
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    fail(res, "E_HANDLER_THROW", String(err?.message ?? err));
  }
}

const server = http.createServer(handle);
const port = Number(process.env["PORT"] ?? 4891);
server.listen(port, () => {
  console.log(`READY ${port}`);
});
