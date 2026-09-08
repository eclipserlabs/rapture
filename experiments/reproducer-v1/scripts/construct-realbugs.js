// Phase 4: build full captures for frozen real-bug cases (buggy revision only).
// For each case in bug-corpus.json: load impl/buggy (must be vendored first),
// build the full capture (validates the incident reproduces in-process),
// embed impl bytes, write the capture doc, and verify 20/20 fresh-process
// replay via replay-single-v1.js. Failures here mark a case
// UNSUPPORTED_OR_UNREPRODUCIBLE (never a reducer failure).
// Usage: node construct-realbugs.js [case_id...]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v0src = join(root, "..", "reproducer-v0", "src");
const { buildFullCapture, verifyCaptureHash } = await import(join(v0src, "capture.js"));
const { canonicalBytes, hashJson } = await import(join(v0src, "canonical.js"));
const { loadCase, implRequireFor } = await import(join(root, "real-bugs", "lib", "v1real.js"));

const REPLAYS = 20;
const REPLAY_SINGLE = join(root, "scripts", "replay-single-v1.js");

function readTree(dir) {
  const files = execSync(`find '${dir}' -type f | sort`, { encoding: "utf8" }).split("\n").filter(Boolean);
  const map = {};
  for (const f of files) map[f.slice(dir.length + 1)] = readFileSync(f, "utf8");
  return map;
}

function replayFresh(jsonFile) {
  const cwd = mkdtempSync(join(tmpdir(), "reprov1-rb-"));
  const r = spawnSync(process.execPath, [REPLAY_SINGLE, jsonFile], { cwd, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return { ok: false, match: false, error: (r.stderr || r.stdout || "").slice(0, 300) };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, match: out.match === true, liveEffects: out.live_effect_attempts ?? 0 };
  } catch (err) {
    return { ok: false, match: false, error: String(err).slice(0, 300) };
  }
}

async function main() {
  process.env["TZ"] = "UTC"; // determinism control, see replay-single-v1.js
  const only = process.argv.slice(2);
  const corpus = JSON.parse(readFileSync(join(root, "real-bugs", "bug-corpus.json"), "utf8"));
  const outDir = join(root, "results", "real-bugs");
  mkdirSync(outDir, { recursive: true });
  const summary = [];
  for (const entry of corpus.cases) {
    if (only.length > 0 && !only.includes(entry.case_id)) continue;
    console.log(`--- ${entry.case_id} ---`);
    const caseDir = join(root, "real-bugs", entry.case_id);
    const implDir = join(caseDir, "impl", "buggy");
    if (!existsSync(join(implDir, "impl-manifest.json"))) {
      console.log(`SKIP: impl/buggy not vendored for ${entry.case_id}`);
      summary.push({ case_id: entry.case_id, status: "NOT_VENDORED" });
      continue;
    }
    const caseMod = await import(join(caseDir, "case.js"));
    const scenario = caseMod.createScenario(implRequireFor(implDir, caseMod.IMPL_ENTRY));
    let capture;
    try {
      ({ capture } = buildFullCapture(scenario, entry.bug_rev));
    } catch (err) {
      console.log(`FULL-CAPTURE FAIL: ${err.message}`);
      summary.push({ case_id: entry.case_id, status: "UNSUPPORTED_OR_UNREPRODUCIBLE", reason: String(err).slice(0, 300) });
      continue;
    }
    if (!verifyCaptureHash(capture)) throw new Error("capture hash unverifiable");
    const implFiles = readTree(implDir);
    const doc = {
      kind: "real-bug-capture",
      ...capture,
      scenario_id: entry.case_id,
      case_id: entry.case_id,
      impl_entry: caseMod.IMPL_ENTRY,
      impl_files: implFiles,
      state_bytes: canonicalBytes({
        input: capture.input,
        boundary_events: capture.boundary_events,
        db_rows: capture.db_rows,
        config: capture.config,
        failure_fingerprint: capture.failure_fingerprint,
      }),
    };
    doc.doc_hash = hashJson({ ...doc, doc_hash: undefined, impl_files: Object.keys(implFiles).sort() });
    const file = join(outDir, `capture-${entry.case_id}.json`);
    writeFileSync(file, `${JSON.stringify(doc)}\n`);
    const runs = [];
    for (let i = 0; i < REPLAYS; i += 1) runs.push(replayFresh(file));
    const matches = runs.filter((r) => r.ok && r.match).length;
    const live = runs.reduce((n, r) => n + (r.liveEffects ?? 0), 0);
    console.log(`full replay ${matches}/${REPLAYS} live=${live}`);
    summary.push({
      case_id: entry.case_id,
      status: matches === REPLAYS ? "SUPPORTED" : "UNSUPPORTED_OR_UNREPRODUCIBLE",
      full_matches: matches,
      live_effects: live,
      state_bytes: doc.state_bytes,
      impl_bytes: Object.values(implFiles).reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0),
      impl_files: Object.keys(implFiles).length,
    });
  }
  // Merge with previous construction rows so filtered re-runs do not drop cases.
  let prev = [];
  try {
    prev = JSON.parse(readFileSync(join(outDir, "construction.json"), "utf8"));
  } catch {
    prev = [];
  }
  const merged = new Map(prev.map((r) => [r.case_id, r]));
  for (const r of summary) merged.set(r.case_id, r);
  const ordered = corpus.cases.map((e) => merged.get(e.case_id)).filter(Boolean);
  writeFileSync(join(outDir, "construction.json"), `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(JSON.stringify(ordered, null, 2));
}

await main();
