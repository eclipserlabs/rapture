// Phase 5: reduce SUPPORTED real-bug captures (buggy revision ONLY).
// This script sees buggy-revision data only (captures + impl/buggy trees).
// A test asserts it contains no repaired-revision references of any form.
// Usage: node run-reduce-realbugs.js [case_id...]
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { buildCandidate, listAtoms, runCandidate } = await import(join(v0src, "capture.js"));
void buildCandidate;
void listAtoms;
const { ddminReduce, greedyReduce } = await import(join(v0src, "reducer.js"));
const { canonicalBytes, deepClone, hashJson } = await import(join(v0src, "canonical.js"));
const { locallyMinimalFromTrace, wrongFailureStats } = await import(join(root, "src", "score.js"));
const { implRequireFor } = await import(join(root, "real-bugs", "lib", "v1real.js"));

const REPLAYS = 20;
const REPLAY_SINGLE = join(root, "scripts", "replay-single-v1.js");

function replayFresh(jsonFile) {
  const cwd = mkdtempSync(join(tmpdir(), "reprov1-rbport-"));
  const r = spawnSync(process.execPath, [REPLAY_SINGLE, jsonFile], { cwd, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return { ok: false, match: false };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, match: out.match === true, wallMs: out.wall_ms ?? 0, live: out.live_effect_attempts ?? 0 };
  } catch {
    return { ok: false, match: false };
  }
}

function stateBytesOf(doc) {
  return canonicalBytes({
    input: doc.input,
    boundary_events: doc.required_boundary_events,
    db_rows: doc.required_db_rows,
    config: doc.required_config,
    failure_fingerprint: doc.expected_failure_fingerprint,
  });
}

function buildRealArtifact({ caseId, bugRev, sourceCaptureHash, candidate, expectedFp, implFiles, implEntry }) {
  const dbRows = [...candidate.db.entries()].map(([k, v]) => {
    const sep = k.indexOf(":");
    return { table: k.slice(0, sep), key: k.slice(sep + 1), value: deepClone(v) };
  });
  const artifact = {
    schema_version: 1,
    kind: "real-bug-artifact",
    scenario_id: caseId,
    case_id: caseId,
    code_version: bugRev,
    source_capture_hash: sourceCaptureHash,
    input: deepClone(candidate.input),
    required_boundary_events: deepClone(candidate.events),
    required_db_rows: dbRows,
    required_config: deepClone(candidate.config),
    expected_failure_fingerprint: deepClone(expectedFp),
    impl_entry: implEntry,
    impl_files: deepClone(implFiles),
  };
  artifact.state_bytes = stateBytesOf(artifact);
  const { artifact_hash, ...rest } = artifact;
  void artifact_hash;
  artifact.artifact_hash = hashJson(rest);
  return artifact;
}

