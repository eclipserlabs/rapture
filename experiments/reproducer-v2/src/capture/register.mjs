// Generic capture bootstrap: `node --import <this file> app.js`.
// Zero application source changes. Behavior by RAPTURE_V2_MODE:
//   off      - nothing installed (baseline)
//   capture  - record boundary events, persist failed requests to RAPTURE_V2_OUT
//   replay   - serve RAPTURE_V2_CAPTURE_FILE, fail closed, restore its config
import { readFileSync } from "node:fs";
import { MODES, state } from "./state.mjs";
import { installHttpPatch } from "./patch-http.mjs";
import { installPgHook } from "./patch-pg.mjs";
import { installFetchPatch } from "./patch-fetch.mjs";
import { installTimePatch } from "./patch-time.mjs";
import { buildReplayQueues } from "./events.mjs";

export function install() {
  if (state.installed) return state.mode;
  state.installed = true;
  state.mode = process.env["RAPTURE_V2_MODE"] ?? MODES.OFF;
  state.outDir = process.env["RAPTURE_V2_OUT"] ?? null;
  state.captureFile = process.env["RAPTURE_V2_CAPTURE_FILE"] ?? null;
  state.configAllowlist = (process.env["CAPTURE_CONFIG"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (state.mode === MODES.OFF) return state.mode;
  installHttpPatch();
  installPgHook();
  installFetchPatch();
  installTimePatch();
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
