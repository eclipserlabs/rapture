# Rapture Reproducer V3 — Final Research Report

## Executive Summary

V3 asked whether the frozen V2 capture/oracle/replay pipeline converts failures
from **real service repositories** into portable exact executable incidents with
no bug-specific instrumentation, within production-plausible overhead and
privacy bounds. Result: **yes on coverage, correctness, burden, and privacy;
no on full-traffic performance — verdict MODIFY**. 8/8 frozen eligible
incidents across 7 repositories and 4 framework families (koa, express,
fastify, hapi — real entry points, routing, middleware, pg session lookup,
outbound fetch) became reduced portable reproducers with 2-minute marginal
setup, 0 wrappers/assertions, 0 wrong-failure acceptances, 0 secret leaks,
and 8/8 FIX_CONFIRMED (160/160 offline + 160/160 portable + 40/40 fake-down
replays exact). The V2 p95 spike (+62.5%) was diagnosed as
implementation-specific (eager hot-path serialize+redact) and removed — but
success-path performance straddles the production thresholds across
repetitions (final run median p95 +7.7% / throughput -14.0% vs first-pass
+20.6% / -19.4%; structural p50 floor ~+22%), capping the supported boundary
at sampled/selective capture: verdict MODIFY.

**What the headline evidence is, precisely.** Each of the 8 cases is a real
historical bug in an independently existing public repository, checked out at
its exact buggy and fixed SHAs, exercised through that project's **real
framework/service entry path** (`app.listen` / `server.start` /
`Fastify.listen`) with its actual routing, middleware, and buggy
implementation. The *route handler around* that code is
**experiment-authored service scaffolding** (~35-60 LOC per case: the route,
a logging + body middleware pair, a pg session lookup, an outbound config
fetch, and the invariant check that turns the historical defect into an HTTP
500). These are **not eight untouched full production applications**. No
larger application was carried end-to-end in V3 — the directus-scale clones
were directory-screened only (see "Real Service Candidate Screening" and
"What V3 Does NOT Prove"). Removing this remaining realism gap is the job of
the V3.1 large-application case, not of V3.

## V3 Review Closure (re-verified 2026-09-09)

Before V3 was frozen and V3.1 begun, the whole result was re-derived from the
committed protocol rather than trusted from the prose:

- **Frozen hashes reconcile.** Capture tree recomputed
  `8a8ef009d19a7345514d87c41a1133c89674dbc08ef4306dc51bf0fdd1da7fbf` (matches
  `results/capture-freeze.json`); protocol manifest recomputed
  `e1734dcbf488d3c7e705d2217a1ec973de5180ab2e43e96d6d2640a883466b7b` (matches
  `results/manifest.hash`); frozen corpus recomputed
  `9c139c36ba0432cb40b90ab97fa4dfb640258460963c111807d72886bcd8382a` (matches
  `results/headline/bug-corpus.hash`, and `headline/bug-corpus.json` is
  byte-identical to the results copy).
- **Required tests re-run green.** V2 suite `test/capture-v2.test.js` 20/20
  under Node v22.14.0. V3 has no unit suite of its own — the frozen V3 tree is
  evidenced by the V2/V3 equivalence check plus the headline and privacy
  campaigns; that gap is recorded here rather than papered over, and V3.1
  carries a dedicated suite.
- **V2/V3 capture equivalence re-verified.** `scripts/perf-equiv.mjs`
  reports `EQUIVALENT` (same fingerprint, event count, and replay keys) —
  the deferred-recording redesign still preserves V2 semantics exactly.
- **Complete post-amendment headline rerun.** All 8 cases were re-run from a
  cleared summary (no resume) under the final fixture state: 8/8
  AUTO_CAPTURE_SUPPORTED, 160/160 offline exact, 160/160 portable exact, 8/8
  FIX_CONFIRMED, 0 wrong-failure acceptances, 0 secret leaks. Fake-external
  **stopped** + dead PGPORT: 40/40. Every fingerprint, atom count, artifact
  byte count, reducer-trial count and gate value is identical to the values
  reported below; only `artifact_sha` differs, because artifacts embed
  run-volatile fields (`captured_at`, `req_id`, `capture_hash`, recorded time
  draws).
- **Privacy re-run.** Headline secret audit: 0 raw leaks, 0 PII violations,
  surrogate `[SESS:196daafb6c79]` deterministic across files and across runs
  (16 files this run vs 18 previously — the fresh run produced exactly one
  capture per case instead of three for koa-1999). Gate-tier attack suite: 8
  captures, 0 gate leaks, 0 PII violations, 0 replay failures, 0 divergences;
  the gap tier (JWT/PEM/card/bare-password/base64) still leaks raw and is
  still reported as an unsolved boundary finding, not a pass.
- **Verdict preserved.** V3 stays **MODIFY**. Nothing in this re-verification
  upgrades it, and no threshold was moved.

## V2 Freeze

- V2 branch `research/minimal-executable-reproducer-v2`, frozen commit
  `44a86c4edd364c0a37c3c577d8b283f7d87fa683`
  ("research: validate automatic executable incident capture v2").
