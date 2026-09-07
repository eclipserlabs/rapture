// Artifact quality tests: self-contained load, fresh-process portability,
// live-effect guards, deterministic hashes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayContext } from "../../reproducer-v0/src/replay.js";
import { LiveEffectError } from "../../reproducer-v0/src/fingerprint.js";
import { getAdversarialScenario } from "../adversarial/scenarios.js";
import { buildFullCapture, buildCandidate, listAtoms } from "../../reproducer-v0/src/capture.js";
import { ddminReduce } from "../../reproducer-v0/src/reducer.js";
import { buildArtifact, verifyArtifactHash } from "../../reproducer-v0/src/artifact.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPLAY_SINGLE = join(root, "scripts", "replay-single-v1.js");

function replayIsolated(artifactObj) {
  const dir = mkdtempSync(join(tmpdir(), "reprov1-arttest-"));
  const f = join(dir, "reproducer.json");
  writeFileSync(f, JSON.stringify(artifactObj));
  const r = spawnSync(process.execPath, [REPLAY_SINGLE, f], { cwd: dir, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `replay crashed: ${(r.stderr || "").slice(0, 300)}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

describe("artifacts", () => {
  it("reduced artifact loads without original capture", () => {
    const artifact = JSON.parse(
      readFileSync(join(root, "results", "real-bugs", "artifact-rb-jwt-maxage.ddmin.json"), "utf8"),
    );
    const text = JSON.stringify(artifact);
    assert.ok(!text.includes("capture-"), "artifact must not reference capture files");
    assert.ok(!text.includes(tmpdir()), "artifact must not reference temp paths");
    const out = replayIsolated(artifact);
    assert.equal(out.match, true);
    assert.equal(out.live_effect_attempts, 0);
  });

  it("fresh-process portability works (adversarial + real-bug)", () => {
    for (const f of [
      join(root, "results", "adversarial", "artifact-adv-error-paths.ddmin.json"),
      join(root, "results", "real-bugs", "artifact-rb-cron-loop-limit.ddmin.json"),
    ]) {
      const out = replayIsolated(JSON.parse(readFileSync(f, "utf8")));
      assert.equal(out.match, true, `portability failed for ${f}`);
    }
  });

  it("live network attempts fail closed", () => {
    const ctx = new ReplayContext({
      mode: "replay",
      script: new Map(),
      retainedEvents: new Map(),
      config: {},
      db: new Map(),
      tempDir: mkdtempSync(join(tmpdir(), "reprov1-guard-")),
      counters: { liveEffectAttempts: 0 },
    });
    assert.throws(() => ctx.liveFetch("https://prod.example.com/x", {}), LiveEffectError);
    assert.equal(ctx.counters.liveEffectAttempts, 1);
    assert.throws(() => ctx.guardedWrite("/etc/prod.conf"), LiveEffectError);
  });

  it("artifact hashes deterministic", async () => {
    const scenario = getAdversarialScenario("adv-dupe-responses");
    const { capture } = buildFullCapture(scenario, "test");
    const atoms = listAtoms(scenario, capture);
    const scratch = mkdtempSync(join(tmpdir(), "reprov1-hashtest-"));
    const expected = capture.failure_fingerprint.fingerprint_hash;
    const { runCandidate } = await import("../../reproducer-v0/src/capture.js");
    const mk = () => {
      const runTrial = (keepSet) => {
        const r = runCandidate(scenario.run, buildCandidate(scenario, capture, keepSet), scratch);
        return {
          pass: r.fingerprint.fingerprint_hash === expected,
          fingerprintHash: r.fingerprint.fingerprint_hash,
          wallMs: r.wallMs,
        };
      };
      const ddmin = ddminReduce(atoms, runTrial, () => {});
      return buildArtifact({
        scenarioId: scenario.id,
        codeVersion: "test",
        sourceCaptureHash: capture.capture_hash,
        candidate: buildCandidate(scenario, capture, ddmin.keptIds),
        expectedFingerprint: capture.failure_fingerprint,
      });
    };
    const a1 = mk();
    const a2 = mk();
    assert.ok(verifyArtifactHash(a1));
    assert.equal(a1.artifact_hash, a2.artifact_hash);
  });
});
