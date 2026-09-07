# Rapture Reproducer V1 — Final Research Report

## Executive Summary

V1 tested whether V0's exact-failure reduction survives (a) adversarial causal
topology and (b) real historical bugs not designed around the reducer. Result:
**reduction stayed exact, safe, and portable across all 24 cases** — 12/12
adversarial scenarios and 12/12 real historical bugs reduce to portable
20/20 reproducers with 0 wrong-failure acceptances anywhere, 100% causal
recall on the adversarial bench, 12/12 buggy-vs-repaired discrimination, and
median 90% atom / 56% byte reduction on real bugs. **But the hoped-for
ddmin-over-greedy advantage never materialized**: DDMIN tied GREEDY on all 24
cases (0/24 smaller) while costing more trials (697 vs 448 total), so the one
hard-gate sub-item requiring a material DDMIN win FAILS, and stronger-than-
greedy reduction is unjustified on all current evidence. Manual fixture burden
(median 25 min/case, 300 min total) dwarfs reducer compute (median 1.9 ms).
Decision: **CONTINUE** — narrowly, as a capture/oracle-automation research
program, not a reduction-algorithm program. No product is authorized.

## V0 Protocol Closure

- V0 implementation untouched before checks; frozen V0 manifest reused as-is.
- Node v22.14.0 + pnpm 10.12.1: full V0 rerun identical to Node 20 on every
  correctness metric (160/160 full, 160/160 portable, 0 wrong acceptances,
  0 live effects, 259→18 atoms, −81.3% bytes; only ms timings differ).
- V0 tests 14/14 under Node 22 (`node --test "test/*.test.js"`; bare-directory
  discovery differs between Node 20/22 — procedural note only).
- Workspace under Node 22: build OK, typecheck OK, tests OK (40+11+5),
  `pnpm check` identical pre-existing 30/59/173 in `archive/*`.
- V0 protocol: PASS (not BLOCKED). Recorded in V0 `REPORT.md` Appendix A.

## Repository Identity

- Canonical repository: **rapture-fx/rapture**. Verified live in Phase 0:
  `git ls-remote https://github.com/rapture-fx/rapture` returns HEAD =
  `refs/heads/main` = `a2f012afd6e1f548c53853c15cd9ccb54a530f9b`, identical to
  the local base SHA. Local `origin` (wiramahendra/rapture) is a mirror holding
  identical objects. Lineage gate: PASS.
- V1 branch `research/minimal-executable-reproducer-v1` was created from the
  committed V0 SHA (below). All V1 work is under `experiments/reproducer-v1/`
  (+ root `.gitignore` exception); no product, archive, or CLI file changed
  (asserted by test).

## V0 Frozen Commit

`5acf271421ef2afdddec433bd18c007d99b3067c` — "research: validate minimal
executable reproducer v0" on `research/minimal-executable-reproducer-v0`.
V1 branch starts exactly there. (V1 results reported here are uncommitted
working-tree state at report time.)

## Research Questions

1. Does the reducer remain correct under interacting/non-monotonic causal
   structures? — **Yes**: 12/12 exact, 0 wrong acceptances, flips survived.
2. Does ddmin materially outperform greedy on deliberately difficult topology?
   — **No**: 0/24 smaller, higher trial cost. Stronger reduction unjustified.
3. Can real historical bugs become portable reduced reproducers without
   exposing the repaired revision to the reducer? — **Yes**: 12/12, repaired
   revision provably unreferenced by the reduction path (test-enforced).
4. Do reproducers fail on buggy and pass on repaired revisions? — **Yes**:
   12/12 FIX_CONFIRMED.
5. What real-bug classes fall outside the V1 boundary? — None encountered is a
   weakness, not a strength: the corpus is library-level deterministic
   behavior; distributed/DB/secret/browser/native classes have 0 samples
   (see Failure Classes).

## Frozen V1 Protocol

`V1-MANIFEST.json`, hash `f2168a884c8b0f1ff96da05d31bd888272689387acfb9e39315dbe8c75b391e3`
(asserted by test): 12 adversarial definitions + ground truth, GREEDY/DDMIN
algorithms pinned by V0 module hashes, scoring semantics v1, real-bug
eligibility criteria, supported boundary, hard gates, decision rules. Freeze
rule: changes after headline start only for demonstrated harness defects.
Two such defect fixes occurred, both documented as non-substantive:
(1) `vendor-impl.js` relative-outDir resolution (`path.resolve`);
(2) cron `extraTreesPost` moved from `case.js` to `post-vendor.json` sidecar
to harden repaired-revision isolation (byte-identical output verified).
No scenario, corpus, gate, or threshold changed after results.

