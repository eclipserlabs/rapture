// Aggregate the V3.1 brief performance campaign.
//
// Reports BOTH estimators for every gated mode, because independent
// verification showed the prior detector-only headline was estimator-
// sensitive. A gate passes only if it passes under both; otherwise it is
// reported ESTIMATOR_DEPENDENT rather than resolved in the flattering
// direction (preregistered in manifests/V3.1-MANIFEST.json).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "results", "perf", "brief");

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => Math.round(x * 100) / 100;

function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapCI(sample, seed = 7, resamples = 10000) {
  if (!sample.length) return null;
  const rand = mulberry32(seed); const out = [];
  for (let i = 0; i < resamples; i += 1) {
    const s = Array.from({ length: sample.length }, () => sample[Math.floor(rand() * sample.length)]);
    out.push(median(s));
  }
  out.sort((a, b) => a - b);
  return { lo: r2(out[Math.floor(0.025 * out.length)]), hi: r2(out[Math.floor(0.975 * out.length)]) };
}

const recs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const services = [...new Set(recs.map((r) => r.service))].sort();
const modes = [...new Set(recs.map((r) => r.mode))].filter((m) => m !== "OFF").sort();
const METRICS = ["p50", "p95", "p99", "throughputRps"];
const label = { p50: "p50", p95: "p95", p99: "p99", throughputRps: "throughput" };

const out = { generatedAt: new Date().toISOString(), manifest: "manifests/V3.1-MANIFEST.json", services, modes, perService: {}, acrossServices: {} };

for (const mode of modes) {
  const paired = {}; const ratioOfMed = {}; const pooled = {};
  for (const m of METRICS) { paired[m] = []; ratioOfMed[m] = []; pooled[m] = []; }
  const perSvc = {};
  for (const s of services) {
    const off = recs.filter((r) => r.service === s && r.mode === "OFF").sort((a, b) => a.rep - b.rep);
    const mm = recs.filter((r) => r.service === s && r.mode === mode).sort((a, b) => a.rep - b.rep);
    const cell = { reps: mm.length, requests: mm[0]?.requests ?? null };
    for (const m of METRICS) {
      const per = [];
      for (let i = 0; i < Math.min(off.length, mm.length); i += 1) per.push((mm[i][m] / off[i][m] - 1) * 100);
      paired[m].push(median(per));
      pooled[m].push(...per);
      ratioOfMed[m].push((median(mm.map((r) => r[m])) / median(off.map((r) => r[m])) - 1) * 100);
      cell[label[m]] = { pairedMedianPct: r2(median(per)), ratioOfMediansPct: r2((median(mm.map((r) => r[m])) / median(off.map((r) => r[m])) - 1) * 100), perRepPct: per.map(r2) };
    }
    // selective-capture accounting
    const sel = mm.map((r) => r.v31?.requestsSelected ?? 0);
    const seen = mm.map((r) => r.v31?.requestsSeen ?? 0);
    cell.selectedMedian = median(sel);
    cell.actualSelectionRatePct = seen[0] ? r2((median(sel) / median(seen)) * 100) : null;
    cell.persistedTotal = mm.reduce((a, r) => a + (r.v31?.requestsPersisted ?? 0), 0);
    // unselected tail (armed-window mode only)
    if (mm[0]?.unselectedTail?.n) {
      const tailPer = [];
      for (let i = 0; i < Math.min(off.length, mm.length); i += 1) tailPer.push((mm[i].unselectedTail.p95 / off[i].p95 - 1) * 100);
      cell.unselectedTailP95PairedPct = r2(median(tailPer));
    }
    perSvc[s] = cell;
  }
  out.perService[mode] = perSvc;
  const agg = {};
  for (const m of METRICS) {
    agg[label[m]] = {
      pairedMedianPct: r2(median(paired[m])),
      ratioOfMediansPct: r2(median(ratioOfMed[m])),
      perServicePairedPct: paired[m].map(r2),
      perServiceRatioPct: ratioOfMed[m].map(r2),
      minPct: r2(Math.min(...paired[m])),
      maxPct: r2(Math.max(...paired[m])),
      pooled: { n: pooled[m].length, medianPct: r2(median(pooled[m])), ci95: bootstrapCI(pooled[m]) },
    };
  }
  out.acrossServices[mode] = agg;
}

writeFileSync(join(root, "results", "perf", "aggregate-brief.json"), JSON.stringify(out, null, 2));

console.log(`services=${services.join(",")}  reps=${out.perService[modes[0]][services[0]].reps}  requests=${out.perService[modes[0]][services[0]].requests}\n`);
console.log(`${"mode".padEnd(28)} ${"p50 (paired/ratio)".padEnd(22)} ${"p95 (paired/ratio)".padEnd(22)} ${"tput (paired/ratio)".padEnd(22)} sel%`);
for (const mode of modes) {
  const a = out.acrossServices[mode];
  const sel = median(services.map((s) => out.perService[mode][s].actualSelectionRatePct ?? 0));
  const f = (m) => `${String(a[m].pairedMedianPct).padStart(7)} /${String(a[m].ratioOfMediansPct).padStart(7)}`;
  console.log(`${mode.padEnd(28)} ${f("p50").padEnd(22)} ${f("p95").padEnd(22)} ${f("throughput").padEnd(22)} ${sel}`);
}
console.log(`\npooled 95% CI (p95): ` + modes.map((m) => `${m}=[${out.acrossServices[m].p95.pooled.ci95.lo}, ${out.acrossServices[m].p95.pooled.ci95.hi}]`).join("  "));
