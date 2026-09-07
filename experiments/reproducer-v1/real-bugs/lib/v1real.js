// Shared harness for V1 real-bug cases.
//
// A case directory real-bugs/<case_id>/ contains case.js exporting:
//   CASE_ID, IMPL_ENTRY (relpath of requireable entry inside materialized impl),
//   createScenario(implRequire) -> V0-style scenario (run closes over impl).
// Vendored implementation bytes travel INSIDE the artifact (impl_files) and are
// materialized to a fresh temp dir at replay; nothing is ever loaded from the
// original checkout or from the full-capture directory.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REALBUGS = join(here, "..");

export async function loadCase(caseId) {
  if (!/^[a-z0-9-]+$/.test(caseId)) throw new Error(`bad case id: ${caseId}`);
  return import(join(REALBUGS, caseId, "case.js"));
}

/** Write {relpath: content} into dir, creating parent directories. */
export function materializeImpl(implFiles, dir) {
  for (const [rel, content] of Object.entries(implFiles)) {
    if (rel.includes("..")) throw new Error(`unsafe impl path: ${rel}`);
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  // Force CJS interpretation for vendored .js (see vendor-impl.js): the
  // artifact must replay identically regardless of the host package scope.
  if (implFiles["package.json"] === undefined) {
    writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
  }
}

/** Build a require() rooted at the materialized impl dir. */
export function implRequireFor(dir, entryRel) {
  return createRequire(join(dir, entryRel));
}

/** Require the entry file through an impl-rooted require (basename form). */
export function requireEntry(implRequire, entryRel) {
  return implRequire(`./${entryRel.split("/").pop()}`);
}

/**
 * Replay entry shared by the fresh-process dispatcher and in-process trials.
 * candidate: {input, config, db, events} (V0 shapes). implFiles: vendored map.
 */
export async function runRealBugCandidate(caseId, candidate, implFiles, implEntry, tempDir, v0) {
  const implDir = join(tempDir, "impl");
  materializeImpl(implFiles, implDir);
  const implRequire = implRequireFor(implDir, implEntry);
  const caseMod = await loadCase(caseId);
  const scenario = caseMod.createScenario(implRequire);
  return v0.runCandidate(scenario.run, candidate, tempDir);
}
