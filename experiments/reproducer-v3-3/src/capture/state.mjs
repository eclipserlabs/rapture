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
  // V3.3 capture-ownership lifecycle.
  //
  // A boundary operation initiated inside a selected context can outlive the
  // HTTP response, so "response finished" is NOT "ownership finished".
  // Disabling the storage while such an operation is still outstanding would
  // lose or misattribute its evidence. This counter is the second half of the
  // quiescence authority; the storage may only be disabled when BOTH it and
  // inFlightSelected are zero.
  outstandingCaptureOps: 0,
  alsEnableCount: 0,
  alsDisableCount: 0,
  // Preregistered Phase 4 metric: how much wall-clock time the storage is
  // actually active. Instrumentation only -- two timestamp reads per
  // transition, on a path that already does far more work.
  alsActiveMs: 0,
  alsEnabledAt: null,
  processStartMs: Date.now(),
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
    // V3.2 diagnostic: when a boundary wrapper finds a live capture context
    // that belongs to a request OTHER than the one now executing, record which
    // wrapper saw it. Attribution is stack-based and ATTRIB-gated, so it never
    // runs in a measured configuration and touches no frozen file.
    leakByModule: {},
    leakHits: 0,
  },

  // --- V3.2 unsupported-condition detection ---
  // Boundary operations performed during application STARTUP, outside any
  // request, are invisible to a capture model that only records inside a
  // request. An application that does them cannot be replayed offline: at
  // replay time it will try to reach the real dependency and fail to boot.
  //
  // Flipped true by the first inbound request, so after boot the hot path
  // costs one boolean read.
  bootPhaseOver: false,
  bootBoundaryOps: 0,
};

/**
 * A DEPENDENCY boundary operation (Postgres or outbound HTTP) performed
 * before the first inbound request. Time and randomness are excluded on
 * purpose: they are reproduced from the artifact and need nothing live, so
 * counting them would flag applications that replay offline perfectly well.
 */
export function noteBootDependencyOp() {
  if (!state.bootPhaseOver) state.bootBoundaryOps += 1;
}


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
  if (!state.alsEnabled) {
    state.alsEnableCount += 1;
    state.alsEnabledAt = Date.now();
  }
  state.alsEnabled = true;
  return state.als.run(rec, fn);
}

export function releaseSelected() {
  state.inFlightSelected -= 1;
  if (state.inFlightSelected < 0) state.inFlightSelected = 0;
  maybeQuiesceAls();
}

/**
 * Open a capture-ownership interval for a boundary operation issued inside a
 * selected context. Must be paired with closeCaptureOp() on EVERY exit path,
 * including errors, or the storage can never quiesce again.
 */
export function openCaptureOp() {
  state.outstandingCaptureOps += 1;
}

/** Close the interval and, if nothing is left outstanding, consider quiescing. */
export function closeCaptureOp() {
  state.outstandingCaptureOps -= 1;
  if (state.outstandingCaptureOps < 0) state.outstandingCaptureOps = 0;
  if (state.outstandingCaptureOps === 0 && state.inFlightSelected === 0) maybeQuiesceAls();
}

/**
 * Drop the process-wide async_hooks cost once nothing needs request context.
 * Deferred by a macrotask so async work trailing a finished response is not
 * cut off; re-checked before acting.
 */
export function maybeQuiesceAls() {
  if (!state.alsQuiesce || !state.alsEnabled) return;
  // --- V3.3 quiescence authority ---
  // Both halves of capture ownership must be idle. A configured or armed route
  // rule is deliberately NOT consulted: it expresses only what WOULD be
  // selected in future, and selection re-enables the storage lazily at ingress
  // (runSelected) synchronously, before the application handler runs. Pinning
  // the storage open for a rule that may never match is exactly the fixed
  // async_hooks tax that failed V3.2 Gate 1.
  if (state.inFlightSelected > 0) return;
  if (state.outstandingCaptureOps > 0) return;
  if (state.selector == null) return;
  // always-on and ingress sampling genuinely may select ANY request, so for
  // those strategies the storage must stay enabled.
  if (state.selector.strategy === "always-on" || state.selector.sampleRate > 0) return;
  if (state.quiesceTimer != null) return;
  state.quiesceTimer = setTimeout(() => {
    state.quiesceTimer = null;
    // Re-checked immediately before disable(): an operation may have opened
    // while the macrotask was queued.
    if (state.inFlightSelected > 0) return;
    if (state.outstandingCaptureOps > 0) return;
    try {
      state.als.disable();
      state.alsEnabled = false;
      state.alsDisableCount += 1;
      if (state.alsEnabledAt != null) {
        state.alsActiveMs += Date.now() - state.alsEnabledAt;
        state.alsEnabledAt = null;
      }
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
    else {
      state.attrib.boundaryContextHits += 1;
      // Which boundary wrapper observed a live context. In a run where no
      // request is selected, every one of these is a context that outlived
      // the request that created it.
      state.attrib.leakHits += 1;
      const st = new Error().stack ?? "";
      const m = st.match(/patch-(pg|fetch|time|http)\.mjs/);
      const key = m ? m[1] : "unknown";
      state.attrib.leakByModule[key] = (state.attrib.leakByModule[key] ?? 0) + 1;
    }
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
