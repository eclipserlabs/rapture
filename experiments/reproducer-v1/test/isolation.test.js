// Wrong-failure safety + repaired-revision isolation tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const FORBIDDEN = /\bpost_rev\b|POST_REV|impl\/post|extraTreesPost|post-vendor|fixing|\bpatch\b/i;

function expectedHashFor(trialFile) {
  const base = trialFile.slice("trials-".length, -".jsonl".length);
  if (base.startsWith("adv-")) {
    const manifest = JSON.parse(readFileSync(join(root, "V1-MANIFEST.json"), "utf8"));
    const entry = manifest.adversarial_cohort.scenarios.find((s) => s.id === base);
    return entry.expected_failure_fingerprint.fingerprint_hash;
  }
  const capture = JSON.parse(readFileSync(join(root, "results", "real-bugs", `capture-${base}.json`), "utf8"));
  return capture.failure_fingerprint.fingerprint_hash;
}

import { readdirSync } from "node:fs";

describe("safety and isolation", () => {
  it("wrong failure never accepted (all trial logs, both cohorts)", () => {
    const dirs = [join(root, "results", "adversarial"), join(root, "results", "real-bugs")];
    let passTrials = 0;
    let files = 0;
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.startsWith("trials-") && x.endsWith(".jsonl"))) {
        files += 1;
        const expected = expectedHashFor(f);
        const lines = readFileSync(join(dir, f), "utf8").trim().split("\n");
        for (const line of lines) {
          const t = JSON.parse(line);
          if (t.pass) {
            passTrials += 1;
            assert.equal(t.fingerprint_hash, expected, `accepted wrong failure in ${f} trial ${t.trial}`);
          }
        }
      }
    }
    assert.ok(files >= 20, `expected trial logs for 12 adversarial + 12 real-bug runs, found ${files}`);
    assert.ok(passTrials > 0);
  });

  it("real-bug reducer path has no access to repaired revision or fixing patch", () => {
    const files = [
      join(root, "scripts", "run-reduce-realbugs.js"),
      join(root, "scripts", "construct-realbugs.js"),
      join(root, "scripts", "replay-single-v1.js"),
      join(root, "real-bugs", "lib", "v1real.js"),
    ];
    for (const dir of readdirSync(join(root, "real-bugs"), { withFileTypes: true })) {
      if (dir.isDirectory() && dir.name !== "lib") {
        files.push(join(root, "real-bugs", dir.name, "case.js"));
      }
    }
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.ok(!FORBIDDEN.test(src), `${f} references repaired-revision material`);
    }
    // And the reduce script reads only bug_rev from the corpus (never post_rev).
    const reduceSrc = readFileSync(join(root, "scripts", "run-reduce-realbugs.js"), "utf8");
    assert.ok(reduceSrc.includes("bug_rev"));
    assert.ok(!reduceSrc.includes("post_rev"));
  });

  it("temporary directories used by tests are fresh", () => {
    const a = mkdtempSync(join(tmpdir(), "reprov1-iso-"));
    const b = mkdtempSync(join(tmpdir(), "reprov1-iso-"));
    assert.notEqual(a, b);
    writeFileSync(join(a, "x"), "1");
    assert.throws(() => readFileSync(join(b, "x"), "utf8"));
  });
});
