// V3 perf calibration service A ("shop"): realistic node:http middleware stack.
// Middleware (real, in-service): request-id, JSON body parse, timing header,
// toy API-key auth for POST. Routes exercise pg + outbound fetch.
// Postgres via the frozen V2 pg tree (setup script asserts presence).
// /__v3stats is capture-exempt telemetry (frozen /__ rule).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { state } from "../src/capture/state.mjs";

const elu = monitorEventLoopDelay({ resolution: 10 });
elu.enable();
let gcCount = 0;
let gcTime = 0;
try {
  const { PerformanceObserver } = await import("node:perf_hooks");
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcCount += 1;
      gcTime += e.duration;
    }
  }).observe({ entryTypes: ["gc"] });
} catch {
  // gc entries unavailable: report zeros
}

const PG_URL = new URL("../../reproducer-v2/node_modules/pg/lib/index.js", import.meta.url);
const { default: pg } = await import(PG_URL.href);

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});
const FAKE = process.env["FAKE_ORIGIN"] ?? "http://localhost:47109";
const API_KEY = process.env["SHOP_API_KEY"] ?? "shop-test-key";

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
  const url = new URL(req.url ?? "/", "http://shop.invalid");
  const rid = randomUUID();
  res.setHeader("x-request-id", rid);
  try {
    if (url.pathname === "/__v3stats") {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      send(res, 200, {
        requestsSeen: state.stats.requestsSeen,
        requestsPersisted: state.stats.requestsPersisted,
        bytesRecorded: state.stats.bytesRecorded,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        cpuUserUs: cpu.user,
        cpuSystemUs: cpu.system,
        eluMeanNs: Math.round(elu.mean),
        eluP99Ns: Math.round(elu.percentile(99)),
        gcCount,
        gcTimeMs: Math.round(gcTime * 100) / 100,
      });
      return;
    }
    if (url.pathname === "/products" && req.method === "GET") {
      const r = await pool.query("SELECT sku, name, price FROM v3shop_products ORDER BY sku LIMIT 10");
      send(res, 200, { products: r.rows });
      return;
    }
    const m = url.pathname.match(/^\/products\/([\w-]+)$/);
    if (m && req.method === "GET") {
      const r = await pool.query("SELECT sku, name, price FROM v3shop_products WHERE sku = $1", [m[1]]);
      if (r.rows.length === 0) {
        send(res, 404, { error: "no such product" });
        return;
      }
      const price = await (await fetch(`${FAKE}/pricing?sku=${encodeURIComponent(m[1])}`)).json();
      if (url.searchParams.get("fail") === "boom") {
        send(res, 500, { error: "calibration failure with boundaries", code: "E_SHOP_BOUNDARY_BOOM" });
        return;
      }
      send(res, 200, { product: r.rows[0], quote: price });
      return;
    }
    if (url.pathname === "/orders" && req.method === "POST") {
      if (req.headers["x-api-key"] !== API_KEY) {
        send(res, 401, { error: "bad api key" });
        return;
      }
      const body = await parseBody(req);
      const inv = await pool.query("SELECT qty FROM v3shop_inventory WHERE sku = $1", [body.sku ?? ""]);
      const ship = await (await fetch(`${FAKE}/shipping?qty=${Number(body.qty ?? 1)}`)).json();
      const row = inv.rows[0];
      if (!row || row.qty < Number(body.qty ?? 1)) {
        send(res, 422, { error: "insufficient inventory" });
        return;
      }
      const ins = await pool.query("INSERT INTO v3shop_orders(sku, qty, cost) VALUES ($1, $2, $3) RETURNING id", [
        body.sku,
        Number(body.qty ?? 1),
        ship.cost ?? 0,
      ]);
      send(res, 200, { ok: true, orderId: ins.rows[0].id });
      return;
    }
    if (url.pathname === "/boom") {
      send(res, 500, { error: "calibration failure", code: "E_SHOP_BOOM" });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_SHOP_THROW" });
  }
}

const server = http.createServer(handle);
server.listen(Number(process.env["PORT"] ?? 47101), () => console.log(`READY ${process.env["PORT"] ?? 47101}`));

// Graceful shutdown so --cpu-prof profiles flush on exit.
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
