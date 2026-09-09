// Shared capture runtime state (experiment-only, not a product).
// Imported by register.mjs, all patches, persist, and tests.
import { AsyncLocalStorage } from "node:async_hooks";

export const MODES = {
  OFF: "off",
  CAPTURE: "capture",
  REPLAY: "replay",
  // V3 perf-ladder modes (pre-headline generic work; see REPORT).
  // context-only: ALS request context only, no boundary interception.
  CONTEXT_ONLY: "context-only",
  // intercept-discard: full interception, events counted but never retained.
  INTERCEPT_DISCARD: "intercept-discard",
};

export const state = {
  mode: process.env["RAPTURE_V2_MODE"] ?? MODES.OFF,
  outDir: process.env["RAPTURE_V2_OUT"] ?? null,
  captureFile: process.env["RAPTURE_V2_CAPTURE_FILE"] ?? null,
  configAllowlist: (process.env["CAPTURE_CONFIG"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  als: new AsyncLocalStorage(),
  reqCounter: 0,
  installed: false,
  // Housekeeping guard: capture machinery itself (persistence, ids) must
  // never record boundary observations into the incident it is writing.
  suspended: false,
  // intercept-discard: wrappers execute but recordEvent only counts.
  noRetain: false,
  // Replay-only: parsed capture + per-kind consumption cursors.
  replayDoc: null,
  replayQueues: null,
  stats: { requestsSeen: 0, requestsPersisted: 0, bytesRecorded: 0, eventsRecorded: 0 },
};

export function currentRequest() {
  return state.als.getStore() ?? null;
}

/** Monotonic request-local sequence number for a boundary observation. */
export function nextSeq(rec) {
  rec.seq += 1;
  return rec.seq;
}

export function newRequestRecord(reqId, reqSummary) {
  return {
    reqId,
    seq: 0,
    request: reqSummary,
    events: [],
    config: snapshotConfig(),
    appError: null,
    bytesRecorded: 0,
  };
}

export function snapshotConfig() {
  const out = {};
  for (const name of state.configAllowlist) {
    out[name] = process.env[name] ?? null;
  }
  return out;
}
