# Rapture Reproducer V0 — Final Research Report

## Executive Summary

Yes — within the V0 boundary, a captured backend failure can be automatically
transformed into a materially smaller, portable executable artifact that
repeatedly reproduces the same failure without live dependencies. Across 8
deterministic incident fixtures: full-capture replay succeeded 160/160,
reduced-artifact portable replay succeeded 160/160 in fresh processes, causal
recall was 100%, wrong-failure acceptance was 0, aggregate byte reduction was
81.3%, aggregate atom reduction was 93.1%, and total reducer search cost was
271 in-process trials in ~39 ms. All 7 hard gates and all 5 usefulness gates
pass. Decision: **CONTINUE** (research only — this establishes technical
viability, not market demand, and authorizes no product build).

## Research Question

Given a complete deterministic capture of a single-process backend incident,
can an automated reducer remove irrelevant captured inputs/state/interactions
and produce a significantly smaller offline artifact that reproduces the same
failure fingerprint reliably?

## Repository / Branch / HEAD

- Repository working tree: `/Users/wira/Documents/rapture/rapture`
- Branch: `research/minimal-executable-reproducer-v0` (created from `main` clean)
- HEAD: `a2f012afd6e1f548c53853c15cd9ccb54a530f9b`
- Remote: `origin https://github.com/wiramahendra/rapture`
- Lineage note: the task names `rapture-fx/rapture`; the actual remote org is
  `wiramahendra`. The tree was clean, history intact, and all baseline commands
  behaved as documented, so lineage was treated as the same lab lineage with a
  different remote string — recorded here, not a stop condition.
- Runtime note (original run): the experiment ran on Node v20.19.5, not Node
  22+ (repo `engines` wants >=22). Closed by the Node 22 conformance rerun
  below (Appendix A); the deviation no longer stands.
- Manifest: `MANIFEST.json`, hash
  `82d38d866d022da759bd07c208f96157a19515bd459e76c17ddeb904a10750c6`.

## Baseline Repository Validation

