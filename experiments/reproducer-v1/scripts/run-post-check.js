// Phase 6: buggy-vs-repaired discrimination. ONLY this script may touch
// repaired-revision implementations. For each REDUCED_PORTABLE artifact it
// rebuilds the doc with repaired-revision impl bytes (same reduced data),
// runs it fresh-process 5x, and classifies:
//   FIX_CONFIRMED     - original fingerprint absent on all runs, clean behavior
//   FIX_NOT_CONFIRMED - original fingerprint still reproduces
//   FIX_INCONCLUSIVE  - non-match but via harness/setup/other failure
// Usage: node run-post-check.js [case_id...]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const RUNS = 5;
const REPLAY_SINGLE = join(root, "scripts", "replay-single-v1.js");

function readTree(dir) {
  const files = execSync(`find '${dir}' -type f | sort`, { encoding: "utf8" }).split("\n").filter(Boolean);
  const map = {};
  for (const f of files) map[f.slice(dir.length + 1)] = readFileSync(f, "utf8");
  return map;
}

function replayFresh(jsonFile) {
  const cwd = mkdtempSync(join(tmpdir(), "reprov1-post-"));
  const r = spawnSync(process.execPath, [REPLAY_SINGLE, jsonFile], { cwd, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "").slice(0, 200) };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, match: out.match === true, kind: out.fingerprint?.failure_kind, code: out.fingerprint?.error_code };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

async function main() {
  const only = process.argv.slice(2);
  const outDir = join(root, "results", "real-bugs");
  const reduction = JSON.parse(readFileSync(join(outDir, "reduction.json"), "utf8"));
  const rows = [];
  for (const r of reduction) {
    if (only.length > 0 && !only.includes(r.case_id)) continue;
    if (r.status !== "REDUCED_PORTABLE") {
      rows.push({ case_id: r.case_id, status: r.status, discrimination: "NOT_EVALUABLE" });
      continue;
    }
    console.log(`--- ${r.case_id} ---`);
    const artifact = JSON.parse(readFileSync(join(outDir, `artifact-${r.case_id}.ddmin.json`), "utf8"));
    const postDir = join(root, "real-bugs", r.case_id, "impl", "post");
    const postDoc = {
      ...artifact,
      kind: "real-bug-artifact",
      code_version: `${artifact.code_version}->repaired`,
      impl_files: readTree(postDir),
    };
    delete postDoc.artifact_hash;
    const { hashJson } = await import(join(root, "..", "reproducer-v0", "src", "canonical.js"));
    postDoc.artifact_hash = `repaired-run:${hashJson({ ...postDoc })}`;
    const pf = join(outDir, `postcheck-${r.case_id}.json`);
    writeFileSync(pf, `${JSON.stringify(postDoc)}\n`);
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) runs.push(replayFresh(pf));
    const matches = runs.filter((x) => x.ok && x.match).length;
    const kinds = [...new Set(runs.map((x) => (x.ok ? x.kind : `SPAWN:${x.error}`)))];
    let discrimination;
    if (matches === RUNS) discrimination = "FIX_NOT_CONFIRMED";
    else if (matches === 0 && kinds.length === 1 && kinds[0] === "NO_FAILURE") discrimination = "FIX_CONFIRMED";
    else discrimination = "FIX_INCONCLUSIVE";
    rows.push({ case_id: r.case_id, status: r.status, discrimination, post_matches: matches, post_kinds: kinds });
    console.log(`${r.case_id}: matches ${matches}/${RUNS} kinds=${kinds.join(",")} -> ${discrimination}`);
  }
  writeFileSync(join(outDir, "discrimination.json"), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(JSON.stringify(rows, null, 2));
}

await main();