- V2 HEAD verified on the V3 branch before headline work: `test/capture-v2.test.js`
  **20/20 pass under Node v22.14.0** (correctness, frozen reduction, buggy-vs-fixed,
  workspace green). One headline verification (v2-qs-limit) was attempted via the
  V2 corpus runner; the runner needs live Postgres and was stopped to avoid
  mutating frozen V2 results — the 20/20 suite (which includes buggy-vs-fixed
  discrimination) stands as the verification pass. V2 results tree restored
  byte-identical afterwards (`git checkout -- experiments/reproducer-v2/results`).
- Preserved V2 caveats (unchanged, not rewritten):
  (1) p95 success-path overhead **+62.5%** (usefulness target failed);
  (2) headline corpus was **library-level harnesses**, not service repositories.
- V3 branch `research/minimal-executable-reproducer-v3` created from the exact
  V2 commit. Per commit policy, V3 work is left **uncommitted** for review.

## Research Thesis

A backend failure should be transformable automatically into a trustworthy
portable executable incident that runs offline and reproduces the same failure
against the real application code. V3 tests the frozen V2 capture/oracle/replay
pipeline against **actual service repositories running their normal HTTP request
stacks**, with performance and privacy as first-class product kill gates.
Reduction is NOT the frontier (frozen V1/V2 GREEDY reused unchanged); no agent
repair; no productization.

## Preregistered V3 Protocol

`experiments/reproducer-v3/manifests/V3-MANIFEST.json`, sha256
`e1734dcbf488d3c7e705d2217a1ec973de5180ab2e43e96d6d2640a883466b7b`
(recorded in `results/manifest.hash`), frozen 2026-09-09 before headline
evaluation. It pins: real-service definition, supported V3 boundary, historical
eligibility, screening integrity (broader pool, frozen bug-corpus.json hashed
before first headline capture, no replacement of failed eligible cases),
coverage denominator (failures count, never reclassified), automatic-oracle
rules (FailureFingerprintV2, no per-bug tuning), 5-mode performance methodology
(>=5 reps, >=5000 reqs, rotated order), privacy threat model + hard privacy
gates, hard coverage/correctness/manual-burden gates, production-viability
performance gates (median p95 <=20%, no service p95 >35%, median p99 <=30%,
median throughput degradation <=15%), usefulness targets, kill conditions, and
CONTINUE/MODIFY/KILL/INVALID_EXPERIMENT/INSUFFICIENT_CORPUS decision rules.

## Real Service Definition

Each headline case must be an independently existing public Node.js service
repository started through its real entry point (`app.listen` / `server.start` /
`Fastify.listen`), exercising actual routing + middleware + the historical
buggy implementation, with >=2 of: framework routing, middleware, auth/session,
database access, outbound HTTP, config behavior, multi-module service layer.
Forbidden: calling one utility directly, rewriting app routes for capture,
replacing middleware, hand-mocking recorded dependencies, bug-specific oracle
assertions. All 8 frozen cases satisfy this (4 framework families; every
service runs logging + body middleware, a pg session lookup, and an outbound
config fetch per request).

## Supported Boundary

Node 22+, one application process per captured request, actual service HTTP
entry on node:http-compatible stacks (express 4, fastify 5, hapi 21, koa 3),
Postgres via pg where present, outbound HTTP via global fetch, time/randomness
via the frozen mechanism, AsyncLocalStorage request context, HTTP-5xx failure
trigger. Out of scope (unchanged): multi-process, detached queues/workers,
WebSocket/session replay, scheduler races, native nondeterminism, non-pg
drivers, browser, private prod credentials, full prod snapshots.

## Corpus Storage / Reproducibility

No third-party repository is vendored into `experiments/reproducer-v3/`.
Historical revisions live as git worktrees under
`.rapture/reproducer-v3/corpus-hl/` (gitignored) plus V1-vendored dep trees
reused unmodified; `headline/bug-corpus.json` pins repository URLs, exact SHAs,
worktree names, service files, triggers, and ports, and a clean checkout plus
the worktree script reproduces the corpus from public repos. Tracked
experiment size is 6.4 MB (preferred <10 MB: 5.5 MB calibration raw + 75
headline perf files + 16 headline captures/artifacts + manifests); external
corpus cache is 6.1 GB (framework worktrees with node_modules + screening
clones + Postgres data, all gitignored under `.rapture/`).

## V2 p95 Overhead Root-Cause Investigation

V2 reported +62.5% p95 success-path overhead at N=150 with ms quantization.
V3 investigated on 2 calibration services that will NEVER be headline cases
(shop: routing/middleware/API-key auth/pg/fetch; directory: session lookup,
2pg+2fetch search), local PG + deterministic fake external, 5 modes
(OFF/CONTEXT_ONLY/INTERCEPT_DISCARD/FULL_SUCCESS_PATH/FAILED_PERSIST),
10 independent reps x 5000 measured requests, rotated order, warmed,
concurrency 16, plus --cpu-prof attribution on the frozen V2 code.

