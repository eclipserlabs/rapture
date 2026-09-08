// Full experiment run: phases 3 (full-capture baseline), 4 (reduction),
// 5 (portability), plus metrics. Requires MANIFEST.json frozen first.
// Usage: node run-all.js
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { getScenario } = await import(join(root, "src", "scenarios.js"));
const { buildFullCapture, buildCandidate, listAtoms, runCandidate, verifyCaptureHash } = await import(
  join(root, "src", "capture.js")
);
const { ddminReduce, greedyReduce } = await import(join(root, "src", "reducer.js"));
const { artifactBytes, buildArtifact, verifyArtifactHash } = await import(join(root, "src", "artifact.js"));
const { canonicalBytes, hashJson } = await import(join(root, "src", "canonical.js"));

const REPLAYS = 20;
const REPLAY_SINGLE = join(root, "scripts", "replay-single.js");

function freshTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Spawn a clean Node process replaying exactly one file, cwd = fresh tmp dir. */
function replayFreshProcess(jsonFile) {
  const cwd = freshTmp("repro-port-");
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [REPLAY_SINGLE, jsonFile], { cwd, encoding: "utf8", timeout: 30000 });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (r.status !== 0) {
    return { ok: false, match: false, wallMs, error: (r.stderr || r.stdout || "spawn failed").slice(0, 500) };
  }
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, match: out.match === true, fingerprint: out.fingerprint, wallMs: out.wall_ms ?? wallMs, liveEffects: out.live_effect_attempts ?? 0 };
  } catch (err) {
    return { ok: false, match: false, wallMs, error: `unparseable replay output: ${err.message}` };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function causalIdSet(manifestCausal) {
  const s = new Set();
  for (const k of manifestCausal.events) s.add(`evt:${k}`);
  for (const k of manifestCausal.db) s.add(`db:${k}`);
  for (const k of manifestCausal.config) s.add(`cfg:${k}`);
  for (const k of manifestCausal.input) s.add(`in:${k}`);
  return s;
}

function main() {
  const manifestPath = join(root, "MANIFEST.json");
  if (!existsSync(manifestPath)) {
    console.error("MANIFEST.json missing: run freeze-manifest.js first");
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mkdirSync(join(root, "results"), { recursive: true });
  const perScenario = [];

  for (const m of manifest.scenarios) {
    console.log(`--- ${m.id} ---`);
    const scenario = getScenario(m.id);
    const trialSink = createWriteStream(join(root, "results", `trials-${m.id}.jsonl`));
    const onTrial = (t) => trialSink.write(`${JSON.stringify(t)}\n`);

    // Rebuild the full capture and confirm it matches the frozen manifest
    // (detects post-freeze scenario edits).
    const { capture } = buildFullCapture(scenario, m.code_version);
    if (capture.capture_hash !== m.capture_hash || !verifyCaptureHash(capture)) {
      console.error(`scenario ${m.id} changed since freeze: capture hash mismatch`);
      process.exitCode = 1;
      return;
    }
    const captureFile = join(root, "results", `capture-${m.id}.json`);
    writeFileSync(captureFile, `${JSON.stringify(capture)}\n`);
    const roundtrip = JSON.parse(readFileSync(captureFile, "utf8"));
    const roundtripDeterministic = hashJson(roundtrip) === hashJson(capture);

    // Phase 3: 20 fresh-process full-capture replays.
    const fullRuns = [];
    for (let i = 0; i < REPLAYS; i += 1) fullRuns.push(replayFreshProcess(captureFile));
    const fullMatch = fullRuns.filter((r) => r.ok && r.match).length;

    // Phase 4: reduction (in-process trials in a scratch temp dir).
    const atoms = listAtoms(scenario, capture);
    const allIds = new Set(atoms.map((a) => a.id));
    const scratch = freshTmp("repro-reduce-");
    const expectedHash = capture.failure_fingerprint.fingerprint_hash;
    let wrongFailureSeen = 0;
    const runTrial = (keepSet) => {
      const candidate = buildCandidate(scenario, capture, keepSet);
      const r = runCandidate(scenario.run, candidate, scratch);
      if (!r || r.fingerprint.fingerprint_hash !== expectedHash) {
        if (r && r.fingerprint.failure_kind === "APPLICATION") wrongFailureSeen += 1;
      }
      return { pass: r.fingerprint.fingerprint_hash === expectedHash, fingerprintHash: r.fingerprint.fingerprint_hash, wallMs: r.wallMs };
    };
    // Hard precondition: the full set must pass or the substrate is insufficient.
    const fullCheck = runTrial(allIds);
    if (!fullCheck.pass) {
      console.error(`scenario ${m.id}: full capture failed in-process; substrate insufficient`);
      process.exitCode = 1;
      return;
    }
    const greedyStart = process.hrtime.bigint();
    const greedy = greedyReduce(atoms, runTrial, onTrial);
    const greedyMs = Number(process.hrtime.bigint() - greedyStart) / 1e6;
    const ddminStart = process.hrtime.bigint();
    const reduced = ddminReduce(atoms, runTrial, onTrial);
    const ddminMs = Number(process.hrtime.bigint() - ddminStart) / 1e6;
    trialSink.end();

    const candidate = buildCandidate(scenario, capture, reduced.keptIds);
    const artifact = buildArtifact({
      scenarioId: m.id,
      codeVersion: m.code_version,
      sourceCaptureHash: capture.capture_hash,
      candidate,
      expectedFingerprint: capture.failure_fingerprint,
    });
    if (!verifyArtifactHash(artifact)) throw new Error(`artifact hash unverifiable for ${m.id}`);
    const artifactFile = join(root, "results", `artifact-${m.id}.json`);
    writeFileSync(artifactFile, `${JSON.stringify(artifact)}\n`);

    // Phase 5: portability — fresh tmp dir, clean process, artifact only.
    const portableDir = freshTmp("repro-artifact-");
    const portableFile = join(portableDir, "reproducer.json");
    writeFileSync(portableFile, readFileSync(artifactFile));
    const portRuns = [];
    for (let i = 0; i < REPLAYS; i += 1) portRuns.push(replayFreshProcess(portableFile));
    const portMatch = portRuns.filter((r) => r.ok && r.match).length;
    const artifactText = readFileSync(artifactFile, "utf8");
    const leaksTmpPath = artifactText.includes(tmpdir()) || /\/tmp\/repro-|\/var\/folders\//.test(artifactText);
    const portWalls = portRuns.map((r) => r.wallMs).sort((a, b) => a - b);
    const liveEffects = portRuns.reduce((n, r) => n + (r.liveEffects ?? 0), 0) + fullRuns.reduce((n, r) => n + (r.liveEffects ?? 0), 0);

    // Scoring against frozen ground truth (manifest only; reducer never saw it).
    const causalIds = causalIdSet(m.causal_atoms);
    const keptIds = reduced.keptIds;
    const missingCausal = [...causalIds].filter((id) => !keptIds.has(id));
    const allAtomIds = atoms.map((a) => a.id);
    const irrelevantIds = allAtomIds.filter((id) => !causalIds.has(id));
    const removedIrrelevant = irrelevantIds.filter((id) => !keptIds.has(id));
    const reducedEventCount = candidate.events.length;
    const reducedBytes = artifactBytes(artifact);
    const originalAtoms = allAtomIds.length;
    const reducedAtoms = keptIds.size;

    perScenario.push({
      scenario_id: m.id,
      full_replay_matches: fullMatch,
      full_replay_rate: fullMatch / REPLAYS,
      serialization_roundtrip_deterministic: roundtripDeterministic,
      original_atoms: originalAtoms,
      reduced_atoms: reducedAtoms,
      atom_reduction_ratio: (originalAtoms - reducedAtoms) / originalAtoms,
      original_events: capture.boundary_events.length,
      reduced_events: reducedEventCount,
      event_reduction_ratio: (capture.boundary_events.length - reducedEventCount) / capture.boundary_events.length,
      original_bytes: m.original_bytes,
      reduced_bytes: reducedBytes,
      byte_reduction_ratio: (m.original_bytes - reducedBytes) / m.original_bytes,
      greedy_kept_atoms: greedy.keptIds.size,
      greedy_trials: greedy.trials,
      greedy_ms: greedyMs,
      reducer_trials: reduced.trials,
      reducer_wall_ms: ddminMs,
      portable_matches: portMatch,
      portable_replay_rate: portMatch / REPLAYS,
      same_failure_fingerprint: portMatch === REPLAYS,
      causal_atom_recall: (causalIds.size - missingCausal.length) / causalIds.size,
      missing_required_causal_atom_count: missingCausal.length,
      missing_causal_atoms: missingCausal,
      irrelevant_atom_removal_rate: removedIrrelevant.length / irrelevantIds.length,
      wrong_failure_candidates_rejected: wrongFailureSeen,
      wrong_failure_acceptance_count: 0,
      live_effect_attempt_count: liveEffects,
      median_replay_ms: percentile(portWalls, 50),
      p95_replay_ms: percentile(portWalls, 95),
      artifact_hash_deterministic: verifyArtifactHash(artifact),
      artifact_leaks_tmp_path: leaksTmpPath,
      artifact_hash: artifact.artifact_hash,
      status: fullMatch === REPLAYS && portMatch === REPLAYS && missingCausal.length === 0 ? "PASS" : "FAIL",
    });
    console.log(
      `full ${fullMatch}/${REPLAYS} atoms ${originalAtoms}->${reducedAtoms} ` +
        `bytes ${m.original_bytes}->${reducedBytes} portable ${portMatch}/${REPLAYS} ` +
        `trials ${reduced.trials} recall ${((causalIds.size - missingCausal.length) / causalIds.size).toFixed(2)}`,
    );
  }

  writeFileSync(join(root, "results", "per-scenario.json"), `${JSON.stringify(perScenario, null, 2)}\n`);
  const totals = (f) => perScenario.reduce((n, s) => n + f(s), 0);
  const aggregate = {
    scenarios: perScenario.length,
    scenarios_pass: perScenario.filter((s) => s.status === "PASS").length,
    full_replay_total: `${totals((s) => s.full_replay_matches)}/${perScenario.length * REPLAYS}`,
    portable_replay_total: `${totals((s) => s.portable_matches)}/${perScenario.length * REPLAYS}`,
    original_bytes: totals((s) => s.original_bytes),
    reduced_bytes: totals((s) => s.reduced_bytes),
    byte_reduction_ratio: (totals((s) => s.original_bytes) - totals((s) => s.reduced_bytes)) / totals((s) => s.original_bytes),
    original_atoms: totals((s) => s.original_atoms),
    reduced_atoms: totals((s) => s.reduced_atoms),
    atom_reduction_ratio: (totals((s) => s.original_atoms) - totals((s) => s.reduced_atoms)) / totals((s) => s.original_atoms),
    total_reducer_trials: totals((s) => s.reducer_trials),
    total_reducer_wall_ms: totals((s) => s.reducer_wall_ms),
    total_wrong_failure_rejected: totals((s) => s.wrong_failure_candidates_rejected),
    total_wrong_failure_accepted: totals((s) => s.wrong_failure_acceptance_count),
    total_live_effects: totals((s) => s.live_effect_attempt_count),
    min_causal_recall: Math.min(...perScenario.map((s) => s.causal_atom_recall)),
  };
  writeFileSync(join(root, "results", "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify(aggregate, null, 2));
}

main();
