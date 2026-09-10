# Rapture Reproducer V3.1 — Selective Capture, Targeted Arming & Deployment Strategy

*Part I below is the first V3.1 campaign. **Part II** answers the selective-capture
brief and carries the final status line for the experiment as a whole.*

## Executive Summary

V3 ended with the executable-incident mechanism working but undeployable:
always-on capture cost roughly +22% p50 and -14% throughput, which capped the
supported boundary at "sampled or selective capture" and left the actual
deployment question open. V3.1 answers it.

**Rapture can be left installed at essentially no cost, and still obtain exact
executable incidents.** An unarmed detector-only fast path measures **+2.56%
p50, +0.38% p95 and -1.14% throughput** against the frozen V3 always-on control
at **+19.22% / +15.57% / -15.79%** on the same three services. All five
detector-only hard gates pass, including the 95% bootstrap interval. That
**+0.38% is estimator-sensitive** — see Independent Verification below; the
robust reading is the pooled 95% upper bound of **+9.24%** against a <=10% gate,
not ~0.4%. When a
failure is observed, a cheap generic detector arms high-fidelity capture for
matching traffic, and the **next** occurrence becomes the artifact.

**Those later-occurrence artifacts are exactly as good as V3's.** 80/80 exact
offline replays with the dependency stopped and a dead database, 80/80 portable
replays from isolated directories, 4/4 historical fixes confirmed, 0
wrong-failure acceptances, 0 secret leaks — and every one of the **421**
targeted artifacts produced exactly one fingerprint class per incident,
identical to the hash V3 recorded. Selective deployment costs nothing in
artifact quality. Privacy did not regress (0 gate-tier leaks), and all
no-retroactive-capture integrity proofs hold.

**Verdict: `MODIFY`, on 27 of 30 hard gates passing and three failing.**

- **1% sampling throughput: -5.46%** against a required >= -5%. Sampling's cost
  turns out to be a *step, not a slope* — 0->1% costs 4.3 pp of throughput while
  1->25% costs only 2.0 pp more — because enabling sampling at all turns on
  process-wide `async_hooks`. Sampling is **strictly dominated** by targeted
  arming at every recurring rate >= 1%.
- **Targeted p95 additional failures: 3** against a required <= 2, failing at
  exactly the 1% rate the gate targets. The cause is mechanical: the frozen
  100-request arming budget equals the expected inter-failure gap at 1%, so a
  third of windows expire and must re-arm.
- **Large application: offline replay 0/20.** parse-server (45,000 LOC) captured
  correctly through its own route with zero source changes — including the real
  `pg-promise -> pg` query the bug provokes — but **cannot boot without a live
  database**, because it does schema work at startup, outside any request, where
  the frozen capture never looks. Relaxing that obstacle so the database is
  reachable at startup still gives only **16/20 with two outcome classes**, so
  **exactness itself did not hold on this application**. Acquisition scaled to
  application size; replay did not.

**The supported region is narrower than "production failures".** One-off
incidents are **0/120** and structurally unreachable by post-detection arming
(and still cost 100 wasted instrumented requests each); 0.1% failures reach only
30-40%. What is solidly supported is **recurring backend failures at >= 1% of
matching traffic**, in single-process Node services that can start without their
dependencies.

Six protocol amendments are recorded, including **two harness defects found
mid-campaign and fully re-run** — a sampler-seed collision that had been making
random sampling look far better than it is, and a metric bug that miscounted
passing reducer trials as wrong-failure acceptances. Both are disclosed in
`results/protocol-amendments.json`; the first discarded evidence that flattered
a strategy.

Next: size the arming budget from the observed failure rate, and extend capture
to boot-time dependency observations. Not V4 yet.

## V3 Review Closure

Before any V3.1 work began, V3 was re-derived from its committed protocol
rather than trusted from its prose.

- **Frozen hashes reconcile.** Capture tree recomputed
  `8a8ef009d19a7345514d87c41a1133c89674dbc08ef4306dc51bf0fdd1da7fbf`; protocol
  manifest recomputed
  `e1734dcbf488d3c7e705d2217a1ec973de5180ab2e43e96d6d2640a883466b7b`; frozen
  corpus recomputed
  `9c139c36ba0432cb40b90ab97fa4dfb640258460963c111807d72886bcd8382a`. All three
  match the values recorded in `experiments/reproducer-v3/results/`.
- **Required tests re-run green.** The V2 suite (`test/capture-v2.test.js`)
  passes 20/20 under Node v22.14.0. V3 had **no unit suite of its own** — its
  frozen tree was evidenced by the V2/V3 equivalence check plus the headline and
  privacy campaigns. That gap is recorded rather than papered over; V3.1 carries
  a dedicated 31-test suite.
- **V2/V3 capture equivalence re-verified**: `EQUIVALENT` (same fingerprint,
  event count and replay keys).
- **Complete post-amendment headline rerun.** All 8 cases re-run from a cleared
  summary under the final fixture state: 8/8 AUTO_CAPTURE_SUPPORTED, 160/160
  offline exact, 160/160 portable exact, 40/40 with the fake dependency stopped
  and a dead PGPORT, 8/8 FIX_CONFIRMED, 0 wrong-failure acceptances, 0 secret
  leaks. Every fingerprint, atom count, artifact byte count, reducer-trial count
  and gate value is identical to the values V3 reported; only `artifact_sha`
  differs, because artifacts embed run-volatile fields (`captured_at`, `req_id`,
  `capture_hash`, recorded time draws).
- **Privacy re-run.** Headline secret audit: 0 raw leaks, 0 PII violations,
  surrogate `[SESS:196daafb6c79]` deterministic across files and across runs.
  Gate-tier attack suite: 8 captures, 0 gate leaks, 0 PII violations, 0 replay
  failures, 0 divergences. The gap tier (JWT/PEM/card/bare-password/base64)
  still leaks raw and is still an unsolved boundary finding, not a pass.
- **koa #1998 amendment** is now recorded machine-readably as
  `PROTOCOL_AMENDED_AND_FULLY_RERUN` in
  `experiments/reproducer-v3/results/headline/protocol-amendments.json`, together
  with the pre-freeze generic flowing-mode fix in `patch-http.mjs`.
- **Headline evidence description tightened.** The V3 report now states
  explicitly, in its Executive Summary, that each case is a real historical bug
  in a real repository exercised through that project's real framework entry
  path, wrapped in **experiment-authored service scaffolding** of ~35–60 LOC —
  **not eight untouched production applications**.

**V3 verdict preserved: `MODIFY`.** Nothing in the re-verification upgrades it
and no threshold was moved.

## Frozen V3 Result

V3 frozen commit: **`c8bb365d71a70f1c1ef5d9a98efb83d7243c5ded`**
(`research: validate real-service executable incidents v3 (MODIFY - selective
capture only)`). The V3.1 branch
`research/minimal-executable-reproducer-v3-1-selective-capture` was created from
exactly that commit.

V3's unresolved question, in its own words: always-on full-traffic interception
costs a structural ~+22% p50 and ~−14% throughput, which "caps deployment scope
to sampled/selective capture until the structural interception cost is
addressed."

## V3.1 Research Question

Can Rapture remain almost invisible on normal production traffic while still
obtaining exact executable incidents quickly enough when failures occur?

## Preregistered Protocol

`experiments/reproducer-v3-1/manifests/V3_1-MANIFEST.json`, sha256
**`b94cd5f72e28d75f6647066df030cf1bbe6cd56cccc38989cf1ec00ac744f5e3`**
(recorded in `results/manifest.hash`), frozen **before any implementation,
calibration or measurement work**. It pins the three deployment strategies,
detector semantics and its forbidden-while-unarmed list, sampling semantics,
arming policy, recurrence workloads and failure profiles, performance
methodology and statistics, capture-efficiency metrics, large-application
eligibility, every hard gate and threshold, the anti-goalpost rules, and the
decision rules.

Three protocol amendments were recorded, all made **before the relevant results
were observed**, in `results/protocol-amendments.json`:

1. **koa-1999 is not probabilistic-capable** under the preregistered incident
   key (detail in "Failure Recurrence Methodology").
2. **Per-profile request budgets** for recurrence trials, uniform across
   strategies, replacing a flat 20000-request runway that did not fit the
   runtime budget.
3. **The sampling capture-probability map is measured on one incident**, since
   ingress selection cannot see which bug is failing.

## Why Failures Cannot Be Captured Retroactively

This is the constraint the whole experiment is built around, and the one a
dishonest version of this result would quietly violate.

To replay a failure exactly, the artifact must contain what the request
*observed* while it ran: the rows Postgres returned, the bodies outbound HTTP
returned, the clock and randomness draws it consumed. Those observations exist
only at the moment each boundary call returns. Once the response has been sent,
they are gone — the process kept no copy, because keeping a copy for every
request is precisely the always-on cost V3 measured at −16% throughput.

Therefore:

- **Capture selection must happen at ingress**, before the application handler
  runs. V3.1 decides in the `node:http` request listener, before
  `listener.call(this, req, res)`.
- **A request not selected at ingress can never become an executable
  incident**, however it ends. There is no code path that upgrades it.
- **A cheap detector can only arm capture for future traffic.** Under targeted
  arming the first failure is *not* executable; the artifact comes from a later
  matching occurrence.

Any strategy claiming to "always capture failures" is either paying always-on
interception cost, or is not producing exact artifacts. Phase 9 exists to prove
V3.1 is not cheating, and its four proofs are gates: a failure there is
`INVALID_EXPERIMENT`, not a bug.

## Deployment Strategies

| Strategy | Selection rule | Purpose |
|---|---|---|
| **A — Always-on** | every non-exempt request is selected at ingress | control; this is frozen V3 |
| **B — Random ingress sampling** | Bernoulli draw at ingress, rate p ∈ {1%, 5%, 10%, 25%}, deterministic seeded RNG | trade steady-state cost against capture probability |
| **C — Targeted arming** | cheap detector on all traffic; an observed failure arms full capture for subsequent requests with the same key until an incident is captured or the window closes | obtain incidents without paying for always-on capture |

Detector semantics (frozen): the only observations permitted while a request is
unselected are its HTTP method, its pathname, the lexically normalized pathname,
and `res.statusCode` at response finish. The incident key is
`method + normalized path`. Explicitly forbidden while unarmed: entering the
capture AsyncLocalStorage, recording any pg result, tee-ing any outbound fetch
body, recording any time/random draw, buffering request or response bodies,
wrapping `res.write`/`res.end`, serializing, redacting, hashing, or persisting
anything.

Arming policy (frozen headline configuration): TTL 300 s, request budget 100.
The window ends on first captured incident (`CAPTURED`), TTL expiry
(`TTL_EXPIRED`), or budget exhaustion (`BUDGET_EXHAUSTED`).

## Inactive Fast Path Design

V3 attributed its structural cost to AsyncLocalStorage propagation across every
async resource in a request, wrapper promise hops on pg, the `Response.clone()`
tee on every outbound fetch, and per-request body buffering. V3.1 removes all of
it from requests that are not selected, generically:

1. **The ALS is never entered for an unselected request.** `runInRequest` is
   reached only after the ingress decision returns `selected: true`.
2. **The ALS is not even *enabled*** while nothing is selected. Node enables
   `async_hooks` lazily on the first `AsyncLocalStorage.run()` and keeps it
   enabled process-wide until `disable()`. V3.1 therefore quiesces: when no
   selected request is in flight and no key is armed, it disables the storage
   after a 100 ms grace, dropping the process-wide `async_hooks` tax entirely.
