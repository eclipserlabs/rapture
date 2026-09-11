# Rapture Reproducer V3.3 — AsyncLocalStorage Lifecycle Closure

**Status: `CONTINUE`. The formal pass gate passes 6/6 and every correctness,
privacy and ownership regression is green.**

**But the broad deployment problem is not solved.** Continuously armed traffic
at 10% still misses the transparent-overhead objective. The supported boundary
narrows to **episodic** capture — armed, captured, drained — and that narrowing
is stated here rather than buried.

- V3.2 checkpoint: **`8f10861df9b8a1c06b0877e93cb02eb6878d5523`**
- V3.3 manifest: `manifests/V3.3-MANIFEST.json`, sha256 **`cda338d1685c14eb354c9328123f48931b2554ae1e7798d4002082286d02f38c`**
- Frozen implementation tree: **`5416f2752c885bb8d61abd49888fc29a34e06b814ea278c551d2ebf291417f1d`**
- Phase 4: **150/150 repetitions valid, 0 INVALID_ENVIRONMENT**, gate passed at `load1/cpu 0.212`

## Executive Summary

V3.2 ended with one blocker: once capture had been activated, the process paid a
fixed ~5.9 percentage-point `async_hooks` tax forever, because
`AsyncLocalStorage` could never quiesce while a route remained armed — even
with **zero** requests selected and **zero** boundary events recorded.

**That fixed floor is gone.** With the lifecycle corrected, a process that has
performed 150 real captures and then drained runs at **+0.05% unmatched p95 and
−1.27% throughput** against OFF, with the route still configured as armed — a
**4.59 percentage-point** improvement on V3.2's −5.86%. The storage is verified
quiescent from runtime counters before measurement, in the same process, with no
restart.

**H1 confirmed:** a configured route does not itself require the storage.
`ARMED_NEVER_SELECTED` measures −0.64% p95 / −0.86% throughput with an ALS
active fraction of exactly **0**.

**H4 confirmed:** 1010 enable/disable transitions produced 505 well-formed
artifacts with zero contamination, and the storage correctly refused to quiesce
while 8 pg operations were still in flight after their HTTP responses had
finished.

**H3 is confirmed only for the episodic regime.** At 10% continuously armed
traffic the storage is active **~99% of wall clock** — selections arrive faster
than the quiescence window, so it effectively never disables — and unmatched
traffic pays **+5.40% p95 / −6.43% throughput**, missing the original V3.2
targets. Quiescence removes the tax of *having captured*; it cannot remove the
tax of *currently capturing*.

## Decision Semantics (recorded before any result was inspected)

`results/decision-semantics.json`, written before Phase 4 produced a single
repetition. The frozen manifest scopes the formal pass gate to
**`POST_CAPTURE_QUIESCENT_UNMATCHED` only**; that rule is preserved, not
rewritten, and `ARMED_MIXED_10` is reported separately against the original
V3.2 targets.

| Mode | What it tests | Regime |
|---|---|---|
| `POST_CAPTURE_QUIESCENT_UNMATCHED` | does the fixed V3.2 floor disappear after selected work drains, route still armed | **episodic** |
| `ARMED_MIXED_10` | the original V3.2 Gate 1 question: unmatched traffic while selection is actively occurring | **continuous** |

Pre-committed and now binding: *"`POST_CAPTURE_QUIESCENT_UNMATCHED` passing
must NOT be read as evidence that continuously mixed route targeting is
cheap."* This report honours that.

## The Lifecycle Authority

`AsyncLocalStorage` may be disabled **only** when both are zero:

1. selected request contexts in flight, and
2. outstanding capture-owned asynchronous boundary operations.

**HTTP response completion is explicitly not the authority.** A pg query or
outbound fetch issued inside a selected context can outlive the HTTP stack;
treating "response finished" as "ownership finished" would lose evidence. Every
boundary operation is bracketed on **every** exit path including errors, and both
conditions are re-checked immediately before `disable()`.

