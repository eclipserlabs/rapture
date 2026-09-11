# Rapture Reproducer V3.2 — Route-Targeted Capture Boundary Closure

**Status: COMPLETE. Gate 1 FAILS; Gates 2, 3 and 4 PASS. Verdict `MODIFY`.**
The steady-state campaign was executed on a host that passed the unchanged
preregistered quiescence gate, with 150/150 valid repetitions and zero
environmentally invalid runs.

- V3.1 checkpoint: **`a8d774a55eb01175373c990b9699bf334f9f348e`**
- V3.2 protocol manifest: `manifests/V3.2-MANIFEST.json`, sha256
  **`1101611db49f726c7a4a8e668fef13b61c8c3af09b657b9479af7b5269a99dbb`**
- Frozen V3.2 implementation tree: **`773dfeef4b7edec1d987797f9b9c922e70563d8fbac6021f1b1ce1aad81a8342`**

## Executive Summary

V3.2 asked whether route-targeted capture is bounded, safe and predictable
enough to stop building capture machinery. **Three of the four gates pass. The
fourth — the economics — fails, and fails for a reason nobody had measured
before.**

**Route targeting is not near-free once it has been used.** V3.1 concluded that
armed-but-unmatched traffic costs about −1.14% throughput. That was measured on
a process that had never activated capture. Force 150 captures first — which is
what any deployed system does within its first minute — and the same
configuration costs **−5.86% throughput and +5.07% unmatched p95 while
selecting 0 requests and recording 0 boundary events**. At the preregistered
primary condition of 10% armed traffic, unmatched requests pay **+6.63% p95**
and the service loses **−7.74% throughput**, against ≤5% gates, failing under
both estimators.

The work-avoidance property that V3.1 proved is intact and is **not** the
problem: 0 capture contexts, 0 boundary events, 0 artifacts on unmatched
traffic. The cost is the process-wide `async_hooks` tax, which
`AsyncLocalStorage` cannot shed while any route remains armed. It is paid
permanently after first activation, whether or not anything is captured.

Getting here also required correcting **three defects that all previous phases
had missed** — two in the capture runtime and one in the experiment harness.

**A capture-ownership defect broke cross-request confidentiality.** Under pool
pressure, a queued Postgres connection request is dispatched from the stack of
whichever request *releases* a connection. AsyncLocalStorage therefore reported
the releasing request's context, and the nested `Client.query` recorded a
foreign request's SQL parameters and result rows into someone else's incident.
A request that was **never selected for capture** could have its data persisted
into a selected incident. Fixed by binding the caller's context at connection
acquisition. Proven by a single-variable differential: with `patch-pg.mjs`
reverted the suite fails (OWN-A1, OWN-B2); with the fix every check passes under
identical pool pressure.

**The V3 session-credential surrogate never worked on real cookies.**
`redactHeaders` splits a Cookie header on `;`, strips the `name=` prefix, then
applies a regex that *requires* that prefix — so it could never fire. The same
gap applied to Postgres parameters, which arrive as bare values. V3 only
appeared protected because its fixture shaped the parameter as the literal
pair-form string `"sid=sess-alice"`. Replaced with shape-derived standalone
classification: opaque handles become a deterministic surrogate applied
identically to headers, parameters and replay keys; signature-bearing
credentials are refused outright. **9/9 checks pass, and the surrogated artifact
still replays the exact failure offline.**

**parse-server's "16/20 across two outcome classes" was a measurement
artifact.** The V3.1 replay harness never exited after firing its own timeout,
so slow runs were recorded as a second outcome class; this is also what the
prior session's 15-hour loop was actually doing. With the lifecycle fixed a
replay takes **1697 ms**, and **300/300 replays across three arms produce one
outcome class and one fingerprint**.

**The leading hypothesis for that nondeterminism was wrong, and the controlled
intervention is what caught it.** Arm C restored the ownership defect as the
only variable and still produced 100/100 exact. Reasoning "parse-server uses
pg-promise with a pool, therefore ownership" would have shipped a false causal
claim.

**What remains at application scale is real, and is now detected before an
artifact is handed over.** parse-server performs **55 dependency operations
during startup**, outside any request, where the capture model never looks. Its
offline replay is deterministic and fail-closed (20/20, one class, **0 false
passes**). A generic detector now flags this at capture time as
`BOOT_TIME_DEPENDENCY_ACCESS` with `offline_replay_supported: false`.

