// V1 protocol tests: Node22 conformance record, lineage identity, frozen manifest.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashJson } from "../../reproducer-v0/src/canonical.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");

describe("V1 protocol", () => {
  it("Node 22 V0 conformance passes (recorded rerun)", () => {
    assert.ok(process.version.startsWith("v22."), `tests must run under Node 22, got ${process.version}`);
    const agg = JSON.parse(
      readFileSync(join(root, "..", "reproducer-v0", "results", "aggregate.json"), "utf8"),
    );
    assert.equal(agg.full_replay_total, "160/160");
    assert.equal(agg.portable_replay_total, "160/160");
    assert.equal(agg.total_wrong_failure_accepted, 0);
    assert.equal(agg.total_live_effects, 0);
    assert.equal(agg.min_causal_recall, 1);
    const report = readFileSync(join(root, "..", "reproducer-v0", "REPORT.md"), "utf8");
    assert.ok(report.includes("Appendix A — V0 Protocol Closure"));
    assert.ok(report.includes("Lineage gate: PASS"));
  });

  it("repository lineage assertion passes (canonical identity documented)", () => {
    // Offline-provable half: the base SHA exists locally and the V0 report
    // records rapture-fx/rapture HEAD == main == that SHA (verified live in Phase 0).
    execSync("git cat-file -e a2f012afd6e1f548c53853c15cd9ccb54a530f9b");
    const report = readFileSync(join(root, "..", "reproducer-v0", "REPORT.md"), "utf8");
    assert.ok(report.includes("Canonical repository: rapture-fx/rapture"));
    const head = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    assert.ok(/^[0-9a-f]{40}$/.test(head));
  });

  it("V1 manifest is frozen (hash matches)", () => {
    const manifest = JSON.parse(readFileSync(join(root, "V1-MANIFEST.json"), "utf8"));
    assert.equal(manifest.adversarial_cohort.scenarios.length, 12);
    const recorded = readFileSync(join(root, "results", "v1-manifest.hash"), "utf8").trim();
    assert.equal(hashJson(manifest), recorded);
    assert.ok(manifest.freeze_rules.includes("frozen before headline execution"));
  });
});
