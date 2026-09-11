// One subject repair run, end to end:
//   preflight -> build workspace -> workspace leakage audit -> fresh container
//   -> subject agent under a fixed wall-clock budget -> agent terminates
//   -> hidden evaluation on the host -> record
//
// The hidden evaluator never runs while the agent is alive and never returns
// anything to it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byId, REPO } from "./cases.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const ISO = join(REPO, "experiments", "reproducer-v4", "isolation");
const NODE = process.execPath;
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

const c = byId(arg("--case"));
const arm = arg("--arm");
const label = arg("--label", `${c.id}-${arm}`);
const budget = Number(arg("--budget", "1200"));
const evidence = arg("--evidence");
const outDir = arg("--results", join(HERE, "..", "results", "probe-calibration"));
const ws = join(REPO, ".rapture", "reproducer-v4", "probe-runs", label);
const MODEL = "opencode/muse-spark-1.3-contributor-free";
const CONTAINER = `v4-run-${label}`;

const PROMPT_CORE = [
  "You are repairing a production backend bug.",
  "The supplied repository is the buggy production revision.",
  "Use the supplied incident evidence and repository to identify and fix the bug.",
  "You may inspect and modify application code and run available local tests.",
  "Do not use the internet or search for the historical issue/fix.",
  "Do not modify files outside the supplied repository.",
  "Do not disable tests merely to obtain green output.",
  "When you believe the bug is fixed, stop and provide a concise final report containing root cause, files changed, validation performed and remaining uncertainty.",
];
const PROMPT_TREATMENT = [
  "An executable incident artifact is available in the workspace.",
  "You may run it using the supplied experiment-only repro command against the current working tree.",
  "It reproduces the original production failure when that failure is present.",
];
const WORKSPACE_NOTE = [
  "",
  "Workspace layout:",
  "  /work/repo                    the deployed repository (this is the code you change)",
  "  /work/app                     the deployed service that fails",
  "  /work/incident-evidence.md    the incident report",
  "  /work/incident-evidence.json  the same incident as structured data",
];
const TREATMENT_NOTE = ["  /work/repro                   run the executable incident against /work/repo"];

const prompt = [
  ...PROMPT_CORE,
  ...(arm === "TREATMENT" ? PROMPT_TREATMENT : []),
  ...WORKSPACE_NOTE,
  ...(arm === "TREATMENT" ? TREATMENT_NOTE : []),
].join("\n");

mkdirSync(outDir, { recursive: true });
const record = { schema: "v4-probe-run-1", label, case: c.id, arm, model: MODEL,
                 budget_seconds: budget, started_at: new Date().toISOString() };

const MOUNTS = [
  "-v", `${ws}:/work`,
  "-v", `${join(ISO, "subject-auth")}:/isolated/data/opencode`,
  // The deployed service resolves its Postgres driver through this path. Only
  // the pg dependency closure is exposed, read-only, identically in both arms.
  "-v", `${join(HERE, "vendor", "reproducer-v2", "node_modules")}:/reproducer-v2/node_modules:ro`,
];

const step = (name, res) => {
  record[name] = { exit: res.status, ok: res.status === 0 };
  if (res.status !== 0) record[name].detail = `${res.stdout ?? ""}${res.stderr ?? ""}`.slice(-1200);
  return res.status === 0;
};

// --- 1. preflight -------------------------------------------------------------
const pf = spawnSync(NODE, [join(HERE, "preflight.mjs"), "--mounts", MOUNTS.join(" ")],
                     { encoding: "utf8", timeout: 300000 });
record.preflight = (() => { try { return JSON.parse(pf.stdout); } catch { return { preflight_pass: false, raw: pf.stdout + pf.stderr }; } })();
if (!record.preflight.preflight_pass) {
  record.classification = "INVALID_HARNESS";
  record.invalid_reason = "preflight failed";
  writeFileSync(join(outDir, `run-${label}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ label, classification: record.classification }, null, 2));
  process.exit(1);
}

// --- 2. workspace + leakage audit --------------------------------------------
if (!step("build_workspace", spawnSync(NODE, [join(HERE, "build-workspace.mjs"),
    "--case", c.id, "--arm", arm, "--out", ws, "--evidence", evidence],
    { encoding: "utf8", timeout: 600000 }))) throw new Error("workspace build failed");

const wa = spawnSync(NODE, [join(HERE, "audit-workspace.mjs"), "--case", c.id, "--arm", arm, "--ws", ws],
                     { encoding: "utf8", timeout: 600000 });
record.workspace_audit = (() => { try { return JSON.parse(wa.stdout); } catch { return { workspace_audit_pass: false, raw: wa.stdout + wa.stderr }; } })();
if (!record.workspace_audit.workspace_audit_pass) {
  record.classification = "INVALID_HARNESS";
  record.invalid_reason = "workspace leakage audit failed";
  writeFileSync(join(outDir, `run-${label}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ label, classification: record.classification }, null, 2));
  process.exit(1);
}

// --- 3. fresh container, fresh agent session ----------------------------------
spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
const proxyLinesBefore = Number(spawnSync("docker", ["exec", "v4-proxy", "sh", "-c", "wc -l < /var/log/squid/access.log"],
  { encoding: "utf8" }).stdout.trim() || "0");