Every historical guarantee survived all of it: **8/8, 160/160 offline, 160/160
portable, 8/8 FIX_CONFIRMED, 0 wrong-failure acceptances, 8/8 fingerprints
identical to V3's.**

## Measurement Validity

**V3.1 performance results were collected under subsequently discovered severe
host contention and are retained for provenance but are not used as
authoritative deployment-economics evidence. V3.2 re-measures the question under
an explicit machine-quiescence protocol.**

A leftover diagnostic loop from the prior session (`/tmp/classcheck.sh`, started
06:10:40, still running ~15 hours later) was repeatedly booting parse-server on
a **4-logical-CPU** host, alongside orphaned fixture services from this
session's own smoke tests. Load average at detection was 50.60 — **12.65 per
CPU**.

Two V3.2 repetitions taken before this was noticed are recorded in
`results/invalid-environment-audit.json` and excluded from every estimator. They
are excluded on **host evidence** — no gate value was ever computed from them —
not because of their outcome.

An earlier draft of this report argued that paired estimators and randomised
mode order left V3.1 unbiased. **That argument is withdrawn.** Pairing cancels a
*constant* load; bursty, unmeasured interference is not cancelled, so it cannot
be claimed to leave those estimates unbiased.

`scripts/quiescence.mjs` preregisters the replacement gate: load normalised per
logical CPU (never raw), zero orphaned experiment processes, swap-in **rate**,
available memory (free + inactive + speculative, because macOS keeps raw free
memory near zero by design), all held across a 60-second stabilisation window
where any violation restarts the window. Two flaws in my own criteria were
corrected **before any headline result was inspected** and recorded in
`results/quiescence-criteria-revision.json`.

## Gate 1 — Steady-State Economics (FAIL)

Executed after the unchanged pre-campaign quiescence gate passed at
`load1/cpu 0.22`, 3694 MB available, 0 orphaned processes.
**150/150 repetitions valid, 0 INVALID_ENVIRONMENT.**

**Workload equivalence.** Each frozen V3 fixture exposes only one substantive
route, so a mixed-traffic control cannot be built from it without comparing
unlike work. The V3.2 fixtures register the **same options object and the same
handler** at a second path (`/parse-b`, `/u-b`, `/v-b`), so armed and
unmatched populations perform byte-identical application work while normalising
to distinct route keys. `OFF_MIXED` runs the identical two-route mix.

**Activation.** Every treatment repetition forced **150 selected captures**
before the measured interval, verified from runtime counters. This is the
condition V3.1 never tested.

### Steady-State Mixed Traffic

| Service | Armed % | Unmatched p50 | Unmatched p95 | Unmatched p99 | Selected p95 | Throughput | Δ vs OFF | Unmatched capture contexts | Unmatched boundary events | Gate |
|---|---|---|---|---|---|---|---|---|---|---|
| express-qs | OFF (control) | 9.88 | 15.26 | 22.91 | — | 1511.21 | — | — | — | control |
| express-qs | 0% | 10.55 | 15.88 | 23.22 | — | 1427.76 | -5.86% | **0** | **0** | — |
| express-qs | 1% | 10.56 | 15.93 | 23.88 | 15.82 | 1429.03 | -5.92% | 2000 | 8000 | — |
| express-qs | 10% | 10.82 | 16.42 | 24.41 | 16.26 | 1387.88 | -7.8% | 20000 | 80000 | **FAIL** |
| express-qs | 25% | 11.15 | 16.93 | 26.17 | 16.88 | 1351 | -10.18% | 50000 | 200000 | — |
| koa-1999 | OFF (control) | 8.4 | 13.56 | 22.46 | — | 1752.85 | — | — | — | control |
| koa-1999 | 0% | 8.82 | 13.85 | 22.61 | — | 1680.4 | -3.48% | **0** | **0** | — |
| koa-1999 | 1% | 8.79 | 13.81 | 22.58 | 13.54 | 1686.13 | -3.86% | 2000 | 8000 | — |
| koa-1999 | 10% | 8.92 | 14.05 | 22.8 | 14.07 | 1660.85 | -5.69% | 20000 | 80000 | **FAIL** |
| koa-1999 | 25% | 9.02 | 14.66 | 23.29 | 14.7 | 1630.66 | -7.49% | 50000 | 200000 | — |
| fastify-32442 | OFF (control) | 9.34 | 14.97 | 25.02 | — | 1583.09 | — | — | — | control |
| fastify-32442 | 0% | 9.95 | 15.72 | 26.52 | — | 1488.59 | -5.88% | **0** | **0** | — |
| fastify-32442 | 1% | 9.94 | 15.58 | 27.22 | 15.55 | 1489.15 | -5.54% | 2000 | 8000 | — |
| fastify-32442 | 10% | 10.15 | 15.98 | 27.6 | 15.93 | 1459.7 | -7.74% | 20000 | 80000 | **FAIL** |
| fastify-32442 | 25% | 10.31 | 16.41 | 27.34 | 16.45 | 1432.1 | -9.59% | 50000 | 200000 | — |