Phase-0 preflight on the clean checkout, before any experiment file existed:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm build` | OK (all 8 workspace projects) |
| `pnpm typecheck` | OK |
| `pnpm test` | OK — kernel 40, core 11, cli 5 |
| `pnpm check` | 30 errors / 59 warnings / 173 infos, all pre-existing in `archive/*` (matches the known-broken state; not touched) |

Post-experiment re-verification: build OK, typecheck OK, test OK
(40+11+5), `pnpm check` identical (30/59/173). The experiment lives in
`experiments/` (Biome-excluded, outside the pnpm workspace), so it cannot
affect these commands; a unit test additionally asserts `git status` shows
nothing outside `experiments/reproducer-v0/` plus the root `.gitignore`
exception that makes the experiment committable.

## Supported V0 Boundary

- Runtime: Node.js (developed/tested on v20.19.5; targeting 22+), TypeScript-shaped
  plain ESM JavaScript, zero dependencies.
- Execution shape: single application process handling one logical backend operation.
- Capturable nondeterminism (all through the experiment-owned `ReplayContext`):
  request/input payload, database reads, external HTTP/service responses,
  config values, clock values, random values, ordered boundary-call sequence.
- Replay rule: replay executes the actual fixture application logic while
  substituting recorded nondeterministic boundary results (keyed lookup; no
  re-execution of external systems).
- Forbidden live effects (refused + counted): network, production database,
  filesystem outside the experiment temp dir, email/queues/payments/external APIs
  (no such code paths exist; guards throw `LiveEffectError`).
- Out of scope per spec: production SDK, eBPF, K8s, SaaS, dashboard, auth,
  billing, observability, generic traffic replay, distributed replay,
  concurrency/races, LLM analysis, repair loops. None built.

## Incident Scenario Design

8 fixtures in `src/scenarios.js`, each with intentional noise from three
taxonomies: (a) ambient incident-window events never requested by the failing
operation, (b) requested-but-degraded auxiliary calls (try/catch fallback, so
removal is a legitimate reduction), (c) unread db rows / unread config keys /
extra input fields.

| # | Scenario | Failure | Causal core |
|---|---|---|---|
| 1 | `upstream-503-fallback` | Upstream 503 + broken express fallback | pricing event + `input.express` |
| 2 | `malformed-upstream-payload` | `seats: "unlimited"` (string) breaks strict parse | entitlements event |
| 3 | `database-state-edge` | suspended account + fraud flag blocks charge | 2 db rows |
| 4 | `expired-time-boundary` | captured now crosses iat+TTL | clock event + `TOKEN_TTL_S` + `token.iat` |
| 5 | `random-idempotency-path` | draw 0.87 routes to conflicting dedupe write | random event + idempotency row |
| 6 | `config-region-combination` | only eu-west + standard tier throws | 2 config keys |
| 7 | `ordered-two-call-sequence` | commit conflicts against preceding reserve | reserve + commit events, in order |
| 8 | `noise-heavy-incident` | high-value charge on overdue account declines | billing event + amount + account row + threshold |

Ground truth (`causalAtoms()`) was declared per scenario before the reducer ran
and frozen in `MANIFEST.json`. The reducer never imports it (module boundary +
unit test scanning `src/reducer.js`). Total: 259 removable atoms, of which
18 are causal (scenario 8: 4 of 125).

## Failure Fingerprint Design

`FailureFingerprint = { failure_kind, error_code, message_class, top_frame,
fingerprint_hash }`, hash = SHA-256 over the stable serialization of the four
fields. Application failures (`AppError`) carry stable identity fields;
detail text (e.g. ids) is excluded from identity. Harness outcomes hash
differently by construction: missing-mock → `SETUP/E_MISSING_MOCK`, live
refusal → `SETUP/E_LIVE_EFFECT_BLOCKED`, unexpected throw → `CRASH`, clean
return → `NO_FAILURE`. A candidate is accepted only on exact hash equality, so
a different exception, crash, missing-mock, or success can never count as
reproduction. Unit tests pin all of this.

## Full-Capture Replay Results

Hard gate (≥20/20 per scenario, fresh processes, zero live calls,
serializable): **8/8 pass, 160/160 total.** Every replay ran in a spawned
clean Node process with cwd in a fresh temp dir, loading only the capture
file. Serialization roundtrip is deterministic (hash-stable). Zero live-effect
attempts across all 320 fresh-process runs (160 full + 160 portable).

## Reduction Algorithm

Main reducer (`src/reducer.js`): deterministic ddmin-style chunk deletion
(complements then subsets, granularity doubling) followed by a greedy fixpoint
sweep, so deletion of every remaining removable atom is tested at least once —
the result is 1-minimal, and the report claims only 1-minimality (deletion-only;
no value shrinking per spec). No LLM. No ground-truth labels: input is an
ordered atom list plus a black-box trial closure. Every trial (kept count,
removed ids, pass/fail, fingerprint hash, wall ms) is appended to
`results/trials-<id>.jsonl` (530 lines total). Baseline: single-pass greedy
deletion (`greedyReduce`), recorded separately in the same JSONL (`reducer`
field distinguishes runs).

Replay matching is keyed by `(kind, operation, stable request key)`; retained
events keep original relative sequence, which is what preserves
order-dependent causality (scenario 7 keeps reserve→commit in order).
Missing http/clock/random results throw `MissingMockError` (reject); missing
db rows/config keys replay as `undefined` and let application logic decide
(reject unless genuinely tolerated — graceful-degradation reads are the only
requested-noise that reduces).

## Per-Scenario Reduction Results

| Scenario | Full Replay | Original Atoms | Reduced Atoms | Original Bytes | Reduced Bytes | Reduction % | Reducer Runs | Reducer ms | Portable 20/20 | Same Fingerprint | Causal Recall | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| upstream-503-fallback | 20/20 | 22 | 2 | 2426 | 777 | 68.0% | 13 | 2.5 | 20/20 | true | 1.00 | PASS |
| malformed-upstream-payload | 20/20 | 15 | 1 | 1945 | 770 | 60.4% | 8 | 0.8 | 20/20 | true | 1.00 | PASS |
| database-state-edge | 20/20 | 32 | 2 | 3268 | 707 | 78.4% | 42 | 5.3 | 20/20 | true | 1.00 | PASS |
| expired-time-boundary | 20/20 | 17 | 3 | 1796 | 737 | 59.0% | 51 | 5.6 | 20/20 | true | 1.00 | PASS |
| random-idempotency-path | 20/20 | 15 | 2 | 1878 | 805 | 57.1% | 20 | 1.1 | 20/20 | true | 1.00 | PASS |
| config-region-combination | 20/20 | 19 | 2 | 1591 | 619 | 61.1% | 14 | 0.7 | 20/20 | true | 1.00 | PASS |
| ordered-two-call-sequence | 20/20 | 14 | 2 | 2025 | 901 | 55.5% | 34 | 3.1 | 20/20 | true | 1.00 | PASS |
| noise-heavy-incident | 20/20 | 125 | 4 | 18259 | 881 | 95.2% | 89 | 19.9 | 20/20 | true | 1.00 | PASS |

Every reduced artifact equals exactly its scenario's causal core (irrelevant
removal rate 100% everywhere). Greedy baseline converged to the same cores
with 259 single-pass trials — on this corpus ddmin and greedy tie, because
atoms are near-independent (honestly reported; no interacting-atom case exists
in V0 to separate them).

## Portability Results

8/8 artifacts reproduce 20/20 in fresh processes from a temp-dir copy, loading
only the artifact file (never the capture). Artifacts contain no absolute temp
paths (scanned) and no credentials/network references. Median in-process replay
0.15–0.36 ms; p95 ≤ 0.76 ms (fresh-process spawn overhead excluded from replay
timing and reported separately as negligible at this scale).

## Wrong-Failure / False-Reproduction Analysis

17 wrong-failure candidates were generated during search (all in
`database-state-edge`: removing a causal row turns the failure into success or
a different error) and all 17 were correctly rejected; acceptances: **0**.
No trial ever confused a setup error, crash, or success with the target
failure — the exact-hash predicate held.

## Reduction Cost

271 ddmin trials total, ~39 ms in-process wall (max per-scenario 19.9 ms on the
125-atom stress case); greedy baseline 259 trials / ~70 ms. Replay is sub-ms,
so search cost scales with trial count, not replay latency. Practical for a
local engineering loop at this scale; real-capture scale remains untested
(see Limitations).

## Aggregate Metrics

- Scenarios: 8/8 PASS. Full replay 160/160. Portable replay 160/160.
- Bytes: 33188 → 6197 (**−81.3%**). Atoms: 259 → 18 (**−93.1%**).
- Noise-heavy: −95.2% bytes, −96.8% atoms.
- Min causal recall: 1.00. Wrong-failure accepted: 0. Live effects: 0.
- Raw data: `results/per-scenario.json`, `results/aggregate.json`,
  `results/trials-*.jsonl`, `results/capture-*.json`, `results/artifact-*.json`.

## Hard Gate Results

| Gate | Result |
|---|---|
| 8/8 full captures reproduce exact fingerprint 20/20 | PASS (160/160) |
| Zero live external side effects | PASS (0 attempts) |
| Zero wrong-failure acceptances | PASS (0; 17 correctly rejected) |
| ≥7/8 reduced artifacts 20/20 in fresh processes | PASS (8/8, 160/160) |
| All reduced artifacts self-contained and portable | PASS |
| Reducer uses no ground-truth annotations | PASS (module boundary + test) |
| No existing Rapture product surface modified | PASS (git-status/diff test + unchanged workspace checks) |

## Usefulness Gate Results

| Gate (target) | Result |
|---|---|
| Aggregate bytes ≥ 50% | PASS (81.3%) |
| Aggregate atoms ≥ 50% | PASS (93.1%) |
| Noise-heavy ≥ 70% | PASS (95.2% bytes) |
| Causal recall 100% | PASS (all scenarios) |
| Practical reducer runtime | PASS (worst 19.9 ms; reported, not hidden) |

## Competitive Boundary

No Speedscale/Keploy/FluxRun integration was built or needed for V0 (per
spec, they are context, not baselines). The tested differentiator is narrow:
not traffic capture/replay (occupied) but automatic reduction to a small
portable executable reproducer. V0 supports only the reduction half of that
claim, on synthetic single-process incidents — capture infrastructure,
multi-service replay, and any product surface are explicitly not built.

## Technical Limitations

1. Fixtures are synthetic; capture completeness is assumed, not demonstrated
   on a real production system. The hardest part of a real product (building
   the capture) is untouched.
2. Single-process, deterministic, no concurrency/race support.
3. Replay matching is keyed, not index-based: duplicate identical boundary
   calls and order-sensitive same-key sequences beyond the tested shape are
   unhandled.
4. Noise model is ambient + degradable reads; adversarially entangled state
   (causal and noise sharing one indivisible blob) is untested, as is value
   shrinking.
5. Greedy ties ddmin here — chunking's advantage on interacting atoms is
   unproven in V0.
6. Ran on Node 20, not 22; trivially re-runnable.
7. `pnpm check` remains at its pre-existing 30 errors (archive); the
   experiment is Biome-excluded by design.

## Scientific Interpretation

H1 and H2 are supported within the V0 boundary: most captured state was
irrelevant (93% of atoms), and the reduced artifacts are exactly the causal
cores, portable and exactly reproducing. H0 (reduction unreliable/expensive)
is not supported here: 0 false acceptances, ms-scale cost. H3 (willingness to
pay) was not tested by design. The honest scope of the claim: deletion-based
reduction over a complete, deterministic, keyed capture works and is cheap —
for real incidents, capture completeness and entanglement are the open risks,
not the reducer.

## Decision: CONTINUE / MODIFY / KILL / INVALID_EXPERIMENT

**CONTINUE** — research only. All hard and usefulness gates pass with margin.
Per the product-kill warning, this authorizes no company, SDK, SaaS, or
capture infrastructure.

## Recommended Next Research Task

Test the two open risks on real failures before any product thought: (1) take
3–5 real reported backend bugs from open-source Node services, hand-build
complete captures, and check whether full-capture exact replay is even
achievable (capture-completeness spike); (2) only then, run the V0 reducer
unchanged against them and report recall/reduction — if replay fails or
entanglement defeats deletion, the verdict is MODIFY (capture-bounded) or KILL.

---

Required answer: one captured backend failure CAN be automatically transformed
into a materially smaller (here −81% bytes, −93% atoms), portable executable
artifact that repeatedly reproduces the same failure (here 160/160 fresh
processes) without live dependencies — within the V0 single-process
deterministic boundary, on synthetic incidents.

## Appendix A — V0 Protocol Closure (Node 22 conformance + lineage)

Recorded 2026-09-07 during V1 Phase 0. No V0 implementation file was altered
before these checks; the frozen `MANIFEST.json` (hash `82d38d…c6`) was reused
as-is and `run-all.js` re-verified every capture hash against it.

- Node: v22.14.0 (via nvm), pnpm 10.12.1.
- Full experiment rerun under Node 22: 8/8 full captures 20/20 (160/160),
  8/8 reduced artifacts 20/20 portable (160/160), 0 wrong-failure acceptances
  (17 candidates correctly rejected), 0 live effects, 271 ddmin trials,
  259→18 atoms (−93.1%), 33188→6197 bytes (−81.3%), min causal recall 1.00.
- Node 20 vs Node 22 diff: only millisecond timing fields differ
  (`reducer_wall_ms` 38.87 → 37.15 total; per-scenario replay medians/p95
  within the same sub-ms band). No material change; V0 interpretation stands.
- V0 unit tests under Node 22: 14/14 pass. Procedural note: bare `node --test
  test/` discovery behaves differently on Node 22 than Node 20 in this repo;
  the conforming invocation is `node --test "test/*.test.js"` (same files,
  same assertions, all green).
- Workspace under Node 22: `pnpm build` OK, `pnpm typecheck` OK, `pnpm test`
  OK (40+11+5), `pnpm check` identical pre-existing 30/59/173 in `archive/*`.
- Lineage: `git ls-remote https://github.com/rapture-fx/rapture` returns HEAD
  = `refs/heads/main` = `a2f012afd6e1f548c53853c15cd9ccb54a530f9b`, identical
  to the local base SHA. The V0 branch is exactly that SHA plus the single
  V0 research commit. **Canonical repository: rapture-fx/rapture; local
  `origin` (wiramahendra/rapture) is a mirror holding identical objects.**
  Lineage gate: PASS. V0 protocol: PASS (not BLOCKED).

RAPTURE_REPRODUCER_V0_STATUS=CONTINUE
