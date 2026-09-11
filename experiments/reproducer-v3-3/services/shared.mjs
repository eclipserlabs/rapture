// Shared headline-service helpers (V3): pg session lookup + fetch config.
// Every headline service performs these per request so capture exercises
// real pg + outbound-HTTP paths; the historical bug remains the causal 500.
import { createRequire } from "node:module";

const V2PG = new URL(
  "../../reproducer-v2/node_modules/pg/lib/index.js",
  import.meta.url,
);
export const pg = createRequire(V2PG.href)("pg");

export function pool() {
  return new pg.Pool({
    host: process.env["PGHOST"] ?? "localhost",
    port: Number(process.env["PGPORT"] ?? 5432),
    user: process.env["PGUSER"] ?? "wira",
    database: process.env["PGDATABASE"] ?? "repro_v2",
    ...(process.env["PGPOOL_MAX"] ? { max: Number(process.env["PGPOOL_MAX"]) } : {}),
  });
}

export async function sessionLookup(db) {
  // Constant session-handle probe in `sid=<id>` pair form. The frozen
  // scrub rules map this exact shape to a deterministic [SESS:sha12]
  // surrogate at persist time on both sides (idempotent), so no raw handle
  // ever reaches captures/artifacts while replay keys stay consistent.
  // The lookup deterministically yields no row (noise coverage); the
  // historical bug remains the only causal failure. koa-1998's guard
  // relies on this null session on both revisions.
  const r = await db.query("SELECT sid, uid, role FROM v3dir_sessions WHERE sid = $1", [
    "sid=sess-alice",
  ]);
  return r.rows[0] ?? null;
}

export async function fetchFlags() {
  const base = process.env["FAKE_ORIGIN"] ?? "http://localhost:47109";
  const r = await fetch(`${base}/health`);
  return r.json();
}

export function logged(res, next) {
  res.setHeader("x-logged", "1");
  next();
}

// Uniform session-cookie reader (avoids framework cookie-parser deps).
// The frozen capture layer maps sid=<id> to a deterministic [SESS:sha12]
// surrogate at persist time, so raw session ids never reach artifacts while
// replay keys stay consistent on both sides (fixed-point principle).
export function sidFromCookie(headers) {
  const raw = headers?.cookie ?? headers?.Cookie ?? "";
  const m = /(?:^|;\s*)sid=([^;\s]+)/.exec(String(raw));
  return m ? m[1].slice(0, 128) : null;
}

// Capture-exempt telemetry for headline perf (frozen /__ rule: the capture
// layer never records these requests). Mirrors the calibration shape.
import { monitorEventLoopDelay } from "node:perf_hooks";

const __elu = monitorEventLoopDelay({ resolution: 10 });
__elu.enable();
let __gcCount = 0;
let __gcTime = 0;
try {
  const { PerformanceObserver } = await import("node:perf_hooks");
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      __gcCount += 1;
      __gcTime += e.duration;
    }
  }).observe({ entryTypes: ["gc"] });
} catch {
  // gc entries unavailable: report zeros
}

export function telemetry() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    eluMeanNs: Math.round(__elu.mean),
    eluP99Ns: Math.round(__elu.percentile(99)),
    gcCount: __gcCount,
    gcTimeMs: Math.round(__gcTime * 100) / 100,
  };
}
