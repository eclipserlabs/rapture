# Rapture Reproducer V4 — Stage 1 (Corpus & Harness) Report

**Status: `INSUFFICIENT_CORPUS`. No calibration and no headline repair runs were
performed. No V4 product-value result exists or is claimed.**

Stage 1 stopped at the frozen corpus gate. The gate was not reached, and the
reason is more interesting than "not enough bugs": screening exposed a material
gap between **automatic capture support** and **usable repair-artifact yield**.

- V3.3 checkpoint: **`f420719faca34cbebd1d963f42d13ff9aa33e5e3`**
- Frozen V3.3 implementation: **`5416f2752c885bb8d61abd49888fc29a34e06b814ea278c551d2ebf291417f1d`** — **0 modifications**
- V4 manifest: **`9ce3c4388a389e15ed84754bba2bd262af23ece5a3b700edc87bf8f7fc7d4f04`** — frozen before screening, unmodified
- Candidate pool: `corpus/candidate-pool.json`, sha256 **`3e5986fc253a3e4b…`**

## Executive Summary

The fresh corpus reached **8 AUTO_CAPTURE_SUPPORTED** cases across **6
repositories** — satisfying the capture-support half of the gate. Applying the
frozen treatment-artifact requirement then reduced it to **5 headline-eligible
cases across 3 repositories**, against a required 8 and 6.

**This is the substantive finding of Stage 1.** Capture support materially
overstates how many incidents yield an artifact that can actually establish
whether the bug is present. Of the 8 fresh supported cases examined,
**5 produced a discriminating artifact and 3 did not** — a 37.5% loss that has
nothing to do with repair value and everything to do with what the frozen
system can and cannot express.

Two distinct failure modes, and they are different problems:

1. **Coarse failure identity.** `finalhandler-headers` captures cleanly and
   replays offline, but the defect manifests as **malformed response headers**,
   which FailureFingerprintV2 does not model. Buggy and fixed both fingerprint
   as `HTTP_503`, so the artifact reports the original failure **reproduced
   against the historical fixed revision**.
2. **Replay transport normalization.** `koa-1961` and `send-416` capture
   cleanly but the artifact cannot reproduce the failure **even on the revision
   it was captured from**. Frozen replay re-issues the captured request through
   a normal HTTP client, which recomputes `Content-Length`; koa-1961's trigger
   depends on a declared length inconsistent with the body, so it replays as
   HTTP 200 against the buggy revision that produced a captured 500.

Neither was rescued. No capture semantics, fingerprint logic, replay transport
or bug-specific handling was changed.

## Frozen V3.3 Verification

20/20 independent checks passed before the checkpoint was committed: both
manifest hashes reproduce, the implementation tree reproduces with **0 drift
across 14 files**, Phase 4 aggregates were re-derived from raw artifacts
(`POST_CAPTURE_QUIESCENT_UNMATCHED` +0.05% p95 / −1.27% throughput;
`ARMED_MIXED_10` +5.40% / −6.43%), quiescence was verified before all 30
post-capture repetitions, and `fingerprint.mjs`, `normalize.mjs` and
`replay-one.mjs` remain byte-identical to frozen V3.

## Fresh Corpus

| Bug | Repository | Stack | Buggy | Fixed | Capture Status | Fingerprint (strength) | Events | Artifact Verdict | Headline Eligible |
|---|---|---|---|---|---|---|---|---|---|
| koa-1961 | koajs/koa | koa | e0ba8ef | 3f3ac48 | AUTO_CAPTURE_SUPPORTED | ERR:E_LENGTH_OVERFLOW (STRUCTURED_SPECIFIC) | 0 | INCONCLUSIVE | no |
| express-cookie-maxage | expressjs/express | express | 1cc81699 | 58553394 | AUTO_CAPTURE_SUPPORTED | HTTP_500 (GENERIC_HTTP_STATUS) | 1 | DISCRIMINATING | **yes** |
| express-jsonp | expressjs/express | express | 1b2f3a06 | 9dd0e7af | AUTO_CAPTURE_SUPPORTED | ERR:E_JSONP_UNDEFINED (STRUCTURED_SPECIFIC) | 0 | DISCRIMINATING | **yes** |
| fastify-prefix | fastify/fastify | fastify | 8b9c07b6 | 2f597a92 | AUTO_CAPTURE_SUPPORTED | ERR:E_PREFIX_JOIN (STRUCTURED_SPECIFIC) | 0 | DISCRIMINATING | **yes** |
| hapi-failaction | hapijs/hapi | hapi | db0cb450 | 619380ab | AUTO_CAPTURE_SUPPORTED | ERR:E_NO_DEFAULT_ERROR (STRUCTURED_SPECIFIC) | 1 | DISCRIMINATING | **yes** |
| send-416 | pillarjs/send | node:http+send | 53f0ab4 | 24b4af2 | AUTO_CAPTURE_SUPPORTED | ERR:E_416_NO_HEADERS (STRUCTURED_SPECIFIC) | 0 | INCONCLUSIVE | no |
| fastify-port | fastify/fastify | fastify | 5f4871f9 | 6ac2e953 | AUTO_CAPTURE_SUPPORTED | ERR:E_PORT_DERIVATION (STRUCTURED_SPECIFIC) | 0 | DISCRIMINATING | **yes** |
| finalhandler-headers | pillarjs/finalhandler | node:http+finalhandler | 872134f | 7bfa2f7 | AUTO_CAPTURE_SUPPORTED | HTTP_503 (GENERIC_HTTP_STATUS) | 0 | NON_DISCRIMINATING_ARTIFACT | no |
**Screened and excluded**, each recorded with its reason, none a Rapture limitation:

| Candidate | Exclusion reason |
|---|---|
| restify (all eras) | Node 22 incompatible at both 2019 and 2022 revisions (`Cannot set property closed of #<Readable>`) |
| express 99a369f3 | my model of the defect was wrong — `app.use(RegExp)` did not match mid-path even when buggy |
| koa 769fd75c | `redirect('back')` had already been removed at that revision |
| body-parser 2a2f4719 | buggy revision correctly returned 413; the fix is stream cleanup, likely a hang not a bounded status |
| body-parser 744a350d | **inverted** — the commit deliberately changed a default, so the parent behaved correctly |
| finalhandler 05d38645 | out-of-range status crashes the process (no bounded response); near-valid status normalizes identically in both revisions |

In each case the candidate was dropped rather than reshaped until it produced a
failure.

## Artifact Discrimination Audit

The frozen requirement, verbatim from `phase_4_treatment_artifact`:

> *"reproduces the exact original failure against the buggy revision"*
> *"the historical fixed revision removes the original failure"*

Verified with **frozen V3.3 capture and replay only**. The hidden oracle was not
used and cannot substitute for artifact discrimination.

| Verdict | Count | Cases |
|---|---|---|
| DISCRIMINATING | **5** | express-cookie-maxage, express-jsonp, fastify-prefix, fastify-port, hapi-failaction |
| NON_DISCRIMINATING_ARTIFACT | **1** | finalhandler-headers |
| BUGGY_REVISION_NOT_REPRODUCED | **2** | koa-1961, send-416 |

**Observed yield: 5/8.** This is the exact figure for this screened corpus and
is **not** offered as a population estimate.

**Process correction.** My initial screening verified capture support only and I
reported the 8/6 gate as met. That was wrong. Artifact discrimination is a
separate frozen requirement and had not been checked. The claim is retracted;
the audit that exposed it was requested, not self-initiated.

## Fingerprint Strength

| Strength | Count | Cases |
|---|---|---|
| STRUCTURED_SPECIFIC | 6 | koa-1961, express-jsonp, fastify-prefix, fastify-port, hapi-failaction, send-416 |
| GENERIC_HTTP_STATUS | 2 | express-cookie-maxage (`HTTP_500`), finalhandler-headers (`HTTP_503`) |

`HTTP_500` is genuine frozen fallback behaviour, not an experiment weakening:
`inferFingerprint()` uses a structured `appError` when captured, else an error
class parsed from the body, else `HTTP_${status}`. Where a framework renders an
unstructured error page, identity degrades to *(kind, method, route, status)*.

**Demonstrated collision.** For express-cookie-maxage, the historical defect and
a deliberately unrelated same-route `TypeError` produced the **identical**
fingerprint hash `98b904a7184a03e4…`. V3.3 failure identity should therefore be
described as exact **relative to the frozen fingerprint**, not universally exact.

## Incident-Information Subgroups

| Subgroup | Count |
|---|---|
| LOGIC_ONLY_OR_TRIGGER_DOMINANT | 6 |
| TIME_RANDOM_CONFIG_DEPENDENT | 2 |
| DATABASE_STATE_DEPENDENT | **0** |
| OUTBOUND_HTTP_STATE_DEPENDENT | **0** |
| MULTI_BOUNDARY_DEPENDENT | **0** |

**No database- or outbound-HTTP-dependent case was found in the screened
supported corpus.** An executable incident's distinctive value is reproducing
state an agent cannot otherwise obtain, so this corpus would have tested the
thesis in the regime where `.repro` adds least.

I proposed weighting selection toward boundary-state-dependent bugs and
**withdrew it** before it affected any inclusion decision: that criterion is not
in the frozen manifest, and adding it would have biased selection toward the
treatment arm. Recorded in `results/selection-rule-check.json`.

## What Was Not Done

No calibration runs. No headline runs. No secondary-runtime replication. No
subject agent was invoked at any point. No hidden oracles, evidence packs or
`.repro` artifacts were built for headline use, because the denominator they
would serve was never valid.

## Limitations

- 5/8 is a small-sample observation on one screened corpus, not a yield estimate.
- The corpus skews to logic/trigger-dominant incidents; a stateful corpus might
  show a different artifact-yield profile, higher or lower.
- Two artifact failures trace to the replay **transport**, not to capture; a
  different replay mechanism might reproduce them. That possibility is recorded,
  not acted on, because V3.3 is frozen.
- The bounded search was stopped with 2 of 3 authorized repositories unspent.
  With a maximum of 2 further repositories the gate could reach at most 7 cases
  across 5 repositories, still short of 8 and 6.

## Decision

The frozen Stage 1 gate requires **8 headline-eligible cases across 6
repositories**. Observed: **5 across 3**. The gate cannot be reached within the
authorized search, and neither the gate nor the treatment-artifact requirement
was weakened to close it.

Stage 1 stops here. The most useful output is not the corpus but the
measurement it produced: **automatic capture support is not the same as usable
executable-artifact yield**, and on this corpus the gap was 3 of 8 cases.

RAPTURE_REPRODUCER_V4_STAGE1_STATUS=INSUFFICIENT_CORPUS