## Supported Boundary

Languages TypeScript/JavaScript; Node 22+; single-process behavior
exercisable deterministically from a bounded entry point. In scope: request/
function input, config, clock, randomness, temp-dir fixtures, DB-like state
and HTTP responses through bounded adapters, ordered boundary sequences.
Explicitly out of scope (untested, 0 corpus samples): distributed races,
multi-host consensus, kernel bugs, native nondeterminism, browser rendering,
unbounded production DBs, private-secret bugs, remote-deployment-only bugs.

## Adversarial Reduction Design

12 scenarios (`adversarial/scenarios.js`), one per required topology, reusing
the frozen V0 substrate (record/replay, reducers, artifacts) unchanged.
Ground truth (`must` / `anyOf` / `trigger`) declared pre-reduction, used only
post-hoc via `src/score.js`. Noise in every scenario (ambient events, unread
db/config, extra input). Full-capture gate 12/12 reproduced before any
reducer ran.

## GREEDY vs DDMIN Results

### Adversarial Reduction Matrix

| Scenario | Topology | Original Atoms | Greedy Atoms | DDMIN Atoms | DDMIN Reduction % | Greedy Trials | DDMIN Trials | Exact Fingerprint | Portable 20/20 | Causal Recall | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| adv-joint-pair | jointly-removable-pair | 15 | 2 | 2 | 67.5% | 15 | 28 | true | 20/20 | 1 | PASS |
| adv-alt-sets | alternative-causal-sets | 16 | 2 | 2 | 62.6% | 16 | 30 | true | 20/20 | 1 | PASS |
| adv-one-of-n | at-least-one-of-n | 16 | 1 | 1 | 65.4% | 16 | 6 | true | 20/20 | 1 | PASS |
| adv-sequence | sequence-dependent | 16 | 3 | 3 | 54.4% | 16 | 53 | true | 20/20 | 1 | PASS |
| adv-nonmonotonic | non-monotonic-removal | 12 | 2 | 2 | 58.6% | 12 | 25 | true | 20/20 | 1 | PASS |
| adv-nested | nested-payload-interaction | 12 | 1 | 1 | 58.6% | 12 | 9 | true | 20/20 | 1 | PASS |
| adv-config-3way | config-interaction | 17 | 3 | 3 | 60.4% | 17 | 25 | true | 20/20 | 1 | PASS |
| adv-dupe-responses | duplicate-equivalent-responses | 13 | 1 | 1 | 63.3% | 13 | 9 | true | 20/20 | 1 | PASS |
| adv-error-paths | multiple-error-paths | 14 | 4 | 4 | 54.0% | 14 | 49 | true | 20/20 | 1 | PASS |
| adv-large-interact | large-noisy-interaction | 144 | 4 | 4 | 95.8% | 144 | 158 | true | 20/20 | 1 | PASS |
| adv-repeat-poll | ordered-repeated-boundary | 14 | 3 | 3 | 50.6% | 14 | 53 | true | 20/20 | 1 | PASS |
| adv-masked-quorum | masked-dependency | 14 | 2 | 2 | 59.4% | 14 | 25 | true | 20/20 | 1 | PASS |

Totals: GREEDY 303 trials / 66.9 ms; DDMIN 470 trials / 58.8 ms. DDMIN
smaller-than-greedy count: **0**. All artifacts 1-minimal (trace-proven),
all portable 20/20 (240/240 each reducer), recall 1.00 everywhere.

## Non-Monotonic and Interacting Cases

- **Joint pair** (adv-joint-pair): the empty default-deny core genuinely
  reproduces (verified), yet both reducers keep `{STRICT_A, STRICT_B}` — valid
  but non-minimal. Trace diagnosis (`results/analysis-flips.json`): 0 accepted
  trials dropping both flags, 24 rejected single-flag trials. The frozen
  ddmin's round-robin chunking + complement-first bias lets noise-dropping
  complements that retain both flags pass first, so the pair is never jointly
  dropped. The implementation is frozen and was not "fixed" to chase the gate.
- **Non-monotonic** (adv-nonmonotonic): flip demonstrated — 12 trials pass
  with `store:k_slow` absent while `FAST_PATH` present; 11 fail with both
  absent. Reducer correctness held.
- **Masked** (adv-masked-quorum): flip demonstrated — 5 passes with `n2`
  absent and partners present vs 21 failures with a partner absent.
