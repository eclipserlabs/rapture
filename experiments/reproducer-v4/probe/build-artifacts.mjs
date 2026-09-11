// Freezes the five probe .repro artifacts using the FROZEN V3.3 capture and
// replay implementation, and the frozen V0 greedy reducer, exactly as the V3.3
// regression suite does. No case-specific logic.
//
// Each artifact must satisfy the frozen treatment-artifact requirement:
//   reproduces the exact original failure against the buggy revision, and
//   the historical fixed revision removes it.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_CASES, REPO, V3H } from "./cases.mjs";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";
import { scrubComments } from "./scrub.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const NODE = process.execPath;
const REGISTER = join(REPO, "experiments", "reproducer-v3-3", "src", "capture", "register.mjs");
const REPLAY = join(V3H, "replay-raw.mjs");
const OUT = join(HERE, "artifacts");
const REPS = Number((process.argv.includes("--reps") ? process.argv[process.argv.indexOf("--reps") + 1] : "10"));
const only = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 52100;

function bootCapture(c, outDir, p) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, REPO_ROOT: c.buggyRoot, PORT: String(p),
      RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
      RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: c.routeKey };
    const ch = spawn(NODE, ["--import", REGISTER, c.serviceEntry], { env, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    const t = setTimeout(() => { ch.kill("SIGKILL"); reject(new Error(`boot timeout: ${o.slice(-300)}`)); }, 45000);
    ch.stdout.on("data", (d) => { o += d; if (o.includes("READY")) { clearTimeout(t); resolve(ch); } });
    ch.stderr.on("data", (d) => { o += d; });
    ch.on("exit", (x) => { clearTimeout(t); reject(new Error(`exit ${x}: ${o.slice(-300)}`)); });
  });
}

async function fire(p, req) {
  const init = { method: req.method ?? "GET", headers: req.headers ?? {} };
  if (req.body != null) init.body = req.body;
  try { const r = await fetch(`http://127.0.0.1:${p}${req.path}`, init); await r.text(); return r.status; }
  catch (e) { return `ERR ${String(e?.message ?? e).slice(0, 80)}`; }
}

// Offline replay: dead database port, no external dependency reachable.
//
// The subset is MATERIALIZED rather than passed through --keep. replay-raw.mjs
// guards that flag with `if (!keep) return doc`, so an EMPTY keep set is falsy
// and silently replays the FULL capture -- which made the greedy reducer believe
// it could drop every atom. Writing the subset to a file exercises the true
// semantics. This corrects the reduction driver only; the frozen V3.3 capture
// and replay implementation and the frozen V0 reducer are unchanged.
function trial(c, capturePath, keepIds, rev, p) {
  let usePath = capturePath;
  let tmpDir = null;
  if (keepIds != null) {
    const doc = JSON.parse(readFileSync(capturePath, "utf8"));
    const keep = new Set([...keepIds]);
    tmpDir = mkdtempSync(join(tmpdir(), "v4subset-"));
    usePath = join(tmpDir, "subset.json");
    writeFileSync(usePath, JSON.stringify({ ...doc, events: (doc.events ?? []).filter((e) => keep.has(e.seq)) }));
  }
  const args = ["--app", c.serviceEntry, "--capture", usePath, "--port", String(p)];
  const env = { REPO_ROOT: rev === "buggy" ? c.buggyRoot : c.fixedRoot,
                REPLAY_HOST: "127.0.0.1", PGPORT: "54399" };
  const r = spawnSync(NODE, [REPLAY, ...args, "--env", JSON.stringify(env)],
                      { encoding: "utf8", timeout: 90000 });
  try {
    const out = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1));
    out.fingerprintHash = out.fingerprint?.fingerprint_hash ?? null;
    return out;
  } catch { return { pass: false, fingerprintHash: "UNPARSEABLE", raw: (r.stdout ?? "").slice(-200) }; }
  finally { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); }
}

mkdirSync(OUT, { recursive: true });

