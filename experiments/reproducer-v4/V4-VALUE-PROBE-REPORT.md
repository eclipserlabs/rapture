# V4 Value Probe — Result

**20 valid runs. 5 cases × 2 arms × 2 replicates. Concurrency 1.**

| | |
|---|---|
| Isolation checkpoint | `b9a9a930` |
| Probe manifest | `0afe2fdf2cf0813eb0aaae577c26ee20e06c5f291ff9064e25174a70b6ce3202` |
| Seed / schedule | `539363601`, frozen before run 1, unchanged |
| Subject | opencode 1.18.30, `opencode/muse-spark-1.3-contributor-free`, 1200 s budget |
| Valid / invalid | 20 / 1 (re-run) — 22 subject invocations in total |

---

## Headline numbers

| | CONTROL | TREATMENT |
|---|---|---|
| **Correct-fix rate** | **70%** (7/10) | **90%** (9/10) |
| False-fix rate | 0% | 0% |
| Regression rate | 30% | 10% |
| Timeout rate | 0% | 0% |
| Median wall clock, successful runs | 141.6 s | **107.3 s** (−24.3%) |
| Median tool calls, successful runs | 15 | 16 (+6.7%) |

Absolute correct-fix difference: **+20 percentage points**.

## All 20 outcomes

| # | Case | Arm | Outcome | s | `.repro` | tests |
|---|---|---|---|---|---|---|
| 1 | express-cookie-maxage | C | CORRECT_FIX | 66.5 | – | 0 |
| 2 | express-cookie-maxage | T | CORRECT_FIX | 105.5 | 3 | 6 |
| 3 | express-cookie-maxage | C | **REGRESSION_INTRODUCED** | 145.3 | – | 4 |
| 4 | express-cookie-maxage | T | CORRECT_FIX | 80.1 | 6 | 4 |
| 5 | express-jsonp | T | CORRECT_FIX | 117.0 | 7 | 6 |
| 6 | express-jsonp | C | CORRECT_FIX | 141.6 | – | 1 |
| 7 | fastify-port | C | **REGRESSION_INTRODUCED** | 163.0 | – | 5 |
| 8 | fastify-port | T | **REGRESSION_INTRODUCED** | 203.5 | 4 | 9 |
| 9 | express-jsonp | T | CORRECT_FIX | 107.2 | 3 | 3 |
| 10 | express-jsonp | C | CORRECT_FIX | 105.4 | – | 1 |
| 11 | fastify-prefix | T | CORRECT_FIX | 90.3 | 5 | 6 |
| 12 | fastify-prefix | C | CORRECT_FIX | 238.4 | – | 7 |
| 13 | hapi-failaction | T | CORRECT_FIX | 188.4 | 5 | 1 |
| 14 | hapi-failaction | C | CORRECT_FIX | 183.1 | – | 1 |
| 15 | hapi-failaction | C | CORRECT_FIX | 272.2 | – | 1 |
| 16 | hapi-failaction | T | CORRECT_FIX | 143.8 | 8 | 1 |
| 17 | fastify-port | C | **REGRESSION_INTRODUCED** | 178.1 | – | 4 |
| 18 | fastify-port | T | CORRECT_FIX | 264.1 | 5 | 6 |
| 19 | fastify-prefix | T | CORRECT_FIX | 98.5 | 3 | 3 |
| 20 | fastify-prefix | C | CORRECT_FIX | 100.4 | – | 2 |

## Paired, per case

| Case | CONTROL | TREATMENT | Verdict |
|---|---|---|---|
| express-cookie-maxage | 1/2 | 2/2 | **TREATMENT WINS** |
| express-jsonp | 2/2 | 2/2 | tie (ceiling) |
| fastify-prefix | 2/2 | 2/2 | tie (ceiling) |
| fastify-port | 0/2 | 1/2 | **TREATMENT WINS** |
| hapi-failaction | 2/2 | 2/2 | tie (ceiling) |

**Treatment wins 2, ties 3, loses 0.**

---

## Verdict against the frozen rules

Control is at 70%, so the **normal-baseline** branch applies:

| Frozen requirement | Result |
|---|---|
| Treatment improves correct-fix by ≥ 20 pp | ✅ exactly +20 |
| Treatment wins on ≥ 3 of 5 cases | ❌ **2 of 5** |
| Treatment loses on ≤ 1 of 5 cases | ✅ 0 |
| False fixes and regressions not materially worse | ✅ both better |

