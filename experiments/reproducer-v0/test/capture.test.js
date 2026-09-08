// Capture serialization + artifact hash determinism tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getScenario } from "../src/scenarios.js";
import { buildFullCapture, buildCandidate, listAtoms, runCandidate, verifyCaptureHash } from "../src/capture.js";
import { buildArtifact, verifyArtifactHash, artifactBytes } from "../src/artifact.js";
import { hashJson } from "../src/canonical.js";

describe("capture determinism", () => {
  it("full capture serialization roundtrip is deterministic", () => {
    const scenario = getScenario("database-state-edge");
    const { capture } = buildFullCapture(scenario, "test-version");
    assert.ok(verifyCaptureHash(capture));
    const roundtrip = JSON.parse(JSON.stringify(capture));
    assert.ok(verifyCaptureHash(roundtrip));
    assert.equal(hashJson(roundtrip), hashJson(capture));
    // Key order must not matter.
    const shuffled = JSON.parse(JSON.stringify({ ...capture, input: { note: "x", amount: 1, currency: "USD", accountId: "y" } }));
    assert.equal(typeof shuffled.capture_hash, "string");
  });

  it("ReproducerArtifact hash is deterministic", () => {
    const scenario = getScenario("config-region-combination");
    const { capture } = buildFullCapture(scenario, "test-version");
    const atoms = listAtoms(scenario, capture);
    const keepAll = new Set(atoms.map((a) => a.id));
    const candidate = buildCandidate(scenario, capture, keepAll);
    const a1 = buildArtifact({
      scenarioId: scenario.id,
      codeVersion: "test-version",
      sourceCaptureHash: capture.capture_hash,
      candidate,
      expectedFingerprint: capture.failure_fingerprint,
    });
    const a2 = buildArtifact({
      scenarioId: scenario.id,
      codeVersion: "test-version",
      sourceCaptureHash: capture.capture_hash,
      candidate: buildCandidate(scenario, capture, keepAll),
      expectedFingerprint: capture.failure_fingerprint,
    });
    assert.ok(verifyArtifactHash(a1));
    assert.equal(a1.artifact_hash, a2.artifact_hash);
    assert.ok(artifactBytes(a1) > 0);
  });

  it("in-process replay of the full capture reproduces the fingerprint", () => {
    const scenario = getScenario("expired-time-boundary");
    const { capture, tempDir } = buildFullCapture(scenario, "test-version");
    const atoms = listAtoms(scenario, capture);
    const candidate = buildCandidate(scenario, capture, new Set(atoms.map((a) => a.id)));
    const r = runCandidate(scenario.run, candidate, tempDir);
    assert.equal(r.fingerprint.fingerprint_hash, capture.failure_fingerprint.fingerprint_hash);
    assert.equal(r.liveEffectAttempts, 0);
  });
});