// Capture from a NEUTRAL staging path. The recorded response body of a framework
// error page embeds absolute source paths, so capturing directly from
// <work>/<case-id>-buggy would bake the case identifier -- and the host layout --
// into the frozen artifact, which only TREATMENT can read. That would be an
// asymmetric hint CONTROL never receives.
const STAGE = "/tmp/v4stage";
const stage = (src, name) => {
  const dst = join(STAGE, name);
  spawnSync("rm", ["-rf", dst]);
  mkdirSync(dst, { recursive: true });
  const r = spawnSync("cp", ["-R", `${src}/.`, dst], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stage failed: ${(r.stderr ?? "").slice(0, 200)}`);
  return dst;
};

const rows = [];
for (let c of PROBE_CASES) {
  if (only && c.id !== only) continue;
  const row = { id: c.id, repository: c.repository };
  const capDir = mkdtempSync(join(tmpdir(), `v4cap-${c.id}-`));
  try {
    // The deployed service is staged under the SAME neutral name the workspace
    // uses, because a framework error page records the service frame's path and
    // the research filename encodes the case identifier.
    mkdirSync(join(STAGE, "app"), { recursive: true });
    const stagedService = join(STAGE, "app", "server.mjs");
    writeFileSync(stagedService, scrubComments(readFileSync(c.serviceEntry, "utf8")));
    c = { ...c, buggyRoot: stage(c.buggyRoot, "repo"), fixedRoot: stage(c.fixedRoot, "repo-fixed"),
          serviceEntry: stagedService };
    const p = (port += 3);
    const ch = await bootCapture(c, capDir, p);
    row.trigger_status = await fire(p, c.trigger);
    await sleep(900); ch.kill("SIGKILL"); await sleep(400);

    const files = readdirSync(capDir).filter((f) => f.endsWith(".json"));
    if (!files.length) throw new Error("no incident persisted under ROUTE_SELECTIVE");
    const capturePath = join(capDir, files[0]);
    const doc = JSON.parse(readFileSync(capturePath, "utf8"));
    row.events_total = (doc.events ?? []).length;
    row.captured_class = doc.fingerprint?.normalized_class ?? null;

    const off = [];
    for (let i = 0; i < REPS; i += 1) { port += 1; off.push(trial(c, capturePath, null, "buggy", port)); }
    const fp = off[0]?.fingerprintHash ?? null;
    row.fingerprint_hash = fp;
    row.offline_pass = `${off.filter((r) => r.pass && r.fingerprintHash === fp).length}/${REPS}`;
    row.replay_classes = new Set(off.map((r) => r.fingerprintHash)).size;

    // Frozen greedy reduction, real signature.
    const atomIds = (doc.events ?? []).map((e) => e.seq);
    const reduced0 = greedyReduce(atomIds.map((id) => ({ id })),
      (keepSet) => { port += 1; return trial(c, capturePath, keepSet, "buggy", port); }, () => {});
    const keptIds = reduced0.keptIds;
    row.reduce_trials = reduced0.trials;
    row.atoms = `${keptIds.size}/${atomIds.length}`;

    const reduced = { ...doc, events: (doc.events ?? []).filter((e) => keptIds.has(e.seq)) };
    const artPath = join(OUT, `${c.id}.json`);
    writeFileSync(artPath, JSON.stringify(reduced, null, 2));
    const text = readFileSync(artPath, "utf8");
    row.artifact_bytes = Buffer.byteLength(text);
    row.artifact_sha256 = createHash("sha256").update(text).digest("hex");

    const portRuns = [];
    for (let i = 0; i < REPS; i += 1) { port += 1; portRuns.push(trial(c, artPath, null, "buggy", port)); }
    row.portable_pass = `${portRuns.filter((r) => r.pass && r.fingerprintHash === fp).length}/${REPS}`;

    port += 1;
    const fixed = trial(c, artPath, null, "fixed", port);
    row.fixed_pass = fixed.pass === true;
    row.fixed_fingerprint_absent = fixed.fingerprintHash !== fp;
    row.fix_status = !row.fixed_pass && row.fixed_fingerprint_absent ? "FIX_CONFIRMED" : "FIX_NOT_CONFIRMED";
    row.verdict = row.offline_pass === `${REPS}/${REPS}` && row.portable_pass === `${REPS}/${REPS}`
                  && row.fix_status === "FIX_CONFIRMED" ? "DISCRIMINATING" : "NOT_DISCRIMINATING";
  } catch (e) {
    row.verdict = "ERROR"; row.error = String(e?.message ?? e).slice(0, 300);
  }
  rmSync(capDir, { recursive: true, force: true });
  spawnSync("rm", ["-rf", STAGE]);
  rows.push(row);
  console.log(`${c.id.padEnd(22)} ${String(row.verdict).padEnd(17)} off=${row.offline_pass ?? "-"} port=${row.portable_pass ?? "-"} atoms=${row.atoms ?? "-"} fix=${row.fix_status ?? "-"} ${row.error ?? ""}`);
}
writeFileSync(join(HERE, "..", "results", "probe-artifacts.json"), JSON.stringify({
  schema: "v4-probe-artifacts-1", generated_at: new Date().toISOString(), reps: REPS,
  method: "frozen V3.3 route-selective capture from the buggy revision, frozen V0 greedy reduction, frozen V3.3 offline replay with a dead database port",
  rows,
}, null, 2) + "\n");
console.log("\nDISCRIMINATING:", rows.filter((r) => r.verdict === "DISCRIMINATING").length, "/", rows.length);
