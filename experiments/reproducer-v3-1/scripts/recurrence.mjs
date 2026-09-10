// V3.1 Phase 5: failure-recurrence and capture-efficiency trials.
//
// One trial = one fresh application process under one deployment strategy,
// driven by a deterministic stream of MATCHING traffic in which failures occur
// at the profile's rate. We measure how long each strategy takes to obtain an
// executable incident, and how many requests it had to fully instrument to get
// there.
//
// The stream is sequential on purpose: "the failure occurrence on which the
// incident was captured" is only meaningful if occurrences are ordered.
//
// Usage:
//   node scripts/recurrence.mjs --incidents express-qs --profiles LOW,HIGH \
//        --strategies targeted --trials 30 [--out results/recurrence]
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INCIDENTS } from "./incidents.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

const INCIDENT_IDS = list(arg("--incidents", "express-qs,fastify-32442,hapi-4564,koa-1999"));
const PROFILE_IDS = list(arg("--profiles", "ONE_OFF,RARE,LOW,MEDIUM,HIGH,DETERMINISTIC"));
const STRATEGY_IDS = list(arg("--strategies", "targeted,always-on,sample-1,sample-5,sample-10,sample-25"));
const TRIALS = Number(arg("--trials", "30"));
const OUT = arg("--out", join(root, "results", "recurrence"));

// Preregistered per-profile request budgets (uniform across strategies so no
// strategy is measured on a longer runway than another).
export const PROFILES = {
  ONE_OFF: { rate: null, occurrences: 1, maxRequests: 1000 },
  RARE: { rate: 0.001, maxRequests: 5000 },
  LOW: { rate: 0.01, maxRequests: 2000 },
  MEDIUM: { rate: 0.05, maxRequests: 1000 },
  HIGH: { rate: 0.2, maxRequests: 500 },
  DETERMINISTIC: { rate: 1.0, maxRequests: 100 },
};

const STRATEGY_ENV = {
  // Headline arming policy, frozen in the manifest: TTL 300s, budget 100.
  targeted: { RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "300000", RAPTURE_V31_BUDGET: "100" },
  // Preregistered sensitivity sweep (manifest: arming_semantics.sensitivity_sweep).
  // These are NOT the gate configuration; they exist to characterise the
  // mechanism behind the headline result, never to replace it.
  "targeted-b10": { RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "300000", RAPTURE_V31_BUDGET: "10" },
  "targeted-b1000": { RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "300000", RAPTURE_V31_BUDGET: "1000" },
  "targeted-ttl30": { RAPTURE_V31_STRATEGY: "targeted", RAPTURE_V31_TTL_MS: "30000", RAPTURE_V31_BUDGET: "100" },
  "always-on": { RAPTURE_V31_STRATEGY: "always-on" },
  "sample-1": { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.01" },
  "sample-5": { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.05" },
  "sample-10": { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.1" },
  "sample-25": { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0.25" },
};

// Deterministic, recorded, never replaced.
function trialSeed(incident, profile, strategy, index) {
  const h = createHash("sha256").update(`${incident}|${profile}|${strategy}|${index}`).digest();
  return h.readUInt32BE(0);
}

/**
 * The seed handed to the SERVER's ingress sampler must be independent of the
 * seed this harness uses to generate the failure schedule.
 *
 * They were originally the same value. Because both sides draw from the same
 * mulberry32 stream, `u_i < failureRate` and `u_i < sampleRate` became the SAME
 * event whenever the two rates were equal: every failure was sampled and
 * nothing else was, so 1% sampling appeared to capture 100% of incidents on the
 * first failure. That is an artifact of the harness, not of the mechanism.
 * Deriving the sampler seed from a different hash input makes the two streams
 * independent, which is what "random ingress sampling" is supposed to mean.
 */
function samplerSeed(incident, profile, strategy, index) {
  const h = createHash("sha256").update(`sampler|${incident}|${profile}|${strategy}|${index}`).digest();
  return h.readUInt32BE(0);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextPort = 47700 + ((process.pid % 40) * 25);
const live = new Set();
for (const sig of ["exit", "SIGINT", "SIGTERM", "uncaughtException"]) {
  process.on(sig, () => {
    for (const c of live) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    if (sig === "uncaughtException") process.exit(1);
  });
}

function startService(def, env, port) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_SAMPLE_RATE", "RAPTURE_V31_TTL_MS", "RAPTURE_V31_BUDGET"]) {
      delete base[k];
    }
    const child = spawn(process.execPath, ["--import", REGISTER, def.svc], {
      env: { ...base, ...def.env, PORT: String(port), RAPTURE_V2_MODE: "capture", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.add(child);
    child.on("exit", () => live.delete(child));
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`READY timeout: ${out.slice(-500)}`));
    }, 30000);
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`exit ${c}: ${out.slice(-500)}`));
    });
  });
}