### Gate 1 evaluation, primary condition (10% armed)

| Sub-gate | Required | Observed (paired / ratio-of-medians) | Pass |
|---|---|---|---|
| median unmatched p95 overhead | ≤ 5% | **+6.63% / +6.75%** | **NO** — fails under both |
| median whole-service throughput degradation | ≤ 5% | **−7.74% / −7.79%** | **NO** — fails under both |
| no single service unmatched p95 > 10% | ≤ 10% | 8.82% worst service | yes |
| unmatched capture contexts | 0 | **0** | yes |
| unmatched boundary capture events | 0 | **0** | yes |

**Gate 1: FAIL** (3 of 5 sub-gates pass).

### What actually costs the money

**The work-avoidance property is perfect and is not the problem.** Across the
entire measured interval of `ARMED_UNMATCHED_ONLY`, with 150 captures already
forced during activation: **0 requests selected, 0 boundary events recorded, 0
artifacts persisted.** The fast path does exactly what V3.1 proved it does.

**The cost is the process-wide `async_hooks` tax, and it is paid permanently
once capture has been activated — even when zero capture work is performed.**

The decisive measurement is `ARMED_UNMATCHED_ONLY`: `alsEnabled=true`,
activation 150, **0 selected and 0 events during measurement**, yet median
throughput **1488.1 rps against OFF_MIXED 1578.4 rps (−5.7%)** and unmatched
p95 **+5.07%**. Nothing was captured. The process was simply slower for having
captured something earlier.

The degradation is close to flat in armed rate, which is what identifies the
tax rather than the selected work as the dominant term:

| Armed traffic | Unmatched p95 (paired) | Throughput (paired) |
|---|---|---|
| 0% (armed, never matched) | +5.07% | −5.86% |
| 1% | +3.22% | −5.54% |
| 10% | +6.63% | −7.74% |
| 25% | +10.09% | −9.59% |

Going from 0% to 25% armed adds only ~3.7 pp of throughput cost; the first
~5.9 pp is present before a single request is selected.

**Mechanism.** `AsyncLocalStorage` is enabled lazily by the first selected
request and can never quiesce again while a route remains armed, because
`hasActivePreArm()` reports the pre-armed rule set as live arming. Once
activated, the process pays `async_hooks` propagation on every request
forever.

**Relation to V3.1.** V3.1 measured this configuration at −1.14% throughput —
but in a process that had **never activated capture**, and on a contended host.
That number is not comparable and does not survive. V3.2 supersedes it. The
V3.1 "route targeting is near-free" conclusion was true only of the
never-activated state, which is not a state any deployed system stays in.

## Gate 2 — Session-Credential Safety (PASS)

### Where raw credential data entered

`results/session-location.json`, measured before any fix was designed:

| Location | Contents |
|---|---|
| `$.request.headers.cookie` | every cookie value, raw |
| `$.events[N].request.values[0]` | the session id reused as a bare pg parameter |
| `$.events[N].key` | the replay key derived from that parameter |

Surrogates applied: **none**. The mechanism was structurally inert.

### Session Credential Safety

