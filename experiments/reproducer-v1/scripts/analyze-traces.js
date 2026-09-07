// Post-hoc trace analysis (NOT part of headline execution).
// Re-runs the frozen reducers deterministically with kept-set logging to
// expose context-dependent (non-monotonic / masked) predicate flips and to
// verify the ddmin-vs-greedy diagnosis. Writes results/analysis-flips.json.
// Does not modify any frozen artifact, manifest, or headline metric.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { getAdversarialScenario } = await import(join(root, "adversarial", "scenarios.js"));
const { buildFullCapture, buildCandidate, listAtoms, runCandidate } = await import(
  join(v0src, "capture.js")
);
const { ddminReduce, greedyReduce } = await import(join(v0src, "reducer.js"));

function instrumentedRun(scenarioId) {
  const scenario = getAdversarialScenario(scenarioId);
  const { capture } = buildFullCapture(scenario, "analysis");
  const atoms = listAtoms(scenario, capture);
  const scratch = mkdtempSync(join(tmpdir(), "reprov1-analysis-"));
  const expectedHash = capture.failure_fingerprint.fingerprint_hash;
  const log = [];
  const runTrial = (keepSet) => {
    const candidate = buildCandidate(scenario, capture, keepSet);
    const r = runCandidate(scenario.run, candidate, scratch);
    const pass = r.fingerprint.fingerprint_hash === expectedHash;
    log.push({ kept: [...keepSet].sort(), pass, hash: r.fingerprint.fingerprint_hash });
    return { pass, fingerprintHash: r.fingerprint.fingerprint_hash, wallMs: r.wallMs };
  };
  const silent = () => {};
  greedyReduce(atoms, runTrial, silent);
  const greedyLog = log.splice(0);
  ddminReduce(atoms, runTrial, silent);
  return { greedyLog, ddminLog: log, expectedHash };
}

function has(log, id) {
  return log.filter((t) => !t.kept.includes(id));
}
function hasKept(log, id) {
  return log.filter((t) => t.kept.includes(id));
}

const out = {};
// A5 non-monotonic: slow_row absent+pass while FAST_PATH kept; slow_row absent+fail while FAST_PATH absent.
{
  const { greedyLog, ddminLog } = instrumentedRun("adv-nonmonotonic");
  const all = [...greedyLog, ...ddminLog];
  const slowOutFastInPass = all.filter(
    (t) => !t.kept.includes("db:store:k_slow") && t.kept.includes("cfg:FAST_PATH") && t.pass,
  );
  const slowOutFastOutFail = all.filter(
    (t) => !t.kept.includes("db:store:k_slow") && !t.kept.includes("cfg:FAST_PATH") && !t.pass,
  );
  out.nonmonotonic = {
    slow_absent_fast_present_pass_count: slowOutFastInPass.length,
    slow_absent_fast_absent_fail_count: slowOutFastOutFail.length,
    flip_demonstrated: slowOutFastInPass.length > 0 && slowOutFastOutFail.length > 0,
  };
}
// A12 masked: n2 absent+pass with n1,n3 present; n2 absent+fail with a partner absent.
{
  const { greedyLog, ddminLog } = instrumentedRun("adv-masked-quorum");
  const all = [...greedyLog, ...ddminLog];
  const maskedPass = all.filter(
    (t) =>
      !t.kept.includes("db:nodes:n2") &&
      t.kept.includes("db:nodes:n1") &&
      t.kept.includes("db:nodes:n3") &&
      t.pass,
  );
  const unmaskedFail = all.filter(
    (t) =>
      !t.kept.includes("db:nodes:n2") &&
      (!t.kept.includes("db:nodes:n1") || !t.kept.includes("db:nodes:n3")) &&
      !t.pass,
  );
  out.masked = {
    n2_absent_partners_present_pass_count: maskedPass.length,
    n2_absent_partner_absent_fail_count: unmaskedFail.length,
    flip_demonstrated: maskedPass.length > 0 && unmaskedFail.length > 0,
  };
}
// A1 diagnosis: confirm no accepted trial ever drops both flags together.
{
  const { greedyLog, ddminLog } = instrumentedRun("adv-joint-pair");
  const all = [...greedyLog, ...ddminLog];
  const bothOutPass = all.filter(
    (t) => !t.kept.includes("cfg:STRICT_A") && !t.kept.includes("cfg:STRICT_B") && t.pass,
  );
  const oneOutFail = all.filter(
    (t) =>
      (t.kept.includes("cfg:STRICT_A") !== t.kept.includes("cfg:STRICT_B")) && !t.pass,
  );
  out.jointPair = {
    accepted_trials_dropping_both_flags: bothOutPass.length,
    rejected_single_flag_trials: oneOutFail.length,
    diagnosis:
      "round-robin chunking + complement-first bias: noise-dropping complements " +
      "that retain both flags keep passing, so the pair is never jointly dropped; " +
      "single-flag drops fail (wrong failure or missing ambient).",
  };
}
// A2 alternative: reversed atom order yields the other valid core.
{
  const scenario = getAdversarialScenario("adv-alt-sets");
  const { capture } = buildFullCapture(scenario, "analysis");
  const atoms = listAtoms(scenario, capture).reverse();
  const scratch = mkdtempSync(join(tmpdir(), "reprov1-analysis-"));
  const expectedHash = capture.failure_fingerprint.fingerprint_hash;
  const runTrial = (keepSet) => {
    const r = runCandidate(scenario.run, buildCandidate(scenario, capture, keepSet), scratch);
    return {
      pass: r.fingerprint.fingerprint_hash === expectedHash,
      fingerprintHash: r.fingerprint.fingerprint_hash,
      wallMs: r.wallMs,
    };
  };
  const fwd = instrumentedRun("adv-alt-sets");
  const rev = greedyReduce(atoms, runTrial, () => {});
  const fwdCore = [...fwd.greedyLog.at(-1).kept].filter((id) => id.startsWith("db:"));
  out.altSets = {
    forward_greedy_db_core: fwdCore.sort(),
    reversed_greedy_db_core: [...rev.keptIds].filter((id) => id.startsWith("db:")).sort(),
  };
  out.altSets.distinct_valid_cores =
    JSON.stringify(out.altSets.forward_greedy_db_core) !==
    JSON.stringify(out.altSets.reversed_greedy_db_core);
}

writeFileSync(join(root, "results", "analysis-flips.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