/** One raw HTTP request; returns the status line's code. */
function send(host, port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => sock.write(payload));
    let data = "";
    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        // already gone
      }
      reject(new Error("request timeout"));
    }, 15000);
    sock.on("data", (c) => {
      data += c;
    });
    sock.on("end", () => {
      clearTimeout(timer);
      const m = /^HTTP\/\S+ (\d+)/.exec(data);
      resolve(m ? Number(m[1]) : 0);
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function stats(port) {
  const r = await fetch(`http://127.0.0.1:${port}/__rapture31`);
  return r.json();
}

async function runTrial(incidentId, profileId, strategyId, index) {
  const def = INCIDENTS[incidentId];
  const profile = PROFILES[profileId];
  const seed = trialSeed(incidentId, profileId, strategyId, index);
  const sampleSeed = samplerSeed(incidentId, profileId, strategyId, index);
  const rand = mulberry32(seed);
  const outDir = mkdtempSync(join(tmpdir(), `v31-rec-${incidentId}-`));
  let child = null;
  let port = 0;
  let bootAttempts = 0;
  for (;;) {
    port = (nextPort += 1);
    try {
      child = await startService(
        def,
        { ...STRATEGY_ENV[strategyId], RAPTURE_V2_OUT: outDir, RAPTURE_V31_SEED: String(sampleSeed) },
        port,
      );
      break;
    } catch (err) {
      bootAttempts += 1;
      if (bootAttempts > 25 || !/EADDRINUSE|READY timeout/.test(String(err))) throw err;
    }
  }

  // Precompute the failure SCHEDULE from the seeded RNG before issuing any
  // request. This costs nothing in fidelity -- the same seed produces the same
  // schedule either way -- and it records how many failures the trial was
  // actually dealt, which is what the theoretical sampling reference must be
  // computed against. The FULL request budget is always issued unless an
  // artifact is captured: the traffic after a failure is exactly where targeted
  // arming spends its instrumentation budget, so truncating it would
  // understate that cost.
  const schedule = new Array(profile.maxRequests);
  if (profileId === "ONE_OFF") {
    const at = Math.floor(rand() * profile.maxRequests);
    schedule.fill(false);
    schedule[at] = true;
  } else if (!def.probabilistic) {
    schedule.fill(true);
  } else {
    for (let i = 0; i < profile.maxRequests; i += 1) schedule[i] = rand() < profile.rate;
  }
  const scheduledFailures = schedule.filter(Boolean).length;

  const rec = {
    incident: incidentId,
    family: def.family,
    profile: profileId,
    strategy: strategyId,
    trial: index,
    seed,
    sampleSeed,
    bootAttempts,
    maxRequests: profile.maxRequests,
    scheduledFailures,
    backgroundSharesIncidentKey: def.backgroundSharesKey !== false,
    requestsIssued: 0,
    failureOccurrences: 0,
    firstFailureAt: null,
    firstFailureRequestIndex: null,
    captured: false,
    capturedAtFailureOccurrence: null,
    capturedAtRequestIndex: null,
    additionalFailuresAfterFirstDetection: null,
    matchingSuccessesFullyInstrumented: null,
    fullyInstrumentedRequests: 0,
    msFromFirstFailureToArtifact: null,
    armingDurationMs: null,
    armEvents: 0,
    disarmReason: null,
    artifactPath: null,
    terminated: null,
  };

  try {
    for (let i = 0; i < profile.maxRequests; i += 1) {
      const isFailure = schedule[i];
      const payload = isFailure ? def.trigger(port) : def.background(port, i);
      let status = 0;
      try {
        status = await send(def.host, port, payload);
      } catch {
        status = 0;
      }
      rec.requestsIssued += 1;
      if (status >= 500) {
        rec.failureOccurrences += 1;
        if (rec.firstFailureAt == null) {
          rec.firstFailureAt = Date.now();
          rec.firstFailureRequestIndex = i;
        }
      }
      // Only a failing request can persist an incident (successes are always
      // discarded), so the artifact check runs after failures and at the end.
      // Persistence happens synchronously in the response 'finish' handler, so
      // by the time the client has read the full response the artifact (if any)
      // exists. Successes never persist, so checking after failures is exact.
      const files = isFailure ? readdirSync(outDir).filter((f) => f.endsWith(".json")) : [];
      if (files.length > 0) {
        rec.captured = true;
        rec.capturedAtFailureOccurrence = rec.failureOccurrences;
        rec.capturedAtRequestIndex = i;
        rec.msFromFirstFailureToArtifact = Date.now() - rec.firstFailureAt;
        rec.artifactPath = join(outDir, files[0]);
        rec.terminated = "CAPTURED";
        break;
      }
    }
    if (!rec.terminated) rec.terminated = "BUDGET_EXHAUSTED_NO_CAPTURE";

    const st = await stats(port);
    const sel = st.selector;
    rec.fullyInstrumentedRequests = sel.stats.requestsSelected;
    rec.armEvents = sel.stats.armEvents;
    rec.detectorFailuresObserved = sel.stats.failuresObserved;
    rec.requestsSeenByDetector = sel.stats.requestsSeen;
    const armEvent = sel.events.find((e) => e.type === "ARM");
    const disarmEvent = sel.events.find((e) => e.type === "DISARM");
    if (disarmEvent) {
      rec.disarmReason = disarmEvent.reason;
      rec.armingDurationMs = disarmEvent.durationMs;
      rec.matchingSuccessesFullyInstrumented = disarmEvent.successesDuringWindow;
    } else if (armEvent) {
      rec.disarmReason = "STILL_ARMED_AT_TRIAL_END";
      rec.armingDurationMs = Date.now() - armEvent.at;
      rec.matchingSuccessesFullyInstrumented = sel.armed[0]?.instrumented ?? null;
    }
    // Additional failure occurrences AFTER the one that first revealed the
    // problem. For targeted arming this is the honest cost of the strategy:
    // the first failure only arms, it is never itself executable.
    if (rec.captured && rec.capturedAtFailureOccurrence != null) {
      rec.additionalFailuresAfterFirstDetection = rec.capturedAtFailureOccurrence - 1;
    }
    // Keep the artifact for the correctness phase; copy out of the temp dir.
    if (rec.artifactPath) {
      const keep = join(OUT, "artifacts", `${incidentId}__${profileId}__${strategyId}__t${index}.json`);
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, readFileSync(rec.artifactPath));
      rec.artifactPath = keep;
    }
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 120));
    rmSync(outDir, { recursive: true, force: true });
  }
  return rec;
}

