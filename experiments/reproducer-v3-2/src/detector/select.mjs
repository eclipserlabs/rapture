// V3.1 ingress selection + cheap failure detector.
//
// The whole point of this module is the scientific constraint that a request
// cannot be captured retroactively: whether a request receives high-fidelity
// capture is decided HERE, before the application listener is invoked, and is
// never revised afterwards. Everything the detector may observe while a
// request is NOT selected is limited to the preregistered cheap set:
// method, pathname, normalized pathname, and the final response status.
//
// Nothing in this file is application-specific, framework-specific, or
// bug-specific. No route table is supplied by the application; normalization
// is purely lexical.

export const STRATEGY = {
  OFF: "off",
  // Detector runs on all traffic; nothing is ever selected for capture.
  DETECTOR_ONLY: "detector-only",
  // Detector runs; each request is independently selected with probability p.
  SAMPLING: "sampling",
  // Detector runs; an observed failure arms capture for subsequent matching
  // requests until an incident is captured or the window closes.
  TARGETED: "targeted",
  // Every request is selected: frozen V3 always-on capture (control).
  ALWAYS_ON: "always-on",
  // Statically configured routes are selected; all other traffic is
  // completely uninstrumented. The rule set is generic operator
  // configuration (method + normalized path), never bug-specific code.
  ROUTE_SELECTIVE: "route-selective",
  // As ROUTE_SELECTIVE, but the configured rules form a BOUNDED incident
  // investigation window: they expire on TTL or request budget, after which
  // the process returns to fully uninstrumented traffic.
  ARMED_WINDOW: "armed-window",
};

const DISARM = {
  CAPTURED: "CAPTURED",
  TTL_EXPIRED: "TTL_EXPIRED",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
};

// ---------------------------------------------------------------------------
// Path normalization (preregistered): purely lexical, bounded, LRU-cached so
// the per-request cost is O(1) amortized string work.
// ---------------------------------------------------------------------------

const NUM = /^[0-9]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LONGHEX = /^[0-9a-fA-F]{16,}$/;
const NORM_MAX_SEGMENTS = 12;
const NORM_MAX_LENGTH = 200;
const NORM_CACHE_MAX = 512;
const normCache = new Map();

export function normalizePath(pathname) {
  const cached = normCache.get(pathname);
  if (cached !== undefined) return cached;
  const parts = pathname.split("/");
  const out = [];
  for (let i = 0; i < parts.length && out.length <= NORM_MAX_SEGMENTS; i += 1) {
    const seg = parts[i];
    out.push(NUM.test(seg) || UUID.test(seg) || LONGHEX.test(seg) ? ":id" : seg);
  }
  let norm = out.join("/");
  if (norm.length > NORM_MAX_LENGTH) norm = norm.slice(0, NORM_MAX_LENGTH);
  if (normCache.size >= NORM_CACHE_MAX) {
    normCache.delete(normCache.keys().next().value);
  }
  normCache.set(pathname, norm);
  return norm;
}

// The composed key is cached too, so the steady-state per-request cost of the
// detector is two Map lookups and no string allocation at all once a route has
// been seen. Bounded by the same LRU policy as normalization.
const keyCache = new Map();
const KEY_CACHE_MAX = 1024;

/** Incident key: the preregistered default matching key, method + normalized path. */
export function incidentKey(method, pathname) {
  let byMethod = keyCache.get(method);
  if (byMethod === undefined) {
    if (keyCache.size >= 16) keyCache.delete(keyCache.keys().next().value);
    byMethod = new Map();
    keyCache.set(method, byMethod);
  }
  const cached = byMethod.get(pathname);
  if (cached !== undefined) return cached;
  const key = `${method} ${normalizePath(pathname)}`;
  if (byMethod.size >= KEY_CACHE_MAX) byMethod.delete(byMethod.keys().next().value);
  byMethod.set(pathname, key);
  return key;
}

// ---------------------------------------------------------------------------
// Deterministic RNG for ingress sampling. Seeded per process and recorded, so
// a sampling run is reproducible and no outcome can be hand-picked.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

const ARMED_MAX = 256;

export class Selector {
  constructor(opts = {}) {
    this.strategy = opts.strategy ?? STRATEGY.OFF;
    this.sampleRate = Number(opts.sampleRate ?? 0);
    this.ttlMs = Number(opts.ttlMs ?? 300000);
    this.budget = Number(opts.budget ?? 100);
    this.seed = Number(opts.seed ?? 1);
    // Pre-armed rule set for ROUTE_SELECTIVE / ARMED_WINDOW. Parsed once at
    // boot from generic configuration; the ingress test is one Set lookup on
    // the same normalized key the detector already computes.
    this.routes = new Set(opts.routes ?? []);
    this.windowMs = Number(opts.windowMs ?? 300000);
    this.windowBudget = Number(opts.windowBudget ?? Infinity);
    this.windowOpenedAt = null;
    this.windowUsed = 0;
    this.windowClosedReason = null;
    this.rand = mulberry32(this.seed);
    this.now = opts.now ?? (() => Date.now());
    /** key -> arming record. Holds no headers, bodies, queries or params. */
    this.armed = new Map();
    this.events = [];
    this.stats = {
      requestsSeen: 0,
      requestsSelected: 0,
      selectedBySampling: 0,
      selectedByArming: 0,
      selectedByRoute: 0,
      selectedByWindow: 0,
      unmatchedByRoute: 0,
      selectedByAlwaysOn: 0,
      failuresObserved: 0,
      armEvents: 0,
      disarmCaptured: 0,
      disarmTtl: 0,
      disarmBudget: 0,
      capturedIncidents: 0,
    };
  }

