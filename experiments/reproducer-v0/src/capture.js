// Full-capture construction for reproducer-v0.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepClone, deletePath, hashJson } from "./canonical.js";
import { fingerprintOfOutcome } from "./fingerprint.js";
import { ReplayContext, eventKey, runWithContext } from "./replay.js";

/**
 * Execute the scenario once in record mode and assemble the complete
 * IncidentCapture. Throws if the scenario does not fail with its expected
 * fingerprint (an invalid scenario, not a reducer result).
 */
export function buildFullCapture(scenario, codeVersion) {
  const input = scenario.fullInput();
  const config = scenario.fullConfig();
  const dbRows = scenario.fullDbRows();
  const script = scenario.script();

  const db = new Map(dbRows.map((r) => [`${r.table}:${r.key}`, r.value]));
  const tempDir = mkdtempSync(join(tmpdir(), "repro-capture-"));
  const counters = { liveEffectAttempts: 0 };
  const recordedEvents = [];
  const ctx = new ReplayContext({
    mode: "record",
    script,
    retainedEvents: new Map(),
    config: { ...config },
    db,
    tempDir,
    counters,
    recordedEvents,
  });

  const outcome = runWithContext(ctx, deepClone(input), scenario.run);
  const fingerprint = fingerprintOfOutcome(outcome);

  const expectedFour = scenario.expectedFingerprint();
  const expectedFull = { ...expectedFour, fingerprint_hash: hashJson(expectedFour) };
  if (fingerprint.fingerprint_hash !== expectedFull.fingerprint_hash) {
    throw new Error(
      `scenario ${scenario.id} is invalid: full capture reproduces ` +
        `${fingerprint.fingerprint_hash} but expected ${expectedFull.fingerprint_hash}`,
    );
  }

  const boundaryEvents = [
    ...recordedEvents,
    ...scenario.ambientEvents().map((e, i) => ({ sequence: recordedEvents.length + i, ...e })),
  ];

  const capture = {
    schema_version: 1,
    scenario_id: scenario.id,
    code_version: codeVersion,
    input: deepClone(input),
    boundary_events: boundaryEvents,
    db_rows: deepClone(dbRows),
    config: deepClone(config),
    failure_fingerprint: expectedFull,
  };
  capture.capture_hash = hashJson(stripHash(capture));
  return { capture, tempDir, counters };
}

/**
 * Execute one candidate subset in-process. The predicate is exact fingerprint
 * equality; every other outcome (different failure, crash, missing mock,
 * live-effect refusal, success) is a rejection decided by the caller.
 */
export function runCandidate(scenarioRun, candidate, tempDir) {
  const retainedEvents = new Map(
    candidate.events.map((e) => [eventKey(e.kind, e.operation, e.request_or_key), e]),
  );
  const counters = { liveEffectAttempts: 0 };
  const ctx = new ReplayContext({
    mode: "replay",
    script: new Map(),
    retainedEvents,
    config: candidate.config,
    db: candidate.db,
    tempDir,
    counters,
  });
  const outcome = runWithContext(ctx, deepClone(candidate.input), scenarioRun);
  return {
    fingerprint: fingerprintOfOutcome(outcome),
    wallMs: outcome.wallMs,
    liveEffectAttempts: counters.liveEffectAttempts,
  };
}
function stripHash(capture) {
  const { capture_hash, ...rest } = capture;
  return rest;
}

export function verifyCaptureHash(capture) {
  return hashJson(stripHash(capture)) === capture.capture_hash;
}

/** All removable atoms in a deterministic order: events, db, config, input. */
export function listAtoms(scenario, capture) {
  const atoms = [];
  for (const e of capture.boundary_events) {
    atoms.push({ id: `evt:${eventKey(e.kind, e.operation, e.request_or_key)}`, class: "event", ref: e.sequence });
  }
  for (const r of capture.db_rows) {
    atoms.push({ id: `db:${r.table}:${r.key}`, class: "db", ref: `${r.table}:${r.key}` });
  }
  for (const k of Object.keys(capture.config).sort()) {
    atoms.push({ id: `cfg:${k}`, class: "config", ref: k });
  }
  for (const p of scenario.removableInputFields()) {
    atoms.push({ id: `in:${p}`, class: "input", ref: p });
  }
  return atoms;
}

/**
 * Materialize a candidate capture subset from the full capture + kept atom ids.
 * Order of retained events follows the original sequence.
 */
export function buildCandidate(scenario, capture, keepSet) {
  const events = capture.boundary_events.filter((e) =>
    keepSet.has(`evt:${eventKey(e.kind, e.operation, e.request_or_key)}`),
  );
  const dbKeys = new Set(
    capture.db_rows.filter((r) => keepSet.has(`db:${r.table}:${r.key}`)).map((r) => `${r.table}:${r.key}`),
  );
  const db = new Map();
  for (const r of capture.db_rows) {
    if (dbKeys.has(`${r.table}:${r.key}`)) db.set(`${r.table}:${r.key}`, r.value);
  }
  const config = {};
  for (const k of Object.keys(capture.config)) {
    if (keepSet.has(`cfg:${k}`)) config[k] = capture.config[k];
  }
  const input = deepClone(capture.input);
  for (const p of scenario.removableInputFields()) {
    if (!keepSet.has(`in:${p}`)) deletePath(input, p);
  }
  return { input, config, db, events };
}
