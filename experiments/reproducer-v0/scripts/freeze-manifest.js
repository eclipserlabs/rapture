// Freeze scenario definitions BEFORE any reducer result is observed.
// Usage: node freeze-manifest.js
// Writes experiments/reproducer-v0/MANIFEST.json with scenario definitions,
// ground-truth causal atoms, expected fingerprints, and full-capture hashes.
// Integrity rule: scenarios.js must not change after this manifest is written.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { listScenarios, getScenario } = await import(join(root, "src", "scenarios.js"));
const { buildFullCapture, listAtoms } = await import(join(root, "src", "capture.js"));
const { canonicalBytes, hashJson } = await import(join(root, "src", "canonical.js"));

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: join(root, "..", ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const codeVersion = gitHead();
  const scenarios = [];
  for (const { id, title, description } of listScenarios()) {
    const scenario = getScenario(id);
    const { capture } = buildFullCapture(scenario, codeVersion);
    const atoms = listAtoms(scenario, capture);
    const causal = scenario.causalAtoms();
    scenarios.push({
      id,
      title,
      description,
      code_version: codeVersion,
      expected_failure_fingerprint: capture.failure_fingerprint,
      capture_hash: capture.capture_hash,
      original_atom_count: atoms.length,
      original_event_count: capture.boundary_events.length,
      original_db_row_count: capture.db_rows.length,
      original_config_key_count: Object.keys(capture.config).length,
      removable_input_field_count: scenario.removableInputFields().length,
      original_bytes: canonicalBytes(capture),
      causal_atoms: {
        events: causal.events,
        db: causal.db,
        config: causal.config,
        input: causal.input,
        total: causal.events.length + causal.db.length + causal.config.length + causal.input.length,
      },
    });
  }
  const manifest = {
    experiment: "reproducer-v0",
    frozen_at: new Date().toISOString(),
    code_version: codeVersion,
    note: "Scenario definitions frozen before reducer execution. causal_atoms are ground truth for scoring only.",
    scenarios,
  };
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const hash = hashJson(manifest);
  writeFileSync(join(root, "results", "manifest.hash"), `${hash}\n`);
  console.log(`froze ${scenarios.length} scenarios, manifest hash ${hash}`);
}

main();