- **Alternative sets** (adv-alt-sets): forward greedy keeps `{ban_c,ban_d}`,
  reversed order keeps `{ban_a,ban_b}` — distinct valid cores, both replay.
- **Error paths** (adv-error-paths): 3 distinct wrong APPLICATION fingerprints
  observed and rejected, 0 accepted.
- **Exploratory structured reduction** (excluded from headline):
  `results/exploratory-structured.json` — deleting `payload.user.dept` from
  the retained adv-nested event still reproduces; `role`/`status` are
  load-bearing. Field-level shrinking has headroom the frozen deletion
  reducers cannot reach, but it was not a frozen algorithm and claims nothing.

## Real Historical Bug Corpus

12 cases frozen in `real-bugs/bug-corpus.json` before any reduction (SHAs
verified in-clone; buggy≠repaired behavior verified by execution during
selection). Sources: node-semver (2), node-lru-cache (3), qs (2),
validator.js (2), node-jsonwebtoken (1), cron-parser (2). Classes: range/
option boundaries, state transitions, limit enforcement, crash-vs-correct,
false positives/negatives, time boundaries, loop guards. 7 cases need
non-trivial setup (option combos, clock injection, sign/verify flows, TS
builds); 5 are simpler. Vendoring: exact-revision file trees committed under
`real-bugs/<id>/impl/{buggy,post}/` (lru 1 file … jwt 676 files/5.4 MB with
era npm deps incl. load-time `moment`; cron compiled dist + trimmed luxon).

### Real Bug Corpus

| Repository | Bug/Issue | Buggy SHA | Fixed SHA | Bug Class | Full Capture Supported | Original Atoms | Reduced Atoms | Reduction % | Portable 20/20 | Buggy FAIL | Fixed Original Failure Absent | Fixture Minutes | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| node-semver | PR #878 | 8640bd68 | 9c8692ae | range/option boundary | yes | 13 | 1 | 64.2% | 20/20 | yes | yes | 25 | REDUCED_PORTABLE |
| node-semver | silent accept | 6b77aa84 | e583226b | input validation | yes | 10 | 1 | 56.0% | 20/20 | yes | yes | 15 | REDUCED_PORTABLE |
| node-lru-cache | PR #229 | 0b6689cc | b571d06f | state double-accounting | yes | 20 | 3 | 67.2% | 20/20 | yes | yes | 25 | REDUCED_PORTABLE |
| node-lru-cache | #257 | fd370b8b | ff254a79 | config-combination | yes | 16 | 4 | 62.7% | 20/20 | yes | yes | 20 | REDUCED_PORTABLE |
| node-lru-cache | oversize guard | 7ef678e4 | a3eadb1d | state-transition edge | yes | 16 | 3 | 59.4% | 20/20 | yes | yes | 20 | REDUCED_PORTABLE |
| qs | CVE-2026-2391 f/u | 8079adc7 | 8859c374 | limit bypass | yes | 10 | 1 | 55.1% | 20/20 | yes | yes | 30 | REDUCED_PORTABLE |
| qs | cumulative overflow | 59da434d | 963e538c | missing throw | yes | 11 | 1 | 55.6% | 20/20 | yes | yes | 15 | REDUCED_PORTABLE |
| validator.js | #2822 | d563b158 | 7d42ed2d | crash-vs-correct | yes | 10 | 1 | 54.8% | 20/20 | yes | yes | 30 | REDUCED_PORTABLE |
| validator.js | #2774 | 7fdc788e | 3d2f4b33 | false positive | yes | 8 | 1 | 51.1% | 20/20 | yes | yes | 15 | REDUCED_PORTABLE |
| node-jsonwebtoken | maxAge units | 67550492 | b61cc343 | time boundary | yes | 10 | 1 | 51.5% | 20/20 | yes | yes | 35 | REDUCED_PORTABLE |
| cron-parser | PR #438 | 8410d371 | b48a355b | wrong next-fire | yes | 10 | 1 | 55.4% | 20/20 | yes | yes | 45 | REDUCED_PORTABLE |
| cron-parser | PR #415 | 6d6de5ca | bc213d2d | dead loop guard | yes | 11 | 1 | 57.3% | 20/20 | yes | yes | 25 | REDUCED_PORTABLE |

Reduction % = state-byte reduction (impl bytes excluded from both sides since
they are identical; total artifact bytes recorded separately).

## Corpus Inclusion / Exclusion Integrity

