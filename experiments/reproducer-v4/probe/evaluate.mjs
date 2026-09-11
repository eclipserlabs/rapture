// Hidden evaluator. Runs on the HOST, never inside the subject container and
// never inside a subject workspace. Invoked ONLY after the subject agent
// process has terminated. Returns no feedback to any agent.
//
// Modes:
//   --validate <caseId>          validate the oracle on buggy and fixed revisions
//   --evaluate <caseId> --repo <path>   classify a submitted worktree
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { byId, CORPUS, PG_ENTRY, V3H } from "./cases.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NODE = process.execPath;
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(entry, repoRoot, port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, REPO_ROOT: repoRoot, PORT: String(port),
                  FAKE_ORIGIN: process.env["FAKE_ORIGIN"] ?? "http://localhost:47109", ...extraEnv };
    const child = spawn(NODE, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`READY timeout: ${out.slice(-400)}`)); }, 30000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exit ${c}: ${out.slice(-400)}`)); });
  });
}

const get = (port, path, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers })
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .catch((e) => ({ status: 0, body: "FETCH_ERR " + String(e?.message ?? e).slice(0, 120) }));

// Absolute-form request target cannot be expressed with fetch; raw socket only.
const rawAbsolute = (port, target, headers = {}) => new Promise((res) => {
  const lines = [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
                 ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), `Connection: close`];
  const s = net.connect(port, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
  let buf = "";
  s.on("data", (d) => (buf += d));
  s.on("close", () => {
    const m = (buf.split("\r\n")[0] || "").match(/ (\d{3}) /);
    res({ status: m ? Number(m[1]) : 0, body: (buf.split("\r\n\r\n")[1] || "").slice(0, 400) });
  });
  s.on("error", (e) => res({ status: 0, body: "SOCK_ERR " + e.message }));
});

async function fireOriginal(c, port) {
  if (c.trigger.kind === "raw-absolute") return rawAbsolute(port, c.trigger.path);
  return get(port, c.trigger.path);
}

// The original historical failure is ABSENT when the service no longer reports
// the incident's error code. Presence of that code means the bug remains.
const originalFailurePresent = (c, r) => r.status === 500 && String(r.body).includes(c.code);

async function fireHidden(c, port) {
  const rows = [];
  for (const v of c.hidden_variants) {
    const r = v.expect_host
      ? await rawAbsolute(port, v.path, { "x-expect-host": v.expect_host })
      : await get(port, v.path);
    const pass = v.expect_status ? r.status === v.expect_status : r.status === 200;
    rows.push({ variant: v.name, status: r.status, pass, body: String(r.body).slice(0, 220) });
  }
  return rows;
}

function regression(repoRoot, cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: repoRoot, encoding: "utf8", timeout: 300000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { exit: r.status, pass: r.status === 0, tail: out.trim().split("\n").slice(-12).join("\n") };
}

async function assess(c, repoRoot, basePort, opts = {}) {
  const res = { repo: repoRoot };
  let child = await start(join(V3H, "services", c.service), repoRoot, basePort);
  try {
    const r = await fireOriginal(c, basePort);
    res.original = { status: r.status, body: String(r.body).slice(0, 300) };
    res.original_failure_present = originalFailurePresent(c, r);
  } finally { child.kill("SIGKILL"); await sleep(300); }

  child = await start(join(HERE, "hidden", `${c.id}-hidden.mjs`), repoRoot, basePort + 1);
  try { res.hidden = await fireHidden(c, basePort + 1); } finally { child.kill("SIGKILL"); await sleep(300); }
  res.hidden_all_pass = res.hidden.every((h) => h.pass);

  if (opts.regression !== false) res.regression = regression(repoRoot, c.regression_command);
  return res;
}

const caseId = arg("--validate") ?? arg("--evaluate");
const c = byId(caseId);
const base = Number(arg("--port", "49820"));

if (arg("--validate")) {
  const buggy = await assess(c, join(CORPUS, c.buggy), base);
  const fixed = await assess(c, join(CORPUS, c.fixed), base + 10);
  const ok = buggy.original_failure_present && !buggy.hidden_all_pass
          && !fixed.original_failure_present && fixed.hidden_all_pass;
  console.log(JSON.stringify({
    schema: "v4-probe-oracle-validation-1", case: c.id,
    requirement: "buggy revision must FAIL the original incident and the hidden variants; the historical fixed revision must PASS both",
    buggy, fixed, oracle_valid: ok,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

// --evaluate: classify a submitted worktree.
const repoRoot = arg("--repo");
const r = await assess(c, repoRoot, base);
let classification;
if (r.original_failure_present) classification = "FALSE_FIX_ORIGINAL_FAILURE_REMAINS";
else if (!r.hidden_all_pass) classification = "FALSE_FIX_OVERFIT";
else if (r.regression && !r.regression.pass) classification = "REGRESSION_INTRODUCED";
else classification = "CORRECT_FIX";
console.log(JSON.stringify({ schema: "v4-probe-evaluation-1", case: c.id, classification, ...r }, null, 2));