Profile finding: directly Rapture-attributable self-time was only ~3.2%
(recordEvent JSON.stringify byteLength 0.9%, kernel regexes 0.5%,
redactHeaders 0.4%, pg/http/time wrappers ~0.5/0.5/0.4%). The tail was NOT
self-CPU: async/task-queue effects — Response.clone() tee per outbound fetch,
extra promise hops per pg query, ALS init/destroy tax per async resource,
per-chunk string concat, regex passes over bodies discarded on success.

Generic optimizations applied (all from the preregistered allowed list,
before headline freeze): defer serialization to failure time (raw refs only
on hot path); defer redaction to persist; raw Buffer chunk buffering with
decode+cap+redact at persist; clone consumed as raw bytes on success path;
request-local ephemeral buffering with event counting in intercept-discard;
no hashing of discarded data; plus one generic correctness fix found by
calibration (http wrapper put streams in flowing mode, losing bodies for apps
that await before reading — V2 triggers were all GETs so frozen V2 has this
flaw too; fixed via pause/resume, recorded as protocol amendment).

Fidelity check: V2-code vs V3-code capture of the same failing incident is
byte-identical modulo run-volatile values (request-id UUID, HTTP date, time
draws); fingerprint, keys, redacted bodies equal.

Outcome (frozen tree 8a8ef009, median-of-rep-medians, 10 reps): service A
capture vs off p50 +32.8%, p90 +12.6%, p95 -2.4%, p99 -1.7%, throughput
-22.6%; service B p50 +44.1%, p90 -0.7%, p95 -1.3%, p99 +1.4%, throughput
-16.5%. Ladder (p50): CONTEXT_ONLY +7/+19% (ALS+wrap), INTERCEPT_DISCARD
+35/+20%, FULL +33/+44% — retention adds ~0pp (deferred design holds). V2's
+62.5% p95 tail did NOT reproduce: it was implementation-specific (eager
serialize+redact on the hot path) plus small-N quantization. What remains is
structural: ~+35-44% p50 / ~-20% throughput cost of always-on interception
(ALS propagation across dozens-hundreds of async resources per request +
wrapper promise hops + fetch tee). Environment noise dominates tails
(rep-to-rep whole-machine slowdowns; CIs wide; sub-+-15pp estimates are bands).

## Generic Performance Changes

Listed above; all justified directly by profiling, all generic (no per-case
logic), frozen in tree 8a8ef009 before headline corpus runs. V2 correctness
tests re-run green (20/20) after the changes; V2 calibration correctness
re-verified by byte-identical equiv check; 0 new wrong-failure acceptances;
0 new secret leaks.

## Frozen Capture Implementation

Tree hash `8a8ef009d19a7345514d87c41a1133c89674dbc08ef4306dc51bf0fdd1da7fbf`
(`results/capture-freeze.json`, 13 files across src/capture, src/oracle,
src/replay), frozen after calibration + privacy fixes and before headline
corpus runs. No post-freeze capture changes. One fixture amendment during
headline runs (documented, not a capture change): the koa-1998 service route
mapped unknown throws (including replay-infra errors) to the incident code,
letting a missing-mock failure satisfy the fingerprint; the fixture now maps
only the guard's 401-status failure to E_ASSERT_REGRESSION and rethrows the
rest to the framework default (oracle safety rule). No bug-specific capture
hooks/wrappers/assertions anywhere (0/0/0 in burden records).

