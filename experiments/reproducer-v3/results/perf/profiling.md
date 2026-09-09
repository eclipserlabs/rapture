# V3 Phase 3 — p95 root-cause analysis (pre-headline, calibration services only)

## Question
V2 reported +62.5% p95 success-path overhead (N=150, ms quantization). Is the
tail structural or implementation-specific?

## Method
- 2 calibration services (shop: routing/middleware/auth/pg/fetch; directory:
  heavier shape: session lookup, 2pg+2fetch search), local PG + deterministic
  fake external. Never part of the headline corpus.
- 5 modes: OFF / CONTEXT_ONLY / INTERCEPT_DISCARD / FULL_SUCCESS_PATH
  (=capture) / FAILED_PERSIST. 10 independent reps × 5000 measured requests,
  rotated order, warmed, concurrency 16, N-warmup excluded.
- Attribution: --cpu-prof self-time on capture mode + the mode ladder
  (OFF→CONTEXT_ONLY isolates ALS+wrap; →INTERCEPT_DISCARD isolates
  interception; →FULL isolates retention).

## Profile findings (service A, capture, 3000 reqs, 6837 samples)
Directly Rapture-attributable self-time ≈ 3.2%:
- recordEvent 0.9% (14/17 ticks on the per-event JSON.stringify byteLength line)
- kernel redactSecrets regexes over full bodies 0.5%
- redactHeaders 0.4%
- pg wrapper 0.5%, http wrapper 0.5%, time wrapper 0.4%
The +30% latency gap is therefore NOT self-CPU: it is async/task-queue
effects — Response.clone() tee machinery per outbound fetch, extra promise
hops per pg query, ALS init/destroy tax on every async resource, per-chunk
string concat, and regex passes over bodies that successes then discard.

## Generic optimizations applied (all from the allowed list)
1. Defer serialization until failure: recordEvent retains raw references only;
   JSON.stringify/byteLength happen once at persist time.
2. Defer redaction until failure: redactUrl/redactHeaders/redactTextBody/
   redactPgParams run only on the persist path.
3. Raw chunk buffering: request/response bodies accumulate Buffer refs;
   decode+cap-slice+redact at persist. Removes per-chunk string concat.
4. Clone consumed as raw bytes (arrayBuffer, no UTF-8 decode) on success path.
5. Request-local ephemeral buffering; events counted (not built) in
   intercept-discard; no hashing of discarded data.
6. Correctness fix found by calibration (amendment): the http wrapper's eager
   req.on('data') put streams in flowing mode, losing body/'end' for any app
   that awaits before reading its body (all V2 triggers were GETs, so frozen
   V2 has this flaw too). Fix: pause() at wrap + explicit resume() when the
   app subscribes to 'data' (verified Node 22 does NOT auto-resume).

## Fidelity check
V2-code vs V3-code capture of the same failing incident: byte-identical
modulo run-volatile values (request-id UUID, HTTP date, time draws).
Fingerprint, keys, redacted bodies all equal (scripts/perf-equiv.mjs).

## Final 10-rep outcome (frozen tree 8a8ef009, median-of-rep-medians)
After the Phase 4 privacy fixes (inbound-query redaction, redacted http keys,
row scrubbing, cookie session surrogates, pg substring scrub — all
persist/key-time, re-frozen, full 100-run re-measurement):
- service A capture vs off: p50 +32.8%, p90 +12.6%, p95 -2.4%, p99 -1.7%,
  throughput -22.6%.
- service B capture vs off: p50 +44.1%, p90 -0.7%, p95 -1.3%, p99 +1.4%,
  throughput -16.5%.
- Ladder (p50): CONTEXT_ONLY +7/+19% (ALS+wrap), INTERCEPT_DISCARD +35/+20%,
  FULL +33/+44%. Retention adds ~0pp: the deferred design holds. The
  remainder is structural: ALS propagation tax across dozens-hundreds of
  async resources per request + wrapper promise hops + fetch tee machinery.
- V2's +62.5% p95 tail blowup did NOT reproduce: final p95s are -2.4% / -1.3%.
  Conclusion: the V2 tail was implementation-specific (eager
  serialize+redact on the hot path) plus small-N quantization, now removed.
  What remains is a structural ~+35-44% p50 / ~-20% throughput cost of
  always-on interception.

## Environment noise (honest limitation)
Rep-to-rep whole-machine slowdowns dominate tails (e.g. a/off p95 spans
74→226ms across reps; slow reps are slow in ALL modes). With n=10 the
median-of-reps is robust but CIs are wide; point estimates below ~±15pp
should be read as bands, not precise values.

## Gate reading (performance gates are production-viability gates)
- median p95 overhead -1.9% (≤20%): PASS
- no single service p95 >35% (-2.4%, -1.3%): PASS
- median p99 overhead ≈0% (≤30%): PASS
- median throughput degradation -19.6% (≤15%): FAIL
One performance gate fails: success-path interception is not yet cheap
enough for full-traffic production. Per the preregistered interpretation,
this caps the overall decision at MODIFY even if correctness passes, and
points at sampling/selective capture, not at more hot-path tuning (the
cheap wins are taken; the rest is structural ALS+interception tax).
