// Adversarial topology tests: ordering, alternative cores, non-monotonic search.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventKey } from "../../reproducer-v0/src/replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function perScenario() {
  return JSON.parse(readFileSync(join(root, "results", "adversarial", "per-scenario.json"), "utf8"));
}

describe("adversarial topologies", () => {
  it("sequence-dependent scenario cannot be reduced by illegal reordering", () => {
    const capture = JSON.parse(
      readFileSync(join(root, "results", "adversarial", "capture-adv-sequence.json"), "utf8"),
    );
    const artifact = JSON.parse(
      readFileSync(join(root, "results", "adversarial", "artifact-adv-sequence.ddmin.json"), "utf8"),
    );
    const keptSeqs = artifact.required_boundary_events.map((e) => e.sequence);
    const origSeqs = capture.boundary_events.map((e) => e.sequence);
    assert.deepEqual([...keptSeqs].sort((a, b) => a - b), keptSeqs);
    let j = 0;
    for (const s of origSeqs) {
      if (j < keptSeqs.length && s === keptSeqs[j]) j += 1;
    }
    assert.equal(j, keptSeqs.length, "kept events must be a subsequence in original order");
    const ops = artifact.required_boundary_events.map((e) => e.operation);
    assert.ok(ops.indexOf("auth") < ops.indexOf("refresh"));
    assert.ok(ops.indexOf("refresh") < ops.indexOf("finalize"));
  });

  it("alternative causal-set scenario remains reproducible after valid alternative reduction", () => {
    const flips = JSON.parse(readFileSync(join(root, "results", "analysis-flips.json"), "utf8"));
    assert.equal(flips.altSets.distinct_valid_cores, true);
    const rows = perScenario();
    const row = rows.find((r) => r.scenario_id === "adv-alt-sets");
    assert.equal(row.ddmin_portable, 20);
    assert.equal(row.ddmin_recall, 1);
    assert.ok(Array.isArray(row.ddmin_satisfied_core) && row.ddmin_satisfied_core.length === 2);
  });

  it("non-monotonic scenario exercises reducer search beyond trivial independent deletion", () => {
    const flips = JSON.parse(readFileSync(join(root, "results", "analysis-flips.json"), "utf8"));
    assert.equal(flips.nonmonotonic.flip_demonstrated, true);
    assert.equal(flips.masked.flip_demonstrated, true);
    assert.ok(flips.nonmonotonic.slow_absent_fast_present_pass_count > 0);
    assert.ok(flips.nonmonotonic.slow_absent_fast_absent_fail_count > 0);
  });

  it("event keys used in ground truth match replay keys", () => {
    // Guards against ground-truth/replay key skew that would fake recall.
    const manifest = JSON.parse(readFileSync(join(root, "V1-MANIFEST.json"), "utf8"));
    const capture = JSON.parse(
      readFileSync(join(root, "results", "adversarial", "capture-adv-sequence.json"), "utf8"),
    );
    const entry = manifest.adversarial_cohort.scenarios.find((s) => s.id === "adv-sequence");
    const liveKeys = new Set(
      capture.boundary_events.map((e) => `evt:${eventKey(e.kind, e.operation, e.request_or_key)}`),
    );
    for (const id of entry.ground_truth.must) assert.ok(liveKeys.has(id), `stale ground-truth id ${id}`);
  });
});