**koa #1998 amendment status: `PROTOCOL_AMENDED_AND_FULLY_RERUN`.** The
amendment touched only the experiment-authored service fixture
(`headline/services/koa-1998.mjs`) — never the frozen capture tree, oracle,
reducer, or replay engine, and the tree hash is unchanged
(`8a8ef009…`). koa-1998 was re-run under the amended fixture, and on
2026-09-09 the **entire 8-case corpus** was re-run from a cleared summary
under the final fixture state with identical results (see "V3 Review
Closure"). Both amendments — this one and the pre-freeze generic
flowing-mode fix in `patch-http.mjs` — are recorded machine-readably in
`results/headline/protocol-amendments.json`.

## Privacy Threat Model

Experiment policy, NOT a compliance certification. Gate tier (raw values must
never serialize): inbound/outbound header values with sensitive names,
sensitive query-param values + URL userinfo passwords, secret-like config
values/names, provider-key shapes in bodies/pg-params/URLs (V3 SECRET_VALUE
scrub over kernel redaction). Documented gaps (exploratory, never gated;
secret-gated incidents are outside the V3 boundary): arbitrary password values
in JSON/rows without name signal, JWTs/PEM/cards in free text, base64-encoded
secrets, PII emails/phones/names outside name-based locations (retained in DB
rows/bodies only where the app branches on them). Fixed-point principle:
N(redacted(x)) == N(x) — substring scrub idempotent, session pairs to
deterministic [SESS:sha12], replay keys from redacted values both sides;
whole-value [REDACTED] for pg params was tried and REJECTED (breaks matching).
Attack suite: 14 classes, 8 gate captures replay 5/5, 0 gate leaks, 0 PII
violations; gap tier leaks (JWT/PEM/card/password-value/base64) reported as
boundary-mapping findings. Headline services carry no PII payloads by
construction; session/auth travels only as a constant pair-form probe that
frozen scrub maps to [SESS:*] idempotently (verified: raw handles absent from
all 16 headline files, surrogate deterministic across files).

## Real Service Candidate Screening

Screened (external cache `.rapture/reproducer-v3/corpus*/`, gitignored):
koa #1999 + #1998, express CVE-2024-47764, qs CVE-2026-2391-follow-up,
fastify CVE-2025-32442, semver PR #878, hapi #4560 + #4564 (all included);
fastify CVE-2026-33806 (EXCLUDED after screening: leading-space trigger
erased by node:http OWS trimming and undici — outside transport boundary);
fastify #6558 ReDoS (screened, not selected: parsing outside handlerTimeout,
no 500 attainable); hapi b5e8d331 pipelined (screened: 400-vs-empty, no 500);
directus/etherpad-lite/nocodb/payload/tooljet/parse-server/koa clones
(directory-level screening; no pinnable single-request historical bug fitting
the boundary identifiable within budget — honest limitation, not silent drop).
Full record: `headline/exclusions.json` (+ results copy). Baseline bugs were
reproduced WITHOUT Rapture before freeze; headline capture ran only after
`bug-corpus.json` was frozen (sha256
`9c139c36ba0432cb40b90ab97fa4dfb640258460963c111807d72886bcd8382a`,
`results/headline/bug-corpus.hash`). No frozen case replaced.

## Frozen Headline Corpus

8 eligible baseline-reproducible incidents, 7 distinct repositories
(koajs/koa, expressjs/express, jshttp/cookie, ljharb/qs, fastify/fastify,
npm/node-semver, hapijs/hapi), 4 framework families (koa, express, fastify,
hapi). Two incidents exercise dependency bugs (qs, semver — V2 SHAs) through
full framework stacks rather than bare harnesses; six are framework bugs.
One pg-CAUSAL case (express-semver via v2_expect); all cases run pg session
lookup + outbound fetch noise per request.

## Service Architecture Summary

Every service: real entry point (listen/start), framework routing, logging +
body middleware, pg session-table lookup (constant pair-form probe —
surrogate-stable, §Privacy), outbound fetch to local fake external for
config, multi-module route handler; bug trigger → HTTP 500 with ERR code,
fixed revision → clean 200/400/401. Buggy/fixed revisions are isolated git
worktrees (exact SHAs in bug-corpus.json); services mount them via REPO_ROOT
with zero application-source changes; Rapture integration is exclusively the
frozen `--import register.mjs` bootstrap plus env.

## Automatic Capture Coverage

8/8 frozen eligible incidents reached AUTO_CAPTURE_SUPPORTED with only the
generic frozen integration (bootstrap + trigger). Setup 2 min/case (trigger
only, V2 convention), 0 bug-specific wrappers, 0 bug-specific assertions,
0 manually supplied causal facts, 0 application LOC changed. (Experiment-
authored service-route fixtures ~35-60 LOC each are tracked scaffolding, not
Rapture instrumentation; fixture LOC reported separately, not counted as
integration burden per the V2 convention.)

## Offline Replay Results

8/8 replay the exact inferred fingerprint 20/20 offline (160/160) with dead
PGPORT and fail-closed guards armed: single outcome class every run, 0
unexpected live network/DB effects. Fake-down proof: all 8 portable artifacts
replay 5/5 (40/40) with the fake-external process STOPPED and dead PGPORT.

## Portable Artifact Results

8/8 reduced portable artifacts replay 20/20 (160/160) from clean temp dirs,
artifact-only (no original capture), bytes 2963-3772 (median ~3150), atoms
2/4, 2/4, 2/4, 2/4, 3/6, 3/5, 3/5, 2/4 (median reduction ~50%), reducer trials
36 total (4,4,4,4,6,5,5,4), 0 wrong-failure acceptances, 0 secret leaks, no
absolute original paths. Reduction ratio is secondary in V3 (reported only).

## Buggy-vs-Fixed Results

8/8 FIX_CONFIRMED: buggy revision reproduces the inferred fingerprint (500 +
ERR code); fixing revision returns clean 200/400/401 with the original
fingerprint absent (fixed statuses: 200,401,400,400,400,200,200,200). Fixed
revisions never saw capture or reducer. 0 INCONCLUSIVE.

## Manual Integration Burden

Median incident-specific Rapture setup 2 min (<=5), median bug-specific
wrappers 0, assertions 0, causal facts 0. Baseline fixture construction
(worktree + service route + trigger, incl. debugging) averaged ~15-30 min per
case one-time — reported separately from Rapture setup per the V2 convention;
the Rapture-side marginal cost per new incident on a known stack is the
2-minute trigger.

