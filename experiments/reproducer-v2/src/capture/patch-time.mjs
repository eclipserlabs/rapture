// Time + randomness capture: Date.now, no-arg new Date(), Math.random,
// crypto.randomUUID (where the runtime allows reassignment).
import { currentRequest } from "./state.mjs";
import { consumeReplayEvent, eventKey, recordEvent, replayActive, captureActive } from "./events.mjs";
import { state } from "./state.mjs";

const OrigDate = globalThis.Date;
const origNow = OrigDate.now.bind(OrigDate);
const origRandom = Math.random.bind(Math);
let origRandomUUID = null;
try {
  origRandomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto) ?? null;
} catch {
  origRandomUUID = null;
}

export const capabilities = {
  dateSubclass: true,
  randomUUID: origRandomUUID != null,
};

function timeKey(rec) {
  const idx = rec.timeIndex ?? 0;
  rec.timeIndex = idx + 1;
  return eventKey("time", {}, idx);
}

function randomKey(rec) {
  const idx = rec.randomIndex ?? 0;
  rec.randomIndex = idx + 1;
  return eventKey("random", {}, idx);
}

class V2Date extends OrigDate {
  constructor(...args) {
    const rec = state.suspended ? null : currentRequest();
    if (args.length === 0 && rec && (captureActive() || replayActive())) {
      if (replayActive()) {
        const key = timeKey(rec);
        const evt = consumeReplayEvent(state.replayQueues, "time", key);
        super(evt.result.value);
        return;
      }
      super(origNow());
      const key = timeKey(rec);
      recordEvent(rec, "time", "now", key, {}, { value: super.getTime() }, null);
      return;
    }
    super(...args);
  }
  static now() {
    const rec = state.suspended ? null : currentRequest();
    if (!rec || (!captureActive() && !replayActive())) return origNow();
    if (replayActive()) {
      const key = timeKey(rec);
      const evt = consumeReplayEvent(state.replayQueues, "time", key);
      return evt.result.value;
    }
    const value = origNow();
    const key = timeKey(rec);
    recordEvent(rec, "time", "now", key, {}, { value }, null);
    return value;
  }
}
for (const staticName of ["parse", "UTC"]) {
  V2Date[staticName] = OrigDate[staticName].bind(OrigDate);
}

let installed = false;

export function installTimePatch() {
  if (installed) return;
  installed = true;
  globalThis.Date = V2Date;
  Math.random = function v2Random() {
    const rec = state.suspended ? null : currentRequest();
    if (!rec || (!captureActive() && !replayActive())) return origRandom();
    if (replayActive()) {
      const key = randomKey(rec);
      const evt = consumeReplayEvent(state.replayQueues, "random", key);
      return evt.result.value;
    }
    const value = origRandom();
    const key = randomKey(rec);
    recordEvent(rec, "random", "draw", key, {}, { value }, null);
    return value;
  };
  if (origRandomUUID) {
    try {
      globalThis.crypto.randomUUID = function v2RandomUUID() {
        const rec = state.suspended ? null : currentRequest();
        if (!rec || (!captureActive() && !replayActive())) return origRandomUUID();
        if (replayActive()) {
          const key = randomKey(rec);
          const evt = consumeReplayEvent(state.replayQueues, "random", key);
          return evt.result.value;
        }
        const value = origRandomUUID();
        const key = randomKey(rec);
        recordEvent(rec, "random", "uuid", key, {}, { value }, null);
        return value;
      };
    } catch {
      capabilities.randomUUID = false;
    }
  } else {
    capabilities.randomUUID = false;
  }
}

export function uninstallTimePatch() {
  if (!installed) return;
  installed = false;
  globalThis.Date = OrigDate;
  Math.random = origRandom;
  if (origRandomUUID) {
    try {
      globalThis.crypto.randomUUID = origRandomUUID;
    } catch {
      // ignore
    }
  }
}
