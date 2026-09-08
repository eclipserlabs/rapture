// Post-hoc scoring for reproducer-v1. This module MAY read ground truth from
// the frozen manifest. It is imported only by scoring/reporting code AFTER
// reduction completes — never by the reducer trial path (asserted by test).
// Scoring semantics frozen in V1-MANIFEST.json (scoring_semantics v1).

/**
 * @param {{must:string[], anyOf:string[][]}} groundTruth
 * @param {Set<string>} keptIds
 * @param {string[]} allIds
 */
export function scoreKept(groundTruth, keptIds, allIds) {
  const missingMust = groundTruth.must.filter((id) => !keptIds.has(id));
  const satisfiedCore =
    groundTruth.anyOf.length === 0
      ? null
      : groundTruth.anyOf.find((core) => core.every((id) => keptIds.has(id))) ?? null;
  const coreOk = groundTruth.anyOf.length === 0 || satisfiedCore !== null;
  const recall = missingMust.length === 0 && coreOk ? 1 : 0;
  const relevant = new Set([...groundTruth.must, ...groundTruth.anyOf.flat()]);
  const irrelevant = allIds.filter((id) => !relevant.has(id));
  const removedIrrelevant = irrelevant.filter((id) => !keptIds.has(id));
  return {
    recall,
    missingMust,
    satisfiedCore,
    coreOk,
    irrelevantCount: irrelevant.length,
    irrelevantRemovalRate: irrelevant.length === 0 ? 1 : removedIrrelevant.length / irrelevant.length,
  };
}

/**
 * Local 1-minimality from trial traces: every kept atom must have a failing
 * single-removal trial under the named reducer.
 */
export function locallyMinimalFromTrace(trials, keptIds, reducerName) {
  const missing = [];
  for (const id of keptIds) {
    const found = trials.some(
      (t) => t.reducer === reducerName && t.pass === false && t.removed.length === 1 && t.removed[0] === id,
    );
    if (!found) missing.push(id);
  }
  return { locallyMinimal: missing.length === 0, unproven: missing };
}

/** Distinct wrong-failure (APPLICATION, non-target) fingerprints in trials. */
export function wrongFailureStats(trials, targetHash) {
  const seen = new Set();
  let rejected = 0;
  let accepted = 0;
  for (const t of trials) {
    if (t.pass) {
      if (t.fingerprint_hash !== targetHash) accepted += 1;
      continue;
    }
    if (t.fingerprint_kind === "APPLICATION" && t.fingerprint_hash !== targetHash) {
      seen.add(t.fingerprint_hash);
      rejected += 1;
    }
  }
  return { distinctWrongFailures: seen.size, wrongRejected: rejected, wrongAccepted: accepted };
}