| Credential Class | Capture Location | Raw Persisted | Transformation | Replay Preserved | Privacy Blocked | Status |
|---|---|---|---|---|---|---|
| Opaque session handle | cookie header + pg parameter + replay key | **No** | deterministic `[SESS:sha12]` | **Yes, exact** | No | PASS |
| Session id reused as pg lookup parameter | pg parameter + key | **No** | same surrogate as the cookie | **Yes, exact** | No | PASS |
| Signed cookie (`s:uid.SIG…`) | cookie header | **No** | none possible | n/a | **Yes** | PASS |
| JWT-shaped session token | cookie header | **No** | none possible | n/a | **Yes** | PASS |
| Same credential across request + boundary events | all sites | **No** | one stable surrogate | **Yes** | No | PASS |
| Irrelevant cookie (`theme=dark`) | cookie header | n/a | none — preserved | **Yes** | No | PASS |
| Unselected request's credential → selected incident | — | **No**, raw *or* surrogate | — | — | — | PASS |

Blocking the signature-bearing classes is the honest outcome, not an evasion:
the application *verifies* those values, so substituting a surrogate would
change application behaviour and the replay would reproduce a **different**
failure. Persisting them raw is equally unacceptable. Refusing to emit a
trustworthy reproducer is the only truthful third option, and it is explicit:
`PRIVACY_BLOCKED_SESSION_CREDENTIAL`, `executable: false`.

**Your added invariant holds.** SESS-7/8 ran at pool max 2 against concurrency
16: an unselected request's credential reached a selected incident neither raw
nor as its surrogate. A transformed foreign credential is still a cross-request
disclosure, so both were tested.

Inherited suites re-ran clean: P8/P9 **9/9**, P10 **6/6**. P10-3 and P10-6 now
report `gapTierPresent=0` where they previously reported 1 — the standalone
surrogate closed the V3 gap-tier session-cookie class. This **narrows** the gap
tier; it does not solve it. PEM, card-like and base64 shapes remain unaddressed,
and JWTs are now blocked rather than leaked.

## Gate 3 — Large-Application Determinism (PASS, as a bounded unsupported condition)

### Large Application Determinism

| Condition | Runs | Outcome Classes | Exact Rate | Earliest Divergence | Causal Intervention | Classification |
|---|---|---|---|---|---|---|
| Arm A — full pre-fix V3.1 implementation | 100 | **1** | 100/100 | none observed | baseline | no nondeterminism |
| Arm B — full post-fix V3.2 implementation | 100 | **1** | 100/100 | none observed | — | no nondeterminism |
| Arm C — V3.2 with **only** `patch-pg` reverted | 100 | **1** | 100/100 | none observed | ownership defect restored | **hypothesis refuted** |
| Offline replay (dependency truly unreachable) | 20 | **1** | 0/20 | app fails to boot | — | deterministic, fail-closed, **0 false passes** |

The V3.1 harness never exited after firing its own total timeout — the boot-poll
timer chain kept rescheduling — so a single replay could outlive its 180 s cap
by many minutes and slow runs were recorded as a second outcome class. Fixed in
the V3.2 copy; recorded outcomes are unchanged, only the time to report them.
**>6 min → 1697 ms median.**

**The pg ownership defect is not the cause.** Arm C differs from arm B in
exactly one file and still produced 100/100 exact. Causation was not inferred
from "parse-server uses pg-promise with a pool"; it was tested, and rejected.

**The real limitation, causally identified:** parse-server performs **55
dependency operations during startup**, outside any request. The capture model
records only inside-request observations, so those are absent and the
application cannot boot with its dependencies down.

**Detection moved from replay time to capture time.** Previously Rapture emitted
a reproducer it could not honour offline and only failed when someone tried to
use it. A generic detector counts dependency operations (Postgres and outbound
HTTP) before the first inbound request:

| Case | Boot dependency ops | Flagged | Offline replay supported |
|---|---|---|---|
| koa-1999 | 0 | no | yes |
| express-qs | 0 | no | yes |
| hapi-4564 | 0 | no | yes |
| **parse-server** | **55** | **BOOT_TIME_DEPENDENCY_ACCESS** | **no** |

Time and randomness are deliberately excluded from the count: they replay from
the artifact and need nothing live. An initial version counted them and produced
a **false positive on hapi-4564**, an application that replays offline 20/20.
The negative controls caught it before it reached any conclusion.

Classification: **`DETERMINISTIC_UNSUPPORTED_BOUNDARY`**.

## Gate 4 — Existing Correctness (PASS)

### Frozen Corpus Regression

