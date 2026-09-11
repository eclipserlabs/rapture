// Hidden evaluator. Runs on the HOST, never inside the subject container and
// never inside a subject workspace. Invoked ONLY after the subject agent
// process has terminated. Returns no feedback to any agent.
//
//   --validate <caseId>                 validate the oracle on both revisions
//   --evaluate <caseId> --repo <path>   classify a submitted worktree
//   --baseline <caseId>                 record the regression baseline (buggy tree)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { byId } from "./cases.mjs";
import { compareToBaseline, runRegression } from "./regression.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const NODE = process.execPath;
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASELINES = join(HERE, "baselines");

function start(entry, repoRoot, port, c) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, REPO_ROOT: repoRoot, PORT: String(port) };
    if (c.needsPgAndExternal) env.FAKE_ORIGIN = process.env["FAKE_ORIGIN"] ?? "http://localhost:47109";
    const child = spawn(NODE, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`READY timeout: ${out.slice(-500)}`)); }, 45000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`exit ${code}: ${out.slice(-500)}`)); });
  });
}

// Absolute-form request targets cannot be expressed with fetch; raw socket only.
const rawAbsolute = (port, target, headers = {}) => new Promise((res) => {
  const lines = [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
                 ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), `Connection: close`];
  const s = net.connect(port, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
  let buf = "";
  s.on("data", (d) => (buf += d));
  s.on("close", () => {
    const m = (buf.split("\r\n")[0] || "").match(/ (\d{3}) /);
    res({ status: m ? Number(m[1]) : 0, body: (buf.split("\r\n\r\n")[1] || "").slice(0, 500) });
  });
  s.on("error", (e) => res({ status: 0, body: "SOCK_ERR " + e.message }));
});