## Headline Performance Results

3 headline services (express-qs, koa-1999, fastify-32442 at FIXED revisions,
success triggers with pg+fetch on path), 5 modes x 5 reps x 5000 measured
requests, rotated order, warmed, concurrency 16, raw latency arrays +
server telemetry (CPU/RSS/heap/ELU/GC via capture-exempt `/__stats`) in
`results/headline/perf/` (75 files + aggregate.json). Median-of-reps,
FULL_SUCCESS_PATH (capture) vs OFF, final complete run:

- express-qs: p50 +21.2%, p90 -1.6%, p95 -1.1%, p99 -0.2%, throughput -10.7%
- koa-1999: p50 +25.6%, p90 +20.2%, p95 +7.7%, p99 +8.1%, throughput -16.1%
- fastify-32442: p50 +21.7%, p90 +27.3%, p95 +24.7%, p99 +10.6%, throughput -14.0%

Medians across services: p50 +21.7%, p90 +20.2%, p95 +7.7%, p99 +8.1%,
throughput -14.0%. 0 failed/errors in all 75 runs. Resource deltas
(median capture-over-off per 5000-req run): CPU +6.3-7.7s user, RSS
+43-55 MB (ephemeral, discarded), ELU mean ~17ms.

Run-to-run variance (reported, not hidden): a first latency-only pass
(same design, no telemetry) measured median p95 +20.6% and throughput
-19.4% (two gates failing); the final telemetry-complete pass measures
+7.7% / -14.0% (all passing). With n=5 the true values straddle the
thresholds — see interpretation.

## p50/p90/p95/p99 Analysis

Calibration (n=10): p95/p99 overheads ~0% (tail fixed), p50 +33/+44%
(structural). Headline final (n=5): p50 +21/+26/+22%, p90 -2/+20/+27%, p95
-1/+8/+25%, p99 -0/+8/+11%. Tails are no longer blown up (V2's +62.5% was
implementation-specific), but the success-path floor (p50 consistently
~+22%) and throughput (~-14%) remain structurally expensive under always-on
interception, and run-to-run variance (first pass median p95 +20.6% /
throughput -19.4%) puts the true values astride the preregistered
thresholds — a MODIFY-grade limitation, not a clean pass.

## CPU / Memory / Event-Loop Analysis

Calibration telemetry (perf-a/b raw): CPU +15-25% in capture, RSS deltas
+85-92MB vs +3-8MB off (ephemeral per-request buffering, discarded on
success), heap +20-40MB, ELU mean +20-60%, GC counts +30%. Headline
telemetry (per 5000-req run, capture-over-off medians): CPU user +6.3-7.7s,
RSS +43-55MB, ELU mean ~17ms both modes (event loop not saturated; cost is
spread across ALS/task-queue work, not loop blockage). Retention adds ~0pp
over intercept-discard: cost is interception (ALS + wrappers + tee), not
persisted bytes.

## Privacy and Secret Audit

Attack suite: 0 gate leaks, 0 PII violations, 7/7 gate captures replay 5/5
(`results/privacy/attack.json`); gap tier (JWT/PEM/card/bare-password/base64)
documented as boundary findings. Headline: `headline/secret-audit.json` scans
18 files (8 captures + 8 artifacts + corpus manifests): 0 raw secret leaks, 0
PII violations, 0 absolute-path leaks; [SESS:*] surrogate present and
deterministic across files (expected marker for the probe handle observed);
0 replay failures caused by redaction (160/160 + 160/160 + 40/40 all exact).

## Privacy-vs-Fidelity Failures

None: no case required raw sensitive content for replay; no case was
privacy-blocked. Session/auth state travels as a constant pair-form probe
that frozen scrub maps idempotently, preserving key agreement. The one
fidelity-relevant finding is the koa-1998 fixture amendment (below), which
was a service-mapping defect, not a redaction-vs-fidelity conflict.

## Unsupported Incident Classes

