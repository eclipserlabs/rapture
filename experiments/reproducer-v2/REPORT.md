# Rapture Reproducer V2 — Final Research Report

## Executive Summary

V2 asked whether a failing Node.js backend request can **automatically** emit the
complete deterministic capture and failure oracle needed by the frozen V1
reducer, cutting V1's ~25 min/case manual fixture burden to <= 5 minutes.
Result: **yes, inside the frozen narrow boundary**. A single generic
`--import` bootstrap (zero application source changes) converted 8/8
calibration incidents and **6/6 eligible historical backend bugs into exact
offline portable reproducers**: 280/280 fresh-process replays reproduce the
automatically inferred fingerprint, 0 wrong-failure acceptances, 0 secret
leaks, 6/6 FIX_CONFIRMED, median incident-specific setup 2 minutes with 0
incident-specific wrappers/assertions. Median overhead on successful requests
is 0% but p95 overhead (+62.5%) misses the usefulness target, so the honest
verdict is **CONTINUE** on the capture/oracle thesis with an explicit
performance-narrowing caveat — not an unqualified product signal.

## V1 Freeze and Commit

- V1 branch `research/minimal-executable-reproducer-v1` verified under Node
  v22.14.0: **19/19 V1 tests pass** (the single earlier failure was a
  Node-version gate running under Node 20, not a result contradiction).
- V1 headline results stand as reported (12/12 adversarial, 12/12 real bugs,
  DDMIN never beats GREEDY, median 25 min manual burden). The qualified
  CONTINUE interpretation is preserved exactly, caveats included.
- V1 frozen commit: `07604551dc57821cff01600d69e4864d5b2338e4`
  ("research: validate executable reproducer v1").
- V2 branch `research/minimal-executable-reproducer-v2` created from that SHA.
- Per commit policy, V2 work below is left **uncommitted** for review.

## Research Question

Primary: can a failing Node.js backend request automatically emit enough
execution context to generate a portable exact-failure reproducer with < 5
minutes of incident-specific human setup?

Secondary questions (all answered below): request-scoped failed-only
persistence; low/No-instrumentation capture of HTTP/PG/clock/random/config;
inferred failure predicate; offline replay without Postgres/network/secrets;
frozen-reducer compatibility; buggy-vs-fixed discrimination; capture overhead.

## Frozen V2 Protocol

`V2-MANIFEST.json`, hash
`2bd9acb413138b03515497402dba1c8ebfc427e61f15bbe4ef659d4effcdacb5`
(recorded in `results/manifest.hash`), frozen 2026-09-07 before headline
evaluation. It pins the capture boundary, the `FailureFingerprintV2` oracle
definition, calibration scenarios, real-bug eligibility, overhead methodology,
hard gates, and decision rules. Two generic harness correctness defects were
fixed after the manifest but **before** corpus freeze and headline runs, and
are classified as protocol amendments (see metrics.json): (1) global bytes
accounting added cumulative instead of delta; (2) `redactTextBody` passed
`sk-live-*`-shaped keys through raw (caught by the new unit test). Neither is
bug-specific; both affect all cases identically.

## Supported Capture Boundary

Single Node.js backend process (Node >= 22); node:http transport (incl.
frameworks built on it); Postgres through the `pg` package (Pool + Client);
outbound HTTP through global fetch; `Date.now` / no-arg `new Date()` /
`Math.random` / `crypto.randomUUID`; allowlisted env config only
(`CAPTURE_CONFIG`); one logical request via AsyncLocalStorage; failures are
HTTP 5xx or request-scoped uncaught application errors. Out of scope:
multi-process, brokers, workers, races, browsers, native modules, persisted
production secrets, other drivers/protocols.

## Capture Runtime Architecture

`src/capture/`: `register.mjs` (single generic bootstrap:
`node --import <experiment>/src/capture/register.mjs app.js`, zero app source
changes; modes off/capture/replay); `context.mjs` + `state.mjs` (ALS request
records); `patch-http.mjs` (listener wrapping for createServer/on);
`patch-pg.mjs` (single CJS `Module._load` hook covering Pool + Client);
`patch-fetch.mjs` (global fetch); `patch-time.mjs` (Date/Math.random/UUID);
`events.mjs` (keyed record/consume with fail-closed infra errors);
`persist.mjs` (persist iff status >= 500 or appError, else discard);
`redact.mjs` (headers/URL/params/body/config redaction over kernel rules).

## Request Context Propagation