  /** True when a request's outcome must be observed by the cheap detector. */
  get detects() {
    return this.strategy !== STRATEGY.OFF && this.strategy !== STRATEGY.ALWAYS_ON;
  }

  /** True while any key holds a live arming (drives ALS quiescence). */
  /** True while a pre-armed rule set can still select a future request. */
  hasActivePreArm() {
    if (this.strategy === STRATEGY.ROUTE_SELECTIVE) return this.routes.size > 0;
    if (this.strategy === STRATEGY.ARMED_WINDOW) return this.#windowOpen();
    return false;
  }

  #windowOpen() {
    if (this.routes.size === 0) return false;
    if (this.windowClosedReason != null) return false;
    // Budget is checked BEFORE the not-yet-opened shortcut. Otherwise a
    // window configured with budget 0 would let exactly one request through
    // before closing, which is not a bounded window at all.
    if (this.windowUsed >= this.windowBudget) {
      this.windowClosedReason = DISARM.BUDGET_EXHAUSTED;
      return false;
    }
    if (this.windowOpenedAt == null) return true;
    if (this.now() - this.windowOpenedAt >= this.windowMs) {
      this.windowClosedReason = DISARM.TTL_EXPIRED;
      return false;
    }
    return true;
  }

  hasActiveArming() {
    if (this.hasActivePreArm()) return true;
    const t = this.now();
    for (const rec of this.armed.values()) {
      if (rec.expiresAt > t && rec.budgetRemaining > 0) return true;
    }
    return false;
  }

  /**
   * The ingress decision. Called before the application listener runs and
   * never revisited. Returns {selected, key, reason}.
   */
  selectAtIngress(method, pathname) {
    this.stats.requestsSeen += 1;
    if (this.strategy === STRATEGY.OFF) return { selected: false, key: null, reason: "off" };
    if (this.strategy === STRATEGY.ALWAYS_ON) {
      this.stats.requestsSelected += 1;
      this.stats.selectedByAlwaysOn += 1;
      return { selected: true, key: incidentKey(method, pathname), reason: "always-on" };
    }
    const key = incidentKey(method, pathname);
    if (this.strategy === STRATEGY.DETECTOR_ONLY) {
      return { selected: false, key, reason: "detector-only" };
    }
    if (this.strategy === STRATEGY.SAMPLING) {
      // Bernoulli draw BEFORE execution. An unselected request can never be
      // upgraded later, whatever status it ends with.
      if (this.rand() < this.sampleRate) {
        this.stats.requestsSelected += 1;
        this.stats.selectedBySampling += 1;
        return { selected: true, key, reason: "sampled" };
      }
      return { selected: false, key, reason: "unsampled" };
    }
    if (this.strategy === STRATEGY.ROUTE_SELECTIVE) {
      if (!this.routes.has(key)) {
        this.stats.unmatchedByRoute += 1;
        return { selected: false, key, reason: "route-unmatched" };
      }
      this.stats.requestsSelected += 1;
      this.stats.selectedByRoute += 1;
      return { selected: true, key, reason: "route-selected" };
    }
    if (this.strategy === STRATEGY.ARMED_WINDOW) {
      if (!this.routes.has(key)) {
        this.stats.unmatchedByRoute += 1;
        return { selected: false, key, reason: "window-unmatched" };
      }
      if (!this.#windowOpen()) {
        return { selected: false, key, reason: "window-closed-" + this.windowClosedReason };
      }
      if (this.windowOpenedAt == null) this.windowOpenedAt = this.now();
      this.windowUsed += 1;
      this.stats.requestsSelected += 1;
      this.stats.selectedByWindow += 1;
      return { selected: true, key, reason: "window-selected" };
    }
    // TARGETED: select only if this key currently holds a live arming.
    const rec = this.armed.get(key);
    if (rec == null) return { selected: false, key, reason: "unarmed" };
    const t = this.now();
    if (rec.expiresAt <= t) {
      this.#disarm(key, rec, DISARM.TTL_EXPIRED);
      return { selected: false, key, reason: "unarmed-ttl-expired" };
    }
    if (rec.budgetRemaining <= 0) {
      this.#disarm(key, rec, DISARM.BUDGET_EXHAUSTED);
      return { selected: false, key, reason: "unarmed-budget-exhausted" };
    }
    rec.budgetRemaining -= 1;
    rec.instrumented += 1;
    this.stats.requestsSelected += 1;
    this.stats.selectedByArming += 1;
    return { selected: true, key, reason: "armed" };
  }

  /**
   * Cheap detector observation, at response finish. The ONLY inputs are the
   * key computed at ingress and the final status code. This observation can
   * arm capture for FUTURE matching requests; it can never turn the request
   * that produced it into an executable incident.
   */
  observeOutcome(key, status, wasSelected) {
    if (key == null) return;
    const failed = status >= 500;
    const rec = this.armed.get(key);
    if (rec != null && !failed) {
      rec.successesDuringWindow += 1;
    }
    if (!failed) {
      this.#expireIfDue(key, rec);
      return;
    }
    this.stats.failuresObserved += 1;
    if (rec != null) {
      rec.failuresSeen += 1;
      if (wasSelected) rec.failuresSelected += 1;
      this.#expireIfDue(key, rec);
      return;
    }
    if (this.strategy !== STRATEGY.TARGETED) return;
    this.#arm(key, status);
  }

  /**
   * Called when a selected request actually persisted an executable incident.
   * This is the only success termination for an arming window.
   */
  noteIncidentCaptured(key, path) {
    this.stats.capturedIncidents += 1;
    const rec = this.armed.get(key);
    if (rec == null) return;
    rec.captured = true;
    rec.capturedAt = this.now();
    rec.capturedPath = path;
    this.#disarm(key, rec, DISARM.CAPTURED);
  }

  #arm(key, status) {
    if (this.armed.size >= ARMED_MAX) {
      this.armed.delete(this.armed.keys().next().value);
    }
    const t = this.now();
    const rec = {
      key,
      armedAt: t,
      expiresAt: t + this.ttlMs,
      budgetRemaining: this.budget,
      firstFailureAt: t,
      firstFailureStatus: status,
      failuresSeen: 1,
      failuresSelected: 0,
      successesDuringWindow: 0,
      instrumented: 0,
      captured: false,
      capturedAt: null,
      capturedPath: null,
    };
    this.armed.set(key, rec);
    this.stats.armEvents += 1;
    this.events.push({ at: t, type: "ARM", key, status });
  }

  #expireIfDue(key, rec) {
    if (rec == null) return;
    if (rec.expiresAt <= this.now()) this.#disarm(key, rec, DISARM.TTL_EXPIRED);
    else if (rec.budgetRemaining <= 0) this.#disarm(key, rec, DISARM.BUDGET_EXHAUSTED);
  }

  #disarm(key, rec, reason) {
    this.armed.delete(key);
    if (reason === DISARM.CAPTURED) this.stats.disarmCaptured += 1;
    else if (reason === DISARM.TTL_EXPIRED) this.stats.disarmTtl += 1;
    else this.stats.disarmBudget += 1;
    this.events.push({
      at: this.now(),
      type: "DISARM",
      key,
      reason,
      armedAt: rec.armedAt,
      durationMs: this.now() - rec.armedAt,
      failuresSeen: rec.failuresSeen,
      failuresSelected: rec.failuresSelected,
      successesDuringWindow: rec.successesDuringWindow,
      instrumented: rec.instrumented,
      captured: rec.captured,
      capturedPath: rec.capturedPath,
    });
  }

  /**
   * Serializable arming state. Deliberately carries no request content: the
   * privacy regression test asserts that no header, body, query string, pg
   * parameter, cookie, or unnormalized URL can appear here.
   */
  snapshot() {
    return {
      strategy: this.strategy,
      routes: [...this.routes],
      windowOpen: this.hasActivePreArm(),
      windowClosedReason: this.windowClosedReason,
      windowUsed: this.windowUsed,
      sampleRate: this.sampleRate,
      ttlMs: this.ttlMs,
      budget: this.budget,
      seed: this.seed,
      stats: { ...this.stats },
      armed: [...this.armed.values()].map((r) => ({
        key: r.key,
        armedAt: r.armedAt,
        expiresAt: r.expiresAt,
        budgetRemaining: r.budgetRemaining,
        firstFailureAt: r.firstFailureAt,
        firstFailureStatus: r.firstFailureStatus,
        failuresSeen: r.failuresSeen,
        instrumented: r.instrumented,
        captured: r.captured,
      })),
      events: this.events,
    };
  }
}

export function selectorFromEnv(env = process.env) {
  const raw = env["RAPTURE_V31_STRATEGY"] ?? STRATEGY.OFF;
  const known = Object.values(STRATEGY);
  if (!known.includes(raw)) throw new Error(`unknown RAPTURE_V31_STRATEGY: ${raw}`);
  return new Selector({
    strategy: raw,
    sampleRate: Number(env["RAPTURE_V31_SAMPLE_RATE"] ?? "0"),
    ttlMs: Number(env["RAPTURE_V31_TTL_MS"] ?? "300000"),
    budget: Number(env["RAPTURE_V31_BUDGET"] ?? "100"),
    seed: Number(env["RAPTURE_V31_SEED"] ?? "1"),
    // Generic operator configuration: comma-separated "METHOD /normalized/path".
    routes: (env["RAPTURE_V31_ROUTES"] ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
    windowMs: Number(env["RAPTURE_V31_WINDOW_MS"] ?? "300000"),
    windowBudget: Number(env["RAPTURE_V31_WINDOW_BUDGET"] ?? "Infinity"),
  });
}
