// Deterministic record/replay substrate for reproducer-v0.
//
// Boundary rule: ALL nondeterminism (external responses, clock, randomness,
// config, database reads) flows through ReplayContext. Application logic that
// bypasses it (Date.now(), Math.random(), fetch, ...) cannot be captured and
// is treated as a harness violation in tests.
//
// Replay lookup is keyed by (kind, operation, stable request key) so that
// removing an ambient (never-requested) capture event does not disturb the
// remaining events. Retained events keep their original relative sequence,
// which is what preserves order-dependent causality.
import { isAbsolute, resolve } from "node:path";
import { stableStringify } from "./canonical.js";
import { LiveEffectError, MissingMockError } from "./fingerprint.js";

export function eventKey(kind, operation, requestKey) {
  return `${kind}:${operation}:${stableStringify(requestKey)}`;
}

export class ReplayContext {
  /**
   * @param {object} args
   * @param {"record"|"replay"} args.mode
   * @param {Map<string, unknown>} args.script - keyed scripted results (record mode serves from here)
   * @param {Map<string, object>} args.retainedEvents - keyed retained events (replay mode serves from here)
   * @param {object} args.config - full (record) or retained (replay) config map
   * @param {Map<string, unknown>} args.db - keyed db rows (`table:key` -> value)
   * @param {string} args.tempDir - only filesystem root the app may touch
   * @param {{ liveEffectAttempts: number }} args.counters - mutated on every refused live effect
   * @param {Array<object>} [args.recordedEvents] - record-mode sink for requested events
   */
  constructor(args) {
    this.mode = args.mode;
    this.script = args.script;
    this.retainedEvents = args.retainedEvents;
    this.config = args.config;
    this.db = args.db;
    this.tempDir = args.tempDir;
    this.counters = args.counters;
    this.recordedEvents = args.recordedEvents ?? [];
    this.sequence = 0;
    this.callOrder = [];
  }

  _lookup(kind, operation, requestKey) {
    const key = eventKey(kind, operation, requestKey);
    if (this.mode === "record") {
      if (!this.script.has(key)) {
        throw new MissingMockError(`record script has no result for ${key}`);
      }
      const result = this.script.get(key);
      this.recordedEvents.push({
        sequence: this.sequence,
        kind,
        operation,
        request_or_key: requestKey,
        recorded_result: result,
        metadata: { ambient: false },
      });
      this.sequence += 1;
      this.callOrder.push(key);
      return result;
    }
    const evt = this.retainedEvents.get(key);
    if (evt === undefined) {
      throw new MissingMockError(`no retained boundary event for ${key}`);
    }
    this.callOrder.push(key);
    return evt.recorded_result;
  }

  /** External HTTP/service response through the experiment-owned boundary. */
  http(operation, requestKey) {
    return this._lookup("http", operation, requestKey);
  }

  /** Captured clock value. */
  clock(label) {
    return this._lookup("clock", "now", label);
  }

  /** Captured random value in [0, 1). */
  random(label) {
    const v = this._lookup("random", "draw", label);
    if (typeof v !== "number") throw new MissingMockError(`random draw for ${label} is not a number`);
    return v;
  }

  /** Environment/config value. Missing keys replay as undefined (app logic decides). */
  getConfig(key) {
    return this.config[key];
  }

  /** Database read through the experiment-owned boundary. Missing rows replay as undefined. */
  dbGet(table, key) {
    return this.db.get(`${table}:${key}`);
  }

  // -- Forbidden live effects (always refused, counted) --

  /** Any live network attempt is refused. There is no allow-list. */
  liveFetch(_url, _opts) {
    this.counters.liveEffectAttempts += 1;
    throw new LiveEffectError("live network is forbidden during replay");
  }

  /**
   * Filesystem writes are allowed only inside the experiment temp directory.
   * Everything else is refused and counted.
   */
  guardedWrite(path) {
    const abs = isAbsolute(path) ? path : resolve(this.tempDir, path);
    const root = resolve(this.tempDir);
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      this.counters.liveEffectAttempts += 1;
      throw new LiveEffectError(`filesystem write outside experiment temp dir refused: ${path}`);
    }
    return abs;
  }
}

/**
 * Run application logic under a replay/record context.
 * Never throws: all outcomes (including harness refusals) are returned.
 */
export function runWithContext(ctx, input, fn) {
  const start = process.hrtime.bigint();
  try {
    const value = fn(ctx, input);
    const end = process.hrtime.bigint();
    return { status: "returned", value, wallMs: Number(end - start) / 1e6 };
  } catch (error) {
    const end = process.hrtime.bigint();
    return { status: "threw", error, wallMs: Number(end - start) / 1e6 };
  }
}