step("container_start", spawnSync("docker", ["run", "-d", "--name", CONTAINER,
  "--network", "v4-subject-net", "--hostname", "subject",
  "-e", "HTTPS_PROXY=http://10.83.0.10:3128", "-e", "HTTP_PROXY=http://10.83.0.10:3128",
  "-e", "ALL_PROXY=http://10.83.0.10:3128", "-e", "https_proxy=http://10.83.0.10:3128",
  "-e", "http_proxy=http://10.83.0.10:3128", "-e", "NO_PROXY=localhost,127.0.0.1",
  ...MOUNTS, "v4-subject-image", "sleep", "infinity"], { encoding: "utf8", timeout: 300000 }));

const t0 = Date.now();
const agent = spawnSync("docker", ["exec", "-w", "/work", CONTAINER,
  "timeout", String(budget), "opencode", "run", "--auto", "--dir", "/work", "-m", MODEL, prompt],
  { encoding: "utf8", timeout: (budget + 180) * 1000, maxBuffer: 64 * 1024 * 1024 });
record.agent_seconds = Math.round((Date.now() - t0) / 10) / 100;
record.agent_exit = agent.status;
record.agent_timed_out = agent.status === 124;

const trace = `${agent.stdout ?? ""}\n----- stderr -----\n${agent.stderr ?? ""}`;
const traceFile = join(outDir, `trace-${label}.log`);
writeFileSync(traceFile, trace);
record.trace_file = `results/probe-calibration/trace-${label}.log`;
record.trace_bytes = trace.length;

// Agent terminated. Only now does anything evaluative happen.
spawnSync("docker", ["stop", "-t", "5", CONTAINER], { encoding: "utf8" });

// --- 4. behavioural observations from the trace -------------------------------
const strip = (s) => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
const clean = strip(trace);
record.observations = {
  repro_invocations: (clean.match(/\/work\/repro\b|(^|\s)\.\/repro\b/gm) ?? []).length,
  repro_outcome_lines: (clean.match(/ORIGINAL_FAILURE_(REPRODUCED|ABSENT)/g) ?? []),
  test_invocations: (clean.match(/node --test|npm test|npm run test/g) ?? []).length,
  network_attempt_markers: (clean.match(/ENETUNREACH|EAI_AGAIN|403 Forbidden|CONNECT tunnel failed|Proxy tunneling failed|NO_WEB_ACCESS|FETCH_FAILED/g) ?? []).length,
  webfetch_or_search_attempts: (clean.match(/WebFetch|Exa Web Search|websearch/gi) ?? []).length,
};

// --- 5. diff the submitted worktree ------------------------------------------
const gdiff = spawnSync("git", ["diff", "--stat"], { cwd: join(ws, "repo"), encoding: "utf8" });
record.patch_stat = gdiff.stdout.trim();
record.patch_empty = gdiff.stdout.trim() === "";
writeFileSync(join(outDir, `patch-${label}.diff`),
              spawnSync("git", ["diff"], { cwd: join(ws, "repo"), encoding: "utf8" }).stdout);

// --- 6. proxy audit trail for this run ---------------------------------------
const proxyLog = spawnSync("docker", ["exec", "v4-proxy", "sh", "-c",
  `tail -n +${proxyLinesBefore + 1} /var/log/squid/access.log`], { encoding: "utf8" }).stdout;
writeFileSync(join(outDir, `proxy-${label}.log`), proxyLog);
const hosts = {};
for (const line of proxyLog.split("\n")) {
  const f = line.split(/\s+/);
  if (f.length < 7) continue;
  const key = `${line.includes("TCP_TUNNEL") ? "ALLOWED" : "DENIED"} ${f[6]}`;
  hosts[key] = (hosts[key] ?? 0) + 1;
}
record.proxy_attempts = hosts;
record.proxy_denied_non_provider = Object.keys(hosts).some((k) => k.startsWith("DENIED") && !/opencode\.ai/.test(k));

// --- 7. hidden evaluation (host, after termination only) ----------------------
if (record.patch_empty && record.agent_timed_out) {
  record.classification = "TIMEOUT_NO_FIX";
} else {
  const ev = spawnSync(NODE, [join(HERE, "evaluate.mjs"), "--evaluate", c.id, "--repo", join(ws, "repo"),
                              "--port", String(49900 + (process.pid % 40))],
                       { encoding: "utf8", timeout: 900000 });
  record.evaluation = (() => { try { return JSON.parse(ev.stdout); } catch { return { classification: "INVALID_HARNESS", raw: (ev.stdout + ev.stderr).slice(-1500) }; } })();
  record.classification = record.evaluation.classification;
  if (record.patch_empty && record.classification !== "CORRECT_FIX") record.classification = "AGENT_ABORTED_NO_PATCH";
}

// Workspace retention. Each workspace is ~60 MB and 20 headline runs would
// need ~1.2 GB simultaneously, which this host does not have. Everything the
// audit needs -- the submitted patch, the full trace, the proxy log, the
// workspace manifest hashes and the hidden evaluation -- is already written to
// results/, and the workspace itself is reproducible from build-workspace.mjs.
// Retention therefore defaults to OFF; pass --keep-workspace to retain it.
record.workspace_retained = process.argv.includes("--keep-workspace");
record.workspace_path = ws;
if (!record.workspace_retained) {
  spawnSync("rm", ["-rf", ws], { encoding: "utf8" });
  record.workspace_removed_after_evaluation = true;
}

record.finished_at = new Date().toISOString();
writeFileSync(join(outDir, `run-${label}.json`), JSON.stringify(record, null, 2) + "\n");
spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
console.log(JSON.stringify({ label, arm, classification: record.classification,
  agent_seconds: record.agent_seconds, timed_out: record.agent_timed_out,
  patch_empty: record.patch_empty, observations: record.observations,
  proxy_attempts: record.proxy_attempts }, null, 2));