Within screening: transport-erased triggers (fastify-33806 leading space),
parse-outside-timeout ReDoS (#6558), non-500 status fixes (hapi pipelined),
full-service clones without pinnable single-request bugs
(directus/etherpad/nocodb/payload/tooljet/parse-server). By construction
(0 samples, boundary-excluded): multi-process, detached queues/workers,
WebSocket/session replay, scheduler races, native nondeterminism, non-pg
drivers, browser, private prod credentials, full prod snapshots.

## Hard Gates

| Gate | Observed | Required | Pass |
|---|---|---|---|
| Eligible incidents | 8 | >=8 | yes |
| Distinct repos | 7 | >=5 | yes |
| Framework families | 4 | >=2 | yes |
| No library-wrapper cases | 0 wrappers (2 dep-bugs via real stacks, disclosed) | 0 | yes |
| AUTO_CAPTURE_SUPPORTED | 8/8 (100%) | >=70% | yes |
| Offline 20/20 of supported | 8/8 (160/160) | >=80% | yes |
| Portable 20/20 of replayed | 8/8 (160/160) | >=80% | yes |
| FIX_CONFIRMED of evaluable | 8/8 (100%) | >=80% | yes |
| Wrong-failure acceptances | 0 | 0 | yes |
| Live external effects | 0 | 0 | yes |
| Raw credential/secret leaks | 0 | 0 | yes |
| Artifact-only replay | yes (tmp-dir isolated, PG dead, fake down) | yes | yes |
| Median Rapture setup | 2 min | <=5 | yes |
| Median wrappers/assertions/causal facts | 0/0/0 | 0 | yes |

## Performance Gates

| Gate | Observed (final run) | Required | Pass |
|---|---|---|---|
| Median p95 FULL_SUCCESS_PATH overhead | +7.7% (first pass +20.6%) | <=20% | yes* |
| No single service p95 >35% | max +24.7% | yes | yes |
| Median p99 overhead | +8.1% | <=30% | yes |
| Median throughput degradation | -14.0% (first pass -19.4%, calibration -19.6%) | <=15% | yes* |

*Borderline: run-to-run variance straddles both starred thresholds (see
interpretation). The gates pass on the final telemetry-complete run but the
limitation is recorded as unresolved variance, supporting MODIFY rather than
an unqualified CONTINUE.

## Privacy Gates

| Gate | Observed | Required | Pass |
|---|---|---|---|
| 0 raw leaks in attack suite | 0 | 0 | yes |
| 0 raw leaks in headline artifacts | 0 | 0 | yes |
| No prod/private credentials | none used or present | none | yes |
| Transformations documented | threat-model + REPORT | yes | yes |
| Fidelity-breaking redaction => privacy-blocked | 0 such cases | 0 | yes |

## Usefulness Targets

| Target | Observed | Pass |
|---|---|---|
| Overall portable yield >=75% | 8/8 (100%) | yes |
| Median atom reduction >=40% | ~50% | yes |
| Artifact sizes operationally small | 2963-3772 bytes (median ~3150) | yes (reported, no post-hoc threshold) |
| Successes persist no artifact | yes (discard verified in perf: failed=0) | yes |
| One bootstrap/config integration | yes (`--import` + env) | yes |
| p95 overhead (V2 target, informative) | +7.7% median final (+20.6% first pass) | borderline (see MODIFY) |

## Scientific Interpretation

H1 (frozen generic capture converts real service failures): SUPPORTED —
8/8 eligible real-service incidents across 4 framework families became
automatic portable executable incidents with 0 bug-specific Rapture code.
H2 (tail overhead production-plausible): MIXED — the V2 p95 spike was
implementation-specific and is fixed (final median p95 +7.7%, p99 +8.1%),
but the structural p50 floor (~+22%) and throughput cost (~-14%, straddling
the threshold across repetitions: -19.6% calibration, -19.4% first pass,
-14.0% final) leave production-plausibility for always-on full traffic
unresolved. H3 (privacy-safe without fidelity loss): SUPPORTED within the
gate tier — 0 leaks with 0 redaction-caused replay failures; gap tier mapped,
not solved. H4 (buggy-vs-fixed discrimination): SUPPORTED — 8/8
FIX_CONFIRMED with 0 oracle collisions (after one fixture amendment that
closed a service-side infra-mapping hole). H0 (services need per-bug
adapters): REJECTED inside the boundary (2-min marginal setup), SURVIVES
outside it (screening exclusions). H5/H6 remain untested by design.

## Exact Product Boundary Supported by V3

Single-process Node 22+ services on node:http-compatible stacks (express 4,
fastify 5, hapi 21, koa 3) with pg/fetch dependencies, failing as HTTP 5xx
through request-scoped handling, captured in sampled/failed-request mode
(not full-traffic always-on), with gate-tier secrets never persisted and
gap-tier shapes excluded. Throughput-sensitive deployments require sampling
or selective capture — an architectural consequence, not a tuning task (cheap
wins are taken; remainder is ALS+interception structure).

## What V3 Does NOT Prove

No multi-service/detached-worker replay; no non-pg drivers; no secret-gated
incidents (gap tier unsolved: JWT/PEM/cards/bare passwords/base64); no
browser; no production traffic validation (local services only); no repair
value (V4 question); no demand/pricing signal; full-service clones
(directus-scale) were directory-screened only; p50/throughput costs make
always-on full-traffic capture inadvisable on the evidence.

## Decision

MODIFY — the executable-incident thesis survives on real service
repositories at 100% coverage with zero bug-specific instrumentation, zero
oracle collisions, zero leaks, and 8/8 fix discrimination, but success-path
performance straddles the production-viability thresholds across repetitions
(median p95 +7.7% final vs +20.6% first pass; throughput -14.0% vs
-19.4%/-19.6%; structural p50 floor ~+22%), capping deployment scope to
sampled/selective capture until the structural interception cost is
addressed. State the narrowed boundary above; do not broaden protocols or
add agents/ product surface.

## Recommended Next Research Action

A sampling/selective-capture design spike (capture a fraction of successful
requests; always persist failures) re-measured on the 3 headline services
against the same gates, plus one directus-scale service incident attempted
under the frozen bootstrap; success criterion: median p95 <=20% AND median
throughput degradation <=15% with coverage/manual-burden/privacy gates held.
Do not design V4 (repair value) until the performance boundary is settled.

---

### Required tables

#### Headline Service Corpus

| Repository | Framework/Stack | Historical Bug | Buggy SHA | Fixed SHA | Auth | Postgres | Outbound HTTP | Baseline Reproduced | Frozen Eligible |
|---|---|---|---|---|---|---|---|---|---|
| koajs/koa | koa 3 | #1999 absolute-form URL | 1061776 | 571938d | pg lookup | noise | noise | 500 vs 200 | yes |
| koajs/koa | koa 3 | #1998 ctx.assert HttpError | 4a191b1 | 1061776 | pg lookup | noise | noise | 500 vs 401 | yes |
| expressjs/express + jshttp/cookie | express 4 | CVE-2024-47764 cookie inject | 4.19.2 | 4.21.1 | pg lookup | noise | noise | 500 vs 400 | yes |
| ljharb/qs (via express) | express 4 | CVE-2026-2391-f/u arrayLimit | 8079adc7 | 8859c374 | pg lookup | noise | noise | 500 vs 400 | yes |
| fastify/fastify | fastify 5 | CVE-2025-32442 valid. bypass | v5.3.0 | v5.3.2 | pg lookup | noise | noise | 500 vs 400 | yes |
| npm/node-semver (via express) | express 4 | PR #878 tilde prerelease | 8640bd68 | 9c8692ae | pg lookup | causal | noise | 500 vs 200 | yes |
| hapijs/hapi | hapi 21 | #4560 IPv6 request.url | 5095382 | ee8475b | pg lookup | noise | noise | 500 vs 200 | yes |
| hapijs/hapi | hapi 21 | #4564 IPv6 hostname parse | 62032e6 | 97c435f | pg lookup | noise | noise | 500 vs 200 | yes |

(Full SHAs in `results/headline/bug-corpus.json`.)

#### Executable Incident Results

| Repository | Auto Capture | Setup Min | Bug-Specific Wrappers | Oracle Auto | Offline 20/20 | Reduced Portable 20/20 | Buggy FAIL | Fixed Original Failure Absent | Artifact Bytes | Secret Leaks | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| koa #1999 | yes | 2 | 0 | ERR:E_URL_MISMATCH | 20/20 | 20/20 | 500 | 200 | 2963 | 0 | AUTO_CAPTURE_SUPPORTED |
| koa #1998 | yes | 2 | 0 | ERR:E_ASSERT_REGRESSION | 20/20 | 20/20 | 500 | 401 | 3107 | 0 | AUTO_CAPTURE_SUPPORTED |
| express cookie | yes | 2 | 0 | ERR:E_COOKIE_INJECT | 20/20 | 20/20 | 500 | 400 | 3215 | 0 | AUTO_CAPTURE_SUPPORTED |
| express qs | yes | 2 | 0 | ERR:E_QS_LIMIT_BYPASS | 20/20 | 20/20 | 500 | 400 | 3215 | 0 | AUTO_CAPTURE_SUPPORTED |
| fastify 32442 | yes | 2 | 0 | ERR:E_VALIDATION_BYPASS | 20/20 | 20/20 | 500 | 400 | 3087 | 0 | AUTO_CAPTURE_SUPPORTED |
| express semver | yes | 2 | 0 | ERR:E_SEMVER_MISMATCH | 20/20 | 20/20 | 500 | 200 | 3772 | 0 | AUTO_CAPTURE_SUPPORTED |
| hapi 4560 | yes | 2 | 0 | ERR:E_URL_GETTER | 20/20 | 20/20 | 500 | 200 | 3055 | 0 | AUTO_CAPTURE_SUPPORTED |
| hapi 4564 | yes | 2 | 0 | ERR:E_HOST_PARSE | 20/20 | 20/20 | 500 | 200 | 3126 | 0 | AUTO_CAPTURE_SUPPORTED |

#### Headline Performance

Median-of-5-reps per cell (5000 measured requests each; raw per-rep rows in
`results/headline/perf/`, medians in `aggregate.json`). CPU/RSS are per-run
growth (stats1-stats0); ELU is run-end mean. Overhead % = capture-vs-off p95.

| Service | Mode | Requests | p50 | p90 | p95 | p99 | Throughput | CPU | RSS | Event Loop | Overhead % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| express-qs | off | 5000x5 | 32.5 | 65.0 | 75.8 | 97.5 | 426 | 6.0s | 48MB | 17.7ms | — |
| express-qs | context-only | 5000x5 | 35.1 | 67.7 | 79.5 | 114.5 | 406 | 6.4s | 45MB | 17.6ms | +4.8% |
| express-qs | intercept-discard | 5000x5 | 38.9 | 71.9 | 82.9 | 102.4 | 371 | 7.5s | 41MB | 18.6ms | +9.4% |
| express-qs | capture | 5000x5 | 39.4 | 64.0 | 74.9 | 97.4 | 380 | 7.7s | 46MB | 17.4ms | -1.1% |
| express-qs | failed-persist | 5000x5 | 40.2 | 71.7 | 80.9 | 98.7 | 367 | 7.5s | 47MB | 17.7ms | +6.7% |
| koa-1999 | off | 5000x5 | 25.2 | 51.7 | 64.7 | 90.4 | 538 | 4.8s | 54MB | 16.6ms | — |
| koa-1999 | context-only | 5000x5 | 27.5 | 54.7 | 66.9 | 95.1 | 494 | 5.2s | 53MB | 16.6ms | +3.4% |
| koa-1999 | intercept-discard | 5000x5 | 32.7 | 64.6 | 75.3 | 102.2 | 439 | 6.3s | 42MB | 17.7ms | +16.3% |
| koa-1999 | capture | 5000x5 | 31.6 | 62.1 | 69.7 | 97.7 | 451 | 6.6s | 43MB | 17.5ms | +7.7% |
| koa-1999 | failed-persist | 5000x5 | 32.0 | 61.2 | 72.9 | 101.6 | 443 | 6.3s | 42MB | 17.3ms | +12.6% |
| fastify-32442 | off | 5000x5 | 27.5 | 48.2 | 56.6 | 90.4 | 511 | 4.9s | 47MB | 15.3ms | — |
| fastify-32442 | context-only | 5000x5 | 29.1 | 51.3 | 59.8 | 87.5 | 491 | 5.1s | 49MB | 15.1ms | +5.6% |
| fastify-32442 | intercept-discard | 5000x5 | 33.1 | 61.2 | 70.5 | 95.4 | 442 | 6.2s | 51MB | 17.2ms | +24.5% |
| fastify-32442 | capture | 5000x5 | 33.5 | 61.3 | 70.6 | 100.0 | 440 | 6.3s | 55MB | 16.8ms | +24.7% |
| fastify-32442 | failed-persist | 5000x5 | 33.7 | 60.0 | 70.4 | 111.1 | 429 | 6.4s | 55MB | 16.8ms | +24.4% |

#### Privacy

| Sensitive Class | Capture Location | Raw Leak | Transformation | Replay Preserved | Status |
|---|---|---|---|---|---|
| Session handle probe | pg params | no | pair-form -> [SESS:sha12] (idempotent) | yes 20/20 | PASS |
| Cookie/session names | inbound headers | no | none transited (no session cookies sent) | n/a | PASS |
| Provider keys/bearer/JWT/PEM/cards | attack suite bodies/headers/rows | no (gate) / documented gaps | shape scrub / gap findings | 5/5 gate | PASS (gate) / FINDING (gap) |
| PII email/phone/user-id | DB rows/bodies (attack suite) | retained per policy where branch data | documented | yes | PASS (policy) |
| Config secrets | env | no | {redacted, sha256} placeholder | n/a (never restored) | PASS |

#### Gate Summary

See Hard Gates / Performance Gates / Privacy Gates tables above.

### Required answers

1. Yes — all 8 incidents capture through actual routing/middleware/session/pg/fetch stacks via the real entry points; no experiment-authored transport.
2. 100% of frozen eligible incidents (8/8) became automatic portable executable incidents (160/160 + 160/160 + 40/40 fake-down).
3. Zero required bug-specific capture hooks, wrappers, or failure assertions (0/0/0; one service-fixture mapping correction, documented).
4. Yes — 8/8 historical fixing revisions eliminate the captured failure (200/400/401, fingerprint absent).
5. V2's p95 was eager serialize+redact on the hot path plus small-N quantization (self-CPU only ~3.2%); removed by deferred design.
6. After generic changes, on real successful service traffic (final run):
p50 +21/+26/+22%, p90 -2/+20/+27%, p95 -1/+8/+25%, p99 -0/+8/+11%
(medians +21.7/+20.2/+7.7/+8.1%); first pass measured higher
(median p95 +20.6%, throughput -19.4%).
7. No cleanly — final medians pass (p95 +7.7% <=20%, throughput -14.0%
<=-15% edge) but run-to-run variance straddles both thresholds and the p50
floor (~+22%) is structural; always-on full-traffic capture is not robustly
supported by the evidence (MODIFY).
8. No — 0 raw leaks in attack suite (8 captures) and 0 across all 18 headline files.
9. Provider shapes->redacted, session pairs->[SESS:*], secret config->placeholders, all replay-preserving; gap tier (JWT/PEM/cards/bare-password/base64) cannot be transformed safely yet.
10. No incident was privacy-blocked; gap-tier shapes would block secret-gated incidents (out of scope by design).
11. Boundary stated in "Exact Product Boundary Supported by V3" above.
12. Narrow scope to sampled/selective capture and re-measure; do not proceed to repair-value testing or product work until performance gates pass.

RAPTURE_REPRODUCER_V3_STATUS=MODIFY
