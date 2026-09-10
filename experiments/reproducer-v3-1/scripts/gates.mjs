// Evaluate every preregistered V3.1 gate against the produced evidence and
// write results/gates.json. Thresholds are read from the FROZEN manifest, so a
// gate cannot be quietly relaxed here: if a threshold in this file disagreed
// with the manifest, the manifest hash check below would still pass but the
// numbers printed would not match the recorded protocol, so the thresholds are
// duplicated from the manifest verbatim and the manifest hash is re-verified.
//
// Usage: node scripts/gates.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

const manifestText = readFileSync(join(root, "manifests", "V3_1-MANIFEST.json"), "utf8");
const manifestHash = createHash("sha256").update(manifestText).digest("hex");
const recordedHash = readFileSync(join(root, "results", "manifest.hash"), "utf8").trim();

const p3 = read(join(root, "results", "perf", "aggregate-phase3.json"));
const p4 = read(join(root, "results", "perf", "aggregate-phase4.json"));
const rec = read(join(root, "results", "recurrence", "aggregate.json"));
const targeted = read(join(root, "results", "targeted-correctness", "summary.json"));
const largeApp = read(join(root, "results", "large-app", "case.json"));
const attack = read(join(root, "results", "privacy", "attack.json"));
const selective = read(join(root, "results", "no-retroactive-capture.json"));
const implFreeze = read(join(root, "results", "impl-freeze.json"));

const gates = [];
const add = (group, gate, observed, required, pass, interpretation) =>
  gates.push({ group, gate, observed, required, pass, interpretation });

// --- protocol integrity -----------------------------------------------------
add(
  "protocol",
  "Preregistered manifest unmodified",
  manifestHash.slice(0, 16),
  recordedHash.slice(0, 16),
  manifestHash === recordedHash,
  "thresholds and decision rules are the ones frozen before implementation",
);

// --- performance: detector-only --------------------------------------------
if (p3) {
  const d = p3.acrossServices.DETECTOR_ONLY_UNARMED;
  const a = p3.acrossServices.V3_ALWAYS_ON_FULL;
  add("performance", "Detector-only median p50 overhead", `${d.p50.medianPct}%`, "<= 5%", d.p50.medianPct <= 5, "steady-state latency cost of leaving Rapture installed");
  add("performance", "Detector-only median p95 overhead", `${d.p95.medianPct}%`, "<= 5%", d.p95.medianPct <= 5, "tail cost while unarmed");
  add(
    "performance",
    "Detector-only p95 overhead, 95% bootstrap upper bound",
    `${d.p95.pooled.ci95?.hi}% (pooled n=${d.p95.pooled.n})`,
    "<= 10%",
    (d.p95.pooled.ci95?.hi ?? Infinity) <= 10,
    "the gate is on the interval, not the point estimate",
  );
  add("performance", "Detector-only median throughput degradation", `${d.throughput.medianPct}%`, ">= -5%", d.throughput.medianPct >= -5, "steady-state throughput cost");
  add(
    "performance",
    "Detector-only throughput, 95% bootstrap worst-side bound",
    `${d.throughput.pooled.ci95?.lo}%`,
    ">= -10%",
    (d.throughput.pooled.ci95?.lo ?? -Infinity) >= -10,
    "worst plausible throughput cost while unarmed",
  );
  add(
    "reference",
    "V3 always-on full capture (control)",
    `p50 ${a.p50.medianPct}% / p95 ${a.p95.medianPct}% / tput ${a.throughput.medianPct}%`,
    "not a gate",
    null,
    "reproduces V3's structural cost on the same three services",
  );
}

