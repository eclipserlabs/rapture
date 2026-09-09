// Aggregate raw perf repetitions into per-mode distributions + overheads.
// Reads results/perf/raw/perf-*.json, writes results/perf/aggregate.json.
// Overhead base: OFF mode of the same service (median-of-rep-medians).
// Reports raw rep values alongside aggregates (no hidden averaging).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const round2 = (x) => Math.round(x * 100) / 100;

function summarize(lat) {
  const s = [...lat].filter((x) => x >= 0).sort((a, b) => a - b);
  return {
    n: s.length,
    p50: round2(pct(s, 50)),
    p90: round2(pct(s, 90)),
    p95: round2(pct(s, 95)),
    p99: round2(pct(s, 99)),
    mean: round2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
  };
}

function main() {
  const dir = join(root, "results", "perf", "raw");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const reps = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const byServiceMode = new Map();
  for (const r of reps) {
    // Success-path distributions exclude the /boom failures in failed-persist.
    const succ = r.latencies.filter((_, i) => r.statuses[i] >= 200 && r.statuses[i] < 500);
    const k = `${r.service}/${r.mode}`;
    if (!byServiceMode.has(k)) byServiceMode.set(k, []);
    const cpu0 = r.stats0.cpuUserUs + r.stats0.cpuSystemUs;
    const cpu1 = r.stats1.cpuUserUs + r.stats1.cpuSystemUs;
    byServiceMode.get(k).push({
      rep: r.rep,
      wallMs: r.wallMs,
      dist: summarize(r.failedMix ? succ : r.latencies),
      failedCount: r.statuses.filter((s) => s >= 500).length,
      errors: r.errors,
      throughputRps: round2((r.requests / r.wallMs) * 1000),
      cpuUs: cpu1 - cpu0,
      rssDelta: r.stats1.rss - r.stats0.rss,
      heapDelta: r.stats1.heapUsed - r.stats0.heapUsed,
      eluMeanNs: r.stats1.eluMeanNs,
      eluP99Ns: r.stats1.eluP99Ns,
      gcCount: r.stats1.gcCount - r.stats0.gcCount,
      gcTimeMs: round2(r.stats1.gcTimeMs - r.stats0.gcTimeMs),
      eventsRecorded: (r.stats1.eventsRecorded ?? 0) - (r.stats0.eventsRecorded ?? 0),
      persisted: r.stats1.requestsPersisted - r.stats0.requestsPersisted,
      seen: r.stats1.requestsSeen - r.stats0.requestsSeen,
    });
  }
  const med = (xs) => round2(pct([...xs].sort((a, b) => a - b), 50));
  const out = {};
  for (const [k, rows] of byServiceMode) {
    const [service, mode] = k.split("/");
    out[k] = {
      service,
      mode,
      reps: rows.length,
      raw: rows,
      agg: {
        p50: med(rows.map((r) => r.dist.p50)),
        p90: med(rows.map((r) => r.dist.p90)),
        p95: med(rows.map((r) => r.dist.p95)),
        p99: med(rows.map((r) => r.dist.p99)),
        mean: med(rows.map((r) => r.dist.mean)),
        throughputRps: med(rows.map((r) => r.throughputRps)),
        cpuUs: med(rows.map((r) => r.cpuUs)),
        rssDelta: med(rows.map((r) => r.rssDelta)),
        heapDelta: med(rows.map((r) => r.heapDelta)),
        eluMeanNs: med(rows.map((r) => r.eluMeanNs)),
        eluP99Ns: med(rows.map((r) => r.eluP99Ns)),
        gcCount: med(rows.map((r) => r.gcCount)),
        gcTimeMs: med(rows.map((r) => r.gcTimeMs)),
      },
    };
  }
  // Overhead of each mode vs OFF (same service), per metric.
  for (const [k, v] of Object.entries(out)) {
    const base = out[`${v.service}/off`]?.agg;
    if (!base || v.mode === "off") {
      v.overheadVsOff = null;
      continue;
    }
    const ov = (a, b) => (b === 0 ? null : round2(((a - b) / b) * 100));
    v.overheadVsOff = {
      p50: ov(v.agg.p50, base.p50),
      p90: ov(v.agg.p90, base.p90),
      p95: ov(v.agg.p95, base.p95),
      p99: ov(v.agg.p99, base.p99),
      mean: ov(v.agg.mean, base.mean),
      throughput: ov(v.agg.throughputRps, base.throughputRps),
    };
  }
  writeFileSync(join(root, "results", "perf", "aggregate.json"), JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}: p50=${v.agg.p50} p95=${v.agg.p95} p99=${v.agg.p99} rps=${v.agg.throughputRps} ov=${JSON.stringify(v.overheadVsOff)}`);
  }
}

main();
