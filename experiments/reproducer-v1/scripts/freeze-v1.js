// Freeze the V1 protocol BEFORE headline execution.
// Usage: node freeze-v1.js
// Validates 12/12 adversarial full captures reproduce (no reducer involved),
// then writes V1-MANIFEST.json + hash. Do not edit frozen definitions after
// headline execution starts (see manifest `freeze_rules`).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { listAdversarialScenarios, getAdversarialScenario } = await import(
  join(root, "adversarial", "scenarios.js")
);
const { buildFullCapture, listAtoms } = await import(join(v0src, "capture.js"));
const { canonicalBytes, hashJson } = await import(join(v0src, "canonical.js"));

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: join(root, "..", ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function shaFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const codeVersion = gitHead();
  const frozenV0Modules = {};
  for (const f of ["canonical.js", "fingerprint.js", "replay.js", "capture.js", "reducer.js", "artifact.js"]) {
    frozenV0Modules[f] = shaFile(join(v0src, f));
  }
  const scenarios = [];
  for (const { id, topology, title, description } of listAdversarialScenarios()) {
    const scenario = getAdversarialScenario(id);
    // Record-only: validates the scenario reproduces; the reducer is not run.
    const { capture } = buildFullCapture(scenario, codeVersion);
    const atoms = listAtoms(scenario, capture);
    const gt = scenario.groundTruth();
    scenarios.push({
      id,
      topology,
      title,
      description,
      code_version: codeVersion,
      expected_failure_fingerprint: capture.failure_fingerprint,
      capture_hash: capture.capture_hash,
      original_atom_count: atoms.length,
      original_event_count: capture.boundary_events.length,
      original_db_row_count: capture.db_rows.length,
      original_config_key_count: Object.keys(capture.config).length,
      removable_input_field_count: scenario.removableInputFields().length,
      original_bytes: canonicalBytes(capture),
      ground_truth: {
        must: gt.must,
        any_of: gt.anyOf,
        trigger: gt.trigger ?? [],
      },
    });
  }
  if (scenarios.length !== 12) throw new Error(`expected 12 adversarial scenarios, got ${scenarios.length}`);

  const manifest = {
    experiment: "reproducer-v1",
    frozen_at: new Date().toISOString(),
    code_version: codeVersion,
    freeze_rules:
      "Adversarial definitions, corpus criteria, algorithms, scoring, and gates below are " +
      "frozen before headline execution. After the headline run starts, changes are allowed " +
      "only for a demonstrated harness correctness defect, and substantive changes invalidate " +
      "the affected cohort (reported, not silently re-frozen).",
    adversarial_cohort: { scenarios },
    reducer_algorithms: {
      GREEDY: {
        description: "Deterministic single-pass single-atom deletion over the frozen atom order.",
        implementation: "V0 greedyReduce (hash pinned in frozen_v0_modules).",
      },
      DDMIN: {
        description:
          "Deterministic delta debugging: complement/subset chunk tests with granularity " +
          "doubling, then a greedy fixpoint sweep (1-minimal result).",
        implementation: "V0 ddminReduce (hash pinned in frozen_v0_modules).",
      },
      structured_reduction: "EXPLORATORY ONLY, excluded from headline comparison (see report).",
    },
    frozen_v0_modules: frozenV0Modules,
    scoring_semantics: {
      version: 1,
      recall: "1 iff all `must` ids retained AND (>=1 `any_of` core retained when non-empty), else 0.",
      irrelevant_removal: "removed irrelevant / total irrelevant, irrelevant = atoms outside must+any_of.",
      locally_minimal: "every kept atom has a failing single-removal trial under the same reducer.",
      predicate: "exact FailureFingerprint hash equality; all else rejects.",
    },
    real_bug_eligibility: {
      purpose: "Historical bugs independent of this experiment, within the V1 single-process boundary.",
      require: [
        "Bug predates this experiment.",
        "Identifiable buggy revision (BUG_REV) and later repaired revision (POST_REV).",
        "Externally observable incorrect behavior described by a report or regression test.",
        "Single-process backend/library behavior exercisable deterministically from a bounded entry point.",
        "Local deterministic trigger plausibly constructible without production credentials.",
      ],
      prefer: [
        "Input edge cases, config combinations, serialization/parsing, API responses, data-state edges, time boundaries, cache/state transitions, dependency-response behavior.",
        "Cases requiring non-trivial fixture/boundary setup (not only tiny unit tests).",
      ],
      exclude: [
        "Pure formatting/type-only bug with no runtime behavior.",
        "Build-system-only failure (unless a real runtime compatibility incident).",
        "Distributed scheduling outside the V1 boundary.",
        "Unavailable external service credentials required.",
        "Reproducer necessarily includes the repaired patch.",
        "Insufficient evidence for buggy/repaired revisions.",
      ],
      integrity: [
        "bug-corpus.json (with exclusions) frozen before reduction runs.",
        "No eligible failure dropped from the denominator because reduction fails.",
        "No corpus tuning after outcomes.",
      ],
    },
    supported_v1_boundary: {
      languages: ["TypeScript", "JavaScript"],
      runtime: "Node.js 22+",
      application_shape: "single-process backend or library behavior exercisable deterministically from a bounded entry point",
      supported_inputs: [
        "request/function input", "environment/config", "clock", "randomness",
        "filesystem fixture inside isolated temp directory",
        "database-like state through a bounded experiment adapter",
        "external HTTP/service responses through a bounded experiment adapter",
        "ordered boundary-call sequence",
      ],
      out_of_scope: [
        "true distributed race bugs", "multi-host consensus failures", "kernel bugs",
        "native-code nondeterminism", "browser-only rendering bugs",
        "unbounded production databases", "bugs requiring private production secrets",
        "bugs reproducible only inside a complete remote deployment",
      ],
    },
    hard_gates: {
      adversarial: [
        "12/12 full adversarial captures reproduce before reduction.",
        "0 wrong-failure acceptances.",
        ">=10/12 DDMIN reduced artifacts replay 20/20 portably.",
        "100% causal recall on successful adversarial reductions.",
        ">=1 scenario where DDMIN finds a smaller valid reproducer than frozen GREEDY.",
      ],
      real_bugs: [
        ">=10 eligible real historical bugs in frozen corpus.",
        ">=8 viable deterministic full captures (else weak boundary coverage).",
        "0 wrong-failure acceptances.",
        ">=60% of full-capture-supported bugs produce portable reduced reproducers.",
        ">=80% of successful reduced reproducers preserve exact fingerprint 20/20.",
        ">=80% of evaluable repaired revisions no longer show the original failure.",
      ],
    },
    usefulness_targets: [
      "Median real-bug atom reduction >= 50%.",
      "Median real-bug byte reduction >= 50%.",
      "Median reducer runtime <= 5 s for supported corpus.",
      "No successful real reproducer requires live network.",
      "Median manual full-capture setup burden plausibly automatable (report actuals).",
    ],
    decision_rules: {
      CONTINUE: "Adversarial reduction exact+safe; >=60% of supported real bugs become portable reduced reproducers with buggy-vs-repaired discrimination; fixture burden plausibly automatable.",
      MODIFY: "Primitive strong for a clear subset; narrow the thesis.",
      KILL: "Topology breaks correctness, real bugs rarely reduce portably, revisions indistinguishable, or capture burden dwarfs reduction value.",
      INVALID_EXPERIMENT: "Corpus tuned after outcomes, repaired-patch/causal-label leakage, wrong failures accepted, live deps used, or frozen protocol substantively changed after results.",
      BLOCKED_V0_PROTOCOL: "Already cleared in V1 Phase 0 (see V0 REPORT Appendix A).",
    },
  };

  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "V1-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const hash = hashJson(manifest);
  writeFileSync(join(root, "results", "v1-manifest.hash"), `${hash}\n`);
  console.log(`froze ${scenarios.length} adversarial scenarios, manifest hash ${hash}`);
}

main();
