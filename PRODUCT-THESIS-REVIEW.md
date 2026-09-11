# Rapture — Post-V4 Stage 1 Product Thesis Review

## Executive decision

**No thesis can be responsibly chosen yet, because the single most
decision-relevant fact has never been measured: whether an executable incident
improves repair at all.**

Five experiments established that the mechanism works. None established that the
artifact is worth anything. V4 was designed to answer exactly that and stopped
before running a single subject agent. Choosing between Reproducer A, Reproducer
B and procedure conformance today would be choosing on architectural taste,
which the evidence rules correctly forbid.

This is not a tie. It is a specific, cheap, asymmetric experiment that has not
been run and now can be, because **5 self-verifying artifacts already exist**.

## What V0–V3.3 actually proved

Observed, not inferred:

- **V3** — 8 real historical incidents from 7 repositories and 4 framework
  families became portable executable reproducers: **160/160 offline exact,
  160/160 portable exact, 8/8 FIX_CONFIRMED, 0 wrong-failure acceptances,
  0 bug-specific wrappers or assertions**, with ~2 minutes of incident-specific
  setup.
- **V3.1** — selective capture works; route targeting is the viable mechanism.
  Random sampling is dominated by a fixed cost floor (1% and 10% sampling cost
  the same throughput, 0.02 pp apart).
- **V3.2** — three defects found that all prior phases missed, including a pg
  pool ownership bug that wrote one request's SQL parameters into another
  request's incident. Also: the V3 session-credential surrogate was
  **structurally inert on real cookies**, and parse-server's famous "16/20
  nondeterminism" was a harness bug, not nondeterminism.
- **V3.3** — the AsyncLocalStorage lifecycle tax is removable for episodic
  capture (+0.05% p95, −1.27% throughput with a route still armed), but **not**
  for continuously armed traffic (+5.40% / −6.43% at 10% armed, where the
  storage is active ~99% of wall clock).

**The critical caveat, which V4 exposed:** this corpus was co-developed with the
system. Every capability was demonstrated against incidents that were available
while the mechanism was being built.

## What V4 Stage 1 falsified or weakened

The first genuinely held-out test. Eight fresh incidents Rapture had never been
developed against reached **AUTO_CAPTURE_SUPPORTED across 6 repositories** — the
capture mechanism generalized.

Then the frozen treatment requirement was applied: the artifact must reproduce
on the buggy revision **and stop reproducing on the historical fixed revision**.
Yield fell to **5 of 8, across 3 repositories**.

| Failure mode | Cases | Mechanism |
|---|---|---|
| NON_DISCRIMINATING_ARTIFACT | finalhandler-headers | the defect is malformed **response headers**, which FailureFingerprintV2 does not model; buggy and fixed both fingerprint `HTTP_503`, so the artifact reports the failure reproduced against the **fixed** revision |
| BUGGY_REVISION_NOT_REPRODUCED | koa-1961, send-416 | frozen replay re-issues the captured request through a normal HTTP client, which **recomputes `Content-Length`**; a trigger depending on a declared length inconsistent with the body replays as HTTP 200 against the revision that produced a captured 500 |

**5/8 is the exact observed figure for this screened corpus and is not a
population estimate.**

Two further observations, both recorded:

- A demonstrated **fingerprint collision**: the historical cookie defect and a
  deliberately unrelated same-route `TypeError` produced the identical hash
  `98b904a7184a03e4…`. V3.3 failure identity is exact *relative to the frozen
  fingerprint*, not universally exact.
- **Zero** database-dependent or outbound-HTTP-dependent cases appeared in the
  screened supported corpus (6 logic/trigger-dominant, 2 time/random). The
  corpus would have tested the thesis in the regime where an executable incident
  adds least.

**What V4 did not falsify:** anything about repair value. No calibration run, no
headline run, no subject agent was invoked.

## Product A assessment — self-verifying executable incident

Apply the kill test: *would closing the V4 failures require Rapture to become
materially broader than the original small primitive?*

