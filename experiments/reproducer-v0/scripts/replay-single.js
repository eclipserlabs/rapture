// Fresh-process replay entry for reproducer-v0 portability runs.
// Usage: node replay-single.js <artifact-or-capture.json>
// Loads ONLY the given file (never the original capture when given an
// artifact), replays once with no network/credentials, prints one JSON line.
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { getScenario } = await import(join(here, "..", "src", "scenarios.js"));
const { runCandidate } = await import(join(here, "..", "src", "capture.js"));
const { candidateFromArtifact } = await import(join(here, "..", "src", "artifact.js"));
const { deepClone } = await import(join(here, "..", "src", "canonical.js"));

function main() {
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
  const isArtifact = Array.isArray(doc.required_boundary_events);
  const scenario = getScenario(doc.scenario_id);
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
  const tempDir = mkdtempSync(join(tmpdir(), "repro-single-"));
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

main();
