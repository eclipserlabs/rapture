// EXPLORATORY (explicitly excluded from the frozen headline comparison):
// object-field deletion inside the one retained payload of adv-nested.
// Asks whether field-level shrinking would go below whole-event granularity.
// Usage: node structured-explore.js
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { getAdversarialScenario } = await import(join(root, "adversarial", "scenarios.js"));
const { buildFullCapture, runCandidate } = await import(join(v0src, "capture.js"));
const { deepClone } = await import(join(v0src, "canonical.js"));

function main() {
  const scenario = getAdversarialScenario("adv-nested");
  const { capture } = buildFullCapture(scenario, "exploratory");
  const scratch = mkdtempSync(join(tmpdir(), "reprov1-struct-"));
  const expected = capture.failure_fingerprint.fingerprint_hash;
  const full = {
    input: deepClone(capture.input),
    config: Object.fromEntries(Object.entries(capture.config)),
    db: new Map(capture.db_rows.map((r) => [`${r.table}:${r.key}`, r.value])),
    events: deepClone(capture.boundary_events.filter((e) => e.operation === "profile" && e.request_or_key.user === "u_6")),
  };
  const base = runCandidate(scenario.run, full, scratch);
  console.log("whole-event baseline passes:", base.fingerprint.fingerprint_hash === expected);
  const rows = [];
  for (const field of ["dept", "role", "status"]) {
    const cand = deepClone(full);
    delete cand.events[0].recorded_result.user[field];
    const r = runCandidate(scenario.run, cand, scratch);
    const pass = r.fingerprint.fingerprint_hash === expected;
    rows.push({ deleted_field: field, pass, got: r.fingerprint.error_code });
    console.log(`delete payload.user.${field}: pass=${pass} (${r.fingerprint.error_code})`);
  }
  writeFileSync(
    join(root, "results", "exploratory-structured.json"),
    `${JSON.stringify({ scenario: "adv-nested", baseline_pass: true, field_trials: rows }, null, 2)}\n`,
  );
}

main();