async function main() {
  process.env["TZ"] = "UTC"; // determinism control, see replay-single-v1.js
  const only = process.argv.slice(2);
  const outDir = join(root, "results", "real-bugs");
  mkdirSync(outDir, { recursive: true });
  const construction = JSON.parse(readFileSync(join(outDir, "construction.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(join(root, "real-bugs", "bug-corpus.json"), "utf8"));
  const rows = [];
  for (const c of construction) {
    if (only.length > 0 && !only.includes(c.case_id)) continue;
    if (c.status !== "SUPPORTED") {
      rows.push({ case_id: c.case_id, status: c.status });
      continue;
    }
    console.log(`--- ${c.case_id} ---`);
    const entry = corpus.cases.find((e) => e.case_id === c.case_id);
    const caseMod = await import(join(root, "real-bugs", c.case_id, "case.js"));
    const scenario = caseMod.createScenario(
      implRequireFor(join(root, "real-bugs", c.case_id, "impl", "buggy"), caseMod.IMPL_ENTRY),
    );
    const doc = JSON.parse(readFileSync(join(outDir, `capture-${c.case_id}.json`), "utf8"));
    const atoms = v0ListAtoms(caseMod, scenario, doc);
    const fullAtoms = atoms;
    const allIds = new Set(fullAtoms.map((a) => a.id));
    const scratch = mkdtempSync(join(tmpdir(), "reprov1-rbreduce-"));
    const expectedHash = doc.failure_fingerprint.fingerprint_hash;
    const trialSink = createWriteStream(join(outDir, `trials-${c.case_id}.jsonl`));
    const trials = [];
    let lastKind = "UNKNOWN";
    const runTrial = (keepSet) => {
      const candidate = v0BuildCandidate(caseMod, scenario, doc, keepSet);
      const r = runCandidate(scenario.run, candidate, scratch);
      lastKind = r.fingerprint.failure_kind;
      return {
        pass: r.fingerprint.fingerprint_hash === expectedHash,
        fingerprintHash: r.fingerprint.fingerprint_hash,
        wallMs: r.wallMs,
      };
    };
    const wrap = (name) => (t) => {
      const rec = { ...t, reducer: name, fingerprint_kind: lastKind };
      trials.push(rec);
      trialSink.write(`${JSON.stringify(rec)}\n`);
    };
    if (!runTrial(allIds).pass) throw new Error(`full set fails in-process for ${c.case_id}`);
    const gStart = process.hrtime.bigint();
    const greedy = greedyReduce(fullAtoms, runTrial, wrap("greedy"));
    const greedyMs = Number(process.hrtime.bigint() - gStart) / 1e6;
    const dStart = process.hrtime.bigint();
    const ddmin = ddminReduce(fullAtoms, runTrial, wrap("ddmin"));
    const ddminMs = Number(process.hrtime.bigint() - dStart) / 1e6;
    trialSink.end();

    const mkArtifact = (keptIds, tag) => {
      const candidate = v0BuildCandidate(caseMod, scenario, doc, keptIds);
      const artifact = buildRealArtifact({
        caseId: c.case_id,
        bugRev: entry.bug_rev,
        sourceCaptureHash: doc.capture_hash,
        candidate,
        expectedFp: doc.failure_fingerprint,
        implFiles: doc.impl_files,
        implEntry: doc.impl_entry,
      });
      const f = join(outDir, `artifact-${c.case_id}.${tag}.json`);
      writeFileSync(f, `${JSON.stringify(artifact)}\n`);
      const dir = mkdtempSync(join(tmpdir(), "reprov1-rbart-"));
      const pf = join(dir, "reproducer.json");
      writeFileSync(pf, readFileSync(f));
      const runs = [];
      for (let i = 0; i < REPLAYS; i += 1) runs.push(replayFresh(pf));
      return { artifact, matches: runs.filter((r) => r.ok && r.match).length };
    };
    const gArt = mkArtifact(greedy.keptIds, "greedy");
    const dArt = mkArtifact(ddmin.keptIds, "ddmin");
    const gMin = locallyMinimalFromTrace(trials, [...greedy.keptIds], "greedy");
    const dMin = locallyMinimalFromTrace(trials, [...ddmin.keptIds], "ddmin");
    const wrong = wrongFailureStats(trials, expectedHash);
    rows.push({
      case_id: c.case_id,
      status: dArt.matches === REPLAYS ? "REDUCED_PORTABLE" : "REDUCTION_FAILED",
      original_atoms: allIds.size,
      original_state_bytes: doc.state_bytes,
      greedy_atoms: greedy.keptIds.size,
      greedy_state_bytes: gArt.artifact.state_bytes,
      greedy_trials: trials.filter((t) => t.reducer === "greedy").length,
      greedy_ms: greedyMs,
      greedy_portable: gArt.matches,
      greedy_locally_minimal: gMin.locallyMinimal,
      ddmin_atoms: ddmin.keptIds.size,
      ddmin_state_bytes: dArt.artifact.state_bytes,
      atom_reduction_ratio: (allIds.size - ddmin.keptIds.size) / allIds.size,
      byte_reduction_ratio: (doc.state_bytes - dArt.artifact.state_bytes) / doc.state_bytes,
      ddmin_trials: trials.filter((t) => t.reducer === "ddmin").length,
      ddmin_ms: ddminMs,
      ddmin_portable: dArt.matches,
      ddmin_locally_minimal: dMin.locallyMinimal,
      size_delta_greedy_minus_ddmin: greedy.keptIds.size - ddmin.keptIds.size,
      wrong_distinct: wrong.distinctWrongFailures,
      wrong_accepted: wrong.wrongAccepted,
      total_artifact_bytes: Buffer.byteLength(JSON.stringify(dArt.artifact), "utf8"),
    });
    console.log(
      `atoms ${allIds.size}->${ddmin.keptIds.size} bytes ${doc.state_bytes}->${dArt.artifact.state_bytes} ` +
        `port ${dArt.matches}/${REPLAYS} status ${rows.at(-1).status}`,
    );
  }
  // Merge with previous reduction rows so filtered re-runs do not drop cases.
  let prev = [];
  try {
    prev = JSON.parse(readFileSync(join(outDir, "reduction.json"), "utf8"));
  } catch {
    prev = [];
  }
  const merged = new Map(prev.map((r) => [r.case_id, r]));
  for (const r of rows) merged.set(r.case_id, r);
  const ordered = corpus.cases.map((e) => merged.get(e.case_id)).filter(Boolean);
  writeFileSync(join(outDir, "reduction.json"), `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(JSON.stringify(ordered, null, 2));
}

// Local shims reusing V0 capture logic against doc-shaped captures.
import { eventKey } from "../../reproducer-v0/src/replay.js";
import { deletePath, deepClone as cloneInput } from "../../reproducer-v0/src/canonical.js";

function v0ListAtoms(caseMod, scenario, doc) {
  void caseMod;
  const atoms = [];
  for (const e of doc.boundary_events) {
    atoms.push({ id: `evt:${eventKey(e.kind, e.operation, e.request_or_key)}`, class: "event" });
  }
  for (const r of doc.db_rows) atoms.push({ id: `db:${r.table}:${r.key}`, class: "db" });
  for (const k of Object.keys(doc.config).sort()) atoms.push({ id: `cfg:${k}`, class: "config" });
  for (const p of scenario.removableInputFields()) atoms.push({ id: `in:${p}`, class: "input" });
  return atoms;
}

function v0BuildCandidate(caseMod, scenario, doc, keepSet) {
  void caseMod;
  const events = doc.boundary_events.filter((e) =>
    keepSet.has(`evt:${eventKey(e.kind, e.operation, e.request_or_key)}`),
  );
  const db = new Map();
  for (const r of doc.db_rows) {
    if (keepSet.has(`db:${r.table}:${r.key}`)) db.set(`${r.table}:${r.key}`, r.value);
  }
  const config = {};
  for (const k of Object.keys(doc.config)) {
    if (keepSet.has(`cfg:${k}`)) config[k] = doc.config[k];
  }
  const input = cloneInput(doc.input);
  for (const p of scenario.removableInputFields()) {
    if (!keepSet.has(`in:${p}`)) deletePath(input, p);
  }
  return { input, config, db, events };
}

await main();
