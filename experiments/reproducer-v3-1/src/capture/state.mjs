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

  // --- V3.1 selective capture ---
  // Ingress selector (null in V3 legacy modes, where every request is
  // selected exactly as frozen V3 did).
  selector: null,
  // Selected requests currently in flight. ALS may only be quiesced at zero.
  inFlightSelected: 0,
  // When true, AsyncLocalStorage is disabled whenever no selected request is
  // in flight and no key is armed, so the process-wide async_hooks tax is not
  // paid during ordinary unarmed traffic.
  alsQuiesce: true,
  // Default true: V3 legacy modes must behave exactly as frozen V3. Only the
  // V3.1 bootstrap clears it, and only when a selector is installed.
  alsEnabled: true,
  quiesceTimer: null,

  // --- V3.1 Phase 1 fast-path attribution (experiment instrumentation) ---
  // Enabled only when RAPTURE_V31_ATTRIB=1 so the counters can never appear
  // in a performance measurement. Every counter below is incremented ONLY on
  // the expensive path, so a run of purely unselected traffic must leave all
  // of them at zero. That is the Phase 1 hard expectation.
  attrib: {
    alsStoresCreated: 0,
    eventBuffersAllocated: 0,
    boundaryContextHits: 0,
    boundaryContextMisses: 0,
  },
};

/** Phase 1 instrumentation switch, read once so the branch folds away. */
export const ATTRIB = process.env["RAPTURE_V31_ATTRIB"] === "1";

/**
 * Enter the capture ALS for a selected request, enabling async_hooks lazily.
 * Unselected requests never reach here, which is what keeps the fast path
 * free of AsyncLocalStorage propagation cost.
 */
export function runSelected(rec, fn) {
  if (ATTRIB) state.attrib.alsStoresCreated += 1;
  state.inFlightSelected += 1;
  state.alsEnabled = true;
  return state.als.run(rec, fn);
}

export function releaseSelected() {
  state.inFlightSelected -= 1;
  if (state.inFlightSelected < 0) state.inFlightSelected = 0;
  maybeQuiesceAls();
}

/**
 * Drop the process-wide async_hooks cost once nothing needs request context.
 * Deferred by a macrotask so async work trailing a finished response is not
 * cut off; re-checked before acting.
 */
export function maybeQuiesceAls() {
  if (!state.alsQuiesce || !state.alsEnabled) return;
  if (state.inFlightSelected > 0) return;
  if (state.selector == null) return;
  if (state.selector.strategy === "always-on" || state.selector.sampleRate > 0) return;
  if (state.selector.hasActiveArming()) return;
  if (state.quiesceTimer != null) return;
  state.quiesceTimer = setTimeout(() => {
    state.quiesceTimer = null;
    if (state.inFlightSelected > 0) return;
    if (state.selector?.hasActiveArming()) return;
    try {
      state.als.disable();
      state.alsEnabled = false;
    } catch {
      // ALS disable is best-effort; correctness never depends on it
    }
  }, 100);
  state.quiesceTimer.unref?.();
}

/**
 * The single hot-path predicate every boundary wrapper (pg, fetch, Date,
 * Math.random, crypto.randomUUID) consults.
 *
 * V3.1 fast path: when no request has been SELECTED, the AsyncLocalStorage is
 * not enabled, so no store can possibly be active and `getStore()` is
 * guaranteed to return undefined. Reading one boolean instead of entering
 * async_hooks is what makes the unarmed branch a genuine no-op — the wrappers
 * stay installed (so any request can be armed at any moment) without charging
 * ordinary traffic for them.
 *
 * `alsEnabled` defaults to true so V3 legacy modes are completely unaffected;
 * only the V3.1 bootstrap clears it, and `runSelected` sets it before any
 * `als.run`, so the flag can never be false while a store is live.
 */
export function currentRequest() {
  if (!state.alsEnabled) {
    if (ATTRIB) state.attrib.boundaryContextMisses += 1;
    return null;
  }
  const rec = state.als.getStore() ?? null;
  if (ATTRIB) {
    if (rec == null) state.attrib.boundaryContextMisses += 1;
    else state.attrib.boundaryContextHits += 1;
  }
  return rec;
}

/** Monotonic request-local sequence number for a boundary observation. */
export function nextSeq(rec) {
  rec.seq += 1;
  return rec.seq;
}

export function newRequestRecord(reqId, reqSummary) {
  if (ATTRIB) state.attrib.eventBuffersAllocated += 1;
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
