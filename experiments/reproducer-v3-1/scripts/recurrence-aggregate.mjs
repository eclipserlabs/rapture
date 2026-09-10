// Aggregate Phase 5 recurrence trials into the preregistered capture-efficiency
// metrics, per (incident, profile, strategy) cell.
//
// The theoretical sampling reference 1-(1-p)^n is reported ALONGSIDE the
// empirical capture probability, never in place of it.
//
// Usage: node scripts/recurrence-aggregate.mjs [--in results/recurrence]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const IN = arg("--in", join(root, "results", "recurrence"));

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
function quantile(xs, q) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  if (s.length === 1) return s[0];
  const idx = Math.min(s.length - 1, Math.ceil(q * s.length) - 1);
  return s[Math.max(0, idx)];
}
const median = (xs) => quantile(xs, 0.5);

const SAMPLE_RATE = { "sample-1": 0.01, "sample-5": 0.05, "sample-10": 0.1, "sample-25": 0.25 };
const PROFILE_RATE = {
  ONE_OFF: null,
  RARE: 0.001,
  LOW: 0.01,
  MEDIUM: 0.05,
  HIGH: 0.2,
  DETERMINISTIC: 1.0,
};

const rows = JSON.parse(readFileSync(join(IN, "trials.json"), "utf8"));
const applicable = rows.filter((r) => r.applicable !== false);
const notApplicable = rows.filter((r) => r.applicable === false);

const cells = new Map();
for (const r of applicable) {
  const k = `${r.incident}|${r.profile}|${r.strategy}`;
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k).push(r);
}

const out = { cells: [], notApplicable, generatedAt: new Date().toISOString() };
for (const [k, trials] of cells) {
  const [incident, profile, strategy] = k.split("|");
  const captured = trials.filter((t) => t.captured);
  const rate = SAMPLE_RATE[strategy];
  const failuresPerTrial = trials.map((t) => t.failureOccurrences);
  const cell = {
    incident,
    family: trials[0].family,
    profile,
    strategy,
    trials: trials.length,
    requestBudget: trials[0].maxRequests,
    artifactsObtained: captured.length,
    // Empirical, censored at the profile's request budget.
    failureCaptureProbability: round2(captured.length / trials.length),
    medianFailureOccurrencesInTrial: median(failuresPerTrial),
    medianAdditionalFailuresToCapture: median(captured.map((t) => t.additionalFailuresAfterFirstDetection)),
    p95AdditionalFailuresToCapture: quantile(
      captured.map((t) => t.additionalFailuresAfterFirstDetection),
      0.95,
    ),
    medianCaptureAtFailureOccurrence: median(captured.map((t) => t.capturedAtFailureOccurrence)),
    medianFullyInstrumentedRequests: median(trials.map((t) => t.fullyInstrumentedRequests)),
    p95FullyInstrumentedRequests: quantile(trials.map((t) => t.fullyInstrumentedRequests), 0.95),
    medianFullyInstrumentedPerArtifact: captured.length
      ? median(captured.map((t) => t.fullyInstrumentedRequests))
      : null,
    medianMatchingSuccessesInstrumented: median(captured.map((t) => t.matchingSuccessesFullyInstrumented)),
    medianTimeToArtifactMs: median(captured.map((t) => t.msFromFirstFailureToArtifact)),
    p95TimeToArtifactMs: quantile(captured.map((t) => t.msFromFirstFailureToArtifact), 0.95),
    medianArmingDurationMs: median(trials.map((t) => t.armingDurationMs)),
    medianRequestsIssued: median(trials.map((t) => t.requestsIssued)),
    disarmReasons: trials.reduce((acc, t) => {
      if (t.disarmReason) acc[t.disarmReason] = (acc[t.disarmReason] ?? 0) + 1;
      return acc;
    }, {}),
    terminations: trials.reduce((acc, t) => {
      acc[t.terminated] = (acc[t.terminated] ?? 0) + 1;
      return acc;
    }, {}),
  };
  // Theoretical reference for ingress sampling only, using the failure count
  // actually observed in each trial. Reported next to, never instead of, the
  // measured probability.
  if (rate != null) {
    const theo = failuresPerTrial.map((n) => 1 - (1 - rate) ** n);
    cell.theoreticalReference = {
      formula: "1-(1-p)^n",
      p: rate,
      medianFailureOccurrencesObserved: median(failuresPerTrial),
      meanTheoreticalCaptureProbability: round2(theo.reduce((a, b) => a + b, 0) / theo.length),
      note: "computed from the failure occurrences actually observed within the trial's request budget; it is a reference, not evidence",
    };
  }
  cell.profileFailureRate = PROFILE_RATE[profile];
  out.cells.push(cell);
}

out.cells.sort(
  (a, b) =>
    a.incident.localeCompare(b.incident) ||
    Object.keys(PROFILE_RATE).indexOf(a.profile) - Object.keys(PROFILE_RATE).indexOf(b.profile) ||
    a.strategy.localeCompare(b.strategy),
);
writeFileSync(join(IN, "aggregate.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${join(IN, "aggregate.json")} (${out.cells.length} cells)`);
console.log(
  `${"incident".padEnd(15)} ${"profile".padEnd(14)} ${"strategy".padEnd(11)} ${"cap".padEnd(7)} ${"P".padEnd(6)} medAddFail p95AddFail medInstr medMs`,
);
for (const c of out.cells) {
  console.log(
    `${c.incident.padEnd(15)} ${c.profile.padEnd(14)} ${c.strategy.padEnd(11)} ${String(`${c.artifactsObtained}/${c.trials}`).padEnd(7)} ${String(c.failureCaptureProbability).padEnd(6)} ${String(c.medianAdditionalFailuresToCapture).padStart(10)} ${String(c.p95AdditionalFailuresToCapture).padStart(10)} ${String(c.medianFullyInstrumentedRequests).padStart(8)} ${String(c.medianTimeToArtifactMs).padStart(6)}`,
  );
}
