# Rapture Reproducer V0 — Minimal Executable Production-Failure Artifact

Research experiment (T34/T35): given a complete deterministic capture of a
single-process backend incident, can an automated reducer remove irrelevant
captured inputs/state/interactions and produce a significantly smaller offline
artifact that reproduces the same failure fingerprint reliably?

This is a self-contained research fixture under `experiments/` (excluded from
Biome, outside the pnpm workspace). It adds no product surface: no CLI
changes, no kernel/core changes, no archive changes. Plain Node ESM, zero
dependencies, tests via `node --test`.

## Layout

- `src/canonical.js` — stable stringify, SHA-256, path helpers
- `src/fingerprint.js` — `AppError`, harness errors, `FailureFingerprint`
- `src/replay.js` — record/replay boundary substrate (`ReplayContext`)
- `src/scenarios.js` — 8 frozen incident fixtures (ground truth for scoring only)
- `src/capture.js` — full-capture builder, atom listing, candidate replay
- `src/reducer.js` — ddmin-style reducer + greedy baseline (no fixture imports)
- `src/artifact.js` — portable `ReproducerArtifact` build/verify
- `scripts/freeze-manifest.js` — freeze scenario definitions (run first, once)
- `scripts/run-all.js` — phases 3–5 + metrics (requires frozen manifest)
- `scripts/replay-single.js` — fresh-process single-replay entry (portability)
- `test/` — unit tests (`node --test test/`)
- `MANIFEST.json` — frozen scenario definitions + ground truth + capture hashes
- `results/` — captures, artifacts, trial JSONL, per-scenario + aggregate metrics
- `REPORT.md` — final research report with decision gate

## Reproduce

```sh
node scripts/freeze-manifest.js   # freeze scenarios before any reducer run
node scripts/run-all.js           # full experiment: replay, reduce, portability
node --test test/                 # 14 unit tests (11 required + 3 determinism)
```

## Result (2026-09-07)

8/8 scenarios: full replay 20/20, portable replay 20/20, causal recall 100%,
zero wrong-failure acceptances, aggregate byte reduction 81%, atom reduction
93%. See `REPORT.md` and `RAPTURE_REPRODUCER_V0_STATUS=CONTINUE`.