async function fire(port, req) {
  if (req.absolute) return rawAbsolute(port, req.absolute, req.headers ?? {});
  const init = { method: req.method ?? "GET", headers: req.headers ?? {} };
  if (req.body != null) init.body = req.body;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${req.path}`, init);
    return { status: r.status, body: (await r.text()).slice(0, 500) };
  } catch (e) { return { status: 0, body: "FETCH_ERR " + String(e?.message ?? e).slice(0, 150) }; }
}

// The frozen CORRECT_FIX definition requires that the failure is "not merely
// replaced by an unrelated infrastructure/setup failure". A code-only check
// fails that: a patch that breaks the request in a NEW way still removes the
// original error code. The original incident therefore counts as resolved only
// when the request stops failing at all. Every historical fixed revision in
// this corpus returns a non-5xx status for its own trigger, so this is a
// strictly stronger rule, not a different one.
const originalFailurePresent = (c, r) => {
  const stillFailing = r.status === 0 || r.status >= 500;
  const exactCode = c.originalFailure.kind === "code"
    ? r.status >= 500 && String(r.body).includes(c.originalFailure.code)
    : r.status === c.originalFailure.status;
  return { present: stillFailing, exact_original_signature: exactCode };
};

async function assess(c, repoRoot, basePort, opts = {}) {
  const res = { repo: repoRoot };

  let child = await start(c.serviceEntry, repoRoot, basePort, c);
  try {
    const r = await fire(basePort, c.trigger);
    const of = originalFailurePresent(c, r);
    res.original = { status: r.status, body: String(r.body).slice(0, 300) };
    res.original_failure_present = of.present;
    res.original_exact_signature_present = of.exact_original_signature;
  } finally { child.kill("SIGKILL"); await sleep(400); }

  child = await start(c.hiddenEntry, repoRoot, basePort + 1, c);
  try {
    const rows = [];
    for (const v of c.hidden) {
      const r = await fire(basePort + 1, v);
      rows.push({ variant: v.name, status: r.status, pass: r.status === (v.expect_status ?? 200),
                  body: String(r.body).slice(0, 200) });
    }
    res.hidden = rows;
  } finally { child.kill("SIGKILL"); await sleep(400); }
  res.hidden_all_pass = res.hidden.every((h) => h.pass);

  if (opts.regression !== false) {
    res.regression = c.regressionStack
      ? runRegression(c.regressionStack, repoRoot)
      : (() => { const p = spawnSync(c.regressionCommand[0], c.regressionCommand.slice(1),
                     { cwd: repoRoot, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
                 return { supported: true, exit: p.status, failed: p.status === 0 ? 0 : 1,
                          failing: p.status === 0 ? [] : ["node --test non-zero exit"] }; })();
  }
  return res;
}

const caseId = arg("--validate") ?? arg("--evaluate") ?? arg("--baseline");
const c = byId(caseId);
const base = Number(arg("--port", "49820"));
mkdirSync(BASELINES, { recursive: true });
const baselineFile = join(BASELINES, `${c.id}.json`);

if (arg("--baseline")) {
  const run = (root) => c.regressionStack ? runRegression(c.regressionStack, root)
    : (() => { const p = spawnSync(c.regressionCommand[0], c.regressionCommand.slice(1),
                 { cwd: root, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
               return { supported: true, exit: p.status, failed: p.status === 0 ? 0 : 1,
                        failing: p.status === 0 ? [] : ["node --test non-zero exit"] }; })();
  const buggy = run(c.buggyRoot);
  const fixed = run(c.fixedRoot);
  // The baseline used for comparison is the UNMODIFIED BUGGY tree -- the tree
  // every subject actually starts from.
  writeFileSync(baselineFile, JSON.stringify({ schema: "v4-probe-regression-baseline-1", case: c.id,
    recorded_at: new Date().toISOString(), tree: c.buggyRoot, ...buggy,
    fixed_revision_reference: { tree: c.fixedRoot, total: fixed.total, failed: fixed.failed,
                                failing: (fixed.failing ?? []).slice(0, 20) } }, null, 2) + "\n");
  console.log(JSON.stringify({ case: c.id,
    buggy: { total: buggy.total, failed: buggy.failed, seconds: buggy.seconds },
    fixed: { total: fixed.total, failed: fixed.failed, seconds: fixed.seconds },
    buggy_failing: (buggy.failing ?? []).slice(0, 6) }, null, 2));
  process.exit(0);
}

if (arg("--validate")) {
  // Oracle validity is about the original incident and the hidden variants.
  // The repository suite is handled separately by --baseline, which records the
  // pre-existing failures on BOTH revisions.
  const buggy = await assess(c, c.buggyRoot, base, { regression: false });
  const fixed = await assess(c, c.fixedRoot, base + 10, { regression: false });
  const ok = buggy.original_failure_present && !buggy.hidden_all_pass
          && !fixed.original_failure_present && fixed.hidden_all_pass;
  console.log(JSON.stringify({
    schema: "v4-probe-oracle-validation-1", case: c.id,
    requirement: "the buggy revision must FAIL the original incident and the hidden variants; the historical fixed revision must PASS both",
    buggy, fixed, oracle_valid: ok,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

// --evaluate: classify a submitted worktree.
const repoRoot = arg("--repo");
const r = await assess(c, repoRoot, base);
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
r.regression_comparison = compareToBaseline(baseline, r.regression);

let classification;
if (r.original_failure_present) {
  classification = r.original_exact_signature_present
    ? "FALSE_FIX_ORIGINAL_FAILURE_REMAINS"
    : "FALSE_FIX_ORIGINAL_FAILURE_REMAINS";   // replaced by a different 5xx: still not repaired
  r.original_failure_note = r.original_exact_signature_present
    ? "the original incident signature is still produced"
    : "the original signature is gone but the request still fails with a different 5xx, which the frozen rule does not count as a fix";
}
else if (!r.hidden_all_pass) classification = "FALSE_FIX_OVERFIT";
else if (r.regression_comparison.regression === true) classification = "REGRESSION_INTRODUCED";
else if (r.regression_comparison.comparable === false) classification = "INVALID_HARNESS";
else classification = "CORRECT_FIX";
console.log(JSON.stringify({ schema: "v4-probe-evaluation-1", case: c.id, classification, ...r }, null, 2));