Re-run in full after **every** generic change (ownership fix; redaction
rewrite; boot-time detector):

| Incident | Capture | Offline 20/20 | Portable 20/20 | Buggy Failure | Fixed Failure Absent | Wrong Failure | Secret Leak | Status |
|---|---|---|---|---|---|---|---|---|
| koa-1999 | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| koa-1998 | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| express-cookie | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| express-qs | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| fastify-32442 | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| express-semver | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| hapi-4560 | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| hapi-4564 | yes | 20/20 | 20/20 | yes | yes | 0 | 0 | SUPPORTED |
| **Total** | **8/8** | **160/160** | **160/160** | **8/8** | **8/8** | **0** | **0** | — |

Fingerprints identical to V3's: **8/8**. No fingerprint drift, so nothing was
tuned per case.

**Byte-identity with the frozen V3 tree is now 5/13.** Changed: `context`,
`patch-fetch`, `patch-http`, `patch-pg`, `persist`, `redact`, `register`,
`state`. Unchanged: `events`, `patch-time`, **`oracle/fingerprint`**,
**`oracle/normalize`**, **`replay/replay-one`** — failure identity and the
replay engine are untouched, which the 8/8 fingerprint match confirms
empirically rather than by assertion.

## Gate Summary

| Gate | Observed | Required | Pass |
|---|---|---|---|
| 1 — steady-state economics | unmatched p95 **+6.63%**, throughput **−7.74%** @10% armed; 0 contexts, 0 events | unmatched p95 ≤5%, throughput ≤5%, no service >10% | **no** |
| 2 — session safety | 9/9; 0 raw credentials; exact replay preserved; blocked classes explicit | zero raw credentials, replay intact or fail closed | **yes** |
| 3 — large-app determinism | 300/300 one class; offline 20/20 fail-closed, 0 false passes; detected at capture time | 20/20 exact after generic fix, **or** causally named + deterministically detected | **yes** |
| 4 — existing correctness | 8/8, 160/160, 160/160, 8/8, 0, 0, fingerprints 8/8 | all frozen gates intact | **yes** |
| — ownership isolation | defect reproduced without fix; clean with fix; single variable | boundary observations belong to the issuing request | **yes** |
| — no-retroactive-capture | 9/9 | all proofs hold | **yes** |

## Required Answers

1. **Does unmatched traffic remain near OFF after the process has already
   captured many targeted requests?** **No.** It costs +6.63% p95 and −7.74%
   throughput at 10% armed, against ≤5% gates, failing under both estimators.
   V3.1's near-free result held only for a process that had never activated
   capture.
2. **What portion of remaining cost is constant vs indirect contention?**
   **Overwhelmingly constant.** −5.86% throughput is present at **0% armed
   traffic**, with 0 requests selected and 0 events recorded. Going from 0% to
   25% armed adds only ~3.7 pp more. The dominant term is the activation tax,
   not the selected requests.
3. **Can raw session credentials be removed generically while exact replay
   remains trustworthy?** **Yes for opaque handles** — one deterministic
   surrogate across header, parameter and replay key, with replay verified
   exact. **No for signature-bearing credentials**, by construction.
4. **Which credential-dependent incidents must be privacy-blocked?** Those
   carrying a credential the application cryptographically verifies: signed
   cookies and JWT-shaped tokens. They fail closed as
   `PRIVACY_BLOCKED_SESSION_CREDENTIAL`.
5. **What exactly causes parse-server's two replay outcome classes?** Nothing —
   they do not exist. It was a harness lifecycle defect. 300/300 exact, one
   class, across three arms.
6. **Is that cause inside or outside the declared boundary?** The *measurement*
   defect was in the experiment harness. The genuine limitation — 55 dependency
   operations during startup — is **outside** the boundary, which records only
   inside-request observations.
7. **Can unsupported nondeterminism be detected fail-closed before a trusted
   artifact is emitted?** **Yes.** Flagged at capture time as
   `BOOT_TIME_DEPENDENCY_ACCESS` with `offline_replay_supported: false`, with
   three negative controls confirming it does not over-trigger.
8. **Did any generic correction change the frozen 8-case results?** **No.** 8/8,
   160/160, 160/160, 8/8, fingerprints 8/8 after every change.