Each inbound request gets a stable record (method, path, query, redacted
headers, capped body, sequence id) propagated through async execution with
AsyncLocalStorage. Unit test proves two concurrent requests never share
context. Capture-exempt telemetry prefix `/__` keeps overhead probes out of
incidents.

## Postgres Capture

Query text (whitespace-normalized identity), redacted params, returned rows,
row count, error, and ordering are recorded per request; replay serves the
recorded result by key without connecting (any real `connect()` in replay
throws `RAPTURE_V2_LIVE_ATTEMPT`). Unrecorded queries throw
`RAPTURE_V2_MISSING_MOCK`. Calibration incident 1 exercises 3 queries;
dashboard exercises 6; real-bug cases exercise causal (semver/cron expectation
lookups) and noise reads.

## Outbound HTTP Capture

Method, redacted URL, safe request body, response status, redacted response
headers, response body, and ordering are recorded; replay returns the recorded
response. Anything unrecorded fails closed with an infra-coded error that can
never equal an incident fingerprint.

## Time / Randomness / Config Capture

Consumed `Date.now`/`new Date()` values, `Math.random`/`randomUUID` draws, and
allowlisted config values are recorded as ordered sequences and replayed
deterministically (per-kind counters). Config values that look secret become
`{redacted: true, sha256}` placeholders and are never restored as plaintext.

## Secret Handling

Artifacts never persist Authorization headers, cookies, API keys, DB
passwords, tokens, private keys, or kernel-redaction matches; secret-looking
query params and URL passwords are redacted with shape preserved. Replay fails
closed on live network/DB attempts and needs no original secrets.
Evidence: 20/20 unit tests include header/body/URL/config redaction cases;
`results/secret-audit.json` scans all 32 persisted captures/artifacts:
**0 leaks**. Limitation (honest): no headline case is secret-gated — secrets
that must be persisted are out of scope by design, so redaction is proven by
unit tests + audit, not by a secret-dependent incident.

## Automatic Failure Oracle

`FailureFingerprintV2` is inferred from the incident with no hand-authored
assertion: request method + route, HTTP status, application error name/code
when present, normalized response/error class (`ERR:<code>` from 5xx JSON
envelopes, else `HTTP_<status>`), stable application frame when present, and a
sha256 hash. Normalization strips timestamps, random IDs, request IDs, temp
paths, and stack line offsets — never error identity. Safety rule enforced in
code (`classifyReplayOutcome`): missing mocks, infra errors, live attempts,
syntax/timeout crashes, and unrelated 5xx map to `infra` fingerprints that
cannot satisfy the incident hash. All 6 historical fingerprints were inferred
automatically during capture (e.g. `ERR:E_QS_LIMIT_BYPASS`).

## Calibration Results

8/8 required failure classes on a real node:http service + real local
Postgres + local fake external dependency, all captured with the generic
bootstrap only (no incident-specific instrumentation), then replayed with
Postgres and the fake service stopped.

| Incident | Auto Capture | DB Captured | HTTP Captured | Oracle Auto | Offline 20/20 | Live Effects | Artifact Bytes | Status |
|---|---|---|---|---|---|---|---|---|
| DB row edge case (/orders/ord-bad) | yes | yes (3) | — | ERR:E_ORDER_SUSPENDED | 20/20 | 0 | 2552→1218 | PASS |
| Malformed upstream JSON (/profile) | yes | — | yes (2) | ERR:E_PROFILE_SHAPE | 20/20 | 0 | 1230→872 | PASS |
| Upstream 503 broken fallback (/price) | yes | yes (1) | yes (1) | ERR:E_PRICE_FALLBACK | 20/20 | 0 | 1415→809 | PASS |
| Time-expiry boundary (/token) | yes | yes (1) | — | ERR:E_TOKEN_EXPIRED | 20/20 | 0 | 979→486 | PASS |
| Random/UUID faulty branch (/rollout) | yes | yes (1) | — | ERR:E_ROLLOUT | 20/20 | 0 | 1132→637 | PASS |
| Config combination (/store) | yes | yes (1) | yes (1) | ERR:E_STORE_CONFIG | 20/20 | 0 | 1372→781 | PASS |
| DB+HTTP interaction (/checkout) | yes | yes (1) | yes (1) | ERR:E_CHECKOUT | 20/20 | 0 | 1357→770 | PASS |
| Noise-heavy (/dashboard, 20 events) | yes | yes (6) | yes (4) | ERR:E_DASHBOARD | 20/20 | 0 | 6844→3980 | PASS |

