// Deletion-based reducers for reproducer-v0.
//
// INTEGRITY: this module never imports fixture definitions and never learns
// which atoms are required. It receives only an ordered atom list plus a
// black-box trial function returning pass/fail against the exact expected
// failure fingerprint. A test asserts this file contains no reference to
// necessity labels.
//
// Main reducer: ddmin-style chunk deletion followed by a greedy fixpoint sweep,
// so deletion of every remaining removable atom is tested at least once
// (1-minimal result). Baseline: single-pass greedy deletion.

/**
 * @param {Array<{id:string}>} atoms - deterministic order, full set passes
 * @param {(keepIds: Set<string>) => {pass:boolean, fingerprintHash:string, wallMs:number}} runTrial
 * @param {(trial: object) => void} onTrial - trial recorder (JSONL sink)
 */
export function ddminReduce(atoms, runTrial, onTrial) {
  let trial = 0;
  const test = (keepIds, removed, reducer) => {
    trial += 1;
    const r = runTrial(keepIds);
    onTrial({
      trial,
      reducer,
      kept_count: keepIds.size,
      removed: [...removed].sort(),
      pass: r.pass,
      fingerprint_hash: r.fingerprintHash,
      wall_ms: r.wallMs,
    });
    return r.pass;
  };

  let current = atoms.map((a) => a.id);
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (current.length < 2) break;
    const subsets = splitInto(current, Math.min(n, current.length));
    let reduced = false;
    for (const s of subsets) {
      const complement = current.filter((id) => !s.includes(id));
      if (complement.length === current.length) continue;
      if (test(new Set(complement), new Set(s), "ddmin")) {
        current = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    for (const s of subsets) {
      if (s.length === current.length) continue;
      if (test(new Set(s), new Set(current.filter((id) => !s.includes(id))), "ddmin")) {
        current = s;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (n >= current.length) break;
    n = Math.min(2 * n, current.length);
  }

  // Greedy fixpoint sweep: guarantees 1-minimality and documents it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...current]) {
      const candidate = current.filter((x) => x !== id);
      if (test(new Set(candidate), new Set([id]), "ddmin-sweep")) {
        current = candidate;
        changed = true;
      }
    }
  }
  return { keptIds: new Set(current), trials: trial };
}

/** Single-pass greedy deletion baseline (cheap algorithmic comparison). */
export function greedyReduce(atoms, runTrial, onTrial) {
  let trial = 0;
  let current = atoms.map((a) => a.id);
  for (const id of atoms.map((a) => a.id)) {
    if (!current.includes(id)) continue;
    const candidate = current.filter((x) => x !== id);
    trial += 1;
    const r = runTrial(new Set(candidate));
    onTrial({
      trial,
      reducer: "greedy",
      kept_count: candidate.length,
      removed: [id],
      pass: r.pass,
      fingerprint_hash: r.fingerprintHash,
      wall_ms: r.wallMs,
    });
    if (r.pass) current = candidate;
  }
  return { keptIds: new Set(current), trials: trial };
}

function splitInto(list, n) {
  const out = Array.from({ length: n }, () => []);
  list.forEach((id, i) => {
    out[i % n].push(id);
  });
  return out.filter((s) => s.length > 0);
}
