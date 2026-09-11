// Builds one sanitized subject workspace.
//
// Invariants enforced (and machine-checked by audit-workspace.mjs afterwards):
//   * the workspace contains ONLY the historical buggy snapshot
//   * a NEW single-commit git repository, no remote, no future history
//   * dependencies pre-provisioned on the host (the container has no network)
//   * no hidden evaluator, no oracle, no upstream fix data, no other run's output
//   * CONTROL and TREATMENT differ by exactly one thing: the .repro and its runner
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { byId, REPO, V3H } from "./cases.mjs";
import { vendor } from "./vendor-deps.mjs";
import { scrubComments } from "./scrub.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const c = byId(arg("--case"));
const arm = arg("--arm");                       // CONTROL | TREATMENT
const dest = arg("--out");                      // run workspace root (becomes /work)
const evidenceSrc = arg("--evidence");          // prebuilt, shared byte-identically by both arms
if (!["CONTROL", "TREATMENT"].includes(arm)) throw new Error(`--arm must be CONTROL or TREATMENT`);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

// --- 1. buggy snapshot, stripped of all git history --------------------------
const repoDst = join(dest, "repo");
mkdirSync(repoDst, { recursive: true });
// dereference MUST stay off: node_modules/.bin entries are relative symlinks
// into their packages, and copying them as plain files breaks every CLI shim
// (mocha, lab, borp) because the shim's own relative requires then resolve from
// .bin/ instead of the package directory.
// `cp -R` rather than fs.cpSync: symlinks must be preserved verbatim, because
// node_modules/.bin entries are relative links into their packages and copying
// them as plain files breaks every CLI shim (mocha, lab, borp). cpSync's
// symlink-preserving mode raises ERR_INTERNAL_ASSERTION on these trees.
{
  const r = spawnSync("cp", ["-R", `${c.buggyRoot}/.`, repoDst], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`snapshot copy failed: ${(r.stderr ?? "").slice(0, 300)}`);
}
rmSync(join(repoDst, ".git"), { recursive: true, force: true });
if (existsSync(join(repoDst, ".git"))) throw new Error(".git survived removal");

const git = (...a) => spawnSync("git", a, { cwd: repoDst, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "service@example.invalid");
git("config", "user.name", "Service Build");
git("add", "-A");
git("commit", "-q", "-m", "Initial import of the deployed revision");

// --- 2. the deployed application --------------------------------------------
// Service sources carry RESEARCH annotations: the issue number, the fixing
// revision sha, and a plain-language root-cause explanation. Copied verbatim
// they would hand the subject the answer. A contiguous run of `//` lines is
// treated as one block: if ANY line in the block mentions the historical bug the
// WHOLE block is dropped, because continuation lines carry the explanation
// without repeating the sha. Only comments are touched; no executable line is
// altered.
const appDst = join(dest, "app");
mkdirSync(appDst, { recursive: true });
writeFileSync(join(appDst, "server.mjs"), scrubComments(readFileSync(c.serviceEntry, "utf8")));
if (c.sharedEntry) writeFileSync(join(appDst, "shared.mjs"), scrubComments(readFileSync(c.sharedEntry, "utf8")));

// --- 3. conventional incident evidence (byte-identical across arms) ----------
for (const f of ["incident-evidence.json", "incident-evidence.md"]) {
  cpSync(join(evidenceSrc, f), join(dest, f));
}

// --- 4. TREATMENT ONLY: the frozen executable incident + its runner ----------
const treatment = arm === "TREATMENT";
if (treatment) {
  const rt = join(dest, ".repro", "rt");
  mkdirSync(join(rt, "experiments", "reproducer-v3", "headline"), { recursive: true });
  mkdirSync(join(rt, "packages", "kernel"), { recursive: true });
  // Frozen V3.3 replay semantics: V3.3's src tree verbatim, placed where the
  // replay entrypoint's own relative imports resolve to it.
  cpSync(join(V3H, "replay-raw.mjs"), join(rt, "experiments", "reproducer-v3", "headline", "replay-raw.mjs"));
  cpSync(join(REPO, "experiments", "reproducer-v3-3", "src"), join(rt, "experiments", "reproducer-v3", "src"), { recursive: true });
  cpSync(join(REPO, "packages", "kernel", "dist"), join(rt, "packages", "kernel", "dist"), { recursive: true });
  vendor(join(REPO, "packages", "kernel"), join(rt, "packages", "kernel", "node_modules"),
         join(REPO, "node_modules", ".pnpm"));
  cpSync(c.artifact, join(dest, ".repro", "incident.repro.json"));

  // The experiment-only runner. Two outcomes, nothing else. It exposes no
  // hidden generalization oracle and no historical fix information.
  const runner = `#!/usr/bin/env bash
# Experiment-only incident runner.
# Executes the captured production incident against the CURRENT worktree and
# reports whether the original failure is still present.
set -uo pipefail
OUT=$(node /work/.repro/rt/experiments/reproducer-v3/headline/replay-raw.mjs \\
  --app /work/app/server.mjs \\
  --capture /work/.repro/incident.repro.json \\
  --port 48999 \\
  --env '{"REPO_ROOT":"/work/repo","PGPORT":"54399","REPLAY_HOST":"127.0.0.1"}' 2>&1 | tail -1)

node -e '
const raw = process.argv[1];
let d = null; try { d = JSON.parse(raw); } catch {}
if (!d) { console.log("REPRO_RUNNER_ERROR"); console.log(raw.slice(0, 500)); process.exit(2); }
console.log(d.pass ? "ORIGINAL_FAILURE_REPRODUCED" : "ORIGINAL_FAILURE_ABSENT");
console.log("observed_http_status=" + (d.status ?? "none"));
' "$OUT"
`;
  writeFileSync(join(dest, "repro"), runner);
  chmodSync(join(dest, "repro"), 0o755);
}

const manifest = {
  case: c.id, arm, built_at: new Date().toISOString(),
  buggy_snapshot: c.buggyRoot,
  evidence_json_sha256: sha256File(join(dest, "incident-evidence.json")),
  evidence_md_sha256: sha256File(join(dest, "incident-evidence.md")),
  repro_present: treatment,
  repro_artifact_sha256: treatment ? sha256File(join(dest, ".repro", "incident.repro.json")) : null,
};
writeFileSync(join(HERE, "..", "results", "probe-calibration", `workspace-${c.id}-${arm}.json`),
              JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