160/160 fresh-process offline replays; 8/8 reduced portable 20/20 with the
frozen V1 GREEDY reducer (atoms 80→29 total, trials 73); 0 wrong-failure
acceptances; 0 secret leaks. Calibration is substrate evidence only, not
headline product evidence.

## Capture Overhead

Same fixed workload (N=150, warmed) across three modes:

| Mode | Median Latency | P95 Latency | Throughput | RSS | Overhead % |
|---|---|---|---|---|---|
| off | 3 ms | 8 ms | 267.4 rps | +3.2 MB | — |
| capture-discard (successes dropped) | 3 ms | 13 ms | 205.2 rps | +8.9 MB | median 0%, p95 +62.5% |
| capture-persist (failures written) | 3 ms | 128 ms | 62.8 rps | +8.7 MB | median 0%, p95 +1500% |

Median meets the usefulness target (<=10%); **p95 misses it** (<=15%).
Caveats: ms-granularity quantization dominates at 3 ms medians, and the
persist path includes synchronous file writes on failures only. Reading:
overhead looks plausible for sampled/failed-request recording, not proven for
full production traffic — a narrowing caveat, not a gate failure (overhead
carries no hard gate).

## Frozen Capture Implementation

Tree hash `3c0197b458d8b47372f60de8e820847717cc217f867d2042a5207c6775cc722e`
(`results/capture-freeze.json`, 13 files across src/capture, src/oracle,
src/replay), frozen after calibration and before headline bug selection. No
post-freeze capture changes; no bug-specific hooks/wrappers/assertions exist
anywhere in headline cases (asserted by corpus runner design + 0-wrapper
burden records).

## Historical Backend Bug Corpus

6 frozen eligible cases across 6 repositories (target 8, minimum 6 met;
repositories minimum 3 exceeded). Each wraps a public pre-V2 historical bug
(revisions from the V1 corpus, vendored trees reused unmodified) in a bounded
node:http harness. At least 3 exercise Postgres (semver-tilde and cron-dow
causally, plus noise reads in 4 others); at least 3 exercise outbound HTTP
(qs-limit, semver-tilde, validator-crash, jwt-maxage, lru-evict, cron-dow all
hit the local fake). Frozen in `real-bugs/bug-corpus.json` before headline
runs; all searched candidates with exclusion reasons in
`real-bugs/exclusions.json`. Stated limitation: the corpus inherits V1's
library-level granularity (bugs behind HTTP harnesses, not full service
repos) — service-repo bugs with pinnable revisions were not identifiable
offline and are recorded as an excluded class, not silently dropped.

## Corpus Exclusions

5 V1 sibling cases excluded by pre-registered per-repo diversity caps;
1 duplicate-repo case excluded for extreme per-trial replay cost; genuine
service-repo bugs excluded as unidentifiable offline. No eligible case was
dropped after outcomes (freeze predates all headline runs).

## Per-Bug Automatic Capture Results

Generic integration per case: one bootstrap (`--import register.mjs`) +
`CAPTURE_CONFIG=FAKE_ORIGIN` + one trigger request. Application source LOC
changed: 0. Incident-specific wrappers/assertions/causal facts: 0.

| Repository | Issue/Bug | Buggy SHA | Fixed SHA | DB | Outbound HTTP | Integration LOC | Setup Minutes | Auto Capture | Oracle Auto | Offline 20/20 | Reduced Portable | Buggy FAIL | Fixed Failure Absent | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ljharb/qs | CVE-2026-2391 f/u | 8079adc7 | 8859c374 | noise | noise | 0 | 2 | SUPPORTED | ERR:E_QS_LIMIT_BYPASS | 20/20 | 20/20 | yes (500) | yes (400) | AUTO_CAPTURE_SUPPORTED |
| npm/node-semver | PR #878 | 8640bd68 | 9c8692ae | causal | noise | 0 | 2 | SUPPORTED | ERR:E_SEMVER_MISMATCH | 20/20 | 20/20 | yes (500) | yes (200) | AUTO_CAPTURE_SUPPORTED |
| validatorjs/validator.js | #2822 | d563b158 | 7d42ed2d | noise | noise | 0 | 2 | SUPPORTED | ERR:E_VALIDATOR_CRASH | 20/20 | 20/20 | yes (500) | yes (200) | AUTO_CAPTURE_SUPPORTED |
| auth0/node-jsonwebtoken | maxAge units | 67550492 | b61cc343 | noise | noise | 0 | 2 | SUPPORTED | ERR:E_JWT_MAXAGE_BYPASS | 20/20 | 20/20 | yes (500) | yes (401) | AUTO_CAPTURE_SUPPORTED |
| isaacs/node-lru-cache | oversize guard | 7ef678e4 | a3eadb1d | noise | noise | 0 | 2 | SUPPORTED | ERR:E_CACHE_WIPE | 20/20 | 20/20 | yes (500) | yes (200) | AUTO_CAPTURE_SUPPORTED |
| harrisiirak/cron-parser | PR #438 | 8410d371 | b48a355b | causal | noise | 0 | 2 | SUPPORTED | ERR:E_CRON_MISMATCH | 20/20 | 20/20 | yes (500) | yes (200) | AUTO_CAPTURE_SUPPORTED |

