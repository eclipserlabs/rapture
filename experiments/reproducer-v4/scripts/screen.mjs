// V4 Stage 1 candidate screening.
//
// For each candidate: build buggy/fixed worktrees at the exact revisions,
// provision production dependencies, verify the historical failure is present
// on the buggy revision and absent on the fixed revision, then screen with the
// FROZEN V3.3 capture system and classify.
//
// Rapture is never modified. An unsupported case is recorded, not rescued.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V4 = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v4";
const REGISTER = "/Users/wira/Documents/rapture/rapture/experiments/reproducer-v3-3/src/capture/register.mjs";
const NODE = process.execPath;
const sh = (c, a, o = {}) => { try { return execFileSync(c, a, { encoding: "utf8", stdio: "pipe", ...o }); } catch (e) { return "ERR:" + String(e.message).slice(0, 120); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function worktrees(c) {
  const repo = join(V4, "repos-src", c.repo);
  const src = existsSync(repo) ? repo : c.repoPath;
  const buggy = join(V4, "work", `${c.id}-buggy`);
  const fixed = join(V4, "work", `${c.id}-fixed`);
  for (const [dir, rev] of [[buggy, c.fixSha + "^"], [fixed, c.fixSha]]) {
    if (!existsSync(dir)) sh("git", ["-C", src, "worktree", "add", "--detach", "--quiet", dir, rev]);
  }
  return { buggy, fixed,
    buggyRev: (sh("git", ["-C", buggy, "rev-parse", "--short", "HEAD"]) || "").trim(),
    fixedRev: (sh("git", ["-C", fixed, "rev-parse", "--short", "HEAD"]) || "").trim() };
}

function deps(dir, shareFrom) {
  if (existsSync(join(dir, "node_modules"))) return "present";
  if (shareFrom && existsSync(join(shareFrom, "node_modules"))) {
    try { symlinkSync(join(shareFrom, "node_modules"), join(dir, "node_modules")); return "shared"; } catch { /* fall through */ }
  }
  const r = sh("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], { cwd: dir, timeout: 300000 });
  return r.startsWith("ERR:") ? r : "installed";
}

function boot(c, repoRoot, port, captureEnv) {
  const env = { ...process.env, REPO_ROOT: repoRoot, PORT: String(port), ...(c.env ?? {}), ...(captureEnv ?? {}) };
  const args = captureEnv ? ["--import", REGISTER, join(root, "services", c.service)] : [join(root, "services", c.service)];
  const child = spawn(NODE, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => {
    let o = ""; const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("boot timeout: " + o.slice(-250))); }, 30000);
    child.stdout.on("data", (d) => { o += d; if (o.includes("READY")) { clearTimeout(t); res(child); } });
    child.stderr.on("data", (d) => { o += d; });
    child.on("exit", (code) => { clearTimeout(t); rej(new Error(`exit ${code}: ${o.slice(-250)}`)); });
  });
}

const results = [];
for (const c of CASES) {
  const row = { id: c.id, repository: c.repository, stack: c.stack, issue: c.issue, fixSha: c.fixSha, summary: c.summary };
  try {
    const w = worktrees(c);
    row.buggy_rev = w.buggyRev; row.fixed_rev = w.fixedRev;
    row.deps_buggy = deps(w.buggy);
    row.deps_fixed = deps(w.fixed, w.buggy);
    // 1. historical failure present on buggy
    let child = await boot(c, w.buggy, c.port);
    const b = await c.trigger(c.port);
    child.kill("SIGKILL"); await sleep(400);
    row.buggy_status = b.status; row.buggy_body = String(b.body ?? "").slice(0, 120);
    // 2. absent on fixed
    child = await boot(c, w.fixed, c.port + 1);
    const f = await c.trigger(c.port + 1);
    child.kill("SIGKILL"); await sleep(400);
    row.fixed_status = f.status; row.fixed_body = String(f.body ?? "").slice(0, 120);
    row.discriminates = c.discriminates(b, f);
    if (!row.discriminates) { row.classification = "CAPTURE_FAILURE"; row.reason = "buggy/fixed behaviour did not discriminate"; results.push(row); console.log(fmt(row)); continue; }
    // 3. screen with FROZEN V3.3
    const out = mkdtempSync(join(tmpdir(), "v4scr-"));
    child = await boot(c, w.buggy, c.port + 2, {
      RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: out,
      RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: c.routeKey,
    });
    await c.trigger(c.port + 2);
    await sleep(900); child.kill("SIGKILL"); await sleep(400);
    const files = readdirSync(out).filter((x) => x.endsWith(".json"));
    if (!files.length) { row.classification = "CAPTURE_FAILURE"; row.reason = "no artifact persisted"; }
    else {
      const doc = JSON.parse(readFileSync(join(out, files[0]), "utf8"));
      row.fingerprint_class = doc.fingerprint?.normalized_class ?? null;
      row.fingerprint_hash = (doc.fingerprint?.fingerprint_hash ?? "").slice(0, 16);
      row.events = (doc.events ?? []).length;
      row.event_kinds = [...new Set((doc.events ?? []).map((e) => e.kind))];
      row.offline_replay_supported = doc.offline_replay_supported;
      row.boundary_ops_outside_request = doc.boundary_ops_outside_request;
      if (doc.status === "PRIVACY_BLOCKED_SESSION_CREDENTIAL") { row.classification = "PRIVACY_BLOCKED"; row.reason = doc.reason; }
      else if (doc.unsupported_condition) { row.classification = "UNSUPPORTED_BOUNDARY"; row.reason = doc.unsupported_condition; }
      else if (!row.fingerprint_class) { row.classification = "CAPTURE_FAILURE"; row.reason = "no fingerprint inferred"; }
      else row.classification = "AUTO_CAPTURE_SUPPORTED";
    }
    rmSync(out, { recursive: true, force: true });
  } catch (e) {
    row.classification = "CAPTURE_FAILURE"; row.reason = String(e?.message ?? e).slice(0, 200);
  }
  results.push(row); console.log(fmt(row));
}
function fmt(r) {
  return `${(r.id||"").padEnd(18)} ${String(r.classification||"?").padEnd(23)} buggy=${String(r.buggy_status??"-").padEnd(4)} fixed=${String(r.fixed_status??"-").padEnd(4)} disc=${r.discriminates??"-"} ev=${r.events??"-"} ${r.fingerprint_class??""} ${r.reason?"| "+String(r.reason).slice(0,60):""}`;
}
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "screening.json"), JSON.stringify({
  schema: "v4-screening-1", generatedAt: new Date().toISOString(),
  frozen_capture: "V3.3 implementation 5416f2752c885bb8d61abd49888fc29a34e06b814ea278c551d2ebf291417f1d (unmodified)",
  manifest: "9ce3c4388a389e15ed84754bba2bd262af23ece5a3b700edc87bf8f7fc7d4f04",
  screened: results.length, results,
  counts: ["AUTO_CAPTURE_SUPPORTED","PRIVACY_BLOCKED","UNSUPPORTED_BOUNDARY","CAPTURE_FAILURE"]
    .reduce((a,k)=>{a[k]=results.filter(r=>r.classification===k).length;return a;},{}),
}, null, 2));
const counts = ["AUTO_CAPTURE_SUPPORTED","PRIVACY_BLOCKED","UNSUPPORTED_BOUNDARY","CAPTURE_FAILURE"].map(k=>`${k}=${results.filter(r=>r.classification===k).length}`);
console.log("\n" + counts.join("  "));
