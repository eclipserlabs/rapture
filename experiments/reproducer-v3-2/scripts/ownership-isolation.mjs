// V3.2 Phase 1 — adversarial capture-ownership isolation.
//
// The pg pool ownership defect: a queued pool connection request is dispatched
// from the stack of whichever request RELEASES a connection, so the nested
// Client.query observed the releasing request's capture context. An unmatched
// request's SQL, parameters and result rows were recorded into a different
// request's incident.
//
// This suite proves ownership adversarially, by planting per-request marker
// values in the SQL parameters and then asserting where those markers end up.
// Two directions matter:
//
//   A. selected vs unselected — an unselected request's marker must NEVER
//      appear in any captured incident. (correctness AND cross-request privacy)
//   B. selected vs selected   — request S1's marker must never appear in
//      request S2's incident. Pool pressure must not cross-contaminate two
//      legitimately captured incidents.
//
// Pool pressure is forced by making the pool smaller than the concurrency.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(root, "services", "ownership-probe.mjs");
const PORT = 48901;
const CONC = 16;
const POOL_MAX = 2;      // << CONC, so nearly every query queues

function start(env) {
  const outDir = mkdtempSync(join(tmpdir(), "v32own-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_ATTRIB","PGPOOL_MAX"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: { ...base, PORT: String(PORT), PGPOOL_MAX: String(POOL_MAX),
           REPO_ROOT: "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/express-4.21.1",
           FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN",
           RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir, ...env },
    stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => {
    let o = ""; const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("timeout " + o.slice(-300))); }, 30000);
    child.stdout.on("data", (d) => { o += d; if (o.includes("READY")) { clearTimeout(t); res({ child, outDir }); } });
    child.stderr.on("data", (d) => { o += d; });
    child.on("exit", (c) => { clearTimeout(t); rej(new Error(`exit ${c} ${o.slice(-300)}`)); });
  });
}
const hammer = async (paths) => {
  let n = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) { const i = n++; if (i >= paths.length) return;
      try { await (await fetch(`http://localhost:${PORT}${paths[i]}`)).arrayBuffer(); } catch {} }
  }));
};
const docsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8"), doc: JSON.parse(readFileSync(join(dir, f), "utf8")) }));

const findings = [];
// A suite that observes zero subjects proves nothing. Any check whose
// population is empty is recorded as a FAILURE, not a pass.
const record = (id, description, pass, detail) => {
  const m = /incidents=(\d+)/.exec(detail ?? "");
  if (m != null && Number(m[1]) === 0) {
    findings.push({ id, description, pass: false, detail: (detail ?? "") + "  [VACUOUS: zero incidents observed]" });
    console.log(`FAIL  ${id}  ${description} — ${detail} [VACUOUS]`);
    return;
  }
  findings.push({ id, description, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${description}${detail ? " — " + detail : ""}`);
};

// ---------------------------------------------------------------------------
// A. selected vs unselected. /boom is armed and fails; /quiet is unmatched and
//    succeeds. Every request plants its own marker in the SQL parameters.
// ---------------------------------------------------------------------------
{
  const { child, outDir } = await start({ RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /boom" });
  try {
    const paths = [];
    for (let i = 0; i < 400; i++) paths.push(i % 10 === 0 ? `/boom?m=SEL-${i}` : `/quiet?m=UNSEL-${i}`);
    await hammer(paths);
    await new Promise((r) => setTimeout(r, 900));
    const docs = docsIn(outDir);
    const leaked = docs.filter((d) => d.text.includes("UNSEL-"));
    record("OWN-A1", "unselected request markers never appear in any captured incident",
      leaked.length === 0, `incidents=${docs.length} contaminated=${leaked.length}`);
    // Every incident must contain exactly its OWN marker and no other request's.
    let foreign = 0;
    for (const d of docs) {
      const own = d.doc.request?.url?.match(/m=(SEL-\d+)/)?.[1] ?? null;
      const all = [...new Set((d.text.match(/SEL-\d+/g) ?? []))];
      if (own && all.some((m) => m !== own)) foreign += 1;
    }
    record("OWN-A2", "each incident contains only its own request marker",
      foreign === 0, `incidents=${docs.length} withForeignMarkers=${foreign}`);
    rmSync(outDir, { recursive: true, force: true });
  } finally { child.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 400)); }
}

// ---------------------------------------------------------------------------
// B. selected vs selected. BOTH routes are armed and both fail, so two
//    independent incidents compete for the same 2-connection pool.
// ---------------------------------------------------------------------------
{
  const { child, outDir } = await start({ RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /boom,GET /boom2" });
  try {
    const paths = [];
    for (let i = 0; i < 300; i++) paths.push(i % 2 === 0 ? `/boom?m=A-${i}` : `/boom2?m=B-${i}`);
    await hammer(paths);
    await new Promise((r) => setTimeout(r, 900));
    const docs = docsIn(outDir);
    let cross = 0;
    for (const d of docs) {
      const own = d.doc.request?.url?.match(/m=([AB]-\d+)/)?.[1] ?? null;
      const all = [...new Set((d.text.match(/[AB]-\d+/g) ?? []))];
      if (own && all.some((m) => m !== own)) cross += 1;
    }
    record("OWN-B1", "two concurrently-captured incidents never exchange boundary observations",
      cross === 0, `incidents=${docs.length} crossContaminated=${cross}`);
    const both = docs.filter((d) => /A-\d+/.test(d.text) && /B-\d+/.test(d.text));
    record("OWN-B2", "no incident contains markers from both armed routes",
      both.length === 0, `incidents=${docs.length} mixed=${both.length}`);
    rmSync(outDir, { recursive: true, force: true });
  } finally { child.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 400)); }
}

const doc = {
  generatedAt: new Date().toISOString(),
  concurrency: CONC, poolMax: POOL_MAX,
  design: "pool max is far below concurrency so nearly every query is queued and dispatched from a foreign request's stack, which is the exact condition that produced the defect",
  findings, allPassed: findings.every((f) => f.pass),
};
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "ownership-isolation.json"), JSON.stringify(doc, null, 2));
console.log(`\nall passed: ${doc.allPassed}`);