**Route configuration is not ownership.** An armed rule expresses only what
*would* be selected; selection re-enables the storage lazily at ingress,
synchronously, before the handler runs. Pinning the storage open for a rule that
may never match was exactly the V3.2 tax.

## Phase 1 — Lifecycle Mechanism (7/7)

The route stayed configured as `["GET /boom"]` for the entire run. Only traffic changed.

| State | alsEnabled | enable / disable | selected | artifacts | Result |
|---|---|---|---|---|---|
| ARMED_NEVER_SELECTED | false | 0 / 0 | 0 | 0 | storage never enabled |
| SELECTED_ACTIVE | true | 1 / 0 | 1 | 1 | enabled lazily, incident produced |
| POST_SELECTED_QUIESCENT | **false** | 1 / 1 | 1 | 1 | **disabled while still armed** |
| REACTIVATED | — | 2 / 2 | 2 | 2 | re-enabled lazily, correct incident |

## Phase 2 — Adversarial Lifecycle Correctness (15/15)

| Hard gate | Required | Observed |
|---|---|---|
| cross-request contamination | 0 | **0** (200 + 300 + 505 artifacts) |
| lost selected boundary events | 0 | **0** relative to the frozen V3.2 baseline |
| wrong-owner events | 0 | **0** |
| premature ALS disable | 0 | **0** |
| wrong-failure acceptances | 0 | **0** |

The decisive check: with all 8 HTTP responses finished
(`activeSelectedContexts=0`) but 8 pg queries still in flight
(`outstandingCaptureOps=8`), the storage stayed enabled and disabled only
after they drained. 1010 transitions across 505 paced cycles yielded 505
well-formed artifacts and zero contamination.

**A finding I initially got wrong.** My first suite failed three checks and I
nearly reported a critical-invariant violation. The loss occurred even at a
**0 ms** detach delay, which ruled out quiescence. A differential settled it:

| Case | V3.2 (never quiesces) | V3.3 (quiescence) |
|---|---|---|
| awaited work | 8/8, 4 events each | 8/8, 4 events each |
| post-response work | **0/8** | **0/8** |

Identical. The tests had asserted a property the architecture never had.

## Post-Response Boundary (recorded, not broadened)

Operations completing after response finalisation are **outside the
executable-incident persistence boundary**: the incident is serialised when the
response finishes, so such observations are absent from the artifact. This is a
pre-existing property of deferred persist-at-response-finish, differentially
established as identical in V3.2, and **V3.3 does not broaden it**.

## Phase 3 — Frozen Correctness Regression

| Requirement | Observed |
|---|---|
| auto-capture | **8/8** |
| offline exact replay | **160/160** |
| portable exact replay | **160/160** |
| fix confirmed | **8/8** |
| fingerprints unchanged | **8/8** |
| wrong-failure acceptances | **0** |
| raw session-credential leaks | **0** |

Session-credential behaviour unchanged (**9/9**): opaque handles surrogated,
signature-bearing credentials `PRIVACY_BLOCKED`, surrogated artifact still
replays exactly. `BOOT_TIME_DEPENDENCY_ACCESS` still deterministically
detected (**4/4**, parse-server 55 boot ops flagged). Neither boundary reopened.

## Phase 4 — Performance

150/150 valid repetitions, 0 INVALID_ENVIRONMENT, 20000 measured requests each
at concurrency 16, ≥150 forced captures before every activated mode, storage
verified quiescent before measurement with **no process restart**.