9. **What exact deployment boundary is now supported?** Single-process Node ≥22
   on a `node:http`-compatible stack (express 4, koa 3, fastify 5, hapi 21),
   Postgres via `pg`, outbound `fetch`; capture selected by route/operation
   targeting or a bounded armed window; failures recurring on the targeted key;
   applications that **start without their dependencies** — with those that do
   not now explicitly flagged rather than silently unsupported. Session-bearing
   incidents are supported for opaque handles and refused for
   signature-bearing credentials. **The economics of this boundary under mixed
   traffic remain unmeasured.**
10. **Is there any capture-mechanism question important enough to justify
    V3.3?** **Yes, exactly one**, and it is narrow and falsifiable — see
    Decision below. It is not a backlog of possible improvements.
11. **Should Rapture proceed to V4?** **Not yet.** Acquisition is correct,
    private and bounded, but a deployment that costs ~6–8% of a service's
    throughput indefinitely after its first capture is not the product promise
    V4 would be testing.

## Decision

Three gates pass and one fails, so `CONTINUE` is not available.

`KILL` requires that route-targeted mixed-traffic economics are **not
production-plausible**. That is not what the evidence shows. The miss is 1.6 pp
on p95 and 2.7 pp on throughput against gates set at 5%, the work-avoidance
property is perfect, and the cost has a single identified mechanism rather than
being diffuse or structural to the capture model.

`MODIFY` requires exactly one narrow, newly identified boundary whose causal
mechanism is known and which one final falsifiable experiment could settle.
That is precisely the situation.

### The one remaining blocker

**`AsyncLocalStorage` cannot quiesce while a route is armed, so the
process-wide `async_hooks` cost is paid permanently after the first capture.**

`state.maybeQuiesceAls()` already exists and already knows how to disable the
storage when nothing needs request context. It is blocked by
`selector.hasActiveArming()`, which reports a pre-armed route rule as live
arming — permanently, by definition, because the rule never expires.

### The one experiment that settles it

Allow the storage to quiesce whenever no selected request is in flight, even
while a route remains armed, re-enabling it lazily at ingress on the next match
(the mechanism `runSelected` already uses). Then re-run **this identical
Phase 1 campaign** — same manifest, same thresholds, same estimators.

- If unmatched p95 ≤5% and throughput degradation ≤5% at 10% armed, Gate 1
  passes and capture research ends.
- If it does not, the `async_hooks` tax is structural under any arming model,
  and route-targeted capture is economically dead. That is a `KILL`, and it
  would be the correct one.

This is justified as a further infrastructure experiment — rather than more
open-ended research — because it is a single named code path, with a single
predicted direction, evaluated against thresholds that are already frozen, and
it can return `KILL` as readily as `PASS`. No other capture-mechanism
question is open: correctness, privacy, ownership, unsupported-condition
detection and the frozen corpus are all settled and regression-tested.

**V3.3 is not proposed for any other reason, and no other improvement is
bundled into it.**

## Artifact Index

| Artifact | Path |
|---|---|
| V3.1 checkpoint verification | `results/v31-checkpoint-verification.json` |
| Protocol manifest + hash | `manifests/V3.2-MANIFEST.json`, `manifests/manifest.sha256` |
| Frozen implementation tree | `results/impl-freeze.json` |
| Quiescence protocol + criteria revision | `scripts/quiescence.mjs`, `results/quiescence-criteria-revision.json` |
| Measured idle floor + inventory | `results/idle-floor.json` |
| Discarded-run audit | `results/invalid-environment-audit.json` |
| Phase 1 deferral | `results/phase1-deferral.json` |
| pg ownership differential | `results/ownership-isolation.json` |
| Session credential locations | `results/session-location.json` |
| Session credential safety | `results/session-safety.json` |
| Privacy (new modes, P8/P9) | `results/privacy-newmodes.json`, `results/no-retroactive-capture.json` |
| parse-server 300-replay diagnosis | `results/parse-server-diagnosis.json` |
| parse-server offline determinism | `results/parse-server-offline.json` |
| Unsupported-condition detection | `results/unsupported-detection.json` |
| Frozen corpus regression | `results/regression-8/summary.json`, `gates.json` |

All V3.2 work is left **uncommitted** for review.

RAPTURE_REPRODUCER_V3_2_STATUS=MODIFY