12 researched candidates excluded pre-reduction with recorded reasons
(`real-bugs/exclusions.json`): 9 redundant siblings (per-repo caps for
diversity), 1 hazard (lru key-reuse: buggy-revision iteration hangs + murky
parent lineage), 2 near-duplicate anchor bugs (jwt exp/nbf; time class kept
the stronger accept-vs-reject case). No eligible case was dropped after
outcomes; denominator intact (12/12 supported, so no denominator pressure
arose). One selection correction pre-reduction: a mistranscribed cron SHA was
resolved against the clone (`bc213d2d…7596`) before freezing.

## Full-Capture Support Rate

12/12 frozen cases viable: 240/240 fresh-process full replays, 0 live
effects. Boundary coverage exceeds the ≥8 gate, but the boundary tested is
narrow (deterministic library behavior) — see Failure Classes.

## Real-Bug Reduction Results

12/12 REDUCED_PORTABLE: 145 → 19 atoms (−86.9%), state bytes 15777 → 6556
(median atom −90.0%, median byte −55.8%). GREEDY trials 145, DDMIN trials 227;
sizes tied on all 12 (delta 0). All artifacts 1-minimal, hash-verified.

## Portable Reproducer Results

240/240 fresh-process artifact-only replays across 12 cases; artifacts carry
vendored impl bytes (self-contained), no absolute temp paths, no secrets
(test-only HMAC key documented as fixture), no network, deterministic hashes.

## Buggy-vs-Fixed Discrimination

12/12 FIX_CONFIRMED (5/5 repaired-revision runs each, original fingerprint
absent with clean behavior; any harness failure would have meant
INCONCLUSIVE, any reproduction NOT_CONFIRMED — neither occurred).
Repaired-revision access is confined to `run-post-check.js` + `vendor-impl.js`;
the reduction path's isolation is test-enforced (source scans + `bug_rev`-only
corpus access).

## Wrong-Failure Safety Analysis

Adversarial: 3+1 distinct wrong APPLICATION fingerprints observed (error-paths
3, joint-pair 1), all rejected. Real bugs: 0 wrong-failure candidates (oracles
are binary by construction — a limitation on strictness stress, honestly
noted). Acceptances: **0 of 767 total trials**.

## Manual Fixture Burden

Per-case 15–45 min, median 25 min, total 300 min (~5 h); adapter median 83 LOC
(total 958); 1–4 modeled boundaries per case (`real-bugs/<id>/BURDEN.json`).
Dominant costs: oracle encoding from issue reports, incident noise modeling,
and dep-closure triage (jwt moment, qs side-channel, cron TS build, TZ
pinning). Reducer compute is negligible beside it (median 1.9 ms/case).
The oracle shapes collapsed to 5 stereotypes (boolean-flip, throw-vs-silent,
silent-vs-throw, value-match, accept-vs-reject), which is the main evidence
that burden *could* be partly automated — but no automation was built, so
"plausibly automatable" is an inference, flagged as such.

## Reducer Compute Cost

Adversarial: 470 DDMIN + 303 GREEDY trials, ~126 ms total in-process. Real
bugs: 227 + 145 trials; median DDMIN 1.9 ms, max 1396 ms (cron loop-limit:
luxon load + parse per trial). Fresh-process replay medians sub-ms
(library-call scale). All well under the 5 s usefulness target; cost scales
with trial count × per-trial replay, and per-trial replay dominates on heavy
impls (cron) — the only cost risk found.

## Failure Classes / Unsupported Classes

Validated: input edges, option/config combos, serialization/parsing, limit
enforcement, cache state transitions, time boundaries (injected clock),
throw/accept behavioral boundaries. Untested (0 samples): distributed races,
multi-service, DB-backed services, secret-gated bugs, browser-only, native
code, build-only failures, and any bug whose trigger needs a live remote.
The corpus is library-level; "single-process backend" is validated at that
granularity only. Unsupported-class handling was never exercised because no
frozen case failed support — a Mersenne-style gap: the UNSUPPORTED path is
implemented but unproven.

## Hard Gates

| Gate | Observed | Pass |
|---|---|---|
| 12/12 adversarial full captures reproduce pre-reduction | 12/12 | yes |
| 0 wrong-failure acceptances (both cohorts, 767 trials) | 0 | yes |
| ≥10/12 DDMIN artifacts portable 20/20 | 12/12 | yes |
| 100% causal recall on successful adversarial reductions | 1.00 min | yes |
| ≥1 DDMIN materially smaller than frozen GREEDY | 0/24 | **no** → stronger reduction unjustified |
| ≥10 eligible real bugs frozen | 12 | yes |
| ≥8 viable full captures | 12 | yes |
| 0 wrong-failure acceptances (real bugs) | 0 | yes |
| ≥60% of supported bugs portable | 12/12 (100%) | yes |
| ≥80% exact fingerprint 20/20 | 12/12 (100%) | yes |
| ≥80% repaired revisions lose original failure | 12/12 evaluable, 100% | yes |

