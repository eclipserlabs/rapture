// Aggregate V3.1 perf repetitions into per-mode distributions, overheads, and
// 95% bootstrap confidence intervals over per-repetition estimates.
//
// Point estimate = median across repetitions (median-of-rep-medians for
// latency quantiles), exactly as preregistered. Raw per-rep values are carried
// through so no averaging is hidden.
//
// Usage: node scripts/perf-aggregate.mjs --phase 3|4|calibration
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const PHASE = arg("--phase", "3");
const dir = join(root, "results", "perf", PHASE === "calibration" ? "calibration" : `phase${PHASE}`);
const BOOTSTRAP = 10000;

const round2 = (x) => Math.round(x * 100) / 100;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% bootstrap CI for the median of a per-repetition overhead sample.
 * Overheads are resampled as paired per-rep ratios so the interval reflects
 * repetition-to-repetition variation, which is what dominates on this machine.
 */
function bootstrapCI(sample, seed = 7) {
  if (sample.length < 3) return null;
  const rand = mulberry32(seed);
  const meds = new Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    const draw = new Array(sample.length);
    for (let i = 0; i < sample.length; i += 1) draw[i] = sample[Math.floor(rand() * sample.length)];
    meds[b] = median(draw);
  }
  meds.sort((a, b) => a - b);
  return {
    lo: round2(meds[Math.floor(0.025 * BOOTSTRAP)]),
    hi: round2(meds[Math.floor(0.975 * BOOTSTRAP)]),
  };
}

const rows = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

const byService = new Map();
for (const r of rows) {
  if (!byService.has(r.service)) byService.set(r.service, new Map());
  const modes = byService.get(r.service);
  if (!modes.has(r.mode)) modes.set(r.mode, []);
  modes.get(r.mode).push(r);
}

const METRICS = ["p50", "p90", "p95", "p99"];
const out = { phase: PHASE, bootstrapResamples: BOOTSTRAP, services: {}, acrossServices: {} };
const overheadSamples = new Map(); // mode -> metric -> [per-service median overheads]
const pooledSamples = new Map(); // mode -> metric -> [every service x rep paired overhead]

for (const [service, modes] of byService) {
  const off = (modes.get("OFF") ?? []).sort((a, b) => a.rep - b.rep);
  if (!off.length) continue;
  const svcOut = { modes: {} };
  for (const [mode, reps0] of modes) {
    const reps = [...reps0].sort((a, b) => a.rep - b.rep);
    const cell = {
      reps: reps.length,
      requests: reps[0]?.requests ?? 0,
      perRep: reps.map((r) => ({
        rep: r.rep,
        p50: round2(r.p50),
        p90: round2(r.p90),
        p95: round2(r.p95),
        p99: round2(r.p99),
        rps: round2(r.throughputRps),
        errors: r.errors,
        failed: r.failedCount,
        selected: r.v31?.requestsSelected ?? null,
        seen: r.v31?.requestsSeen ?? null,
        persisted: r.v31?.requestsPersisted ?? null,
        alsEnabled: r.v31?.alsEnabled ?? null,
        cpuUs: r.stats1 && r.stats0 ? (r.stats1.cpuUserUs + r.stats1.cpuSystemUs) - (r.stats0.cpuUserUs + r.stats0.cpuSystemUs) : null,
        rssDelta: r.stats1 && r.stats0 ? r.stats1.rss - r.stats0.rss : null,
        eluMeanNs: r.stats1?.eluMeanNs ?? null,
        bootMs: r.bootMs,
      })),
      errorsTotal: reps.reduce((a, r) => a + r.errors, 0),
      failedTotal: reps.reduce((a, r) => a + r.failedCount, 0),
    };
    for (const m of METRICS) cell[m] = round2(median(reps.map((r) => r[m])));
    cell.throughputRps = round2(median(reps.map((r) => r.throughputRps)));
    cell.cpuUs = round2(median(cell.perRep.map((r) => r.cpuUs ?? 0)));
    cell.rssDelta = round2(median(cell.perRep.map((r) => r.rssDelta ?? 0)));
    cell.eluMeanNs = round2(median(cell.perRep.map((r) => r.eluMeanNs ?? 0)));
    cell.bootMs = round2(median(cell.perRep.map((r) => r.bootMs ?? 0)));
    cell.fullyInstrumentedTotal = reps.reduce((a, r) => a + (r.v31?.requestsSelected ?? 0), 0);
    cell.seenTotal = reps.reduce((a, r) => a + (r.v31?.requestsSeen ?? 0), 0);
    cell.observedSampledFraction = cell.seenTotal
      ? round2((cell.fullyInstrumentedTotal / cell.seenTotal) * 100) / 100
      : null;
    cell.persistedTotal = reps.reduce((a, r) => a + (r.v31?.requestsPersisted ?? 0), 0);

    if (mode !== "OFF") {
      // Paired per-repetition overheads: rep k of MODE against rep k of OFF.
      const pairs = reps
        .map((r) => ({ r, o: off.find((x) => x.rep === r.rep) }))
        .filter((p) => p.o != null);
      cell.overhead = {};
      for (const m of METRICS) {
        const sample = pairs.map((p) => ((p.r[m] - p.o[m]) / p.o[m]) * 100);
        cell.overhead[m] = {
          medianPct: round2(median(sample)),
          minPct: round2(Math.min(...sample)),
          maxPct: round2(Math.max(...sample)),
          ci95: bootstrapCI(sample),
          perRepPct: sample.map(round2),
        };
      }
      const tp = pairs.map((p) => ((p.r.throughputRps - p.o.throughputRps) / p.o.throughputRps) * 100);
      cell.overhead.throughput = {
        medianPct: round2(median(tp)),
        minPct: round2(Math.min(...tp)),
        maxPct: round2(Math.max(...tp)),
        ci95: bootstrapCI(tp),
        perRepPct: tp.map(round2),
      };
      const cpu = pairs
        .map((p) => {
          const a = (p.r.stats1.cpuUserUs + p.r.stats1.cpuSystemUs) - (p.r.stats0.cpuUserUs + p.r.stats0.cpuSystemUs);
          const b = (p.o.stats1.cpuUserUs + p.o.stats1.cpuSystemUs) - (p.o.stats0.cpuUserUs + p.o.stats0.cpuSystemUs);
          return b ? ((a - b) / b) * 100 : 0;
        });
      cell.overhead.cpu = { medianPct: round2(median(cpu)), ci95: bootstrapCI(cpu) };
      const rss = pairs.map((p) => (p.r.stats1.rss - p.r.stats0.rss) - (p.o.stats1.rss - p.o.stats0.rss));
      cell.overhead.rssBytes = { median: round2(median(rss)) };

      if (!overheadSamples.has(mode)) overheadSamples.set(mode, new Map());
      const perMode = overheadSamples.get(mode);
      for (const m of [...METRICS, "throughput", "cpu"]) {
        if (!perMode.has(m)) perMode.set(m, []);
        perMode.get(m).push(cell.overhead[m].medianPct);
      }
      // Pooled sample: every service x repetition paired overhead. This is the
      // sample the preregistered bootstrap gate is evaluated on, because with
      // only three services a bootstrap over three service medians has no
      // resolution.
      if (!pooledSamples.has(mode)) pooledSamples.set(mode, new Map());
      const pooled = pooledSamples.get(mode);
      for (const m of [...METRICS, "throughput", "cpu"]) {
        if (!pooled.has(m)) pooled.set(m, []);
        pooled.get(m).push(...(cell.overhead[m].perRepPct ?? [cell.overhead[m].medianPct]));
      }
    }
    svcOut.modes[mode] = cell;
  }
  out.services[service] = svcOut;
}

