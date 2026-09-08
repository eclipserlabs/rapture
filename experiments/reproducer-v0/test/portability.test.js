// Portability + workspace-isolation tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getScenario } from "../src/scenarios.js";
import { buildFullCapture, buildCandidate, listAtoms } from "../src/capture.js";
import { ddminReduce } from "../src/reducer.js";
import { buildArtifact, verifyArtifactHash, candidateFromArtifact } from "../src/artifact.js";
import { runCandidate } from "../src/capture.js";
import { stableStringify } from "../src/canonical.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

describe("portability", () => {
  it("portable artifact contains no original absolute temp paths", () => {
    const scenario = getScenario("noise-heavy-incident");
    const { capture, tempDir } = buildFullCapture(scenario, "test-version");
    const atoms = listAtoms(scenario, capture);
    const scratch = mkdtempSync(join(tmpdir(), "repro-test-"));
    const expectedHash = capture.failure_fingerprint.fingerprint_hash;
    const runTrial = (keepSet) => {
      const r = runCandidate(scenario.run, buildCandidate(scenario, capture, keepSet), scratch);
      return { pass: r.fingerprint.fingerprint_hash === expectedHash, fingerprintHash: r.fingerprint.fingerprint_hash, wallMs: r.wallMs };
    };
    const reduced = ddminReduce(atoms, runTrial, () => {});
    const artifact = buildArtifact({
      scenarioId: scenario.id,
      codeVersion: "test-version",
      sourceCaptureHash: capture.capture_hash,
      candidate: buildCandidate(scenario, capture, reduced.keptIds),
      expectedFingerprint: capture.failure_fingerprint,
    });
    assert.ok(verifyArtifactHash(artifact));
    const text = stableStringify(artifact);
    assert.ok(!text.includes(tempDir), "artifact must not reference the capture temp dir");
    assert.ok(!text.includes(tmpdir()), "artifact must not reference any absolute temp path");
    assert.ok(!/\/var\/folders\//.test(text));
    // The artifact alone (no capture file) replays to the same fingerprint.
    const replay = runCandidate(scenario.run, candidateFromArtifact(artifact), scratch);
    assert.equal(replay.fingerprint.fingerprint_hash, expectedHash);
  });

  it("no existing Rapture product surface is modified", () => {
    const repo = join(root, "..", "..");
    const status = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Allowed: the experiment directory itself, plus the root .gitignore
    // exception that makes the experiment committable (no src/ changes).
    const outside = status.filter((l) => !l.includes("experiments/reproducer-v0") && !l.endsWith(".gitignore"));
    assert.deepEqual(outside, [], `only experiments/reproducer-v0 may change, found: ${outside.join("; ")}`);
    const diff = execSync("git diff --stat", { cwd: repo, encoding: "utf8" });
    assert.ok(!/packages\/|apps\/|archive\//.test(diff), "no product or archive code may change");
  });
});