mkdirSync(OUT, { recursive: true });
const rows = [];
const startedAt = Date.now();
for (const incidentId of INCIDENT_IDS) {
  const def = INCIDENTS[incidentId];
  for (const profileId of PROFILE_IDS) {
    // Probabilistic profiles need a benign same-key request. Where none
    // exists this is recorded as NOT_APPLICABLE, never silently skipped.
    // DETERMINISTIC needs no benign traffic (every matching request fails).
    // ONE_OFF needs only surrounding traffic, which may be non-matching.
    // Every other profile needs a benign request that SHARES the incident key,
    // because that is the only way a failure RATE on that key exists.
    const needsSameKeyBenign = !["DETERMINISTIC", "ONE_OFF"].includes(profileId);
    if (profileId === "ONE_OFF" && def.background == null) {
      rows.push({
        incident: incidentId,
        family: def.family,
        profile: profileId,
        strategy: null,
        applicable: false,
        reason: "no surrounding-traffic request defined for this incident",
      });
      continue;
    }
    if (needsSameKeyBenign && !def.probabilistic) {
      rows.push({
        incident: incidentId,
        family: def.family,
        profile: profileId,
        strategy: null,
        applicable: false,
        reason:
          "no benign request shares this incident key on the buggy revision; every request carrying the key fails (see incidents.mjs)",
      });
      continue;
    }
    for (const strategyId of STRATEGY_IDS) {
      for (let t = 0; t < TRIALS; t += 1) {
        const rec = await runTrial(incidentId, profileId, strategyId, t);
        rec.applicable = true;
        rows.push(rec);
        writeFileSync(join(OUT, "trials.json"), `${JSON.stringify(rows, null, 2)}\n`);
      }
      const done = rows.filter((r) => r.incident === incidentId && r.profile === profileId && r.strategy === strategyId);
      const cap = done.filter((r) => r.captured).length;
      console.log(
        `${incidentId}/${profileId}/${strategyId}: captured ${cap}/${done.length} ` +
          `medAddFail=${median(done.filter((r) => r.captured).map((r) => r.additionalFailuresAfterFirstDetection))} ` +
          `medInstr=${median(done.map((r) => r.fullyInstrumentedRequests))} ` +
          `(${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    }
  }
}
writeFileSync(join(OUT, "trials.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log(`wrote ${join(OUT, "trials.json")} (${rows.length} rows)`);

function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return "n/a";
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