STRONG_POSITIVE_SIGNAL fails on one criterion. NEGATIVE_SIGNAL does not apply either: the advantage is 20 pp, not under 10, and there is a 24.3% median-time advantage. Three of five cases are ties **because both arms scored 2/2** — a ceiling, not a null.

That is precisely the frozen definition of INCONCLUSIVE: *"results are mixed at the bug level and neither positive nor negative thresholds are met"*, and *"extreme ceiling effects prevent both correctness and efficiency comparison"*.

The directional picture is favourable and entirely consistent — treatment never lost a case, never produced a false fix, and regressed less. It is not the preregistered bar, and the bar does not move.

---

## The finding that most limits this result

**8 of 10 CONTROL runs started the service and reproduced the failure themselves.**

All five probe cases are pure framework-logic bugs with no database and no outbound dependency. Four of the five frozen artifacts contain **zero** captured boundary events; the fifth contains one. So on this corpus the executable incident is a *one-command reproduction*, competing against "boot the app and curl it" — not against "you cannot reproduce at all".

The calibration cases are the contrast: they need a live Postgres and an outbound HTTP dependency the container does not have, which is exactly where offline replay would matter. **The probe corpus does not test the capability the artifact was built for.** That is a property of which five cases survived V4 Stage 1, not a choice made here.

Where treatment did win, it won on the two hardest cases — the only two where control ever failed.

## The failure mode that decided the result

Three runs converged on the **same wrong one-line `lib/request.js` change** in fastify-port, breaking six `trust proxy` tests (p7 and p17 CONTROL, p8 TREATMENT). In express-cookie-maxage p3, control's one-line `lib/response.js` change broke `res.json(array)`.

Every regression was caught by the differential repository suite, which compares against a baseline recorded on the unmodified buggy tree — express carries 4 pre-existing failures and hapi 6, so a whole-suite-green rule would have been unsatisfiable from the start.

Treatment's one loss (p8) shows the artifact does not prevent this: it confirms the original incident is gone without saying anything about what else broke.

---

## Artifact usage

- **10 of 10** treatment runs invoked `/work/repro` — 3 to 8 times each (median 5).
- Both outcomes were observed: `ORIGINAL_FAILURE_REPRODUCED` before the fix, `ORIGINAL_FAILURE_ABSENT` after.
- **0** control runs invoked it; it is not in their workspace.

The artifact was used, and used as intended. This is not a case of agents ignoring the tool.

---

## Integrity

- **0** web-tool attempts across all 20 runs. **0** external network commands. The only network-capable shell commands in any trace were two `curl` calls to `127.0.0.1`.
- Proxy totals: `opencode.ai` allowed 36; **denied** — `registry.npmjs.org` 33, `models.opencode.ai` 20, `github.com` 20. No hostname was added.
- One localhost request in p7 transited the proxy and was denied. A possible handicap to that run; not decisive — p17, the same case's other CONTROL replicate with no such event, produced the identical wrong patch, as did treatment p8.
- Workspace leakage audit 8/8 and preflight 8/8 on every run. Zero `INVALID_LEAKAGE`.
- Disk never came within 750 MB of the 700 MB floor; 0 workspaces retained.

**Provider instability, disclosed.** Two runs failed with `Upstream request failed: [invalid_request_error] reasoning 'encrypted_content' was not issued to this caller`. That is a provider outage, not an agent giving up, so it is classified `INVALID_HARNESS` and the slot re-run. The detector for it was added **after headline run 1**, when the failure first appeared; the manifest was deliberately not re-frozen for it so the sequence stays visible here. 22 invocations produced 20 valid runs.

---

## What this does and does not support

It does **not** support `STRONG_POSITIVE_SIGNAL`; the preregistered bar was not met.

It does **not** support `NEGATIVE_SIGNAL` either. Treatment lost no case, produced no false fix, regressed less, and was 24% faster on successful runs. Recommending a kill on this evidence would be reading a ceiling as a null.

The honest reading: **on a five-case corpus that cannot exercise the artifact's distinguishing capability, the executable incident was consistently mildly better and never worse.** Three of five cases were already saturated at 2/2 in both arms, so the design could not have detected an effect there whatever the truth is.

Per the frozen rule, INCONCLUSIVE means return for product-level review, and **does not authorize a larger study, corpus expansion, or further mechanism work**.

---

RAPTURE_REPRODUCER_VALUE_PROBE=INCONCLUSIVE

RAPTURE_PRODUCT_THESIS_DECISION=RETURN_TO_PRODUCT_REVIEW