**Failure identity — open-ended.** To distinguish buggy from fixed for
finalhandler-headers you must model response headers. The next defect class will
be response *bodies*; then emitted side effects; then ordering; then timing. The
question "did the same failure occur?" has no finite answer set, because it
depends on which observable the defect happens to perturb. Each extension is
individually reasonable and collectively unbounded. This is the
`Need to model arbitrary response semantics` signal, answering **yes**.

**Transport fidelity — descending.** To reproduce koa-1961 you must stop
reconstructing requests through an HTTP client and start replaying bytes. That
invites chunked-encoding edge cases, malformed headers, HTTP/2 framing, and
eventually socket-level behaviour. This is the `Need raw transport replay`
signal, answering **yes**.

Both failure modes are structural, not incidental. Neither is a bug in the
implementation; both are consequences of where the abstraction was drawn.

**Assessment: the *sharp* version of Product A is damaged.** Its defining
property — self-verification — failed on 37.5% of fresh supported incidents, and
the natural repairs expand the primitive toward generic record/replay.

**But this does not kill it**, for one reason that matters: if a working
artifact produced a large repair benefit, a 5/8 yield would still be a viable
product. Yield only matters conditional on value, and value is unmeasured.

## Product B assessment — executable production context

**What painful operation does it delete?** "Reproduce the production situation
locally." Real, but the deletion is partial: without a self-verifying oracle the
engineer or agent still needs an independent test to know when they are done.
Product B removes the *setup* cost, not the *verification* cost.

**Is it substantially better than strong telemetry plus a modern agent?**
Unknown, and this is precisely the V4 question. The V4 control was deliberately
designed to be strong — sanitized stack trace, span tree, DB operation text,
outbound metadata — because a strawman control would have proved nothing. That
control has never been run against either arm.

**Category risk is higher than Product A's.** Without the oracle, B's
differentiation narrows to "deterministic offline replay of a single request",
which sits adjacent to traffic replay (GoReplay, Speedscale), service
virtualization (WireMock, Hoverfly), time-travel debugging (rr, Replay.io) and
incident telemetry (Sentry, Datadog). It remains explainable in one sentence —
*"the production request, replayable offline"* — so it has not collapsed into a
platform. But it competes on convenience rather than on a capability nobody else
has, and convenience is where incumbents are strongest.

**Assessment: coherent but weaker, and untested on the axis that matters.**
Dropping the oracle discards the property that made Reproducer distinctive while
retaining the capture cost.

## Procedure-conformance assessment

**Evidence available: the weakest of the three, and partly negative.**

Closed bet 5 tested an adjacent thesis — that agent-authored PRs measurably
weaken the verification system — against **50 real merged agent PRs from 30
repositories and 6 agent identities**. Material weakening prevalence was **0%**.
Not low: zero. No added skip markers, no lowered coverage thresholds, no removed
CI test invocations.

That is evidence *against* the nearest measured relative of Product C, and it
should not be discounted because Product C is differently framed.

The preserved caveat cuts both ways: that corpus could only observe
**PR-submitting bots**, while the motivating incidents were reported from
**interactive local sessions**. So bet 5 does not refute the failure class — it
shows the class is invisible in the artifact the detector consumed. A different
observation surface is required, which is exactly Product C's premise and also
its central unsolved problem.

**What ordinary CI already handles:** tests ran, tests passed, coverage
thresholds, lint, type checks, build success, required reviews. This is most of
"did the required engineering operations happen".

**What CI cannot easily establish:** whether the agent *actually executed* the
verification it claims, whether reported results correspond to real execution,
and what was done in a local session that produced a hand-carried diff.

