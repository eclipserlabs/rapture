// Reducer determinism + ground-truth isolation tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdversarialScenario } from "../adversarial/scenarios.js";
import { buildFullCapture, buildCandidate, listAtoms, runCandidate } from "../../reproducer-v0/src/capture.js";
import { ddminReduce, greedyReduce } from "../../reproducer-v0/src/reducer.js";
import { eventKey } from "../../reproducer-v0/src/replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function reduceWith(scenario, atomOrder) {
  const { capture } = buildFullCapture(scenario, "test");
  const atoms = atomOrder ?? listAtoms(scenario, capture);
  const scratch = mkdtempSync(join(tmpdir(), "reprov1-test-"));
  const expected = capture.failure_fingerprint.fingerprint_hash;
  const runTrial = (keepSet) => {
    const r = runCandidate(scenario.run, buildCandidate(scenario, capture, keepSet), scratch);
    return {
      pass: r.fingerprint.fingerprint_hash === expected,
      fingerprintHash: r.fingerprint.fingerprint_hash,
      wallMs: r.wallMs,
    };
  };
  const silent = () => {};
  const greedy = greedyReduce(atoms, runTrial, silent);
  const ddmin = ddminReduce(atoms, runTrial, silent);
  return { capture, greedy: [...greedy.keptIds].sort(), ddmin: [...ddmin.keptIds].sort() };
}

describe("reducers", () => {
  it("GREEDY and DDMIN are deterministic for identical captures", () => {
    const scenario = getAdversarialScenario("adv-sequence");
    const a = reduceWith(scenario);
    const b = reduceWith(scenario);
    assert.deepEqual(a.greedy, b.greedy);
    assert.deepEqual(a.ddmin, b.ddmin);
  });

  it("reducer has no import/path access to causal-ground-truth modules", () => {
    const reducerSrc = readFileSync(
      join(root, "..", "reproducer-v0", "src", "reducer.js"),
      "utf8",
    );
    assert.ok(!/causal|groundTruth|anyOf|scenarios/i.test(reducerSrc));
    for (const f of ["run-adversarial.js", "run-reduce-realbugs.js", "replay-single-v1.js"]) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      assert.ok(!/groundTruth|causalTopology/i.test(src), `${f} must not touch ground-truth APIs`);
    }
  });

  it("reduction is identical with groundTruth stripped from the scenario", () => {
    const scenario = getAdversarialScenario("adv-masked-quorum");
    const withGt = reduceWith(scenario);
    const stripped = { ...scenario, groundTruth: undefined };
    const withoutGt = reduceWith(stripped);
    assert.deepEqual(withGt.greedy, withoutGt.greedy);
    assert.deepEqual(withGt.ddmin, withoutGt.ddmin);
    // And the kept set matches the headline ddmin artifact's implied set.
    const artifact = JSON.parse(
      readFileSync(join(root, "results", "adversarial", "artifact-adv-masked-quorum.ddmin.json"), "utf8"),
    );
    const implied = new Set([
      ...artifact.required_boundary_events.map((e) => `evt:${eventKey(e.kind, e.operation, e.request_or_key)}`),
      ...artifact.required_db_rows.map((r) => `db:${r.table}:${r.key}`),
      ...Object.keys(artifact.required_config).map((k) => `cfg:${k}`),
    ]);
    for (const p of ["tag"]) {
      if (artifact.input[p] !== undefined) implied.add(`in:${p}`);
    }
    assert.deepEqual([...implied].sort(), withGt.ddmin);
  });
});