| Service | Mode | Unmatched p50 | p95 | p99 | Selected p95 | Throughput | Δ vs OFF | ALS active fraction | Capture contexts | Boundary events |
|---|---|---|---|---|---|---|---|---|---|---|
| express-qs | OFF (control) | 9.97 | 15.46 | 23.26 | — | 1500.38 | — | — | — | — |
| express-qs | armed never selected | 10.11 | 15.55 | 23.5 | — | 1476.56 | -0.71% | 0 | **0** | **0** |
| express-qs | post capture quiescent unmatched | 10.18 | 15.54 | 22.84 | — | 1471.84 | -1.21% | 0.027 | **0** | **0** |
| express-qs | armed mixed 1 | 10.59 | 16.09 | 24.24 | 15.93 | 1417.29 | -5.46% | 0.79 | 2000 | 8000 |
| express-qs | armed mixed 10 | 10.87 | 16.47 | 24.72 | 16.61 | 1386.15 | -7.28% | 0.99 | 20000 | 80000 |
| koa-1999 | OFF (control) | 8.43 | 13.59 | 22.51 | — | 1754.69 | — | — | — | — |
| koa-1999 | armed never selected | 8.52 | 13.75 | 23.01 | — | 1725.56 | -0.86% | 0 | **0** | **0** |
| koa-1999 | post capture quiescent unmatched | 8.57 | 13.58 | 22.2 | — | 1725.85 | -1.27% | 0.03 | **0** | **0** |
| koa-1999 | armed mixed 1 | 8.84 | 13.87 | 22.73 | 13.65 | 1671.89 | -4.27% | 0.877 | 2000 | 8000 |
| koa-1999 | armed mixed 10 | 8.97 | 14.16 | 22.98 | 14.27 | 1648.4 | -6.01% | 0.993 | 20000 | 80000 |
| fastify-32442 | OFF (control) | 9.57 | 15.35 | 25.93 | — | 1548.13 | — | — | — | — |
| fastify-32442 | armed never selected | 9.68 | 15.43 | 26.63 | — | 1526.9 | -1.39% | 0 | **0** | **0** |
| fastify-32442 | post capture quiescent unmatched | 9.75 | 15.32 | 26.26 | — | 1515.1 | -2.22% | 0.026 | **0** | **0** |
| fastify-32442 | armed mixed 1 | 9.93 | 15.57 | 26.76 | 15.45 | 1495.38 | -4.34% | 0.796 | 2000 | 8000 |
| fastify-32442 | armed mixed 10 | 10.15 | 16.09 | 27.12 | 15.97 | 1458.68 | -6.43% | 0.985 | 20000 | 80000 |
### Formal pass gate — POST_CAPTURE_QUIESCENT_UNMATCHED

| Sub-gate | Required | Observed (paired / ratio) | Pass |
|---|---|---|---|
| median unmatched p95 overhead | ≤ 5% | **+0.05% / −0.10%** | **yes** |
| median throughput degradation | ≤ 5% | **−1.27% / −1.90%** | **yes** |
| no single service p95 > 10% | ≤ 10% | 1.07% worst | yes |
| mechanism gate vs V3.2 | improve ≥ 3 pp | **−1.27% vs −5.86% → 4.59 pp** | **yes** |
| storage verified quiescent, no restart | true | true | yes |
| zero capture work during measurement | 0 / 0 | selected=0, events=0 | yes |

**Formal gate: PASS (6/6).**

### Reported separately — ARMED_MIXED_10 against the original V3.2 targets

| Check | Required | Observed | Meets |
|---|---|---|---|
| unmatched p95 | ≤ 5% | +5.40% paired / +4.83% ratio | **NO** — ESTIMATOR_DEPENDENT, treated as not meeting |
| throughput | ≤ 5% | −6.43% / −6.06% | **NO** — fails under both |

### ALS active wall-clock fraction

| Mode | express-qs | koa-1999 | fastify-32442 |
|---|---|---|---|
| ARMED_NEVER_SELECTED | 0 | 0 | 0 |
| POST_CAPTURE_QUIESCENT_UNMATCHED | 0.027 | 0.030 | 0.026 |
| ARMED_MIXED_1 | 0.790 | 0.877 | 0.796 |
| ARMED_MIXED_10 | **0.990** | **0.993** | **0.985** |

This is the mechanism. At 10% armed the storage is active ~99% of the time:
selections arrive faster than the quiescence window, so it effectively never
disables and the process behaves like V3.2. At 1% it is ~79–88% active and the
cost falls to −4.34%. Quiescence pays off precisely in proportion to how much of
the time nothing is selected.

## Required Answers

