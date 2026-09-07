// Reducer integrity tests: no ground-truth access, exact-failure predicate,
// sequence preservation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { getScenario } from "../src/scenarios.js";
import { buildFullCapture, buildCandidate, listAtoms, runCandidate } from "../src/capture.js";
import { ddminReduce, greedyReduce } from "../src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));

function reduceScenario(id) {
  const scenario = getScenario(id);
  const { capture } = buildFullCapture(scenario, "test-version");
  const atoms = listAtoms(scenario, capture);
  const scratch = mkdtempSync(join(tmpdir(), "repro-test-"));
  const expectedHash = capture.failure_fingerprint.fingerprint_hash;
  const trials = [];
  const runTrial = (keepSet) => {
    const candidate = buildCandidate(scenario, capture, keepSet);
    const r = runCandidate(scenario.run, candidate, scratch);
    const pass = r.fingerprint.fingerprint_hash === expectedHash;
    trials.push({ pass, hash: r.fingerprint.fingerprint_hash });
    return { pass, fingerprintHash: r.fingerprint.fingerprint_hash, wallMs: r.wallMs };
  };
  const onTrial = () => {};
  const full = runTrial(new Set(atoms.map((a) => a.id)));
  assert.ok(full.pass, "full capture must pass before reduction");
  const result = ddminReduce(atoms, runTrial, onTrial);
  return { scenario, capture, atoms, result };
}

describe("reducer integrity", () => {
  it("cannot access scenario causal labels", () => {
    const src = readFileSync(join(here, "..", "src", "reducer.js"), "utf8");
    assert.ok(!/causal/i.test(src), "reducer.js must not reference causal labels");
    assert.ok(!/scenarios/.test(src), "reducer.js must not import scenario definitions");
  });

  it("preserves the required sequence where sequence is causal", () => {
    const { capture, result } = reduceScenario("ordered-two-call-sequence");
    const { eventKey } = incubation();
    const kept = capture.boundary_events.filter((e) => result.keptIds.has(`evt:${eventKey(e.kind, e.operation, e.request_or_key)}`));
    const ops = kept.map((e) => e.operation);
    const reserveIdx = ops.indexOf("reserve");
    const commitIdx = ops.indexOf("commit");
    assert.ok(reserveIdx !== -1 && commitIdx !== -1, "both sequence-critical events retained");
    assert.ok(reserveIdx < commitIdx, "original relative order preserved");
    const seqs = kept.map((e) => e.sequence);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
  });

  it("rejects candidates that produce a different failure", () => {
    // database-state-edge: removing the fraud flag changes ACCOUNT_FROZEN into success.
    const scenario = getScenario("database-state-edge");
    const { capture } = buildFullCapture(scenario, "test-version");
    const atoms = listAtoms(scenario, capture);
    const keepAll = new Set(atoms.map((a) => a.id));
    keepAll.delete("db:flags:fraud_review");
    const scratch = mkdtempSync(join(tmpdir(), "repro-test-"));
    const candidate = buildCandidate(scenario, capture, keepAll);
    const r = runCandidate(scenario.run, candidate, scratch);
    assert.notEqual(r.fingerprint.fingerprint_hash, capture.failure_fingerprint.fingerprint_hash);
    // The predicate used by the reducer is exact equality: this is a rejection.
    assert.ok(r.fingerprint.fingerprint_hash !== capture.failure_fingerprint.fingerprint_hash);
  });

  it("greedy baseline also converges on the causal core without labels", () => {
    const scenario = getScenario("noise-heavy-incident");
    const { capture } = buildFullCapture(scenario, "test-version");
    const atoms = listAtoms(scenario, capture);
    const scratch = mkdtempSync(join(tmpdir(), "repro-test-"));
    const expectedHash = capture.failure_fingerprint.fingerprint_hash;
    const runTrial = (keepSet) => {
      const r = runCandidate(scenario.run, buildCandidate(scenario, capture, keepSet), scratch);
      return { pass: r.fingerprint.fingerprint_hash === expectedHash, fingerprintHash: r.fingerprint.fingerprint_hash, wallMs: r.wallMs };
    };
    const greedy = greedyReduce(atoms, runTrial, () => {});
    assert.equal(greedy.keptIds.size, 4);
  });
});

// Import indirection so the sequence test uses the same key function as replay.
import { eventKey as _eventKey } from "../src/replay.js";
function incubation() {
  return { eventKey: _eventKey };
}
