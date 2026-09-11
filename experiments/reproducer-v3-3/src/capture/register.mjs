// Generic capture bootstrap: `node --import <this file> app.js`.
// Zero application source changes. V3 mode ladder (RAPTURE_V3_MODE takes
// precedence; RAPTURE_V2_MODE off/capture/replay still honored):
//   off               - nothing installed (baseline)
//   context-only      - ALS request context only, no boundary interception
//   intercept-discard - full interception, events counted but never retained
//   capture           - deferred retention; failed requests persisted once
//   replay            - serve RAPTURE_V2_CAPTURE_FILE, fail closed
import { readFileSync } from "node:fs";
import { MODES, state } from "./state.mjs";
import { STRATEGY, selectorFromEnv } from "../detector/select.mjs";
import { installHttpPatch } from "./patch-http.mjs";
import { installPgHook } from "./patch-pg.mjs";
import { installFetchPatch } from "./patch-fetch.mjs";
import { installTimePatch } from "./patch-time.mjs";
import { buildReplayQueues } from "./events.mjs";

const V3_ALIAS = {
  off: MODES.OFF,
  capture: MODES.CAPTURE,
  replay: MODES.REPLAY,
  "context-only": MODES.CONTEXT_ONLY,
  "intercept-discard": MODES.INTERCEPT_DISCARD,
};

function resolveMode() {
  const v3 = process.env["RAPTURE_V3_MODE"];
  if (v3 != null) {
    if (!(v3 in V3_ALIAS)) throw new Error(`unknown RAPTURE_V3_MODE: ${v3}`);
    return V3_ALIAS[v3];
  }
  return process.env["RAPTURE_V2_MODE"] ?? MODES.OFF;
}

export function install() {
  if (state.installed) return state.mode;
  state.installed = true;
  state.mode = resolveMode();
  state.outDir = process.env["RAPTURE_V2_OUT"] ?? null;
  state.captureFile = process.env["RAPTURE_V2_CAPTURE_FILE"] ?? null;
  state.configAllowlist = (process.env["CAPTURE_CONFIG"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // V3.1 selective capture. When RAPTURE_V31_STRATEGY is set to anything but
  // "off", capture becomes SELECTIVE: only requests selected at ingress enter
  // the capture context. Without it the frozen V3 behaviour is unchanged
  // (every request selected), so V3 evidence stays reproducible here.
  const strategy = process.env["RAPTURE_V31_STRATEGY"];
  if (strategy != null && strategy !== STRATEGY.OFF) {
    state.selector = selectorFromEnv();
    state.alsQuiesce = process.env["RAPTURE_V31_ALS_QUIESCE"] !== "0";
    // Nothing is selected yet, so no store can be active: boundary wrappers
    // may take their one-boolean no-op branch until the first selection.
    state.alsEnabled = false;
    // Diagnostic only (never a gated mode): force the AsyncLocalStorage on at
    // boot so a detector-only run still pays the process-wide async_hooks
    // cost. Comparing it against the quiesced run attributes how much of the
    // structural V3 overhead was ALS propagation rather than our own work.
    // A single no-op run() enables Node's async_hooks for this storage and
    // leaves it enabled; the store itself is NOT active during requests, so
    // the fast path still sees no request context and behaves identically.
    if (process.env["RAPTURE_V31_FORCE_ALS"] === "1") {
      state.als.run({}, () => {});
      state.alsEnabled = true;
    }
    // detector-only never captures: force capture mode so the boundary
    // wrappers are installed and can be armed, but nothing is selected.
    if (state.mode === MODES.OFF) state.mode = MODES.CAPTURE;
  }
  if (state.mode === MODES.OFF) return state.mode;
  installHttpPatch();
  if (state.mode === MODES.CONTEXT_ONLY) return state.mode;
  installPgHook();
  installFetchPatch();
  installTimePatch();
  if (state.mode === MODES.INTERCEPT_DISCARD) {
    state.noRetain = true;
    return state.mode;
  }
  if (state.mode === MODES.REPLAY) {
    if (!state.captureFile) throw new Error("RAPTURE_V2_CAPTURE_FILE is required in replay mode");
    const doc = JSON.parse(readFileSync(state.captureFile, "utf8"));
    state.replayDoc = doc;
    state.replayQueues = buildReplayQueues(doc);
    // Restore recorded non-secret config so replay sees the same environment.
    for (const [k, v] of Object.entries(doc.config ?? {})) {
      if (v != null && typeof v === "object") continue; // redacted placeholder: never restore
      if (typeof v === "string") process.env[k] = v;
    }
  }
  return state.mode;
}

// Auto-install when loaded via --import.
install();
