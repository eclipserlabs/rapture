// V3 perf calibration service B ("directory"): heavier per-request boundary
// shape than service A — cookie session lookup, two-query search, two fetches.
// Exercises: middleware, session logic, config flags, pg, outbound HTTP.
import http from "node:http";
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

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers["cookie"] ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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
  const url = new URL(req.url ?? "/", "http://dir.invalid");
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
    // Session middleware: every request resolves its session row.
    const cookies = parseCookies(req);
    const sess = await pool.query("SELECT uid, role FROM v3dir_sessions WHERE sid = $1", [cookies["sid"] ?? "anon"]);
    const me = sess.rows[0] ?? { uid: "anon", role: "guest" };
    if (url.pathname === "/config") {
      const flag = await pool.query("SELECT value FROM v3dir_flags WHERE name = $1", ["directory-v2"]);
      send(res, 200, { me: me.uid, directoryV2: flag.rows[0]?.value ?? "off" });
      return;
    }
    const um = url.pathname.match(/^\/users\/([\w-]+)$/);
    if (um && req.method === "GET") {
      const r = await pool.query("SELECT id, handle, role FROM v3dir_users WHERE id = $1", [um[1]]);
      if (r.rows.length === 0) {
        send(res, 404, { error: "no such user" });
        return;
      }
      const avatar = await (await fetch(`${FAKE}/avatar/${encodeURIComponent(um[1])}`)).json();
      if (url.searchParams.get("fail") === "boom") {
        send(res, 500, { error: "calibration failure with boundaries", code: "E_DIR_BOUNDARY_BOOM" });
        return;
      }
      send(res, 200, { user: r.rows[0], avatar, seenBy: me.uid });
      return;
    }
    if (url.pathname === "/search" && req.method === "GET") {
      const q = `%${url.searchParams.get("q") ?? ""}%`;
      const users = await pool.query("SELECT id, handle FROM v3dir_users WHERE handle LIKE $1 LIMIT 5", [q]);
      const recent = await pool.query("SELECT id, kind FROM v3dir_events ORDER BY id DESC LIMIT 3");
      const a1 = await (await fetch(`${FAKE}/avatar/batch?ids=${users.rows.map((r) => r.id).join(",")}`)).json();
      const a2 = await (await fetch(`${FAKE}/pricing?sku=sku-1`)).json();
      send(res, 200, { users: users.rows, recent: recent.rows, extra: [a1, a2], seenBy: me.uid });
      return;
    }
    if (url.pathname === "/events" && req.method === "POST") {
      const body = await parseBody(req);
      const ins = await pool.query("INSERT INTO v3dir_events(kind, payload) VALUES ($1, $2) RETURNING id", [
        String(body.kind ?? "click"),
        JSON.stringify(body.payload ?? {}),
      ]);
      if (url.searchParams.get("fail") === "boom") {
        send(res, 500, { error: "calibration failure with body", code: "E_DIR_BODY_BOOM" });
        return;
      }
      send(res, 200, { ok: true, id: ins.rows[0].id });
      return;
    }
    if (url.pathname === "/boom") {
      send(res, 500, { error: "calibration failure", code: "E_DIR_BOOM" });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: "handler throw", code: "E_DIR_THROW" });
  }
}

const server = http.createServer(handle);
server.listen(Number(process.env["PORT"] ?? 47102), () => console.log(`READY ${process.env["PORT"] ?? 47102}`));

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