**Technical plausibility of runtime-independent evidence acquisition:** this is
the crux and it is unproven. Observing what an agent did without harness
cooperation means either instrumenting the execution environment (which the
kernel's shell-free argv exec and fsynced journal partially support) or trusting
self-report (which defeats the purpose). Rapture has never tested this.

**Assessment: architectural intuition with one adjacent negative result.**
Choosing it now would be choosing the least-evidenced option immediately after a
setback in the best-evidenced one, which is the exact pattern the evidence rules
warn against.

## Complexity trajectory comparison

| Thesis | Starting breadth | Trajectory under its own failure modes |
|---|---|---|
| A | narrow primitive | **expanding** — identity modelling and transport fidelity both descend toward generic record/replay |
| B | narrow primitive | **stable** — no oracle means no pressure to model failure semantics, but value is unproven |
| C | unknown | **unknown and potentially large** — runtime-independent evidence may require environment-level instrumentation |

## Competitive-category risk comparison

| Thesis | Nearest incumbents | Differentiation if it works |
|---|---|---|
| A | Sentry/Datadog, traffic replay, time-travel debuggers | **strong** — nobody ships an artifact that self-verifies the fix |
| B | traffic replay, service virtualization, debuggers | **moderate** — convenience over determinism, crowded |
| C | CI providers, policy engines, supply-chain attestation | **unclear** — attestation vendors are adjacent and well funded |

## Evidence-strength comparison

| Thesis | Problem clarity | Mechanism evidence | Fresh external validity | Implementation breadth | Incumbent pressure | Value as models improve | Current confidence | Next evidence required |
|---|---|---|---|---|---|---|---|---|
| **A** self-verifying incident | high | **strong** — 160/160 offline, 160/160 portable, 8/8 fix-confirmed on V3 corpus | **weak** — 5/8 usable-artifact yield on fresh incidents | **expanding** under its own failure modes | low if it works | **uncertain** — better models may need less help | **low–moderate** | does a working artifact improve correct-fix rate against a strong control? |
| **B** executable context | moderate | inherits A's capture evidence | inherits A's 5/8, minus the oracle | stable | **high** | **falling** — agents keep closing this gap | **low** | same question, weaker expected effect |
| **C** procedure conformance | moderate | **none** | adjacent result found **0%** prevalence in 50 agent PRs | unknown | moderate | **rising** — more agent-authored change | **very low** | does the failure class exist on an observable surface at measurable frequency? |

## Recommended next research bet

**Do not engineer anything. Run the cheapest experiment that can kill the
thesis outright.**

Five discriminating artifacts already exist. A repair-value comparison on those
5 cases costs roughly 6 hours of subject-agent time and requires no new capture
work, no corpus mining and no changes to frozen V3.3.

Its value is **asymmetric, and the asymmetry is the point**:

- **A null or negative result kills Reproducer A and B together.** If executable
  incidents do not help repair even on cases where the artifact works perfectly,
  against a strong conventional control, then yield, fingerprint completeness
  and transport fidelity are all irrelevant. The thesis dies for the right
  reason and cheaply.
- **A positive result confirms nothing.** Five cases across three repositories,
  all logic/trigger-dominant, is underpowered and skewed toward the regime where
  `.repro` helps least. A positive signal would only justify *then* paying for
  the full 8/6 corpus.

This must be labelled a **probe, not the V4 headline experiment**. The frozen
V4 gate requires 8 cases across 6 repositories and is not satisfied; the probe
cannot produce a `RAPTURE_REPRODUCER_V4_STATUS` and its results must never be
reported as the preregistered product signal. It requires explicit
authorization, since no calibration or headline run is currently permitted.

Choosing procedure conformance now would abandon the best-evidenced thesis one
experiment before it could be tested, in favour of the least-evidenced one whose
nearest measured relative returned 0%.

## What must not be built next

- Do not extend FailureFingerprintV2 to model response headers, bodies or side
  effects. That is the open-ended path.
- Do not implement raw-socket or byte-level HTTP replay.
- Do not alter `Content-Length` reconstruction or add per-bug replay handling.
- Do not resume corpus mining to reach 8/6 before value is demonstrated.
- Do not build agent-procedure conformance on current evidence.
- Do not design V4.1, V5 or any further capture-mechanism experiment.
- Do not modify frozen V3.3 in any respect.

RAPTURE_REPRODUCER_V4_STAGE1_STATUS=INSUFFICIENT_CORPUS
RAPTURE_PRODUCT_THESIS_DECISION=INSUFFICIENT_EVIDENCE_FOR_PRODUCT_DECISION
NEXT_RESEARCH_ACTION=Run an underpowered, explicitly non-headline repair-value probe on the 5 existing discriminating artifacts, where a null result kills Reproducer A and B and a positive result only justifies funding the full 8/6 corpus.