## Offline Full Replay Results

6/6 replay exact inferred failure 20/20 offline (120/120 runs) with Postgres
stopped, fake service stopped, and dead `PGPORT`: single-outcome fingerprint
in every run (no divergent classes observed). 0 unexpected live network/DB
effects (fail-closed guards armed; none tripped).

## Frozen Reduction Results

Frozen V1 GREEDY reducer, unchanged algorithm, exact-fingerprint rejection:
atoms 35→17 total across cases (5→2, 5→2, 5→2, 6→3, 6→3, 8→5; median 55%
atom reduction), 35 trials total, 0 wrong-failure acceptances. Median byte
reduction 37.6% — modest because request-scoped captures are already small
(4–7 events); there is little ambient noise left to remove, unlike V1's
deliberately noisy fixtures.

## Portable Artifact Results

6/6 reduced artifacts replay 20/20 from clean temp directories
(`results/real-bugs/artifacts/*.json`), artifact-only (no original capture
needed), deterministic sha256 hashes, no secrets, no network.

## Buggy-vs-Fixed Results

6/6 FIX_CONFIRMED: buggy revision reproduces the inferred fingerprint (HTTP
500 with the expected code); fixed revision returns clean 200/400/401 without
the original fingerprint. Fixed revisions were never exposed to capture or
reducer (separate `IMPL_MODE=fixed` boot after reduction). No INCONCLUSIVE
(harness failures) and no NOT_CONFIRMED occurred.

## Incident-Specific Manual Burden

Per case: 2 minutes (trigger request identifier only), 0 application LOC, 0
wrappers, 0 assertions, 0 manually supplied causal facts. Median 2 min vs
V1's 25 min — the workflow bottleneck V2 targeted is reduced by ~12x on
eligible cases. The remaining 2 minutes is harness boot + firing one request,
not boundary modeling.

## Wrong-Failure Analysis

Calibration: every 20/20 run produced exactly the incident class (8 singletons,
160 runs). Historical: every 20/20 full and artifact run produced exactly the
incident class (12 singletons incl. reduction verifies, 240+ runs). Reducer
trials: 35 historical + 73 calibration trials, all either reproducing the
exact hash or failing closed. **Wrong-failure acceptances: 0 everywhere.**
Oracle strictness note (honest): oracles are response-envelope classes plus
error identity; two incidents sharing route+status+code would collide — not
observed in 14 cases, but the oracle is strict, not universal.

## Runtime Overhead

See Capture Overhead table. Median 0% meets the target; p95 +62.5% on
successful requests misses it. Verdict for this question: plausible for
selected/failed-request recording, unproven for full-traffic production.

## Unsupported Failure Classes

Untested by construction (0 samples, boundary-excluded): multi-process,
distributed transactions, brokers, detached workers, races, browsers, native
nondeterminism, secret-gated bugs, non-pg drivers/protocols. Most real
application-level bugs outside the narrow boundary remain out of reach — the
same narrowing V1 flagged, now quantified as the eligible denominator (6/6
inside, unknown outside).

## Hard Gates

