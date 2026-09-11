# V4 Value Probe — Manifest Freeze and Harness Calibration

**Scope executed:** commit the accepted isolation work, freeze
`V4-PROBE-MANIFEST.json`, run calibration. **No probe case was invoked.** V3.3 is
unmodified at `5416f275`, the corpus is unmodified, the subject model is
unchanged, and the provider allowlist is unchanged.

| | |
|---|---|
| Isolation checkpoint | **`b9a9a930`** |
| Probe manifest | `experiments/reproducer-v4/probe/V4-PROBE-MANIFEST.json` |
| Manifest sha256 | **`4a5aaad3b724e7ca0e05eeb4e1f86ca6d36348d93fc3f7ece0314fb387679701`** |
| Randomization seed | `539363601`, frozen with the full 20-run schedule before any subject run |
| Valid calibration runs | **4 of a maximum 4** |

---

## Hidden oracles validated before any subject run

Both calibration cases are on the frozen `excluded_prior_bugs` list and are
permanently ineligible for the five-case probe.

| Case | Buggy revision | Fixed revision | Hidden variants |
|---|---|---|---|
| koa-1998 | fails original (500 `E_ASSERT_REGRESSION`) **and** both hidden variants | original absent (401); variants return 403 and 402 | `ctx.assert` with a *different* status and message on a *different* path |
| koa-1999 | fails original (500 `E_URL_MISMATCH`) **and** both hidden variants | original absent (200); variants parse the authority correctly | absolute-form targets with a *different* authority and a *different* scheme |

The repository regression suite is green on both revisions of both cases, so a
patch cannot pass by breaking tests.

---

## The four runs

| Run | Arm | Outcome | Wall clock | `.repro` calls | Tests run | Patch |
|---|---|---|---|---|---|---|
| koa-1998 | CONTROL | **CORRECT_FIX** | 182.2 s | 0 | 2 | `lib/context.js` +50 −2 |
| koa-1998 | TREATMENT | **CORRECT_FIX** | 178.9 s | 4 | 3 | `lib/context.js` +57 −3 |
| koa-1999 | CONTROL | **CORRECT_FIX** | 141.9 s | 0 | 6 | `lib/request.js` +8 −1 |
| koa-1999 | TREATMENT | **CORRECT_FIX** | 124.1 s | 3 | 4 | `lib/request.js` +6 −1 |

Preflight 8/8 and workspace audit 8/8 on every run. Every patch was confirmed by
the hidden evaluator: original failure absent, **both** hidden variants passing,
repository regression suite green.

**These are not product-value evidence.** Four runs on two excluded bugs, all
succeeding in both arms, say nothing about the five probe cases.

The treatment artifact is genuinely usable by a real agent: both treatment runs
invoked `/work/repro` several times and observed **both** outcomes —
`ORIGINAL_FAILURE_REPRODUCED` before the fix and `ORIGINAL_FAILURE_ABSENT`
after.

**Budget.** The slowest run used 182 s of the 1200 s budget — 15%. No run
approached the timeout, so timeout handling is implemented and enforced but was
not exercised. The budget stays at 1200 s; no change is proposed.

---

## Network: what happened, and who did it

Every run produced an identical pattern.

| Host | Result | Per run |
|---|---|---|
| `opencode.ai:443` | **ALLOWED** — one CONNECT tunnel, logged at close | 1 |
| `models.opencode.ai:443` | **DENIED** | 1 |
| `registry.npmjs.org:443` | **DENIED** | 1–2 |
| `github.com:443` | **DENIED** | 1 |

**`models.opencode.ai` was not added.** Inference completed in 4/4 calibration
runs and 4/4 isolation-audit runs with it denied. The frozen rule permits adding
a hostname only if inference *cannot complete* without it.

**None of the denied attempts is attributable to agent research.** I enumerated
every shell command all four agents executed: **not one performs a network
operation** — no `curl`, `wget`, `git fetch`, `git ls-remote`, `npm view`, no web
tool. The deny pattern is identical across arms and cases at t+~52 s, t+~54 s and
t+~78 s, varying by under six seconds. A bare trivial inference with no
repository reproduces the first two; `npm test` alone with no agent reproduces
the `registry.npmjs.org` deny. These are runtime background checks by opencode
and npm. `github.com` is the least directly attributed of the three: it appears
only in longer sessions and in no trace command.

**A gap worth stating.** The agents never attempted a web tool during a genuine
repair task, so the provider-web-bypass path was exercised by the isolation audit
but **not** by calibration. Zero attempts is not the same as a demonstrated
block under load.

---

## Four leakage defects the calibration found and closed

The first workspace audit failed, and it failed for good reasons.

1. **The deployed application's source comments contained the answer.** The V3
   service files carry research annotations naming the issue number, *both*
   revision shas, and a plain-language root-cause explanation. Copied verbatim
   they would have handed the subject the fix. Comments mentioning the historical
   bug are now stripped when the app enters a workspace; no executable line is
   altered.
2. **The service filename encoded the issue number** (`koa-1998.mjs`) and reached
   the subject through the evidence pack's stack trace. It is deployed as
   `server.mjs`.
3. **The corpus `.git` contains the future fix commits.** Confirmed directly:
   `git cat-file -t 1061776` succeeds in the corpus checkout. The builder strips
   `.git` entirely and creates a new single-commit repository. Three of the four
   agents ran `git log` themselves and saw exactly one commit.
4. **The preflight was destroying its own audit trail.** Re-running `net-up.sh`
   before every run recreated the Squid container and reset the access log.
   `net-up.sh` is now idempotent for a running proxy.

Two further harness amendments: the pg dependency closure is vendored and mounted
read-only (the container has no network, and it is identical in both arms), and
workspace retention now defaults to off after evaluation.

All were made **before any headline data exists**, which is when the frozen rules
permit them.

---

## Resources — the one genuine constraint

| | |
|---|---|
| Reclaimed before calibration | ~890 MB (Homebrew download cache, build-only Go toolchain) |
| Free before calibration | 2.8 GB |
| Free after calibration | **1.6 GB** |
| Workspace size | 58 MB (CONTROL) / 60 MB (TREATMENT) |
| Colima VM growth | ~300 MB, **not** recoverable — the Lima disk file only grows |

**The calibration disk gate is satisfied:** all four runs and all four hidden
evaluations completed with no disk-pressure failure.

**The headline does not fit as-is.** 20 runs at 60 MB would need ~1.2 GB of
simultaneous workspace space against 1.6 GB free, before further VM growth.
Workspace retention therefore now defaults to **off**: one workspace exists at a
time, and the patch, full trace, proxy log, workspace hashes and hidden
evaluation are kept instead. **This is a decision point to confirm before the
headline runs** — the four calibration workspaces are still retained and have not
been deleted.

---

## What calibration did not validate

- provider web-retrieval bypass under a genuine repair task (zero attempts)
- timeout handling on a run that actually exhausts the budget
- behaviour on a case the agent cannot solve — all four succeeded

---

## Files

```
experiments/reproducer-v4/
  V4-PROBE-CALIBRATION-REPORT.md          this report
  probe/V4-PROBE-MANIFEST.json + .sha256  frozen manifest
  probe/                                  harness: preflight, workspace builder,
                                          leakage audit, evidence builder,
                                          hidden oracles, evaluator, run driver
  results/probe-calibration-summary.json  structured result + sha256
  results/probe-calibration/              per-run record, trace, patch, proxy log
```

---

RAPTURE_REPRODUCER_VALUE_PROBE_CALIBRATION=READY_FOR_HEADLINE
