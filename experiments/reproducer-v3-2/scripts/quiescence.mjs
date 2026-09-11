// V3.2 machine-quiescence protocol.
//
// V3.1's performance campaign was later found to have overlapped a
// long-running parse-server diagnostic loop on a 4-logical-CPU host. Those
// numbers are retained for provenance but are NOT authoritative deployment
// economics. V3.2 re-measures under an explicit, objective, preregistered
// quiescence gate that is recorded BEFORE any headline result is inspected.
//
// Usage:
//   node scripts/quiescence.mjs --check          one snapshot, exit 0/1
//   node scripts/quiescence.mjs --gate           hold until stable, then record
//   node scripts/quiescence.mjs --snapshot FILE  write a snapshot to FILE
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: "utf8" }); } catch { return ""; } };

export const CRITERIA = {
  logical_cpus: cpus().length,
  // Normalized to CPU count, never raw load average.
  max_load1_per_cpu: 0.35,
  max_load5_per_cpu: 0.60,
  // Orphaned experiment work of any kind disqualifies the host outright.
  forbidden_process_patterns: [
    "replay-raw-slowboot", "classcheck", "parse-server",
    "reproducer-v3-2/services/", "reproducer-v3/headline/services/",
    "steady-state.mjs", "perf-brief.mjs", "regression-8.mjs",
    "selective-correctness", "leak-diagnosis.mjs",
  ],
  // fake-external is a REQUIRED dependency of the workload, not contention.
  allowed_process_patterns: ["fake-external.mjs"],
  // macOS keeps "free" memory deliberately low (most RAM is file cache), so
  // raw free memory is not a pressure signal. What matters for a benchmark is
  // whether the host is actively swapping DURING measurement, so the criterion
  // is a swap-in RATE, sampled per interval, not a cumulative total.
  // Reclaimable (inactive) pages count as available on macOS; raw free does not.
  min_available_mem_mb: 500,
  max_swapins_per_second: 400,
  stabilization_window_seconds: 60,
  sample_interval_seconds: 10,
  rule: "every sample in the stabilization window must satisfy every criterion; a single violation restarts the window",
};

export function processInventory() {
  const out = sh("ps", ["-A", "-o", "pid=,pcpu=,command="]).split("\n").filter(Boolean);
  const offenders = [];
  // The campaign process runs from a script that is itself on the forbidden
  // list, so it must not flag itself (or its parent shell) as an orphan.
  const selfPids = new Set([process.pid, process.ppid].map(String));
  for (const line of out) {
    const pid = (line.trim().match(/^(\d+)/) ?? [])[1];
    if (pid != null && selfPids.has(pid)) continue;
    if (CRITERIA.allowed_process_patterns.some((p) => line.includes(p))) continue;
    for (const p of CRITERIA.forbidden_process_patterns) {
      if (line.includes(p)) { offenders.push(line.trim().slice(0, 160)); break; }
    }
  }
  const heavy = out
    .map((l) => { const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/); return m ? { pid: +m[1], cpu: +m[2], cmd: m[3].slice(0, 90) } : null; })
    .filter((x) => x && x.cpu >= 20).sort((a, b) => b.cpu - a.cpu).slice(0, 8);
  return { offenders, heavyProcesses: heavy };
}

function availableMemMb() {
  const v = sh("vm_stat", []);
  const pg = Number((v.match(/page size of (\d+)/) ?? [0, 4096])[1]);
  const get = (re) => Number(((v.match(re) ?? [0, "0"])[1] || "0").replace(/\./g, ""));
  const free = get(/Pages free:\s+(\d[\d.]*)/);
  const inactive = get(/Pages inactive:\s+(\d[\d.]*)/);
  const spec = get(/Pages speculative:\s+(\d[\d.]*)/);
  return Math.round(((free + inactive + spec) * pg) / 1048576);
}