3. **One boolean, not a store lookup, gates every wrapper.** `currentRequest()`
   returns `null` immediately when the ALS is not enabled, so the pg, fetch,
   `Date`, `Math.random` and `crypto.randomUUID` wrappers — which stay installed,
   so any request can be armed at any moment — take a single-comparison no-op
   branch on ordinary traffic.
4. **No response interception on the fast path.** Unselected requests get one
   `finish` listener that reads `res.statusCode`; `res.write`/`res.end` are not
   wrapped and no chunk is buffered.
5. **Bounded, allocation-free key derivation.** Path normalization and the
   composed incident key are LRU-cached (512 / 1024 entries), so after a route
   has been seen the per-request detector cost is two `Map` lookups.

Calibration was done on the **V3 calibration services only** (`perf/service-a`,
`perf/service-b`), never on a headline service, per the freeze rule.

**Frozen implementation tree hash:
`e9232b1f643934aa4cc7dff49e78c7ae23edc1af050f1e9efc2c424dc79ec45a`**
(`results/impl-freeze.json`, 14 files), frozen after calibration and before any
headline evaluation, and verified unchanged afterwards.

Only **4 of the 13 files** inherited from the frozen V3 tree were modified:
`capture/state.mjs`, `capture/context.mjs`, `capture/patch-http.mjs`,
`capture/register.mjs`. Every file responsible for **what a captured request
records** — `events.mjs`, `patch-pg.mjs`, `patch-fetch.mjs`, `patch-time.mjs`,
`persist.mjs`, `redact.mjs`, both oracle files and the replay engine — is
**byte-identical to frozen V3**. That is why V3.1 can inherit V3's correctness
and privacy evidence for a selected request, and it is verified directly:
`scripts/capture-equiv.mjs` shows the same failing request captured under frozen
V3, under V3.1 always-on, and under V3.1 sampling@1.0 produces **identical
documents** modulo run-volatile fields.

## Detector-Only Performance

Three service shapes (the same ones V3 used for headline perf: express-qs,
koa-1999, fastify-32442 at FIXED revisions, success workloads with pg and an
outbound fetch on the path), 10 independent repetitions per service per mode,
5000 measured successful requests each, 500 warm-up requests discarded,
concurrency 16, mode order randomized per repetition from a recorded seed.
Raw per-repetition files: `results/perf/phase3/` (120 files).

Median across services of per-service median-of-repetition paired overheads:

| Mode | p50 | p90 | p95 | p99 | Throughput | CPU |
|---|---|---|---|---|---|---|
| DETECTOR_ONLY_UNARMED | **+2.56%** | +0.76% | **+0.38%** | +0.01% | **-1.14%** | +2.96% |
| DETECTOR_ONLY_ALS_ENABLED *(diagnostic)* | +7.15% | +5.75% | +4.29% | +8.75% | -5.78% | +4.77% |
| V3_ALWAYS_ON_FULL *(control)* | +19.22% | +15.56% | +15.57% | +12.03% | -15.79% | +31.42% |

Pooled over all 30 service x repetition pairs, with 95% bootstrap intervals
(10000 resamples):

| Mode | p95 overhead | 95% CI | Throughput | 95% CI |
|---|---|---|---|---|
| DETECTOR_ONLY_UNARMED | +0.73% | [-0.96, **+9.24**] | -2.18% | [**-4.36**, +0.18] |
| DETECTOR_ONLY_ALS_ENABLED | +3.38% | [-0.04, +7.72] | -5.26% | [-6.82, -3.19] |
| V3_ALWAYS_ON_FULL | +17.39% | [+13.29, +21.73] | -16.09% | [-17.64, -13.53] |

**Every detector-only hard gate passes**, including the interval gates: the
bootstrap upper bound on p95 overhead is +9.24% (required <=10%) and the
worst-side throughput bound is -4.36% (required not worse than -10%).

Two further observations, both reported rather than buried:

- **The always-on control is worse here than V3 measured it.** V3's headline run
  reported median throughput -14.0% and called the gate "borderline"; with 10
  repetitions instead of 5 the same measurement gives **-16.09% with a 95%
  interval of [-17.64, -13.53]**, i.e. mostly *outside* V3's own -15% threshold.
  V3's `MODIFY` was, if anything, generous to itself.
- **ALS quiescence is worth roughly 4.5 percentage points, and is not the whole
  story.** Forcing `async_hooks` on while leaving everything else on the fast
  path costs +7.15% p50 / -5.78% throughput versus +2.56% / -1.14% quiesced. So
  disabling the AsyncLocalStorage when nothing is armed recovers about a third
  of the always-on p50 cost; the remaining two thirds are the interception work
  itself (wrappers, tee, buffering), which the fast path avoids by not doing it.

Resource cost while unarmed is indistinguishable from OFF: RSS growth per
5000-request run is 45-52 MB in every mode including OFF, and **0 artifacts were
persisted in any of the 120 runs**.

Cold start is separated and small: median boot time rises from 146-296 ms (OFF)
to 269-430 ms with the bootstrap attached, a one-time `--import` cost.

## Sampling Performance

Same methodology, 6 modes x 3 services x 10 repetitions
(`results/perf/phase4/`, 180 files).

| Mode | p50 | p90 | p95 | p99 | Throughput | CPU | Observed sampled fraction |
|---|---|---|---|---|---|---|---|
| OFF | — | — | — | — | — | — | 0% |
| DETECTOR_ONLY *(phase 3)* | +2.56% | +0.76% | +0.38% | +0.01% | -1.14% | +2.96% | 0% |
| SAMPLE_1 | +6.05% | +4.16% | +2.64% | +0.38% | **-5.46%** | +8.61% | 1.01% |
| SAMPLE_5 | +8.11% | +6.80% | +5.04% | -3.26% | -6.11% | +9.36% | 5.05% |
| SAMPLE_10 | +9.13% | +3.84% | +2.29% | -3.16% | -5.95% | +9.15% | 10.03% |
| SAMPLE_25 | +10.31% | +8.09% | +5.78% | +0.43% | -7.50% | +15.49% | 25.01% |
| V3_ALWAYS_ON_FULL | +19.62% | +18.59% | +14.94% | +6.01% | -14.36% | +31.41% | 100% |

Observed sampled fractions match the nominal rates to two decimal places, and
**0 artifacts were persisted in any run** — sampled-but-successful requests
leave nothing behind, at a scale of 50000 requests per cell.

### Overhead does not scale with the sample rate

This is the substantive result of Phase 4, and it is the opposite of the
intuition the manifest warned against assuming.

Moving from **0% to 1%** sampling costs 4.3 percentage points of throughput
(-1.14% -> -5.46%). Moving from **1% to 25%** — twenty-five times as much
capture — costs only 2.0 more (-5.46% -> -7.50%).

The cause is structural. Node enables `async_hooks` process-wide the first time
any `AsyncLocalStorage.run()` executes, and it stays enabled. Under sampling
that happens within the first hundred requests and never reverts, so **every**
request pays the context-propagation tax, not just the sampled ones. The
marginal cost of actually instrumenting a sampled request is comparatively
small. Sampling therefore buys very little over its own floor: the price is
paid for having sampling switched on at all.

### The 1% gate fails; the 5% gate passes

| Gate | Observed | Required | Pass |
|---|---|---|---|
| 1% sampling, median p95 overhead | +2.64% | <= 5% | yes |
| 1% sampling, median throughput degradation | **-5.46%** | >= -5% | **no** |
| 5% sampling, median p95 overhead | +5.04% | <= 7.5% | yes |
| 5% sampling, median throughput degradation | -6.11% | >= -7.5% | yes |

The 1% throughput gate **fails by 0.46 percentage points** while the looser 5%
gate passes, precisely because the cost is a step and not a slope. The pooled
95% interval for 1% sampling throughput is [-6.59, -3.35], so the failure sits
inside the interval and the point estimate is on the wrong side of the line.
This is reported as a failed gate. It was not re-run to obtain a better number,
and the threshold was frozen before any measurement.

## Failure Recurrence Methodology

### What a trial is

One trial is one freshly booted application process at the historical **buggy**
revision, under one deployment strategy, driven by a **sequential** stream of
HTTP requests issued over raw sockets. Sequencing is required: "the failure
occurrence on which the incident was captured" is only meaningful if occurrences
are ordered. A trial ends when an artifact is persisted (`CAPTURED`) or when the
profile's request budget is exhausted (`BUDGET_EXHAUSTED_NO_CAPTURE`). The full
budget is always issued unless an artifact appears -- the traffic *after* a
failure is exactly where targeted arming spends its instrumentation, so
truncating it would understate that cost.

### How failures are generated (audit)

This matters for interpreting every capture probability below, so it is stated
precisely rather than implied.

- **Mechanism: seeded IID Bernoulli, precomputed into a schedule.** For each
  trial a `mulberry32` stream seeded by
  `sha256(incident|profile|strategy|trialIndex)` is drawn once per request
  position, and position *i* is marked a failure iff `u_i < rate`. Draws are
  independent, so inter-failure gaps are **geometric with mean 1/rate**; the
  number of failures in a trial is Binomial(budget, rate), not a fixed quota.
  Observed counts confirm this (e.g. LOW/1% over a 2000-request budget produced
  13-23 failures across trials, against an expectation of 20).
- **The schedule is precomputed before the first request is issued.** This is
  identical in distribution to deciding per request; it exists so the harness can
  record `scheduledFailures` for the theoretical reference.
- **`ONE_OFF` is not Bernoulli.** It places exactly one failure at a position
  drawn uniformly from the budget. It models "this happened once and never
  again", which is a scenario, not a rate.
- **`DETERMINISTIC` is not Bernoulli either.** Every matching request fails.
- **Trials are independent.** Separate process, separate port, separate database
  connections, separate seed. No arming or sampling state survives a trial.
- **Seeds are frozen and derived, never chosen.** They are a pure function of
  (incident, profile, strategy, trial index). No seed was replaced, and no trial
  was re-run to obtain a different outcome. The sampler seed is derived from an
  independent hash (see V31-AMEND-4).