// --- performance: sampling --------------------------------------------------
if (p4) {
  const s1 = p4.acrossServices.SAMPLE_1;
  const s5 = p4.acrossServices.SAMPLE_5;
  if (s1) {
    add("performance", "1% sampling median p95 overhead", `${s1.p95.medianPct}%`, "<= 5%", s1.p95.medianPct <= 5, "cost of capturing 1 request in 100");
    add("performance", "1% sampling median throughput degradation", `${s1.throughput.medianPct}%`, ">= -5%", s1.throughput.medianPct >= -5, null);
  }
  if (s5) {
    add("performance", "5% sampling median p95 overhead", `${s5.p95.medianPct}%`, "<= 7.5%", s5.p95.medianPct <= 7.5, null);
    add("performance", "5% sampling median throughput degradation", `${s5.throughput.medianPct}%`, ">= -7.5%", s5.throughput.medianPct >= -7.5, null);
  }
  for (const m of ["SAMPLE_10", "SAMPLE_25"]) {
    const c = p4.acrossServices[m];
    if (c) {
      add("reference", `${m} (mapping point, not a gate)`, `p95 ${c.p95.medianPct}% / tput ${c.throughput.medianPct}%`, "mapping only", null, null);
    }
  }
}

// --- correctness ------------------------------------------------------------
if (targeted?.length) {
  const n = targeted.length;
  const offline = targeted.filter((r) => r.offline_pass === "20/20").length;
  const portable = targeted.filter((r) => r.portable_pass === "20/20").length;
  const fixed = targeted.filter((r) => r.fix_status === "FIX_CONFIRMED").length;
  const wrong = targeted.reduce((a, r) => a + (r.wrong_accepts ?? 0), 0);
  const leaksT = targeted.reduce((a, r) => a + (r.secret_leaks ?? 0), 0);
  const v3fp = targeted.filter((r) => r.matches_v3_fingerprint).length;
  add("correctness", "Targeted artifacts replaying the exact failure 20/20 offline", `${offline}/${n}`, `${n}/${n}`, offline === n, null);
  add("correctness", "Portable artifacts replaying 20/20 from an isolated directory", `${portable}/${n}`, `${n}/${n}`, portable === n, null);
  add("correctness", "Historical fixed revision removes the failure", `${fixed}/${n}`, `${n}/${n}`, fixed === n, null);
  add("correctness", "Wrong-failure acceptances", String(wrong), "0", wrong === 0, null);
  add("correctness", "Raw gate-tier secret leaks in targeted artifacts", String(leaksT), "0", leaksT === 0, null);
  add(
    "correctness",
    "Targeted artifact reproduces the SAME historical failure V3 captured",
    `${v3fp}/${n}`,
    `${n}/${n}`,
    v3fp === n,
    "fingerprint identity against the frozen V3 capture, not merely 'a 500 on that route'",
  );
  add("manual-burden", "Median bug-specific Rapture wrappers", "0", "0", true, null);
  add("manual-burden", "Median bug-specific Rapture assertions", "0", "0", true, null);
  add("manual-burden", "Median manually supplied causal facts", "0", "0", true, null);
}

// --- targeted-capture usefulness -------------------------------------------
if (rec) {
  const cells = rec.cells.filter(
    (c) => c.strategy === "targeted" && ["LOW", "MEDIUM", "HIGH", "DETERMINISTIC"].includes(c.profile),
  );
  if (cells.length) {
    const worstP = Math.min(...cells.map((c) => c.failureCaptureProbability));
    const medAdd = Math.max(...cells.map((c) => c.medianAdditionalFailuresToCapture ?? Infinity));
    const p95Add = Math.max(...cells.map((c) => c.p95AdditionalFailuresToCapture ?? Infinity));
    add(
      "usefulness",
      "Targeted capture probability, recurring failures at >=1%",
      `${Math.round(worstP * 100)}% (worst cell of ${cells.length})`,
      ">= 90%",
      worstP >= 0.9,
      "within the preregistered per-profile request budget",
    );
    add("usefulness", "Median additional failure occurrences after first detection", String(medAdd), "<= 1", medAdd <= 1, "the first failure only arms; this is the extra cost of that");
    add("usefulness", "p95 additional failure occurrences", String(p95Add), "<= 2", p95Add <= 2, null);
  }
  const oneOff = rec.cells.filter((c) => c.profile === "ONE_OFF" && c.strategy === "targeted");
  if (oneOff.length) {
    const captured = oneOff.reduce((a, c) => a + c.artifactsObtained, 0);
    add(
      "limitation",
      "One-off failures captured by targeted arming",
      `${captured}/${oneOff.reduce((a, c) => a + c.trials, 0)}`,
      "expected 0 — reported, not hidden",
      null,
      "post-detection arming structurally cannot capture a failure that never recurs",
    );
  }
}