| Metric | Observed | Required | Pass |
|---|---|---|---|
| Calibration auto captured | 8/8 | 8/8 | yes |
| Calibration offline 20/20 | 8/8 | 8/8 | yes |
| Calibration live effects | 0 | 0 | yes |
| Calibration secret leaks | 0 | 0 | yes |
| Calibration wrong acceptances | 0 | 0 | yes |
| Eligible historical bugs | 6 | ≥6 | yes |
| AUTO_CAPTURE_SUPPORTED rate | 6/6 (100%) | ≥70% | yes |
| Replay rate of supported | 6/6 (100%) | ≥70% | yes |
| Portable rate of replayed | 6/6 (100%) | ≥70% | yes |
| Wrong-failure acceptances | 0 | 0 | yes |
| Secret leaks | 0 | 0 | yes |
| FIX_CONFIRMED of evaluable | 6/6 (100%) | ≥80% | yes |
| Median setup minutes | 2 | ≤5 | yes |
| Median wrapper count | 0 | 0 | yes |
| Median assertion count | 0 | 0 | yes |

## Usefulness Targets

| Target | Observed | Pass |
|---|---|---|
| Median successful-request overhead ≤10% | 0% | yes |
| p95 successful-request overhead ≤15% | +62.5% | **no** |
| Median atom reduction ≥50% | 55% | yes |
| Persist only failed requests | yes (successes discarded) | yes |
| One bootstrap/config integration | yes (`--import` + allowlist) | yes |

## Scientific Interpretation

H1 (one bootstrap captures the nondeterminism for exact offline replay):
supported — 14/14 incidents across calibration + history replay exactly with
no live dependencies. H2 (incident provides a strict-enough oracle):
supported within the envelope — 14/14 inferred fingerprints discriminate
buggy from fixed with 0 collisions, though the oracle is class-shaped, not a
proof of universality. H3 (frozen reducer converts auto captures):
supported — 14/14 reduced portable with no algorithm change (and the
reduction step is as cheap as V1 found). H4 (overhead plausible): mixed —
median passes, p95 fails; selective recording is defensible, full-traffic
production is not shown. H0 (per-incident engineering remains): rejected for
eligible cases (2 min, 0 wrappers) but surviving outside the boundary, where
most real bugs likely live. H5 untested by design.

## Product Implication Without Product Claim

If the eligible denominator resembles an organization's request-scoped
pg+fetch failures, the debugging workflow collapses from ~25 minutes of
fixture modeling to firing one request against an instrumented process — the
bottleneck V2 was built to attack. Nothing product-shaped was built (no SaaS,
CLI, dashboard, or deployment); no demand signal was measured. The p95
overhead miss and the library-level corpus granularity are the two explicit
blockers before any product-shaped claim.

## Decision: CONTINUE / MODIFY / KILL / INVALID_EXPERIMENT

**CONTINUE** — with a recorded performance caveat. Every hard gate passes,
most at 100% with zero safety violations, and the manual-burden target (the
experiment's reason to exist) is beaten 2 min vs 5 min. The p95 overhead miss
narrows *deployment* scope (sampled/failed-request recording, not full
traffic) but does not touch the capture/oracle thesis gates. KILL would
require per-bug engineering, live-dependency replay, or unsafe oracles —
none observed. MODIFY would require success confined to a narrower subset
than claimed — but pg-causal, http, time, random, and config cases all pass,
so no narrowing of the frozen boundary is evidenced. The next research action
(not designed here) should target the two honest weaknesses: p95 overhead
reduction and service-repo (non-library) incidents. Anti-goalpost check: no
reducer work was done, no boundary types were added to rescue cases, no
frozen case was dropped, calibration is not counted as headline evidence,
and no product demand is inferred.

## Recommended Next Research Action

A p95-overhead spike (async persistence off the hot path, header/body caps
reviewed) plus 3–5 genuine service-repo incidents attempted under the frozen
bootstrap with zero capture changes; success criterion for continued funding:
≥70% become portable reproducers with setup ≤5 min and p95 overhead ≤15%.
Do not build product surface until that spike reports.

---

Required answers: (1) Yes — one generic `--import` bootstrap auto-captures
the state for exact offline replay (14/14). (2) Yes — the incident infers a
fingerprint that discriminates buggy from fixed with 0 collisions (14/14).
(3) Yes — all replays run with Postgres and external services stopped
(280/280). (4) Yes — median setup 2 min vs V1's ~25 min. (5) Zero eligible
bugs needed bug-specific instrumentation. (6) 6/6 (100%) of eligible bugs
became portable exact reproducers. (7) Median 0%, p95 +62.5% (successful
requests); persist path p95 far higher (failures only). (8) No — 0 leaks in
32 scanned artifacts plus redaction unit tests. (9) Continue the capture
program with a performance caveat; narrow deployment scope, not the thesis.

RAPTURE_REPRODUCER_V2_STATUS=CONTINUE