1. **Can a route remain armed while ALS is actually disabled?** **Yes.**
   Demonstrated with the route configured as `["GET /boom"]` throughout, across
   1010 enable/disable transitions.
2. **What exact state prevents quiescence?** Selected request contexts in
   flight, or outstanding capture-owned boundary operations. Route
   configuration no longer does — that was the V3.2 defect.
3. **Does quiescence wait for outstanding capture-owned boundary operations?**
   **Yes.** With 0 active contexts and 8 pg ops in flight, the storage stayed
   enabled and disabled only after they drained.
4. **Can ALS be repeatedly re-enabled without losing request ownership?**
   **Yes.** 1010 transitions, 505 well-formed artifacts, 0 contamination,
   0 lost events, outstanding-op counter returning to 0.
5. **What is post-capture unmatched overhead versus OFF?** **+0.05% p95,
   −1.27% throughput.**
6. **Did the ~5.9 pp fixed floor disappear?** **Yes, for the episodic regime**
   — 4.59 pp recovered. **No, for the continuous regime**: at 10% armed the
   storage never quiesces and the cost returns (−6.43%).
7. **Did any ownership, privacy, replay or fingerprint guarantee regress?**
   **No.** 8/8, 160/160, 160/160, 8/8 fingerprints, 9/9 session credentials,
   4/4 boot detection, 15/15 adversarial.
8. **Is there any scientifically justified reason to continue capture-mechanism
   research?** **No.** The remaining cost is not a defect but a direct
   consequence of `async_hooks` being required whenever a request is actually
   being captured. No further lifecycle work can remove it, because the storage
   must be active while capture is active.

## Supported Deployment Boundary

**Supported, transparently:** episodic route-targeted capture on single-process
Node ≥22 services — arm a route, capture the incidents, let the storage drain.
While nothing is selected the cost is indistinguishable from uninstrumented
(+0.05% p95, −1.27% throughput) even though the route stays armed.

**Not transparent:** continuously armed routes carrying sustained selected
traffic. At 10% selection the overhead is +5.40% p95 / −6.43% throughput.
Usable, but it does not meet the transparent-overhead objective and must not be
described as free.

Unchanged from V3.2: opaque session handles surrogated and signature-bearing
credentials privacy-blocked; applications performing boot-time dependency work
flagged `BOOT_TIME_DEPENDENCY_ACCESS` and not offline-replayable; operations
completing after response finalisation outside the persistence boundary.

## Experimental Integrity

- Manifest `cda338d1` frozen before evaluation and **unmodified**.
- Implementation `5416f275`, zero drift. `fingerprint.mjs`,
  `normalize.mjs` and `replay-one.mjs` remain byte-identical to frozen V3.
- ALS active-duration instrumentation was preregistered in the manifest's Phase
  4 metrics but had not been implemented; it was added before Phase 4, the
  lifecycle suite was re-verified, and the **full 8-case regression was re-run
  at the new hash** rather than carried forward.
- **Partial outcome visibility is disclosed, not denied.** Early Phase 4
  repetitions were visible in the run log while reporting progress. No gate
  value was computed from them, the decision semantics were fixed in writing
  beforehand, and nothing was tuned afterwards.
- Phase 4 ran under the corrected V3.2 environment semantics: the pre-campaign
  quiescence gate governs whether the campaign may start; a repetition is
  invalidated only by foreign contention, never by benchmark-generated load and
  never by its Rapture outcome. 0/150 were invalidated.

## Decision

All three `CONTINUE` conditions in the frozen manifest are met: the storage
safely quiesces after selected work; post-capture unmatched traffic meets ≤5%
p95 and ≤5% throughput; every correctness, privacy and ownership regression is
green.

Capture-mechanism research is finished. The remaining continuous-regime cost is
not a defect to optimise away — `async_hooks` is required whenever a request
is genuinely being captured, so no lifecycle change can remove it. There is no
V3.4 and none is proposed.

RAPTURE_REPRODUCER_V3_3_STATUS=CONTINUE
RAPTURE_REPRODUCER_CAPTURE_RESEARCH=FREEZE_AND_PROCEED_TO_V4