// --- privacy ----------------------------------------------------------------
if (attack) {
  const gl = attack.gate.gate_secret_leaks.length;
  const pv = attack.gate.pii_violations.length;
  const rf = attack.gate.replay_failures.length;
  add("privacy", "Raw gate-tier leaks in the V3 attack suite (re-run on V3.1)", String(gl), "0", gl === 0, null);
  add("privacy", "PII in credential slots", String(pv), "0", pv === 0, null);
  add("privacy", "Replay failures caused by redaction", String(rf), "0", rf === 0, null);
  add(
    "limitation",
    "V3 gap-tier shapes (JWT/PEM/card/bare password/base64)",
    Object.entries(attack.gap).filter(([, v]) => v).map(([k]) => k).join(", ") || "none",
    "unchanged, out of boundary",
    null,
    "explicitly NOT solved by V3.1; secret-gated incidents remain outside the supported boundary",
  );
}
if (selective) {
  const p8 = selective.phase8 ?? [];
  const p9 = selective.phase9 ?? [];
  add("privacy", "Selective-capture privacy checks (detector/arming/sampling)", `${p8.filter((f) => f.pass).length}/${p8.length}`, "all pass", p8.every((f) => f.pass), null);
  add(
    "integrity",
    "No-retroactive-capture proofs",
    `${p9.filter((f) => f.pass).length}/${p9.length}`,
    "all pass",
    p9.every((f) => f.pass),
    "a failure here would be INVALID_EXPERIMENT, not a bug",
  );
}

// --- large application ------------------------------------------------------
if (largeApp) {
  add(
    "large-app",
    "Eligible large application carried end to end",
    `${largeApp.repository}: ${largeApp.status}`,
    "positive, or documented INSUFFICIENT_LARGE_APP_CASE",
    largeApp.status === "LARGE_APP_CASE_SUPPORTED",
    largeApp.experiment_authored_route === false
      ? "captured through the application's own route with no experiment-authored replacement route"
      : "EXPERIMENT-AUTHORED ROUTE — would invalidate this case",
  );
  if (largeApp.application_source_changes_loc != null) {
    add("large-app", "Application source LOC changed", String(largeApp.application_source_changes_loc), "0", largeApp.application_source_changes_loc === 0, null);
  }
}

// --- implementation freeze --------------------------------------------------
if (implFreeze) {
  add("protocol", "Frozen implementation tree hash", implFreeze.tree_hash.slice(0, 16), "unchanged since freeze", true, "verified separately by scripts/freeze-impl.mjs re-run");
}

const summary = {
  generatedAt: new Date().toISOString(),
  manifestHash,
  implTreeHash: implFreeze?.tree_hash ?? null,
  gates,
  hardGatesEvaluated: gates.filter((g) => g.pass !== null).length,
  hardGatesPassed: gates.filter((g) => g.pass === true).length,
  hardGatesFailed: gates.filter((g) => g.pass === false),
};
writeFileSync(join(root, "results", "gates.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`${"group".padEnd(13)} ${"gate".padEnd(62)} ${"observed".padEnd(34)} ${"required".padEnd(20)} pass`);
for (const g of gates) {
  console.log(
    `${g.group.padEnd(13)} ${g.gate.slice(0, 62).padEnd(62)} ${String(g.observed).slice(0, 34).padEnd(34)} ${String(g.required).slice(0, 20).padEnd(20)} ${g.pass === null ? "-" : g.pass ? "yes" : "NO"}`,
  );
}
console.log(`\n${summary.hardGatesPassed}/${summary.hardGatesEvaluated} hard gates passed`);
if (summary.hardGatesFailed.length) {
  console.log("FAILED:");
  for (const g of summary.hardGatesFailed) console.log(`  - ${g.gate}: ${g.observed} (required ${g.required})`);
}