for (const [mode, metrics] of overheadSamples) {
  out.acrossServices[mode] = {};
  const pooled = pooledSamples.get(mode);
  for (const [metric, sample] of metrics) {
    const pool = pooled?.get(metric) ?? [];
    out.acrossServices[mode][metric] = {
      medianPct: round2(median(sample)),
      perServicePct: sample.map(round2),
      minPct: round2(Math.min(...sample)),
      maxPct: round2(Math.max(...sample)),
      pooled: {
        n: pool.length,
        medianPct: round2(median(pool)),
        ci95: bootstrapCI(pool, 11),
        minPct: pool.length ? round2(Math.min(...pool)) : null,
        maxPct: pool.length ? round2(Math.max(...pool)) : null,
      },
    };
  }
}

writeFileSync(join(dir, "..", `aggregate-phase${PHASE}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote aggregate-phase${PHASE}.json`);
for (const [mode, m] of Object.entries(out.acrossServices)) {
  console.log(
    `${mode.padEnd(28)} p50=${String(m.p50.medianPct).padStart(7)}%  p95=${String(m.p95.medianPct).padStart(7)}%  p99=${String(m.p99.medianPct).padStart(7)}%  tput=${String(m.throughput.medianPct).padStart(7)}%  cpu=${String(m.cpu.medianPct).padStart(7)}%`,
  );
  const pc = m.p95.pooled;
  const tc = m.throughput.pooled;
  console.log(
    `${" ".padEnd(28)} pooled(n=${pc.n}) p95 median ${pc.medianPct}% CI95[${pc.ci95?.lo}, ${pc.ci95?.hi}]  |  throughput median ${tc.medianPct}% CI95[${tc.ci95?.lo}, ${tc.ci95?.hi}]`,
  );
}
for (const [svc, s] of Object.entries(out.services)) {
  for (const [mode, cell] of Object.entries(s.modes)) {
    if (!cell.overhead) continue;
    const c = cell.overhead.p95.ci95;
    const t = cell.overhead.throughput.ci95;
    console.log(
      `  ${svc}/${mode}: p95 ${cell.overhead.p95.medianPct}% CI[${c?.lo},${c?.hi}]  tput ${cell.overhead.throughput.medianPct}% CI[${t?.lo},${t?.hi}]`,
    );
  }
}
