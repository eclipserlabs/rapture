// Fresh-process single-replay entry for reproducer-v1.
// Usage: node replay-single-v1.js <artifact-or-capture.json>
// Resolves adversarial scenarios, V0 scenarios (regression), and real-bug
// cases (doc.kind === "real-bug" -> ../real-bugs/<id>/case.js). Prints one JSON line.
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { getScenario } = await import(join(v0src, "scenarios.js"));
const { getAdversarialScenario } = await import(join(root, "adversarial", "scenarios.js"));
const { runCandidate } = await import(join(v0src, "capture.js"));
const { candidateFromArtifact } = await import(join(v0src, "artifact.js"));
const { deepClone } = await import(join(v0src, "canonical.js"));

function resolveScenario(id) {
  try {
    return getScenario(id);
  } catch {
    return getAdversarialScenario(id);
  }
}

async function main() {
  // Determinism control: all incident time is captured data, but formatting
  // libraries may consult the system zone. Pin UTC for every replay.
  process.env["TZ"] = "UTC";
  const file = process.argv[2];
  if (file === undefined) {
    console.log(JSON.stringify({ error: "missing file argument" }));
    process.exitCode = 2;
    return;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(JSON.stringify({ error: `unreadable file: ${err.message}` }));
    process.exitCode = 2;
    return;
  }
  const tempDir = mkdtempSync(join(tmpdir(), "reprov1-single-"));
  if (doc.kind === "real-bug-capture" || doc.kind === "real-bug-artifact") {
    await runRealBug(doc, tempDir);
    return;
  }
  const scenario = resolveScenario(doc.scenario_id);
  const isArtifact = Array.isArray(doc.required_boundary_events);
  let candidate;
  let expected;
  if (isArtifact) {
    candidate = candidateFromArtifact(doc);
    expected = doc.expected_failure_fingerprint;
  } else {
    candidate = {
      input: deepClone(doc.input),
      config: deepClone(doc.config),
      db: new Map(doc.db_rows.map((r) => [`${r.table}:${r.key}`, r.value])),
      events: deepClone(doc.boundary_events),
    };
    expected = doc.failure_fingerprint;
  }
  const result = runCandidate(scenario.run, candidate, tempDir);
  console.log(
    JSON.stringify({
      scenario_id: doc.scenario_id,
      mode: isArtifact ? "artifact" : "capture",
      fingerprint: result.fingerprint,
      expected_hash: expected.fingerprint_hash,
      match: result.fingerprint.fingerprint_hash === expected.fingerprint_hash,
      wall_ms: result.wallMs,
      live_effect_attempts: result.liveEffectAttempts,
    }),
  );
}

async function runRealBug(doc, tempDir) {
  // The doc carries only the case id + reduced data; implementation bytes are
  // vendored INSIDE the doc (impl_files), never loaded from the original
  // checkout. Materialize to the fresh temp dir and run.
  const { materializeImpl, implRequireFor } = await import(
    join(root, "real-bugs", "lib", "v1real.js")
  );
  const { runCandidate } = await import(join(v0src, "capture.js"));
  if (!/^[a-z0-9-]+$/.test(doc.case_id)) throw new Error(`bad case id: ${doc.case_id}`);
  const caseMod = await import(join(root, "real-bugs", doc.case_id, "case.js"));
  const isArtifact = doc.kind === "real-bug-artifact";
  const { deepClone: clone } = await import(join(v0src, "canonical.js"));
  const candidate = isArtifact
    ? {
        input: clone(doc.input),
        config: clone(doc.required_config),
        db: new Map(doc.required_db_rows.map((r) => [`${r.table}:${r.key}`, r.value])),
        events: clone(doc.required_boundary_events),
      }
    : {
        input: clone(doc.input),
        config: clone(doc.config),
        db: new Map(doc.db_rows.map((r) => [`${r.table}:${r.key}`, r.value])),
        events: clone(doc.boundary_events),
      };
  const implDir = join(tempDir, "impl");
  materializeImpl(doc.impl_files, implDir);
  const implRequire = implRequireFor(implDir, caseMod.IMPL_ENTRY);
  const scenario = caseMod.createScenario(implRequire);
  const outcome = runCandidate(scenario.run, candidate, tempDir);
  const expected = doc.expected_failure_fingerprint ?? doc.failure_fingerprint;
  console.log(
    JSON.stringify({
      scenario_id: doc.case_id,
      mode: isArtifact ? "artifact" : "capture",
      fingerprint: outcome.fingerprint,
      expected_hash: expected.fingerprint_hash,
      match: outcome.fingerprint.fingerprint_hash === expected.fingerprint_hash,
      wall_ms: outcome.wallMs,
      live_effect_attempts: outcome.liveEffectAttempts,
    }),
  );
}

await main();