## Usefulness Targets

| Target | Observed | Pass |
|---|---|---|
| Median real-bug atom reduction ≥ 50% | 90.0% | yes |
| Median real-bug byte reduction ≥ 50% | 55.8% | yes |
| Median reducer runtime ≤ 5 s | 1.9 ms (max 1396 ms) | yes |
| No successful reproducer needs live network | 0 need it | yes |
| Median setup burden plausibly automatable | 25 min/case; stereotyped oracles suggest partial automation | mixed (inference, not proof) |

### Aggregate

| Metric | Observed | Gate/Target | Pass |
|---|---|---|---|
| Adversarial exact + portable | 12/12, 240/240 | 10/12 | yes |
| Adversarial wrong accepted | 0 | 0 | yes |
| DDMIN < GREEDY cases | 0/24 | ≥1 | **no** |
| Real-bug portable reproducers | 12/12 (100%) | ≥60% | yes |
| Buggy-vs-repaired discrimination | 12/12 FIX_CONFIRMED | ≥80% | yes |
| Median real-bug atom reduction | 90.0% | ≥50% | yes |
| Median fixture burden | 25 min/case | plausibly automatable | mixed |

## Scientific Interpretation

H1 (safe + effective under interaction): supported — 24/24 exact, 767 trials,
0 false acceptances, flips survived. H0 (only independent noise reduces):
rejected in its strong form — interacting cores (pairs, quorums, chains,
alternative sets) all reduced safely — but H0's ghost survives in the
cost/benefit form: the simplest deletion algorithm captured 100% of the
observed reducibility, so "automatic reduction" as a differentiator is real
but shallower than hoped. H2 (real bugs convert): supported at 12/12 within
the library-deterministic boundary. H3 (buggy/fixed discrimination):
supported at 12/12. H4 (demand): untested by design. The binding constraint
on any future is not reduction quality but capture/oracle construction cost
(300 min human vs ~2 s machine for 12 cases).

## Product Boundary

Nothing product-shaped was built: no capture infrastructure, SaaS, agents,
eBPF, observability UI, or public CLI. The `.rapture/`-style outputs are
research JSON under `experiments/reproducer-v1/results/`. Per the
product-kill warning, CONTINUE authorizes research into capture/oracle
automation only.

Note: V0's tree-sensitive test ("no existing Rapture product surface is
modified") now fails 13/14 on this branch — expected, since V1's own
`experiments/reproducer-v1/` files postdate V0's frozen commit 5acf271. No
file under `packages/`, `apps/`, or `archive/` changed (V1 workspace test
pins this); V0's recorded results stand on its commit.

## Decision: CONTINUE / MODIFY / KILL / INVALID_EXPERIMENT / BLOCKED_V0_PROTOCOL

**CONTINUE** — qualified. Every safety, portability, reduction, and
discrimination gate passes, most with wide margin; the single failed sub-gate
(DDMIN-vs-GREEDY) is the experiment's most informative result and redirects
rather than ends the program: fund capture/oracle automation, defund
reduction-algorithm work. If the next phase cannot cut fixture burden by an
order of magnitude on unscripted incidents, the honest verdict then is KILL
(elegant reducer, no engineering operation).

## Recommended Next Research Action

A capture-burden spike on 5 unscripted, recently-reported backend incidents
(outside npm-library scale — include one DB-backed service bug): attempt
oracle construction from the issue text alone within a 60-minute budget each,
then run the frozen GREEDY reducer unchanged. Success criterion for further
research: ≥3/5 become portable reproducers inside budget. Do not design
reduction V-algorithms until that spike reports.

---

Required answers: (1) Yes — V0 reran identically under Node 22. (2) Yes —
canonical repo is rapture-fx/rapture; local base SHA identical. (3) No —
DDMIN never beat frozen GREEDY (0/24); stronger reduction unjustified.
(4) 12/12 (100%) of frozen historical bugs became portable reduced
reproducers. (5) Yes — 12/12 distinguish buggy from repaired revisions.
(6) Median 25 min/case (15–45), ~83 LOC adapter; dominant cost of the
pipeline. (7) An engineering operation worth researching only if capture
burden automates; as a reducer story alone it is merely elegant.

RAPTURE_REPRODUCER_V1_STATUS=CONTINUE
