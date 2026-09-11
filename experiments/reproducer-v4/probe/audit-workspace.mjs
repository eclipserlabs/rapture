// Machine-checked leakage audit of a built workspace. Run BEFORE every subject
// run. A failure aborts the run; the run does not count.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { byId } from "./cases.mjs";

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const c = byId(arg("--case"));
const ws = arg("--ws");
const arm = arg("--arm");

const checks = [];
const check = (name, pass, detail) => checks.push({ check: name, pass: !!pass, detail });

// --- git history -------------------------------------------------------------
const g = (...a) => spawnSync("git", a, { cwd: join(ws, "repo"), encoding: "utf8" });
const count = g("rev-list", "--count", "--all").stdout.trim();
check("git_single_commit", count === "1", `commits=${count}`);
const remotes = g("remote", "-v").stdout.trim();
check("git_no_remote", remotes === "", `remotes=${JSON.stringify(remotes)}`);
const allRefs = g("log", "--all", "--oneline").stdout.trim().split("\n").filter(Boolean);
check("git_no_future_history", allRefs.length === 1, `refs=${allRefs.length}`);

// --- forbidden strings anywhere in the workspace ------------------------------
// The historical fixing revision, the issue identifier, and the upstream commit
// subject must not appear. node_modules and the vendored replay runtime are
// scanned too -- exclusion by convenience would defeat the point.
// Precise needles only. A bare issue number matches unrelated content in
// node_modules and would make the audit cry wolf.
const needles = [c.fixed.replace(/^[a-z]+-/, ""), c.id, `#${c.id.split("-")[1]}`];
const forbidden = [];
const skipDirs = new Set([".git"]);
// The vendored replay runtime is frozen V3.3 machinery; it is scanned for
// forbidden strings like everything else, but its own file NAMES are not
// evidence of a leak (see the name scan below).
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.size > 2_000_000) continue;
    let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
    // Third-party changelogs legitimately contain bare "#1998"-style PR
    // references. Inside node_modules only the strong needle -- the fixing
    // revision sha -- is treated as leakage; everywhere else, all needles.
    const inVendor = p.includes(`${"/"}node_modules${"/"}`);
    for (const n of inVendor ? [needles[0]] : needles) {
      if (n && n.length >= 4 && text.includes(n)) forbidden.push({ file: relative(ws, p), needle: n });
    }
  }
};
walk(ws);
check("no_fixing_revision_or_issue_id_in_workspace", forbidden.length === 0,
      forbidden.slice(0, 6));

// --- evaluator isolation ------------------------------------------------------
// Name-based scanning is scoped to workspace-authored content: `repo/node_modules`
// contains unrelated files whose names match these words, and `.repro/rt` is the
// frozen V3.3 replay runtime whose fingerprint oracle is part of the artifact
// mechanism, not the hidden generalization evaluator.
const oracleHits = [];
const skipScan = new Set([join(ws, "repo", "node_modules"), join(ws, ".repro", "rt")]);
const scanNames = (dir) => {
  if (skipScan.has(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (/hidden|evaluat|answer|solution|variant/i.test(e.name)) oracleHits.push(relative(ws, p));
    if (e.isDirectory()) scanNames(p);
  }
};
scanNames(ws);
check("no_hidden_evaluator_material", oracleHits.length === 0, oracleHits.slice(0, 8));

// The substantive check: the hidden variants' own identifiers must not appear
// anywhere in the workspace, including inside node_modules and the runtime.
const variantNeedles = [...c.hidden_variants.map((v) => v.path), ...c.hidden_variants.map((v) => v.name), "x-expect-host"];
const variantHits = [];
const walkFor = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walkFor(p); continue; }
    if (!e.isFile()) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.size > 2_000_000) continue;
    let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const n of variantNeedles) if (text.includes(n)) variantHits.push({ file: relative(ws, p), needle: n });
  }
};
walkFor(ws);
check("no_hidden_variant_identifiers", variantHits.length === 0, variantHits.slice(0, 6));

// --- arm difference -----------------------------------------------------------
const hasRepro = existsSync(join(ws, "repro")) && existsSync(join(ws, ".repro"));
check("arm_repro_presence_matches", arm === "TREATMENT" ? hasRepro : !hasRepro,
      `arm=${arm} repro_present=${hasRepro}`);

// --- dependencies pre-provisioned (the container has no network) --------------
check("dependencies_preprovisioned", existsSync(join(ws, "repo", "node_modules")),
      "repo/node_modules present");

const pass = checks.every((x) => x.pass);
console.log(JSON.stringify({ schema: "v4-probe-workspace-audit-1", case: c.id, arm, ws,
                             checks, workspace_audit_pass: pass }, null, 2));
process.exit(pass ? 0 : 1);
