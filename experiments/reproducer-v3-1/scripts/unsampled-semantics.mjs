// V3.1 Phase 4 (selective-capture brief) — unsampled failure semantics.
//
// The product-honesty check. For every one of the 8 frozen V3 incidents, the
// real historical failure is triggered while the request is deliberately
// OUTSIDE the selected population. The runtime must:
//   - still serve the failure (the application is unaffected),
//   - persist NO artifact,
//   - record NO boundary observations,
//   - and report the request as not selected — never as a partial incident.
//
// This is what forbids the claim "Rapture always captures failures".
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3H = join(root, "..", "reproducer-v3", "headline");
const REGISTER = join(root, "src", "capture", "register.mjs");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";
const NODE = process.execPath;

const CASES = [
  { id: "koa-1999", svc: "koa-1999.mjs", port: 47921, buggy: "koa-1061776", fixed: "koa-571938d" },
  { id: "koa-1998", svc: "koa-1998.mjs", port: 47922, buggy: "koa-4a191b1", fixed: "koa-1061776" },
  { id: "express-cookie", svc: "express-cookie.mjs", port: 47923, buggy: "express-4.19.2", fixed: "express-4.21.1" },
  { id: "express-qs", svc: "express-qs.mjs", port: 47924, buggy: "express-4.21.1", fixed: "express-4.21.1", qs: true },
  { id: "fastify-32442", svc: "fastify-32442.mjs", port: 47925, buggy: "fastify-5.3.0", fixed: "fastify-5.3.2" },
  { id: "express-semver", svc: "express-semver.mjs", port: 47929, buggy: "express-4.21.1", fixed: "express-4.21.1", semver: true },
  { id: "hapi-4560", svc: "hapi-4560.mjs", port: 47927, buggy: "hapi-5095382", fixed: "hapi-ee8475b", host: "::1" },
  { id: "hapi-4564", svc: "hapi-4564.mjs", port: 47928, buggy: "hapi-62032e6", fixed: "hapi-97c435f" },
];

const svcEnv = (c, rev) => ({
  REPO_ROOT: CORPUS + (rev === "buggy" ? c.buggy : c.fixed),
  PORT: String(c.port), QS_MODE: c.qs ? rev : "buggy", SEMVER_MODE: c.semver ? rev : "buggy",
  ...(c.host ? { HOST: c.host } : {}),
});

function start(c, extra) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_ROUTES", "RAPTURE_V31_SAMPLE_RATE", "RAPTURE_V31_WINDOW_BUDGET"]) delete base[k];
    const child = spawn(NODE, ["--import", REGISTER, join(V3H, "services", c.svc)], { env: { ...base, ...svcEnv(c, "buggy"), ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout ${c.id}: ${out.slice(-400)}`)); }, 30000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`exit ${code} ${c.id}: ${out.slice(-400)}`)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two independent ways of being outside the selected population.
const MODES = {
  ROUTE_SELECTIVE_OTHER_ROUTE: { RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "POST /some-other-route" },
  SAMPLING_RATE_ZERO: { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0" },
};

const rows = [];
for (const c of CASES) {
  for (const [mode, env] of Object.entries(MODES)) {
    const outDir = mkdtempSync(join(tmpdir(), `v31uns-${c.id}-`));
    const row = { case: c.id, mode };
    try {
      const child = await start(c, { RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir, RAPTURE_V31_SEED: "20260910", FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN", ...env });
      const r = spawnSync(NODE, [join(V3H, "triggers", "run.mjs"), c.id, String(c.port)], { encoding: "utf8", timeout: 30000 });
      await sleep(200);
      let snap = null;
      const h = c.host === "::1" ? "[::1]" : (c.host ?? "127.0.0.1");
      try { snap = await (await fetch(`http://${h}:${c.port}/__rapture31`)).json(); } catch { /* recorded null */ }
      child.kill("SIGKILL"); await sleep(300);
      const artifacts = readdirSync(outDir).filter((f) => f.endsWith(".json"));
      row.failure_served = /50\d|E_/.test(r.stdout ?? "") || (r.stdout ?? "").includes("500");
      row.trigger_output = (r.stdout ?? "").trim().split("\n")[0]?.slice(0, 90) ?? "";
      row.requests_selected = snap?.selector?.stats?.requestsSelected ?? null;
      row.failures_observed = snap?.selector?.stats?.failuresObserved ?? null;
      row.events_recorded = snap?.capture?.eventsRecorded ?? null;
      row.requests_persisted = snap?.capture?.requestsPersisted ?? null;
      row.artifacts_written = artifacts.length;
      row.als_enabled = snap?.alsEnabled ?? null;
      row.verdict =
        row.artifacts_written === 0 && row.requests_selected === 0 && row.events_recorded === 0
          ? "NOT_CAPTURED" : "UNEXPECTED_CAPTURE";
    } catch (e) { row.verdict = "ERROR"; row.error = String(e?.message ?? e).slice(0, 200); }
    rmSync(outDir, { recursive: true, force: true });
    rows.push(row);
    console.log(`${c.id.padEnd(16)} ${mode.padEnd(28)} ${row.verdict.padEnd(20)} sel=${row.requests_selected} ev=${row.events_recorded} art=${row.artifacts_written}`);
  }
}

const bad = rows.filter((r) => r.verdict !== "NOT_CAPTURED");
const doc = {
  generatedAt: new Date().toISOString(),
  manifest: "manifests/V3.1-MANIFEST.json",
  cases: CASES.length, modes: Object.keys(MODES),
  rows,
  all_not_captured: bad.length === 0,
  violations: bad,
  supported_claim:
    "An unselected request that fails is NOT_CAPTURED: no artifact, no boundary observations, no partial reproducer. The failure is still served normally by the application. Rapture therefore cannot claim 'production failed -> artifact exists'; the supported claim is 'production failed AND the request was selected before it executed -> artifact exists'.",
  why_retroactive_capture_is_impossible:
    "Exact replay needs the database rows, outbound HTTP responses, time draws and randomness the request actually observed. Those are only obtainable while the request executes. After the response is written they are gone, so no amount of post-hoc detection can reconstruct them.",
  strategies_to_raise_capture_probability: [
    "raise the ingress sampling rate (costs throughput on ALL traffic, continuously)",
    "route targeting: arm the specific route/operation under investigation (free for unmatched traffic when nothing else is armed)",
    "detect-then-arm: accept losing occurrence 1 and capture a later one (only works for recurring failures)",
    "bounded armed incident window: arm during an investigation, then return to the fast path",
  ],
};
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "unsampled-semantics.json"), JSON.stringify(doc, null, 2));
console.log(`\nall NOT_CAPTURED: ${doc.all_not_captured}`);