- **Interaction with the 100-request arming budget.** At failure rate *r* the
  expected gap to the next failure is 1/*r* requests. The frozen budget is 100.
  So at 1% the budget and the expected gap are *equal*, and a geometric gap
  exceeds its mean about 37% of the time -- which is precisely the mechanism
  behind the p95 gate failure reported below. At 5% and above the gap (20
  requests or fewer) sits well inside the budget; at 0.1% the gap (~1000) is an
  order of magnitude beyond it.

### What this does and does not license

These numbers describe **the mechanism's behaviour under a frozen IID simulator**.
Real incident arrivals are usually bursty and correlated, which would generally
*favour* targeted arming (a burst delivers the recurrence inside the window) and
disfavour uniform sampling. No claim is made here about real-world incident
distributions; the transferable quantity is the relationship between the arming
budget and the inter-failure gap, not the absolute probabilities.

### Censoring

Capture probabilities are **censored at the per-profile request budget**
(V31-AMEND-2) and must be read as "within N matching requests", never as
asymptotic probabilities. Budgets are identical across strategies within a
profile, so no strategy was given a longer runway than another.

## Targeted Arming Results

Core grid: 4 incidents x 6 profiles x 2 strategies x 30 trials = **40 cells,
1200 trials** (`results/recurrence/trials.json`, aggregated in
`results/recurrence/aggregate.json`). Executed sequentially.

| Incident | Profile | Strategy | Trials | Artifacts | P(capture) | Median add'l failures | p95 add'l | Median instrumented | Median ms |
|---|---|---|---|---|---|---|---|---|---|
| express-qs | DETERMINISTIC | targeted | 30 | 30 | 1.00 | 1 | 1 | 1 | 15 |
| express-qs | HIGH 20% | targeted | 30 | 30 | 1.00 | 1 | 1 | 3 | 30 |
| express-qs | MEDIUM 5% | targeted | 30 | 30 | 1.00 | 1 | 1 | 10 | 66 |
| express-qs | LOW 1% | targeted | 30 | 30 | 1.00 | 1 | **3** | 64 | 201 |
| express-qs | RARE 0.1% | targeted | 30 | 12 | **0.40** | 2 | 5 | 300 | 1874 |
| express-qs | ONE_OFF | targeted | 30 | **0** | **0.00** | n/a | n/a | 100 | n/a |
| fastify-32442 | DETERMINISTIC | targeted | 30 | 30 | 1.00 | 1 | 1 | 1 | 11 |
| fastify-32442 | HIGH 20% | targeted | 30 | 30 | 1.00 | 1 | 1 | 3 | 29 |
| fastify-32442 | MEDIUM 5% | targeted | 30 | 30 | 1.00 | 1 | 1 | 10 | 78 |
| fastify-32442 | LOW 1% | targeted | 30 | 30 | 1.00 | 1 | 2 | 48 | 197 |
| fastify-32442 | RARE 0.1% | targeted | 30 | 9 | **0.30** | 2 | 7 | 400 | 5801 |
| fastify-32442 | ONE_OFF | targeted | 30 | **0** | **0.00** | n/a | n/a | 100 | n/a |
| hapi-4564 | DETERMINISTIC | targeted | 30 | 30 | 1.00 | 1 | 1 | 1 | 14 |
| hapi-4564 | HIGH 20% | targeted | 30 | 30 | 1.00 | 1 | 1 | 3 | 30 |
| hapi-4564 | MEDIUM 5% | targeted | 30 | 30 | 1.00 | 1 | 1 | 13 | 131 |
| hapi-4564 | LOW 1% | targeted | 30 | 30 | 1.00 | 1 | **3** | 60 | 278 |
| hapi-4564 | RARE 0.1% | targeted | 30 | 10 | **0.33** | 2 | 6 | 300 | 883 |
| hapi-4564 | ONE_OFF | targeted | 30 | **0** | **0.00** | n/a | n/a | 100 | n/a |
| koa-1999 | DETERMINISTIC | targeted | 30 | 30 | 1.00 | 1 | 1 | 1 | 12 |
| koa-1999 | ONE_OFF | targeted | 30 | **0** | **0.00** | n/a | n/a | **0** | n/a |

Always-on control (same trials): **100% capture in 29 of 30-trial cells and
30/30 in the rest**, always on the *first* failure (0 additional), but
instrumenting every request it saw -- median 505, 862, 364, 507, 407, 994 and
547 fully instrumented requests in the ONE_OFF and RARE cells respectively.

### The first failure is never the artifact

Median additional failures is **1** in every cell at every rate at or above 1%,
across all four framework families. That is the mechanism working exactly as
designed and as the physics requires: the first failure is observed only by the
cheap detector and arms capture; the artifact comes from the next matching
occurrence. It is never 0, and at rates >=5% it is never more than 1.

### Targeted arming does not reduce instrumentation per incident

This is the most easily over-claimed result, so it is stated plainly. At LOW
(1%), targeted arming fully instruments a median of 64 / 48 / 60 requests to
obtain one artifact; always-on instruments 57 / 49 / 54 for the same artifact.
They are the same order, because **both must wait out one expected
inter-failure gap of 1/rate requests**.

The advantage of targeted arming is **not** fewer instrumented requests per
incident. It is that instrumentation happens *only inside a bounded armed
window*, so when nothing is failing the service runs on the detector-only fast
path at -1.1% throughput instead of always-on's -15.8%. The saving is temporal,
not per-incident.

### Where it stops working

- **0.1% (RARE): 30-40% capture.** The expected gap (~1000 requests) is ten
  times the frozen 100-request budget, so most windows expire before the
  recurrence. Trials that did capture typically needed a *second* re-arm
  (median 2 additional failures).
- **One-off: 0/30 in every incident, by construction.** Post-detection arming
  cannot capture a failure that never recurs. Worse, it *pays* for the attempt:
  100 fully instrumented requests per one-off in three of the four incidents.
- **Unless the failing traffic class is self-separating.** koa-1999's one-off
  cells instrumented **0** requests, because absolute-form request targets key
  as `GET http://example.com/u` and no benign traffic shares that key. When the
  failure class is distinctive, an expired arming window costs nothing.

## Random Sampling Capture Probability

Sampling grid: 1 incident (express-qs) x 6 profiles x 4 rates x 30 trials =
**24 cells, 720 trials** (`results/recurrence-sampling/`). Re-run in full after
the seed-independence defect (V31-AMEND-4); executed as four parallel shards
(V31-AMEND-5), so counts are exact and wall-clock times are upper bounds.

| Profile | 1% | 5% | 10% | 25% | **targeted (frozen policy)** |
|---|---|---|---|---|---|
| DETERMINISTIC | 43% @ 50th failure | 100% @ 11th | 100% @ 7th | 100% @ 4th | **100% @ 2nd** |
| HIGH 20% | 63% @ 23rd | 100% @ 15th | 100% @ 8th | 100% @ 4th | **100% @ 2nd** |
| MEDIUM 5% | 40% @ 24th | 93% @ 19th | 100% @ 9th | 100% @ 3.5th | **100% @ 2nd** |
| LOW 1% | 7% @ 2nd | 57% @ 7th | 93% @ 5th | 100% @ 3rd | **100% @ 2nd** |
| RARE 0.1% | 7% | 33% | 47% | **73%** | 40% |
| ONE_OFF | **0%** | **0%** | **7%** | **27%** | **0%** |

(Cell format: empirical capture probability within the profile's request budget
@ median failure occurrence at which capture happened. Full per-cell metrics,
including p95 and the theoretical 1-(1-p)^n reference, are in
`results/recurrence-sampling/aggregate.json`.)

### Is any sampling regime non-dominated by targeted arming?

**For recurring failures at 1% and above: no, sampling is strictly dominated.**
It needs 3 to 50 failure occurrences where targeted arming needs 1, it captures
less often, *and* it costs -5.5% to -7.5% steady-state throughput against the
detector-only fast path's -1.1%. There is no rate at which it wins on both axes,
or on either axis alone.

**For the two regions targeted arming cannot serve: yes.**

- **One-off failures.** Targeted arming captures 0/30, structurally. Ingress
  sampling captured 2/30 at 10% and **8/30 (27%) at 25%** — close to the 25%
  a single Bernoulli draw predicts, which is exactly what it should be, because
  for a single failure the capture probability *is* the sampling rate. This is
  the only mechanism in the experiment that can ever capture a first occurrence.
- **0.1% (RARE).** 25% sampling captured **73%** against targeted arming's 40%
  under the frozen 100-request budget, because sampling does not care how far
  apart the failures are while an arming window does.

Both wins are bought with continuous overhead on all traffic, forever, for an
incident that may never arrive. That is the trade, stated plainly; it is not a
recommendation.

### Instrumentation cost of sampling

Sampling instruments a fixed fraction of everything: over the 50000-request
performance runs it fully instrumented 507, 2526, 5016 and 12506 requests at
1/5/10/25%. Targeted arming instrumented **1 to 64** requests per captured
incident and **zero** at all other times.

## Time To Executable Incident

Reported for completeness and with an explicit caveat. Median milliseconds from
the first observed failure to a persisted artifact, targeted arming, core grid
(sequential execution): DETERMINISTIC 11-15 ms, HIGH ~30 ms, MEDIUM 66-131 ms,
LOW 197-278 ms, RARE 883-5801 ms.

This quantity is dominated by *how many requests must arrive before the next
failure*, not by any cost inside Rapture, so it scales with the workload's
request rate and is not a property of the mechanism. **Request and failure
counts are the comparable metrics**, and the sampling grid's timings were
measured under 4-way parallel execution and are upper bounds that must not be
compared against the sequentially-measured targeted timings.

## Fully Instrumented Requests Per Incident

| Profile | Targeted (median per artifact) | Always-on (median per artifact) |
|---|---|---|
| DETERMINISTIC | 1 | 1 |
| HIGH 20% | 3 | 2.5-5 |
| MEDIUM 5% | 10-13 | 10-23 |
| LOW 1% | 48-64 | 49-57 |
| RARE 0.1% | 300-400 | 507-994 |
| ONE_OFF | 100 (wasted, no artifact) | 364-547 |

Per incident the two strategies are comparable, because both wait out one
expected inter-failure gap. The difference is what happens the rest of the time:
always-on instruments every request forever, targeted instruments nothing
outside an armed window.

## One-Off Failure Limitation

Stated without softening, because it is the sharpest limit on the product.

**Targeted arming captured 0 of 120 one-off failures** (30 trials x 4
incidents). This is not a tuning shortfall and no budget or TTL can fix it: the
first occurrence is observed only by the cheap detector, and there is no second
occurrence to capture. The physics in "Why Failures Cannot Be Captured
Retroactively" applies directly.

It is also not free. In three of the four incidents the detector armed on the
one-off and then spent its full **100-request budget fully instrumenting benign
traffic** before expiring with `BUDGET_EXHAUSTED` and nothing to show. The
exception is koa-1999, where the failing absolute-form request target keys
separately from ordinary traffic, so the armed window matched **0** subsequent
requests and cost nothing.

The only mechanism that captured any one-off was ingress sampling, at 27% for a
25% rate — and it charges every request in the service, permanently, for that
27%.

## Targeted Correctness

This is the question the whole deployment change hangs on: an artifact produced
by targeted arming comes from a **later occurrence** than the failure that
revealed the problem. Is it as good as one V3 captured by instrumenting
everything?

Method: for each incident, the first targeted artifact from the core grid, put
through exactly the V3 standard with the **fake external dependency stopped**
and a **dead PGPORT**, using the frozen GREEDY reducer unchanged.

| Incident | Family | Fingerprint | Matches V3 hash | Offline | Classes | Atoms | Bytes | Reducer trials | Wrong accepts | Portable | Fixed rev | Fix | Leaks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| express-qs | express | ERR:E_QS_LIMIT_BYPASS | yes | **20/20** | 1 | 2/4 | 3055 | 4 | 0 | **20/20** | 400 | FIX_CONFIRMED | 0 |
| fastify-32442 | fastify | ERR:E_VALIDATION_BYPASS | yes | **20/20** | 1 | 2/4 | 2927 | 4 | 0 | **20/20** | 400 | FIX_CONFIRMED | 0 |
| hapi-4564 | hapi | ERR:E_HOST_PARSE | yes | **20/20** | 1 | 3/5 | 3126 | 5 | 0 | **20/20** | 200 | FIX_CONFIRMED | 0 |
| koa-1999 | koa | ERR:E_URL_MISMATCH | yes | **20/20** | 1 | 2/4 | 2963 | 4 | 0 | **20/20** | 200 | FIX_CONFIRMED | 0 |

**80/80 exact offline replays, 80/80 portable replays, 4/4 FIX_CONFIRMED, 0
wrong-failure acceptances, 0 secret leaks, 0 absolute-path leaks, one outcome
class per incident.**

Two properties deserve emphasis:

- **Fingerprint identity with V3.** Every targeted artifact's fingerprint hash
  equals the hash V3 recorded for the same historical incident. Across all
  **421** targeted artifacts produced by the core grid, each incident yielded
  exactly **one distinct fingerprint**, identical to V3's. The mechanism
  captures *the same historical failure*, not merely "a 500 on that route".
- **Selective deployment costs nothing in artifact quality.** Artifact sizes
  (2927-3126 bytes) and atom counts (2/4, 2/4, 3/5, 2/4) match V3's headline
  artifacts for the same incidents. Capturing a later occurrence produces the
  same object.

### A metric defect found and corrected

The first run of this phase reported 2 wrong-failure acceptances per incident.
That was a defect in the analysis script, not the mechanism: the frozen reducer
records `fingerprint_hash: r.fingerprintHash`, but the trial function returned
`{pass, fingerprint: {...}}` with no `fingerprintHash` field, so the reducer
logged `undefined` and **every passing trial** was counted as a wrong
acceptance. Both runners were corrected to expose the field and the phase was
re-run; the true count is 0. It is also structurally guaranteed: `pass` is
*defined* inside the frozen oracle as fingerprint-hash equality, so a passing
trial with a different fingerprint cannot exist.

## Privacy Regression

The frozen V3 gate-tier attack suite, re-pointed at the V3.1 implementation and
run with every sentinel request selected, plus V3.1-specific checks that V3
could not perform because V3 captured everything.

| Check | Observed | Required | Pass |
|---|---|---|---|
| Raw gate-tier secret leaks (8 attack captures + artifacts) | 0 | 0 | yes |
| PII in credential slots | 0 | 0 | yes |
| Replay failures caused by redaction | 0 | 0 | yes |
| Replay divergences | 0 | 0 | yes |
| Detector-only retains no sensitive request metadata | 0 sentinels, 0 artifacts | 0 | yes |
| Detector-only state is counters + normalized keys only | 629 bytes, no header/cookie/query text | — | yes |
| Targeted arming state contains no credentials, bodies or query strings | 0 sentinels; armed key `POST /boom` carries no query | 0 | yes |
| Sampled-but-successful requests persist nothing | 10 selected, 0 artifacts | 0 | yes |
| Secret sentinels absent from targeted artifacts | 0 | 0 | yes |

Sentinels were planted in every carrier the detector could plausibly touch —
`Authorization` header, `x-api-key`, session cookie, query string and JSON body
— and none reached detector state, arming state, or any artifact. At scale, the
performance campaigns persisted **0 artifacts across 300 runs** (120 in Phase 3,
180 in Phase 4), confirming that neither unarmed nor sampled-successful traffic
leaves anything behind.

**The V3 gap tier is unchanged and explicitly unsolved**: JWTs in free text,
PEM blocks, card-like values, bare password values and base64-encoded secrets
still appear raw. V3.1 makes no claim to have addressed them, and secret-gated
incidents remain outside the supported boundary.

The privacy result transfers with unusually strong warrant here: of the 13 files
inherited from the frozen V3 capture tree, the four V3.1 modified are
`state.mjs`, `context.mjs`, `patch-http.mjs` and `register.mjs`. Every file that
determines **what a captured request records** — `events.mjs`, `patch-pg.mjs`,
`patch-fetch.mjs`, `patch-time.mjs`, `persist.mjs`, `redact.mjs`, both oracle
files and the replay engine — is **byte-identical to V3**.

## No-Retroactive-Capture Integrity Proof

A failure in this section would mean the experiment had invented impossible
production semantics. All nine checks pass
(`results/no-retroactive-capture.json`).

| Proof | Observed | Pass |
|---|---|---|
| An unsampled one-off failure produces no full executable incident | status 500, 0 artifacts, 0 boundary events recorded | yes |
| A detector-only first failure carries no pg/fetch/time/random observations | 0 events, 0 capture contexts entered, 0 artifacts | yes |
| Arming after a failed response does not retroactively populate boundary events | 1 arm event, 0 artifacts | yes |
| The artifact comes from a LATER request selected at ingress | 1 artifact, exactly 1 request selected, kinds pg+http+time | yes |
| The captured occurrence is the second failure, not the first | failures observed 1 + captured 1 | yes |

The unit suite adds four structural proofs: `selectAtIngress` is a pure function
of `(method, pathname)` and cannot observe a status because none exists yet;
observing a failure never increments `requestsSelected`; different routes and
different incident keys never share arming state; and one armed request racing
20 unarmed ones yields exactly one incident containing **zero** boundary events
from the concurrent traffic.

**V3.1 required test suite: 31/31 pass.**

## Budget Sensitivity Sweep (SENSITIVITY ANALYSIS — NOT A GATE)

The frozen arming policy is TTL 300 s, budget 100, and its p95
additional-failures result is the gate. This sweep exists only to explain the
mechanism behind that failure. **It cannot and does not convert the failed gate
into a pass.** Scope and execution conditions are recorded in V31-AMEND-6.

express-qs, 30 trials per cell, at the two profiles where the budget matters:

| Profile | Setting | Capture | Median add'l | p95 add'l | Median instrumented | Windows exhausted |
|---|---|---|---|---|---|---|
| LOW 1% | budget 10 | 24/30 (80%) | 5 | 17 | 78 | 27/30 |
| LOW 1% | **budget 100 (FROZEN)** | **30/30 (100%)** | **1** | **3** | **64** | **10/30** |
| LOW 1% | budget 100, TTL 30 s | 30/30 (100%) | 1 | 4 | 76 | 14/30 |
| LOW 1% | budget 1000 | 30/30 (100%) | 1 | **1** | 81 | **0/30** |
| RARE 0.1% | budget 10 | 1/30 (3%) | 4 | 4 | 50 | 30/30 |
| RARE 0.1% | **budget 100 (FROZEN)** | **12/30 (40%)** | 2 | 5 | 300 | 27/30 |
| RARE 0.1% | budget 100, TTL 30 s | 10/30 (33%) | 3 | 6 | 400 | 29/30 |
| RARE 0.1% | budget 1000 | **29/30 (97%)** | 1 | 2 | 386 | 7/30 |

Three things this establishes:

1. **The request budget is the binding constraint; the TTL never is.** Cutting
   the TTL from 300 s to 30 s changed nothing meaningful (LOW 100% -> 100%,
   RARE 40% -> 33%), because at these request rates the budget is always
   exhausted long before the clock runs out.
2. **The budget must exceed the expected inter-failure gap of 1/rate.** At 1%
   the gap and the frozen budget are both ~100, so a geometric gap overshoots
   its mean often enough to force a re-arm — exactly the p95 of 3. At 0.1% the
   gap is ~1000, ten times the budget, and capture collapses to 40%. Setting
   the budget an order of magnitude above the gap restores near-certain capture
   (100% and 97%) with p95 additional failures of 1 and 2.
3. **The budget is a cap, not a spend.** Raising it 10x at LOW moved median
   fully instrumented requests only from 64 to 81, because the window closes on
   *capture*, not on budget. A generous budget costs almost nothing when the
   failure recurs; it costs only when it does not.

The operational consequence is that a deployable version of this mechanism
would size the arming budget from the observed failure rate rather than fixing
it at a constant. That is a design change, not a result, and V3.1 does not claim
it as one: the frozen policy is what was measured and its p95 gate failed.

## Large Application Screening

Six substantial public Node backends were screened
(`large-app/screening.json`): directus, nocodb, payload, etherpad-lite, tooljet
and parse-server. Five were excluded with recorded reasons — Next.js-coupled
HTTP entry (payload), WebSocket/session-centric behaviour outside the frozen
boundary (etherpad-lite), and no pinnable single-request historical bug with
runnable buggy/fixed revisions inside the experiment's budget (directus, nocodb,
tooljet).

**parse-community/parse-server was eligible and was pursued.** 192 source files,
~45,400 LOC, 840 installed packages, a real express application mounted by
`ParseServer`, Postgres reached through `pg-promise` -> `pg`. Historical bug
#10308, "Postgres query on a Parse internal field with no database column
returns 500 instead of an empty result", fixed in `c5c4325`; buggy revision
`3f888b1` (its parent). Both revisions were built with the project's **own**
build script into isolated git worktrees. No application source was edited and
no experiment-authored route implements the bug.

## Large Application Result

**Capture worked. Offline replay did not. The gate fails.**

### What worked

parse-server was started through its **normal application entry point** with the
generic bootstrap and nothing else — `node --import register.mjs`, plus
environment variables. Under targeted arming:

- the **first** failure on `GET /parse/classes/_User` armed capture and produced
  **no artifact**, exactly as the mechanism requires;
- a **later** matching failure was selected at ingress and became the artifact;
- the incident key the detector derived was the application's own route,
  `GET /parse/classes/_User`, with no route table supplied by anyone;
- the capture contains **12 boundary events** including the real Postgres query
  the historical bug provokes:
  `SELECT * FROM "_User" WHERE "_tombstone" IS NOT NULL LIMIT 100`.

That last point matters: parse-server reaches Postgres through **pg-promise**,
which calls the pg `Client`'s own callback-style `query()`. The frozen
`Module._load` hook intercepted it with no application change and no adapter.
Burden: **0 application source LOC changed, 0 bug-specific wrappers, 0
bug-specific assertions, 0 manually supplied causal facts.**

Baseline was established first, without Rapture attached: buggy revision
`3f888b1` returns **500**, fixed revision `c5c4325` returns **200
`{"results":[]}`**.

### What failed, and why

The artifact does **not** satisfy the frozen offline-replay gate. The
application **cannot boot at all** without a live Postgres: `ParseServer.start()`
performs schema bootstrap during startup, and the connection is refused. This
was confirmed at a 25-second allowance and again at 120 seconds — it is a
connection refusal, not a timeout.

The frozen capture records boundary observations made **inside a captured
request**. Startup work happens outside any request, so there is nothing
recorded that could serve it. The small V3 headline services never exposed this,
because they create a lazy `pg.Pool` and touch the database only inside
handlers.

### Where exactly the boundary sits (diagnostic, NOT a gate result)

To locate the limitation precisely, the same artifact was replayed with the
database reachable **at startup only**, the captured request still served
entirely from the artifact.

| Condition | Result |
|---|---|
| **GATE — database dead (`DATABASE_URI` on a closed port)** | **0/20 — application does not boot (ECONNREFUSED at startup)** |
| DIAGNOSTIC — database reachable at startup, request served from the artifact | **16/20, 2 outcome classes** |

Two things follow, and the second is the more damaging.

**Boot-time dependency access is a hard blocker.** With the database dead the
application never starts, so the artifact can never be exercised at all. This
was reproduced at a 25-second allowance and again at 120 seconds; it is a
connection refusal, not a timeout.

**Even with that removed, replay is not deterministic.** Relaxing the condition
so the database is reachable at startup — with the captured request still served
entirely from the artifact — yields **16/20, not 20/20**, across **two** outcome
classes. An early 3-trial spot check had come back 3/3, which is exactly why the
full 20-repetition protocol exists: the small sample was luck. The V3 headline
services produced a single outcome class in 160/160 replays and the V3.1
targeted artifacts produced a single class in 80/80; this application does not.

Because the diagnostic did not reach 20/20, the reduction, portable-replay and
fix-discrimination stages were **not** run — the pipeline stops at the first
stage that fails rather than reporting downstream numbers built on an unstable
base. The second outcome class was not characterized within the experiment's
budget, and no claim is made about its cause.

### A second finding about the offline proof itself

V3's offline guarantee is enforced by setting `PGPORT=54399`. That is a libpq
environment variable and has **no effect whatsoever** on an application that
connects through an explicit `DATABASE_URI` connection string — parse-server
simply ignored it and, when `DATABASE_URI` was also omitted, fell through to its
Mongo adapter. The dead-port guard as written does not generalize beyond
libpq-style configuration, and the large-application case is what exposed it.

### Verdict on this case

Per the frozen protocol this is a **real negative result on an eligible large
application**, and it is neither replaced nor reweighted. An eligible case was
found, pursued, and it failed the gate.

The result splits cleanly in two, and both halves are informative:

- **Acquisition scales.** Targeted arming, generic key derivation, and
  dependency interception through `pg-promise` all worked on a 45,000-LOC
  application with zero source changes and zero bug-specific code. Nothing about
  the *capture* side needed the application to be small.
- **Replay does not.** The artifact is not self-contained for an application
  that touches its dependencies at startup, and even with that obstacle removed
  it reproduced only 16/20 with two outcome classes. Exactness — the property
  every earlier phase established at 160/160 and 80/80 — **did not hold here.**

This is the most consequential negative in V3.1. It means the exactness
guarantee demonstrated on the headline corpus has been shown to hold for
service-scaffolded incidents and **not yet** for a real application of
substantial size.

## Gate Summary

**27 of 30 hard gates pass. Three fail.** Machine-readable in `results/gates.json`.

| Question / Gate | Frozen Requirement | Observed | Pass | Interpretation |
|---|---|---|---|---|
| Preregistered manifest unmodified | hash matches | `b94cd5f7…` | yes | thresholds are the ones frozen before implementation |
| Frozen implementation unchanged | unchanged since freeze | `e9232b1f…` | yes | no post-freeze implementation change |
| Detector-only median p50 overhead | <= 5% | **+2.56%** | yes | steady-state latency of leaving Rapture installed |
| Detector-only median p95 overhead | <= 5% | **+0.38%** | yes | tail cost while unarmed |
| Detector-only p95, 95% bootstrap upper bound | <= 10% | **+9.24%** (pooled n=30) | yes | the gate is on the interval, not the point estimate |
| Detector-only median throughput degradation | >= -5% | **-1.14%** | yes | near-invisible steady state |
| Detector-only throughput, bootstrap worst side | >= -10% | **-4.36%** | yes | worst plausible unarmed cost |
| 1% sampling median p95 overhead | <= 5% | +2.64% | yes | — |
| **1% sampling median throughput degradation** | **>= -5%** | **-5.46%** | **NO** | fails by 0.46 pp; cost is a step, not a slope |
| 5% sampling median p95 overhead | <= 7.5% | +5.04% | yes | — |
| 5% sampling median throughput degradation | >= -7.5% | -6.11% | yes | looser gate passes where the tighter one failed |
| Targeted artifacts exact offline 20/20 | 4/4 | **4/4 (80/80)** | yes | later-occurrence artifacts are exact |
| Portable artifacts 20/20 from isolated dir | 4/4 | **4/4 (80/80)** | yes | artifact-only, no original capture |
| Historical fix removes the failure | 4/4 | **4/4 FIX_CONFIRMED** | yes | buggy-vs-fixed discrimination intact |
| Targeted artifact matches V3's fingerprint | 4/4 | **4/4** (and 421/421 artifacts, 1 class each) | yes | the same historical failure, not merely a 500 |
| Wrong-failure acceptances | 0 | **0** | yes | structurally guaranteed by the oracle |
| Raw gate-tier secret leaks in artifacts | 0 | **0** | yes | — |
| Median bug-specific wrappers / assertions / causal facts | 0 / 0 / 0 | **0 / 0 / 0** | yes | integration is bootstrap + env only |
| Targeted capture probability, rates >= 1% | >= 90% | **100%** (all 13 cells) | yes | captures on the very next occurrence |
| Median additional failures after first detection | <= 1 | **1** | yes | the first failure only ever arms |
| **p95 additional failures** | **<= 2** | **3** | **NO** | frozen budget 100 ~= the 1% inter-failure gap |
| Raw gate-tier leaks, V3 attack suite on V3.1 | 0 | **0** | yes | redaction code is byte-identical to V3 |
| PII in credential slots | 0 | **0** | yes | — |
| Replay failures caused by redaction | 0 | **0** | yes | privacy costs no fidelity |
| Selective-capture privacy checks | all pass | **4/4** | yes | detector and arming state hold no request content |
| No-retroactive-capture proofs | all pass | **5/5** (+4 structural in the suite) | yes | the experiment is not cheating |
| **Eligible large application end to end** | positive, or documented INSUFFICIENT | **OFFLINE_REPLAY_FAILED** | **NO** | captures fine; cannot boot without its database |
| Application source LOC changed (large app) | 0 | **0** | yes | generic integration only |
| One-off failures captured by targeted arming | reported, not hidden | **0/120** | — | structural, reported as a product limitation |
| V3 gap-tier privacy shapes | unchanged, out of boundary | unchanged | — | explicitly NOT solved by V3.1 |

## Exact Deployment Boundary Supported

| Incident Class | Acquisition Strategy | Expected Support | Known Limitation |
|---|---|---|---|
| **Deterministic recurring** (100%) | targeted arming | **Full.** 100% capture, artifact on the 2nd occurrence, 1 instrumented request | none observed |
| **20% recurring** | targeted arming | **Full.** 100%, 2nd occurrence, ~3 instrumented | none observed |
| **5% recurring** | targeted arming | **Full.** 100%, 2nd occurrence, ~10-13 instrumented | none observed |
| **1% recurring** | targeted arming | **Supported but marginal at the frozen policy.** 100% capture, median 2nd occurrence — but **p95 = 4th occurrence**, and 1/3 of windows expire and must re-arm | the frozen 100-request budget equals the expected inter-failure gap; **this is the failed p95 gate** |
| **0.1% rare** | targeted arming | **Not supported at the frozen policy.** 30-40% capture; median 3rd occurrence | expected gap ~1000 requests vs a 100-request budget; sensitivity analysis shows budget 1000 reaches 97%, but that is not the measured policy |
| **0.1% rare** | 25% ingress sampling | Partial: 73% capture | costs -7.5% throughput continuously, on all traffic, forever |
| **One-off** (never recurs) | targeted arming | **Not supported. 0/120.** | structural: the first failure only arms, and there is no second. Costs 100 wasted instrumented requests per one-off |
| **One-off** | 25% ingress sampling | Partial: **27%** capture | the only mechanism that can capture a first occurrence; -7.5% throughput permanently for a ~1-in-4 chance |
| **Distinctive / self-separating key** (absolute-form target, malformed Host) | targeted arming | **Full**, and free | benign traffic never shares the key, so an expired window instruments **0** requests |
| **Application that cannot boot without its dependencies** | any | **Artifact is not self-contained.** Capture works; offline replay does not | parse-server: boot-time Postgres access is outside any request and therefore uncaptured |
| **Application of substantial size (~45k LOC)** | targeted arming | **Acquisition yes, replay unproven.** 16/20 with 2 outcome classes even with the boot blocker removed | exactness demonstrated only on service-scaffolded incidents so far |

## Scientific Interpretation

**H0 (useful exact capture requires always-on interception): REJECTED.** The
unarmed fast path costs +2.6% p50 and -1.1% throughput while the always-on
control costs +19.2% and -15.8% on the same three services, and targeted arming
still obtains exact artifacts. Capture fidelity and steady-state cost are
separable.

**H1 (a detector-only fast path keeps steady-state overhead near zero):
SUPPORTED.** All five detector-only gates pass, including the bootstrap
interval. ALS quiescence accounts for roughly a third of the recovered cost
(+7.15% p50 with async_hooks forced on versus +2.56% quiesced); the remaining
two thirds come from not doing the interception work at all.

**H2 (sampling trades overhead against capture probability predictably):
SUPPORTED, but the trade is bad.** Overhead is a step function — 0->1% costs
4.3 pp of throughput, 1->25% only 2.0 pp more — because enabling sampling turns
on process-wide `async_hooks` and every request pays regardless of rate. Against
targeted arming, sampling is **strictly dominated for every recurring profile at
or above 1%**: more occurrences needed, lower capture probability, higher
steady-state cost. It is non-dominated only where targeted arming cannot go at
all — one-off failures (27% at a 25% rate) and 0.1% rare failures (73%).

**H3 (targeted arming captures recurring incidents efficiently): SUPPORTED for
rates >= 1%, with a recorded gate failure at exactly 1%.** 100% capture and a
median of one additional failure in all 13 eligible cells. The p95 gate fails at
3 because the frozen 100-request budget coincides with the 1% inter-failure gap.
Targeted arming does **not** reduce instrumented requests per incident — both
strategies wait out one 1/rate gap — it eliminates instrumentation when nothing
is failing.

**H4 (selective capture preserves exactness, portability, fix discrimination and
privacy): SUPPORTED.** 80/80 exact offline, 80/80 portable, 4/4 FIX_CONFIRMED,
4/4 fingerprint-identical to V3, 0 wrong acceptances, 0 leaks. Across all 421
targeted artifacts each incident produced exactly one fingerprint class, equal
to V3's. Nine of the thirteen inherited capture files, including every file that
decides what a request records, are byte-identical to frozen V3.

**H5 (the mechanism works through a larger application's own route): SPLIT —
acquisition SUPPORTED, replay NOT SUPPORTED, gate FAILED.** Capture, arming, key
derivation and dependency interception through `pg-promise` all worked on a
45,000-LOC application with zero source changes. Offline replay failed outright
(the application cannot start without its database), and under the relaxed
diagnostic condition it reproduced only **16/20 across two outcome classes**.
The exactness property that held at 160/160 in V3 and 80/80 in V3.1's targeted
corpus **did not hold here**.

**H6 and H7 remain untested by design.** V3.1 says nothing about whether
executable incidents help anyone repair anything, and nothing about demand.

## What V3.1 Does NOT Prove

- That all production failures become executable. One-off failures are
  **0/120**, and 0.1% failures are 30-40% at the measured policy.
- That always-on capture is production-plausible. It measured **worse** here
  than V3 reported: -16.09% throughput, CI [-17.64, -13.53].
- That sampling solves first-occurrence coverage efficiently. It buys 27% of
  one-offs for a permanent throughput tax.
- That the artifact is self-contained for any application. It is not, for
  applications that touch dependencies during startup.
- **That exact replay generalizes to applications of substantial size.** On the
  one real application attempted it was 16/20 with two outcome classes even
  after removing the boot-time blocker. Every 20/20 and 160/160 exactness figure
  in this report comes from incidents wrapped in experiment-authored service
  scaffolding.
- That the V3 privacy gap tier is addressed. It is unchanged and unsolved.
- That the frozen arming policy is the right one. The sweep suggests otherwise;
  that is a hypothesis for future work, not a result.
- Anything about repair value, agent or human. Anything about demand or pricing.
- That real incident arrivals behave like the IID Bernoulli simulator used here.

## Product Implications

1. **The deployment architecture is detector-only plus targeted arming.** Random
   sampling should not be the default: it is dominated everywhere targeted
   arming works, and its only advantage is a coverage niche bought with
   permanent overhead.
2. **The supported product is recurring backend incidents**, not "production
   failures". The honest pitch is: leave it installed at ~1% steady-state cost,
   and the second time a bug fires you get an exact, portable, offline
   reproducer.
3. **The arming budget must be derived from the observed failure rate**, not
   fixed. The frozen constant is what produced both the 1% p95 failure and the
   0.1% collapse. This is the clearest actionable finding, and it is untested as
   a policy.
4. **First occurrences are a genuine product gap** with no cheap answer inside
   this architecture.
5. **Boot-time dependency capture is required before the artifact is portable
   for real applications**, and **replay determinism at application scale is
   unproven**. These are the two largest engineering gaps V3.1 exposed, and both
   were invisible until a real application was attempted. Until they are closed,
   the exactness claim should be stated as holding for the tested
   service-scaffolded boundary, not for real applications generally.

## Decision

**`MODIFY`.**

The executable-incident mechanism came through V3.1 in better shape than it went
in. The question V3 left open — whether capture can be deployed without paying
always-on interception cost — is answered: **yes**, at +2.6% p50 and -1.1%
throughput while unarmed, against an always-on control of +19.2% and -15.8% on
the same services. And the question this phase existed to settle — whether an
artifact taken from a *later* occurrence is as good as one taken by
instrumenting everything — is answered **yes, exactly**: 80/80 exact offline,
80/80 portable, 4/4 fix-confirmed, and fingerprint-identical to V3 across all
421 targeted artifacts. Privacy and integrity did not regress; the
no-retroactive-capture proofs all hold.

That is not enough for `CONTINUE_TO_V4`, for three recorded reasons.

**Three preregistered gates failed, and two of them bound the product.**

- *1% sampling throughput, -5.46% against >= -5%.* On its own this is a 0.46 pp
  miss on a strategy the rest of the data says to drop anyway. It matters mainly
  because it revealed that sampling cost is a step, not a slope.
- *Targeted p95 additional failures, 3 against <= 2.* This one bites. It fails
  at exactly the 1% failure rate the usefulness gate targets, because the frozen
  100-request arming budget coincides with the 1% inter-failure gap. The
  sensitivity sweep explains the mechanism cleanly and suggests a budget derived
  from the observed rate would fix it — **but that policy has not been measured
  as a headline result, and the gate stays failed.**
- *Large application, offline replay 0/20.* An eligible case was found, pursued
  and failed. parse-server captures correctly and cannot replay offline, because
  it does database work at startup, outside any request, where the frozen
  capture does not look. And with that blocker removed it still reproduced only
  **16/20 across two outcome classes** — so the exactness property, which is the
  whole product, is **unproven at application scale**. This is the most
  consequential negative in V3.1.

**The capturable region is materially narrower than "production failures".**
One-off incidents are **0/120** and structurally unreachable by post-detection
arming — and they still cost 100 wasted instrumented requests each. 0.1%
failures reach only 30-40% at the frozen policy. What is solidly supported is
recurring backend failures at **1% of matching traffic and above**, in
single-process Node services that can start without their dependencies.

`KILL` is not warranted, though the large-application result makes it a closer
call than the gate count suggests. Exactness, portability, fix discrimination,
privacy and integrity all held across 4 framework families and 421 targeted
artifacts, and the deployment thesis was vindicated outright. What failed at
application scale is replay, not capture — and the boot-time cause of the hard
failure is understood and addressable. A `KILL` would be warranted if the
mechanism could not acquire incidents cheaply, or if targeted artifacts were not
exact; neither is the case. `INVALID_EXPERIMENT` does not apply: no
gate or threshold was retuned after results, no failed cell was replaced or
re-seeded, the implementation hash is unchanged since freeze, and the two
harness defects found mid-campaign were disclosed and fully re-run — one of
which had been *flattering* a strategy, and discarding it removed favourable
evidence.

`MODIFY` states the position precisely: the primitive is sound and the
deployment story now works, but the arming policy and boot-time capture are
unresolved engineering questions whose answers change the supported boundary.
Testing repair value on a mechanism whose acquisition policy is known to be
mis-sized, and whose artifacts are not self-contained for real applications,
would measure the wrong thing.

## Recommended Next Research Action

Three narrow, falsifiable pieces of work — **not** a broad V3.2 programme, and
**not** V4.

1. **Rate-adaptive arming budget.** Derive the budget from the observed
   inter-failure gap rather than fixing it at 100, and re-run the frozen
   recurrence protocol unchanged. Success criterion: p95 additional failures
   <= 2 at 1%, and >= 90% capture at 0.1%, without the median fully instrumented
   requests per incident exceeding roughly 1/rate. The sweep says this is
   plausible (100% and 97% at budget 1000, p95 of 1 and 2) but a sensitivity
   analysis is not a result.
2. **Boot-time boundary capture, then replay determinism at application scale.**
   Extend capture to record dependency observations made outside a request
   during application startup, and re-run the parse-server case under the frozen
   gate. Success criterion: offline replay 20/20 with a dead database, one
   outcome class, and no application source change. Note this is **two**
   problems, not one: boot-time capture removes the hard blocker, but the
   diagnostic already showed 16/20 with two classes *after* that blocker is
   removed, so the residual non-determinism must be diagnosed separately. Until
   it is, every exactness figure in this report should be read as scoped to
   service-scaffolded incidents.

3. **Tighten the detector-only interval before claiming a free fast path.**
   Independent verification found the +0.38% p95 headline is estimator-sensitive
   (+5.92% under ratio-of-medians, which would fail the gate), and the campaign
   ran 5000 rather than 10000 requests per repetition. Re-run Phase 3 alone at
   the full request count and/or more repetitions. Success criterion: the pooled
   95% upper bound for detector-only p95 falls materially below the <=10% bound,
   and the two estimators agree within roughly 2 pp. Until then the supportable
   claim is "small, bounded near the gate", not "essentially free".

Do not begin V4 until at least (1) is settled. A repair-value experiment run on
incidents the system acquires unreliably would confound acquisition failure with
repair failure.

## Required Answers

1. **Can Rapture remain installed with near-zero steady-state overhead while
   unarmed?** Yes. +2.56% p50, +0.38% p95, -1.14% throughput; all five
   detector-only gates pass including the bootstrap interval.
2. **Measured p50/p95/p99 and throughput of detector-only mode?** +2.56% /
   +0.38% / +0.01% / -1.14% (medians across 3 services x 10 reps x 5000
   requests). Pooled p95 CI95 [-0.96, +9.24].
3. **How does overhead scale at 1/5/10/25% sampling?** It barely does. p95
   +2.64 / +5.04 / +2.29 / +5.78%; throughput -5.46 / -6.11 / -5.95 / -7.50%.
   The jump is from 0% to 1%; after that the curve is nearly flat.
4. **For each sampling rate, how many repeated failures before capture is
   likely?** At DETERMINISTIC: 1% needs a median of 50 occurrences (43%
   capture), 5% needs 11, 10% needs 7, 25% needs 4. Targeted arming needs 2.
5. **For targeted arming, how many additional failures before an incident?**
   **Median 1, in every cell at every rate >= 1%, across all four framework
   families.** p95 is 3 at 1% (failed gate), 1 elsewhere.
6. **How many successful matching requests must be instrumented during the
   armed window?** Median 1 (deterministic), 3 (20%), 10-13 (5%), 48-64 (1%),
   300-400 (0.1%). Zero when unarmed, and zero even while armed if the failing
   traffic class is self-separating.
7. **Can targeted arming work without developer-supplied bug predicates?** Yes.
   The key is `method + lexically normalized path`; no application supplies a
   route table. It worked unmodified on parse-server's own route.
8. **What happens to one-off incidents?** **0/120 captured**, structurally, and
   they cost 100 wasted instrumented requests each. Only ingress sampling
   captures them, at 27% for a 25% rate.
9. **Does selective capture preserve exactness, portability, fix discrimination
   and zero wrong-failure acceptance?** On the tested corpus, yes: 80/80, 80/80,
   4/4, 0. All 421 targeted artifacts carried one fingerprint class per
   incident, identical to V3's. **On the large application, no** — 16/20 with
   two classes.
10. **Did detector or arming state introduce privacy leaks?** No. 0 gate-tier
    leaks, 0 PII violations, 0 redaction-caused replay failures; arming state
    holds counters and normalized keys only.
11. **Did a larger application work through its own route with no replacement
    route?** Capture did; replay did not. 0 application LOC changed, 0
    bug-specific wrappers, gate FAILED.
12. **Is the right architecture sampling, targeted arming, both, or neither?**
    **Targeted arming**, with sampling rejected as dominated for every recurring
    profile >= 1% and retained only as an optional, expensive fallback for
    one-off and very rare incidents.
13. **Is the evidence strong enough for V4?** No. Two policy-level gate failures
    and an unproven exactness result at application scale must be settled first.

## Independent Verification (2026-09-10)

The completed V3.1 result was re-derived from raw evidence rather than trusted
from the prose above, in the same way V3.1 opened by re-deriving V3. Full
record: `results/v31-independent-verification.json`.

**What reconciled.** All three V3 frozen hashes recompute exactly (capture tree
`8a8ef009…`, protocol manifest `e1734dcb…`, frozen corpus `9c139c36…`, results
copy byte-identical), and the V3 required suite passes 20/20 under Node
v22.14.0 — so `INVALID_EXPERIMENT` is not triggered. The V3.1 manifest hash
`b94cd5f7…` and implementation tree hash `e9232b1f…` both recompute with **zero
per-file drift**, and `test/selective-capture.test.js` passes **31/31**. Every
headline performance number was re-derived from the per-repetition raw latency
arrays under the preregistered estimator and **matched exactly** — detector-only
+2.56% / +0.38% / -1.14%, the V3 control +19.22% / +15.57% / -15.79%, and all
four sampling rates. The 421 targeted artifacts, one fingerprint class per
incident, 0/120 one-off capture, 30-40% RARE capture, the 80/80 offline and
80/80 portable replays and the 3-of-30 failing gates all reproduce. A byte-level
diff against the V3 freeze confirms the load-bearing invariant claim: 9 of 13
inherited files are byte-identical, **including `fingerprint.mjs`,
`normalize.mjs` and the replay engine** — FailureFingerprintV2 and the frozen
V1 GREEDY reduction could not have been tuned to make cases pass.

**Four disclosure gaps found.** None changes a number, a threshold or the
verdict; all are recorded rather than absorbed.

| # | Severity | Finding |
|---|---|---|
| **V31-VERIFY-1** | **material** | The detector-only headline is **estimator-sensitive**. Under the preregistered estimator p95 overhead is **+0.38%**; under ratio-of-medians on the same raw data it is **+5.92%** (express +0.4%, fastify +5.9%, koa +12.7%), which would **fail** the <=5% gate. Throughput is -1.14% vs -3.85% (passes either way). |
| V31-VERIFY-2 | minor | Measured requests per repetition is **5000**, not the 10000 named in the task brief. Preregistered before implementation — not a goalpost move — but not recorded among the six amendments. It widens the intervals, the same axis as V31-VERIFY-1. |
| V31-VERIFY-3 | minor | The brief's required token `DIRECTUS_SCALE_UNSUPPORTED_OR_INCONCLUSIVE` appears nowhere. Directus's disqualification *is* documented substantively in `large-app/screening.json`; only the token is missing. |
| V31-VERIFY-4 | minor | `results/privacy/attack.json` carries a non-empty `retainedPII` list (emails, a phone number, user ids from database rows across 3 files). The passing gate is scoped to **credential slots**, which is correct — but the report never states that artifacts retain the business data of the captured request. |

**On V31-VERIFY-1, precisely.** The preregistered estimator is not merely
different, it is the better one here: repetition-level machine noise is strongly
correlated within a repetition (rep 2 is an outlier across every service and
mode), and pairing cancels exactly that. The reported result therefore stands as
the primary estimate, frozen before measurement, with no threshold moved. But
the prose "essentially no cost" reads more favourably than the evidence robustly
supports. The honest reading is the one this report's own statistics already
imply: detector-only overhead is **small but bounded above near the gate** —
pooled 95% upper bound **+9.24%** against a <=10% gate — not ~0.4%. Tightening
that interval, by more repetitions or the full 10000 requests, is a precondition
for productizing a "free fast path" claim, and is added to the next-action list.

**On the large-application substitution.** parse-server was not a quiet
downgrade to buy a pass: it is a 45,400-LOC application, carried end to end
through its own route with 0 source changes, and it **failed** the gate. The
substitution moved the bar up, not down.

**Verification verdict.** Protocol integrity ESTABLISHED, frozen baselines and
corpus RECONCILED, measurement validity ESTABLISHED subject to V31-VERIFY-1.
**`MODIFY` upheld.**

## Artifact Index

| Artifact | Path |
|---|---|
| V3 frozen commit | `c8bb365d71a70f1c1ef5d9a98efb83d7243c5ded` |
| V3.1 preregistration manifest | `manifests/V3_1-MANIFEST.json` |
| Manifest hash | `results/manifest.hash` (`b94cd5f7…`) |
| Frozen implementation hash | `results/impl-freeze.json` (`e9232b1f…`, verified unchanged) |
| Protocol amendments (6) | `results/protocol-amendments.json` |
| Detector-only raw + aggregate | `results/perf/phase3/` (120 files), `results/perf/aggregate-phase3.json` |
| Sampling raw + aggregate | `results/perf/phase4/` (180 files), `results/perf/aggregate-phase4.json` |
| Core recurrence trials (1200) | `results/recurrence/trials.json`, `aggregate.json` |
| Sampling recurrence trials (720) | `results/recurrence-sampling/trials.json`, `aggregate.json` |
| Budget sweep trials (180) | `results/recurrence-sweep/trials.json`, `aggregate.json` |
| Targeted artifacts (421) | `results/recurrence/artifacts/` |
| Targeted correctness | `results/targeted-correctness/summary.json` + `artifacts/` |
| Large-app screening | `large-app/screening.json` |
| Large-app result | `results/large-app/case.json`, `capture.json` |
| Privacy audit | `results/privacy/attack.json` |
| No-retroactive-capture proof | `results/no-retroactive-capture.json` |
| Gate evaluation | `results/gates.json` |
| Independent verification (2026-09-10) | `results/v31-independent-verification.json` |
| Required test suite (31/31) | `test/selective-capture.test.js` |

Per the commit policy, all V3.1 work is left **uncommitted** for review.

---

# Part II — Selective Capture and Performance Boundary Closure

*This part answers the selective-capture brief. It extends Part I rather than
replacing it: Part I's campaigns (detector-only, sampling, targeted recurrence,
large-application probe, privacy) remain valid for the modes they measured and
are cited at their original values. Part II adds what Part I never implemented —
`ROUTE_SELECTIVE`, `ARMED_WINDOW`, explicit fast-path attribution, correctness
across all 8 frozen incidents, and performance at 10000 requests per
repetition.*

Protocol: `manifests/V3.1-MANIFEST.json`, sha256
`288e1e3f904427b91daea81d9d116289ffda86e40684bb79df46404f19848172`, frozen
before any measurement under it.

## Executive Summary

**Selective capture works, and the mechanism that makes it work is route
targeting — not sampling.**

The architectural claim is now measured directly rather than inferred. A request
that is not selected does **literally zero** capture work: across four unselected
modes driving 2000 real requests each, the runtime created **0 AsyncLocalStorage
stores, 0 event buffers, 0 boundary-context hits, 0 recorded events and 0
artifacts**. The same counters on selected traffic read 2000 / 2000 / 10000 /
8000, so they demonstrably detect the work when it happens. H1 is supported
without qualification.

**All 8 frozen V3 incidents survive selective capture intact.** Forced into the
selected population using only generic configuration, every one reproduced
**20/20 offline with a dead database and the external dependency stopped**,
**20/20 portable from an isolated temp directory**, **8/8 FIX_CONFIRMED**, **0
wrong-failure acceptances**, **0 raw gate-tier secret leaks**, and **8/8
fingerprints identical to the ones V3 recorded**. Selective deployment costs
nothing in artifact quality. H2 is supported.

**H3 is supported for targeting and refuted for sampling.** This is the central
new finding. Random ingress sampling has a **fixed cost floor**: 1% sampling and
10% sampling cost the *same* throughput — **-6.61% vs -6.63%, 0.02 pp apart** —
because enabling sampling at all means any request might be selected, so
`async_hooks` must stay on process-wide. Route targeting has no such floor,
because the AsyncLocalStorage is enabled lazily by the first *selected* request:
an armed-but-unmatched process measures **-1.14% throughput and -1.18% p95**, and
a closed incident window returns to **-1.61% / -0.52%**. At *equal* selected
volume (10%), targeting beats sampling on throughput (**-4.43% vs -6.63%**), and
the population the deployment gate actually governs — unselected requests in a
10%-armed process — runs at **-2.33% p95 or better, i.e. no slower than
uninstrumented**.

**33 of 41 gates pass. Verdict: `MODIFY`.** All eight failures fall into exactly
three groups, and none of them is a correctness or privacy failure:

1. **Every sampling mode fails the throughput arm** (-5.52% to -6.63% against a
   -5% gate), and sampling fails the scaling gate outright because its cost does
   not fall with its rate.
2. **The always-on control fails its own V3 reference gate by 0.15 pp**
   (-15.15% vs -15%). That is the control reproducing V3's known cost, not a
   V3.1 regression.
3. **The large-application probe still fails** (carried forward unchanged from
   Part I, not re-run).

H0 is refuted: the structural overhead does **not** remain substantial for
unselected traffic, and useful capture does **not** require intercepting every
request.

## Protocol Integrity and Disclosed Changes

Two implementation changes were made, both **before** any measurement under this
manifest, and both disclosed in it:

- `select.mjs`: added `ROUTE_SELECTIVE` and `ARMED_WINDOW`, driven by a generic
  `RAPTURE_V31_ROUTES` rule set (`METHOD /normalized/path`) plus
  `RAPTURE_V31_WINDOW_MS` / `RAPTURE_V31_WINDOW_BUDGET`.
- `state.mjs`: added Phase 1 attribution counters, gated behind
  `RAPTURE_V31_ATTRIB=1` so they can never be live in a performance run.

These modes had **never been implemented**. Adding a missing required capability
is not post-hoc tuning: no existing measurement was altered and no threshold
moved.

**One further change was made after the performance campaign, and is disclosed
rather than absorbed.** The privacy suite found a genuine off-by-one in
`ARMED_WINDOW`: the budget check sat *after* the not-yet-opened shortcut, so a
window configured with budget 0 admitted exactly one request before closing —
not a bounded window at all. It is fixed. The fix cannot affect the reported
performance numbers, and this was verified rather than asserted: across all
**30** measured `ARMED_WINDOW_CLOSED` repetitions the runtime reports
**requestsSelected 0, requestsPersisted 0, eventsRecorded 0, ALS disabled**. The
one request the old code admitted was consumed during warmup, which is excluded
from measurement.

**The load-bearing invariant held throughout.** All **9** files that determine
*what a captured request records* — `events`, `patch-pg`, `patch-fetch`,
`patch-time`, `persist`, `redact`, both oracle files and the replay engine —
remain **byte-identical to the frozen V3 capture tree**, verified at byte level
after every change. FailureFingerprintV2 and the frozen V1 GREEDY reducer
therefore could not have been tuned to make any case pass. Implementation tree
re-frozen at `9d9cc6459ba7596d4933fbb64251275fc51d795fbad4c2ae8158016c9c253f8e`;
the 31-test suite passes 31/31 after every change.

## Phase 1 — Fast-Path Attribution

2000 requests per mode, counters read as before/after deltas.

| Mode | selected | ALS stores | event buffers | boundary hits | events | artifacts |
|---|---|---|---|---|---|---|
| DETECTOR_ONLY_UNARMED | 0 | **0** | **0** | **0** | **0** | **0** |
| SAMPLE_0 | 0 | **0** | **0** | **0** | **0** | **0** |
| ROUTE_SELECTIVE (unmatched) | 0 | **0** | **0** | **0** | **0** | **0** |
| ARMED_WINDOW (closed) | 0 | **0** | **0** | **0** | **0** | **0** |
| *ROUTE_SELECTIVE (matched)* | *2000* | *2000* | *2000* | *10000* | *8000* | *0* |
| *V3_ALWAYS_ON_FULL* | *2000* | *2000* | *2000* | *10000* | *8000* | *0* |

The last two rows are positive controls. Because `currentRequest()` is the single
predicate every boundary wrapper consults, **0 boundary-context hits proves
simultaneously** that pg result capture, fetch teeing, time/random recording,
serialization and redaction did not run — none of them can execute without a live
capture context. 0 artifacts on the controls is correct: the perf workload
succeeds, and only failures persist.

## Phase 2 — Performance

3 services × 8 modes × **10 repetitions × 10000 measured requests**, concurrency
16, 500 warmup requests excluded, mode order randomized per repetition, full raw
latency arrays retained, **0 request errors across all 240 repetitions**.

Both preregistered estimators are reported. A gate passes only if it passes under
both.

| Mode | actual sel. | p50 (paired/ratio) | p95 (paired/ratio) | throughput (paired/ratio) | pooled 95% CI (p95) |
|---|---|---|---|---|---|
| ROUTE_SELECTIVE (unmatched) | 0.00% | +2.01 / +3.54 | **-1.18 / +1.67** | **-1.14 / -3.24** | [-3.70, +3.39] |
| ARMED_WINDOW (closed) | 0.00% | +3.38 / +3.46 | **-0.52 / +0.38** | **-1.61 / -2.46** | [-1.83, +8.14] |
| ARMED_WINDOW (10% armed) | 10.00% | +2.55 / +4.51 | +11.50 / +11.50 | -4.43 / -5.66 | [+6.91, +15.56] |
| SAMPLE_1 | 0.96% | +6.83 / +5.96 | +5.86 / +3.90 | **-6.61 / -5.66** | [+0.21, +9.44] |
| SAMPLE_5 | 4.84% | +6.52 / +6.81 | +3.55 / +0.94 | **-5.52 / -4.90** | [-1.30, +6.21] |
| SAMPLE_10 | 9.88% | +7.52 / +8.52 | +3.04 / +3.08 | **-6.63 / -6.44** | [-0.55, +7.29] |
| V3_ALWAYS_ON_FULL *(control)* | 100.00% | +18.17 / +19.27 | +18.98 / +18.51 | -15.15 / -15.27 | [+16.23, +22.67] |

Actual selection rates match configuration to within 0.16 pp at every rate, and
the two zero-rate modes select nothing across 220,000 requests — these are
ingress-selection counts read from the runtime, not persistence counts.

**The `ARMED_WINDOW_10PCT` row needs reading carefully.** Its global p95 of
+11.5% is not a tax on ordinary traffic: the **unselected tail** in the same runs
measures **-5.35%, -2.33% and -6.47%** across the three services — at or below
uninstrumented. The +11.5% is produced entirely by the 10% of requests that were
selected and are paying full V3 capture cost, which the selected-request gate
explicitly permits. The deployment gate governs the unselected population, and
that population passes.

## Phase 3 — Correctness Across All 8 Frozen Incidents

Each incident was forced into the selected population in two generic steps:
the route key was **discovered from the runtime** (the detector arms on the first
failure; the key is read back from `/__rapture31`), then the service was
restarted under `ROUTE_SELECTIVE` configured with that key. No key was
hand-written per bug.

| Incident | discovered key | offline | portable | fix | wrong-accepts | V3 fingerprint |
|---|---|---|---|---|---|---|
| koa-1999 | `GET http://example.com/u` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| koa-1998 | `GET /admin` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| express-cookie | `GET /c` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| express-qs | `GET /parse` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| fastify-32442 | `POST /v` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| express-semver | `GET /check` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| hapi-4560 | `GET /u` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| hapi-4564 | `GET /who` | 20/20 | 20/20 | CONFIRMED | 0 | match |
| **Total** | | **160/160** | **160/160** | **8/8** | **0** | **8/8** |

Replays ran with `PGPORT=54399` (dead) and the fake external dependency
**stopped** — verified stopped in-run, not assumed. 0 raw gate-tier secret leaks;
0 bug-specific wrappers, 0 bug-specific assertions, 0 manually supplied causal
facts. Incident-specific setup is a single `RAPTURE_V31_ROUTES` value that the
runtime itself supplies, well inside the 5-minute gate.

Two harness defects were found and fixed during this phase, both in experiment
code and neither in Rapture: the frozen reducer was called with the wrong
signature, and the stats endpoint was fetched over IPv4 for a service listening
on `::1` (which had made hapi-4560 look uncapturable and later produced two
spurious `UNEXPECTED_CAPTURE` rows). Both are recorded here rather than quietly
corrected.

## Phase 4 — Unsampled Failure Semantics

Every one of the 8 real historical failures was triggered while deliberately
outside the selected population, under two independent mechanisms
(`ROUTE_SELECTIVE` armed on a different route, and sampling at rate 0).

**16/16 cells: `NOT_CAPTURED`** — 0 selected, 0 events recorded, 0 artifacts, in
every case. The application still served the failure normally. The same property
appears independently in Phase 3: for all 8 incidents the *first* failure (the
one that merely arms the detector) produced **0 artifacts**.

**Therefore Rapture cannot claim "production failed → artifact exists."** The
supported claim is narrower and exact:

> *the request was selected before it executed, and it failed → an exact portable
> artifact exists.*

This is not a limitation that better engineering removes. Exact replay needs the
database rows, outbound responses, time draws and randomness the request actually
observed; those exist only while it executes. After the response is written they
are gone.

## Privacy

The frozen V3 gate-tier threat model is retained unchanged. All 6 new-policy
checks pass: unmatched traffic persists nothing, arming state holds only
counters and normalized keys, the `/__rapture31` surface exposes no header,
cookie, body or raw query content, and artifacts from selected requests carry no
raw gate-tier credential.

**One finding is reported honestly rather than absorbed.** The first run of the
new privacy suite flagged a raw cookie session value inside a selected
artifact. A differential test settled whether this was a V3.1 regression: the
identical sentinel-loaded request was captured under the **frozen V3 register**,
under V3.1 always-on, and under V3.1 route-selective. The raw value appears in
**all three**. It is a pre-existing property of the frozen V3 capture tree —
`redact.mjs` is byte-identical to V3 — and belongs to the **documented V3 gap
tier**, which V3.1 explicitly does not claim to solve. The initial suite was
over-strict in treating it as gate tier; it was corrected to V3's actual
definition, and the gap-tier observation is recorded permanently.

Consistent with Part I's independent verification: artifacts retain the business
data of the captured request, because replay requires it. The privacy boundary is
not widened by anything in Part II.

## Gate Summary

**41 evaluated, 33 passed, 8 failed, 3 estimator-dependent.**

| Failed gate | Required | Observed |
|---|---|---|
| SAMPLE_1 median p95 | ≤ 5% | +5.86 paired / +3.90 ratio — **ESTIMATOR_DEPENDENT** |
| SAMPLE_1 throughput | ≤ 5% | **-6.61 / -5.66** — fails under both |
| SAMPLE_5 throughput | ≤ 5% | -5.52 / -4.90 — **ESTIMATOR_DEPENDENT** |
| SAMPLE_10 throughput | ≤ 5% | **-6.63 / -6.44** — fails under both |
| ARMED_WINDOW_10PCT global throughput | ≤ 5% | -4.43 / -5.66 — **ESTIMATOR_DEPENDENT** |
| SAMPLE_1 materially cheaper than SAMPLE_10 | materially cheaper | -6.61 vs -6.63, **0.02 pp apart** |
| V3_ALWAYS_ON throughput *(control)* | ≤ 15% | -15.15, fails by **0.15 pp** |
| Large application end to end | supported or bounded | parse-server: offline replay **0/20** |

Reporting three gates as `ESTIMATOR_DEPENDENT` rather than resolving them in the
flattering direction is the preregistered rule, adopted because Part I's
independent verification found the detector-only headline was estimator-sensitive.

## Required Answers

1. **Does an unselected request actually avoid ALS capture context, pg capture,
   fetch tee/clone and event buffering?** **Yes, provably.** 0 ALS stores, 0
   event buffers, 0 boundary-context hits, 0 events, 0 artifacts across four
   unselected modes; positive controls confirm the counters work.
2. **How much overhead remains at 1%, 5% and 10% selection?** Throughput
   **-6.61%, -5.52%, -6.63%**; p95 **+5.86%, +3.55%, +3.04%**. All three fail
   the 5% throughput gate.
3. **Does overhead scale with actual selection rate?** **For targeting yes; for
   random sampling no.** Sampling's cost is a step, not a slope — 1% and 10%
   are 0.02 pp apart. Targeting scales from -1.14% (nothing matched) to -4.43%
   (10% matched) to -15.15% (everything matched).
4. **What constant overhead remains merely from installing the generic hooks?**
   With hooks installed but nothing ever selected: **p95 -1.18%, throughput
   -1.14%** (route-selective) and **-0.52% / -1.61%** (closed window) — at or
   below uninstrumented, because the AsyncLocalStorage is never enabled. The
   ~6% floor seen under sampling is not the hooks; it is `async_hooks` being
   forced on because any request might be selected.
5. **Can all 8 V3 failures still become exact portable reproducers when
   deliberately selected?** **Yes. 8/8, 160/160 offline, 160/160 portable, 8/8
   FIX_CONFIRMED, 0 wrong-failure acceptances, 8/8 fingerprints identical to
   V3's.**
6. **What happens when a failure occurs outside the selected population?**
   `NOT_CAPTURED`, 16/16 cells: no artifact, no boundary observations, no
   partial reproducer. The application serves the failure normally.
7. **Can we truthfully say "always capture failures"?** **No.** The exact
   supported semantics: *selected before execution, and failed → exact portable
   artifact exists.* Raising coverage means raising sampling (costs ~6%
   throughput on all traffic, permanently), targeting a route under
   investigation (near-free), or accepting the loss of occurrence 1 and arming
   for the next.
8. **Does the integration survive one substantially larger real service?**
   **Partly, and this is the open boundary.** parse-server (45,400 LOC) captured
   correctly through its own route with **0 source changes** and 0 bug-specific
   wrappers, but offline replay is **0/20**: it performs Postgres schema work at
   startup, outside any request, where the frozen capture never looks. Even with
   that blocker relaxed it reached only 16/20 across **two** outcome classes, so
   exactness itself did not hold at application scale. Acquisition scaled;
   replay did not.
9. **What is the exact supported deployment boundary after this experiment?**
   Single-process Node ≥22 services on a `node:http`-compatible stack (express 4,
   koa 3, fastify 5, hapi 21), Postgres via `pg`, outbound `fetch`, that can
   **start without their dependencies**; capture selected by **route/operation
   targeting or a bounded armed incident window**; failures **recurring** on the
   targeted key. Random ingress sampling is measured, and is **not** in the
   supported boundary at these thresholds.
10. **Should the project proceed to V4 repair-value testing?** **Not yet.** The
    acquisition mechanism is sound and its artifacts are exact, but the
    application-scale replay result is unproven. Running a repair-value
    experiment on incidents the system cannot yet reproduce at real application
    scale would confound repair failure with acquisition failure.

## Decision

`CONTINUE` requires unselected traffic within 5% p95 **and** 5% throughput
across the gate population, overhead clearly scaling down with selection rate,
all 8 incidents preserving exactness, **and** a large-service probe that is
either supported or reveals only a clearly bounded compatibility issue.

Three of those four are met, and met convincingly. The fourth is not: the
parse-server residual — 16/20 across two outcome classes *after* the boot-time
blocker is removed — is an unexplained non-determinism, not a bounded
compatibility issue. And the gate population itself splits cleanly: targeting
passes, sampling fails on throughput at every rate.

`KILL` is clearly not met. Meaningful coverage does **not** require intercepting
every request; performance **does** improve as selection falls, provided
selection is targeted; exactness and privacy were **not** weakened — 160/160,
160/160, 8/8, 0, 0; and generic integration did **not** break on a 45,000-LOC
application, which needed 0 source changes and 0 bug-specific instrumentation.

What remains is exactly the `MODIFY` condition: the mechanism is valid, overhead
is materially reduced, correctness is intact, and **one clearly identifiable
boundary** — application-scale replay determinism — is narrow enough for one
more experiment. The deployment model also narrows honestly, from "selective
capture" to **route/operation-targeted arming**, with random sampling
demonstrated to be dominated rather than merely unattractive.

### Recommended next work

1. **Boot-time boundary capture, then application-scale replay determinism.**
   Extend capture to record dependency observations made outside a request
   during startup, then re-run parse-server under the frozen gate. Note this is
   **two** problems: removing the boot blocker still leaves the 16/20
   two-class residual, which must be diagnosed separately. Until it is, every
   exactness figure in this report should be read as scoped to
   service-scaffolded incidents.
2. **Do not pursue random ingress sampling further.** Its cost floor is
   structural — enabling it at all forces process-wide `async_hooks` — so it is
   dominated by targeting at every rate measured.

Do not begin V4 until (1) is settled.

## Part II Artifact Index

| Artifact | Path |
|---|---|
| Brief protocol manifest | `manifests/V3.1-MANIFEST.json` (`288e1e3f…`) |
| Manifest hash | `results/manifest-v3.1-brief.hash` |
| Frozen implementation tree | `results/impl-freeze-v2.json` (`9d9cc645…`, 9/9 V3 files byte-identical) |
| Fast-path attribution | `results/fastpath-attribution.json` |
| Raw performance (240 reps) | `results/perf/brief/` |
| Performance aggregate, both estimators | `results/perf/aggregate-brief.json` |
| 8-incident correctness | `results/selective-correctness-8/summary.json`, `gates.json`, `artifacts/` |
| Unsampled failure semantics | `results/unsampled-semantics.json` |
| New-policy privacy audit | `results/privacy-newmodes.json` |
| Gate evaluation | `results/gates-brief.json` |
| Large-application probe (carried forward) | `results/large-app/case.json` |

All Part II work is left **uncommitted** for review.


RAPTURE_REPRODUCER_V3_1_STATUS=MODIFY