function swapins() {
  const m = sh("vm_stat", []).match(/Swapins:\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

let _lastSwap = null;
export function snapshot() {
  const la = loadavg();
  const n = CRITERIA.logical_cpus;
  const inv = processInventory();
  const sw = swapins();
  const now = Date.now();
  let rate = null;
  if (_lastSwap != null) {
    const dt = (now - _lastSwap.t) / 1000;
    if (dt > 0.5) rate = Math.round((sw - _lastSwap.v) / dt);
  }
  _lastSwap = { t: now, v: sw };
  return {
    swapin_rate_per_s: rate,
    at: new Date().toISOString(),
    logical_cpus: n,
    load1: +la[0].toFixed(2), load5: +la[1].toFixed(2), load15: +la[2].toFixed(2),
    load1_per_cpu: +(la[0] / n).toFixed(3), load5_per_cpu: +(la[1] / n).toFixed(3),
    free_mem_mb: Math.round(freemem() / 1048576),
    available_mem_mb: availableMemMb(),
    total_mem_mb: Math.round(totalmem() / 1048576),
    swapins: sw,
    orphaned_experiment_processes: inv.offenders,
    heavy_processes: inv.heavyProcesses,
  };
}

export function evaluate(s) {
  const f = [];
  if (s.load1_per_cpu > CRITERIA.max_load1_per_cpu) f.push(`load1/cpu ${s.load1_per_cpu} > ${CRITERIA.max_load1_per_cpu}`);
  if (s.load5_per_cpu > CRITERIA.max_load5_per_cpu) f.push(`load5/cpu ${s.load5_per_cpu} > ${CRITERIA.max_load5_per_cpu}`);
  if (s.orphaned_experiment_processes.length) f.push(`orphaned experiment processes: ${s.orphaned_experiment_processes.length}`);
  if (s.available_mem_mb < CRITERIA.min_available_mem_mb) f.push(`available mem ${s.available_mem_mb}MB < ${CRITERIA.min_available_mem_mb}MB`);
  if (s.swapin_rate_per_s != null && s.swapin_rate_per_s > CRITERIA.max_swapins_per_second) f.push(`swapin rate ${s.swapin_rate_per_s}/s > ${CRITERIA.max_swapins_per_second}/s`);
  return { pass: f.length === 0, failures: f };
}

// Only act as a CLI when invoked directly; importing this module must not
// run the gate or call process.exit.
const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
const mode = process.argv[2] ?? "--check";
if (!isMain) {
  // imported: expose snapshot/evaluate/CRITERIA only
} else if (mode === "--check") {
  const s = snapshot(); const e = evaluate(s);
  console.log(JSON.stringify({ ...s, ...e }, null, 2));
  process.exit(e.pass ? 0 : 1);
} else if (mode === "--snapshot") {
  const s = snapshot(); const e = evaluate(s);
  const p = process.argv[3];
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...s, ...e, criteria: CRITERIA }, null, 2));
  console.log(`${e.pass ? "QUIESCENT" : "NOT QUIESCENT"} load1/cpu=${s.load1_per_cpu} avail=${s.available_mem_mb}MB orphans=${s.orphaned_experiment_processes.length}`);
  process.exit(e.pass ? 0 : 1);
} else if (mode === "--gate") {
  const need = Math.ceil(CRITERIA.stabilization_window_seconds / CRITERIA.sample_interval_seconds);
  const samples = [];
  let ok = 0;
  for (;;) {
    const s = snapshot(); const e = evaluate(s);
    samples.push({ ...s, ...e });
    if (e.pass) { ok += 1; console.log(`  sample ${ok}/${need} OK  load1/cpu=${s.load1_per_cpu} load5/cpu=${s.load5_per_cpu} avail=${s.available_mem_mb}MB`); }
    else { if (ok > 0) console.log(`  window RESET: ${e.failures.join("; ")}`); ok = 0; console.log(`  waiting  load1/cpu=${s.load1_per_cpu}  ${e.failures.join("; ")}`); }
    if (ok >= need) break;
    await new Promise((r) => setTimeout(r, CRITERIA.sample_interval_seconds * 1000));
  }
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "results", "quiescence-gate.json"), JSON.stringify({
    criteria: CRITERIA, passed_at: new Date().toISOString(), samples: samples.slice(-30),
  }, null, 2));
  console.log("QUIESCENCE GATE PASSED");
}
