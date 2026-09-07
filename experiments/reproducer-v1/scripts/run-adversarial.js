// Headline adversarial run: full replay, GREEDY + DDMIN reduction, portability,
// post-hoc scoring. Requires frozen V1-MANIFEST.json.
// Ground truth enters ONLY through the manifest into score.js (post-hoc).
// The trial closures below see atoms + expected hash only.
// Usage: node run-adversarial.js
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { getAdversarialScenario } = await import(join(root, "adversarial", "scenarios.js"));
const { buildFullCapture, buildCandidate, listAtoms, runCandidate, verifyCaptureHash } = await import(
  join(v0src, "capture.js")
);
const { ddminReduce, greedyReduce } = await import(join(v0src, "reducer.js"));
const { artifactBytes, buildArtifact, verifyArtifactHash } = await import(join(v0src, "artifact.js"));
const { hashJson } = await import(join(v0src, "canonical.js"));
const { scoreKept, locallyMinimalFromTrace, wrongFailureStats } = await import(join(root, "src", "score.js"));

const REPLAYS = 20;
const REPLAY_SINGLE = join(root, "scripts", "replay-single-v1.js");

function replayFreshProcess(jsonFile) {
  const cwd = mkdtempSync(join(tmpdir(), "reprov1-port-"));
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [REPLAY_SINGLE, jsonFile], { cwd, encoding: "utf8", timeout: 30000 });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (r.status !== 0) {
    return { ok: false, match: false, wallMs, error: (r.stderr || r.stdout || "spawn failed").slice(0, 300) };
  }
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return {
      ok: true,
      match: out.match === true,
      wallMs: out.wall_ms ?? wallMs,
      liveEffects: out.live_effect_attempts ?? 0,
    };
  } catch (err) {
    return { ok: false, match: false, wallMs, error: `unparseable: ${err.message}` };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function main() {
  const manifestPath = join(root, "V1-MANIFEST.json");
  if (!existsSync(manifestPath)) {
    console.error("V1-MANIFEST.json missing: run freeze-v1.js first");
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const outDir = join(root, "results", "adversarial");
  mkdirSync(outDir, { recursive: true });
  const rows = [];

  for (const m of manifest.adversarial_cohort.scenarios) {
    console.log(`--- ${m.id} [${m.topology}] ---`);
    const scenario = getAdversarialScenario(m.id);
    const trialSink = createWriteStream(join(outDir, `trials-${m.id}.jsonl`));
    const trials = [];
    const onTrial = (t) => {
      trials.push(t);
      trialSink.write(`${JSON.stringify(t)}\n`);
    };
    const { capture } = buildFullCapture(scenario, m.code_version);
    if (capture.capture_hash !== m.capture_hash || !verifyCaptureHash(capture)) {
      console.error(`scenario ${m.id} changed since freeze`);
      process.exitCode = 1;
      return;
    }
    const captureFile = join(outDir, `capture-${m.id}.json`);
    writeFileSync(captureFile, `${JSON.stringify(capture)}\n`);

    const fullRuns = [];
    for (let i = 0; i < REPLAYS; i += 1) fullRuns.push(replayFreshProcess(captureFile));
    const fullMatch = fullRuns.filter((r) => r.ok && r.match).length;

    const atoms = listAtoms(scenario, capture);
    const allIds = atoms.map((a) => a.id);
    const scratch = mkdtempSync(join(tmpdir(), "reprov1-reduce-"));
    const expectedHash = capture.failure_fingerprint.fingerprint_hash;
    const runTrial = (keepSet) => {
      const candidate = buildCandidate(scenario, capture, keepSet);
      const r = runCandidate(scenario.run, candidate, scratch);
      return {
        pass: r.fingerprint.fingerprint_hash === expectedHash,
        fingerprintHash: r.fingerprint.fingerprint_hash,
        fingerprintKind: r.fingerprint.failure_kind,
        wallMs: r.wallMs,
      };
    };
    if (!runTrial(new Set(allIds)).pass) {
      console.error(`scenario ${m.id}: full set fails in-process`);
      process.exitCode = 1;
      return;
    }
    // Trial recorder: V0 trace fields plus fingerprint_kind (superset of the
    // frozen V0 trace format) so wrong-failure classes can be audited. The V0
    // reducer always evaluates a trial immediately before recording it, so the
    // most recent trial kind is the correct annotation.
    let lastKind = "UNKNOWN";
    const recordingTrial = (keepSet) => {
      const r = runTrial(keepSet);
      lastKind = r.fingerprintKind;
      return r;
    };
    const wrap = (reducerName) => (t) =>
      onTrial({ ...t, reducer: reducerName, fingerprint_kind: lastKind });

    const gStart = process.hrtime.bigint();
    const greedy = greedyReduce(atoms, recordingTrial, wrap("greedy"));
    const greedyMs = Number(process.hrtime.bigint() - gStart) / 1e6;
    const dStart = process.hrtime.bigint();
    const ddmin = ddminReduce(atoms, recordingTrial, wrap("ddmin"));
    const ddminMs = Number(process.hrtime.bigint() - dStart) / 1e6;
    trialSink.end();

    const buildPortable = (keptIds, tag) => {
      const candidate = buildCandidate(scenario, capture, keptIds);
      const artifact = buildArtifact({
        scenarioId: m.id,
        codeVersion: m.code_version,
        sourceCaptureHash: capture.capture_hash,
        candidate,
        expectedFingerprint: capture.failure_fingerprint,
      });
      if (!verifyArtifactHash(artifact)) throw new Error(`unverifiable artifact ${m.id}/${tag}`);
      const f = join(outDir, `artifact-${m.id}.${tag}.json`);
      writeFileSync(f, `${JSON.stringify(artifact)}\n`);
      const dir = mkdtempSync(join(tmpdir(), "reprov1-art-"));
      const pf = join(dir, "reproducer.json");
      writeFileSync(pf, readFileSync(f));
      const runs = [];
      for (let i = 0; i < REPLAYS; i += 1) runs.push(replayFreshProcess(pf));
      const text = readFileSync(f, "utf8");
      return {
        artifact,
        file: f,
        matches: runs.filter((r) => r.ok && r.match).length,
        walls: runs.map((r) => r.wallMs).sort((a, b) => a - b),
        liveEffects: runs.reduce((n, r) => n + (r.liveEffects ?? 0), 0),
        leaksTmp: text.includes(tmpdir()) || /\/var\/folders\//.test(text),
      };
    };
    const gArt = buildPortable(greedy.keptIds, "greedy");
    const dArt = buildPortable(ddmin.keptIds, "ddmin");

    const gt = { must: m.ground_truth.must, anyOf: m.ground_truth.any_of };
    const gScore = scoreKept(gt, greedy.keptIds, allIds);
    const dScore = scoreKept(gt, ddmin.keptIds, allIds);
    const gMin = locallyMinimalFromTrace(trials, [...greedy.keptIds], "greedy");
    const dMin = locallyMinimalFromTrace(trials, [...ddmin.keptIds], "ddmin");
    const gWrong = wrongFailureStats(
      trials.filter((t) => t.reducer === "greedy"),
      expectedHash,
    );
    const dWrong = wrongFailureStats(
      trials.filter((t) => t.reducer === "ddmin"),
      expectedHash,
    );

    rows.push({
      scenario_id: m.id,
      topology: m.topology,
      full_replay_matches: fullMatch,
      original_atoms: allIds.length,
      original_bytes: m.original_bytes,
      greedy_atoms: greedy.keptIds.size,
      greedy_bytes: artifactBytes(gArt.artifact),
      greedy_trials: trials.filter((t) => t.reducer === "greedy").length,
      greedy_ms: greedyMs,
      greedy_portable: gArt.matches,
      greedy_recall: gScore.recall,
      greedy_locally_minimal: gMin.locallyMinimal,
      ddmin_atoms: ddmin.keptIds.size,
      ddmin_bytes: artifactBytes(dArt.artifact),
      ddmin_reduction_ratio: (m.original_bytes - artifactBytes(dArt.artifact)) / m.original_bytes,
      ddmin_trials: trials.filter((t) => t.reducer === "ddmin").length,
      ddmin_ms: ddminMs,
      ddmin_portable: dArt.matches,
      ddmin_recall: dScore.recall,
      ddmin_missing: dScore.missingMust,
      ddmin_satisfied_core: dScore.satisfiedCore,
      ddmin_locally_minimal: dMin.locallyMinimal,
      ddmin_unproven_minimality: dMin.unproven,
      size_delta_greedy_minus_ddmin: greedy.keptIds.size - ddmin.keptIds.size,
      globally_smaller_than_greedy: ddmin.keptIds.size < greedy.keptIds.size,
      wrong_distinct_greedy: gWrong.distinctWrongFailures,
      wrong_distinct_ddmin: dWrong.distinctWrongFailures,
      wrong_accepted: gWrong.wrongAccepted + dWrong.wrongAccepted,
      live_effects: fullRuns.reduce((n, r) => n + (r.liveEffects ?? 0), 0) + gArt.liveEffects + dArt.liveEffects,
      median_replay_ms: percentile(dArt.walls, 50),
      p95_replay_ms: percentile(dArt.walls, 95),
      artifact_leaks_tmp: gArt.leaksTmp || dArt.leaksTmp,
      status:
        fullMatch === REPLAYS && dArt.matches === REPLAYS && dScore.recall === 1 ? "PASS" : "FAIL",
    });
    console.log(
      `full ${fullMatch}/${REPLAYS} greedy ${greedy.keptIds.size} ddmin ${ddmin.keptIds.size} ` +
        `port ${gArt.matches}/${dArt.matches} recall ${dScore.recall} status ${rows.at(-1).status}`,
    );
  }

  writeFileSync(join(outDir, "per-scenario.json"), `${JSON.stringify(rows, null, 2)}\n`);
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const agg = {
    scenarios: rows.length,
    pass: rows.filter((r) => r.status === "PASS").length,
    full_replay: `${sum((r) => r.full_replay_matches)}/${rows.length * REPLAYS}`,
    ddmin_portable: `${sum((r) => r.ddmin_portable)}/${rows.length * REPLAYS}`,
    greedy_portable: `${sum((r) => r.greedy_portable)}/${rows.length * REPLAYS}`,
    ddmin_smaller_count: rows.filter((r) => r.globally_smaller_than_greedy).length,
    total_greedy_trials: sum((r) => r.greedy_trials),
    total_ddmin_trials: sum((r) => r.ddmin_trials),
    total_greedy_ms: sum((r) => r.greedy_ms),
    total_ddmin_ms: sum((r) => r.ddmin_ms),
    wrong_accepted: sum((r) => r.wrong_accepted),
    live_effects: sum((r) => r.live_effects),
    min_ddmin_recall: Math.min(...rows.map((r) => r.ddmin_recall)),
  };
  writeFileSync(join(outDir, "aggregate.json"), `${JSON.stringify(agg, null, 2)}\n`);
  console.log(JSON.stringify(agg, null, 2));
}

main();
