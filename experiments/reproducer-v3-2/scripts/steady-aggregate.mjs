// V3.2 Gate 1 evaluation. Both preregistered estimators; a gate PASSES only
// under both, otherwise ESTIMATOR_DEPENDENT and treated as not passing.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "results", "steady-state");
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
const r2 = (x) => Math.round(x * 100) / 100;
function mulberry32(seed){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function ci(sample, seed = 7) {
  if (!sample.length) return null;
  const rand = mulberry32(seed), out = [];
  for (let i = 0; i < 10000; i++) { const s = Array.from({length: sample.length}, () => sample[Math.floor(rand()*sample.length)]); out.push(med(s)); }
  out.sort((a,b)=>a-b);
  return { lo: r2(out[Math.floor(0.025*out.length)]), hi: r2(out[Math.floor(0.975*out.length)]) };
}
const recs = readdirSync(dir).filter(f => f.startsWith("ss-")).map(f => JSON.parse(readFileSync(join(dir, f), "utf8")));
const services = [...new Set(recs.map(r => r.service))].sort();
const modes = [...new Set(recs.map(r => r.mode))].filter(m => m !== "OFF_MIXED").sort();
const invalid = recs.filter(r => r.invalidEnvironment);
const out = { generatedAt: new Date().toISOString(),
  manifest: "1101611db49f726c7a4a8e668fef13b61c8c3af09b657b9479af7b5269a99dbb",
  implementation: "773dfeef4b7edec1d987797f9b9c922e70563d8fbac6021f1b1ce1aad81a8342",
  run: "run 2 (corrected per-repetition criterion)", repetitions: recs.length,
  invalid_environment: invalid.length,
  invalid_detail: invalid.map(r => ({ id: r.service + "/" + r.mode + "/rep" + r.rep, reason: r.invalidEnvironmentReason })),
  perService: {}, acrossServices: {} };
for (const mode of modes) {
  const pairedU = [], ratioU = [], pairedT = [], ratioT = [], pooledU = [];
  const per = {};
  for (const s of services) {
    const off = recs.filter(r => r.service === s && r.mode === "OFF_MIXED" && !r.invalidEnvironment).sort((a,b)=>a.rep-b.rep);
    const mm  = recs.filter(r => r.service === s && r.mode === mode        && !r.invalidEnvironment).sort((a,b)=>a.rep-b.rep);
    const pu = [], pt = [];
    for (let i = 0; i < Math.min(off.length, mm.length); i++) {
      pu.push((mm[i].unmatched.p95 / off[i].unmatched.p95 - 1) * 100);
      pt.push((mm[i].throughputRps / off[i].throughputRps - 1) * 100);
    }
    pooledU.push(...pu);
    const rU = (med(mm.map(r=>r.unmatched.p95)) / med(off.map(r=>r.unmatched.p95)) - 1) * 100;
    const rT = (med(mm.map(r=>r.throughputRps)) / med(off.map(r=>r.throughputRps)) - 1) * 100;
    pairedU.push(med(pu)); ratioU.push(rU); pairedT.push(med(pt)); ratioT.push(rT);
    per[s] = { reps: mm.length,
      unmatched: { p50: r2(med(mm.map(r=>r.unmatched.p50))), p95: r2(med(mm.map(r=>r.unmatched.p95))), p99: r2(med(mm.map(r=>r.unmatched.p99))) },
      selectedP95: mm[0] && mm[0].selected.n ? r2(med(mm.map(r=>r.selected.p95))) : null,
      throughputRps: r2(med(mm.map(r=>r.throughputRps))),
      unmatchedP95OverheadPaired: r2(med(pu)), unmatchedP95OverheadRatio: r2(rU),
      throughputDeltaPaired: r2(med(pt)), throughputDeltaRatio: r2(rT),
      armedFractionActual: r2(med(mm.map(r=>r.armedFractionActual))*100),
      selectedTotal: mm.reduce((a,r)=>a+((r.counters && r.counters.requestsSelected) || 0),0),
      eventsTotal: mm.reduce((a,r)=>a+((r.counters && r.counters.eventsRecorded) || 0),0),
      persistedTotal: mm.reduce((a,r)=>a+((r.counters && r.counters.requestsPersisted) || 0),0) };
  }
  out.perService[mode] = per;
  out.acrossServices[mode] = {
    unmatchedP95: { paired: r2(med(pairedU)), ratio: r2(med(ratioU)), perServicePaired: pairedU.map(r2), max: r2(Math.max(...pairedU)), pooledCI: ci(pooledU) },
    throughput:   { paired: r2(med(pairedT)), ratio: r2(med(ratioT)), perServicePaired: pairedT.map(r2), min: r2(Math.min(...pairedT)) } };
}
out.perService.OFF_MIXED = Object.fromEntries(services.map(s => {
  const off = recs.filter(r => r.service === s && r.mode === "OFF_MIXED" && !r.invalidEnvironment);
  return [s, { reps: off.length, unmatched: { p50: r2(med(off.map(r=>r.unmatched.p50))), p95: r2(med(off.map(r=>r.unmatched.p95))), p99: r2(med(off.map(r=>r.unmatched.p99))) }, throughputRps: r2(med(off.map(r=>r.throughputRps))) }];
}));
writeFileSync(join(root, "results", "steady-state-aggregate.json"), JSON.stringify(out, null, 2));
console.log("run 2: " + recs.length + " repetitions, " + invalid.length + " INVALID_ENVIRONMENT\n");
console.log("mode".padEnd(24) + "unmatched p95 paired/ratio".padEnd(30) + "throughput paired/ratio".padEnd(28) + "worst svc");
for (const mode of modes) {
  const a = out.acrossServices[mode];
  console.log(mode.padEnd(24) +
    (String(a.unmatchedP95.paired).padStart(7) + "% /" + String(a.unmatchedP95.ratio).padStart(7) + "%").padEnd(30) +
    (String(a.throughput.paired).padStart(7) + "% /" + String(a.throughput.ratio).padStart(7) + "%").padEnd(28) +
    a.unmatchedP95.max + "%");
}
console.log("\nARMED_UNMATCHED_ONLY zero-gate counters:");
for (const s of services) { const p = out.perService.ARMED_UNMATCHED_ONLY[s];
  console.log("  " + s.padEnd(16) + " selected=" + p.selectedTotal + " events=" + p.eventsTotal + " persisted=" + p.persistedTotal); }
