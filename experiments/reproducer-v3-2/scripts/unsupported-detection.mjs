// V3.2 Phase 3, part 3 — does the runtime DETECT the unsupported condition at
// capture time, before handing over a reproducer it cannot honour offline?
//
// Positive case: parse-server does Postgres schema work during boot.
// Negative control: the V3 fixtures do all their dependency work inside the
// request, so they must NOT be flagged (otherwise the detector is useless).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const V3H = join(root, "..", "reproducer-v3", "headline");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";
const findings = [];
const rec = (id, d, pass, detail) => { findings.push({ id, description: d, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${d} — ${detail}`); };

// --- negative controls: the 8-case fixtures must NOT be flagged
const CASES = [
  { id: "koa-1999", svc: "koa-1999.mjs", port: 49801, buggy: "koa-1061776" },
  { id: "express-qs", svc: "express-qs.mjs", port: 49802, buggy: "express-4.21.1", qs: true },
  { id: "hapi-4564", svc: "hapi-4564.mjs", port: 49803, buggy: "hapi-62032e6" },
];
for (const c of CASES) {
  const outDir = mkdtempSync(join(tmpdir(), "v32und-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, join(V3H, "services", c.svc)], {
    env: { ...base, REPO_ROOT: CORPUS + c.buggy, PORT: String(c.port), QS_MODE: c.qs ? "buggy" : "buggy",
           SEMVER_MODE: "buggy", FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN",
           RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir, RAPTURE_V31_STRATEGY: "always-on" },
    stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => { let o = ""; const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("timeout")); }, 30000);
    child.stdout.on("data", (d) => { o += d; if (o.includes("READY")) { clearTimeout(t); res(); } });
    child.stderr.on("data", (d) => { o += d; }); child.on("exit", () => { clearTimeout(t); rej(new Error("exit " + o.slice(-200))); }); });
  spawnSync(process.execPath, [join(V3H, "triggers", "run.mjs"), c.id, String(c.port)], { encoding: "utf8", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGKILL");
  const f = readdirSync(outDir).filter((x) => x.endsWith(".json"));
  const doc = f.length ? JSON.parse(readFileSync(join(outDir, f[0]), "utf8")) : null;
  rec(`UND-neg-${c.id}`, "in-request-only fixture is NOT flagged unsupported",
    doc != null && doc.offline_replay_supported === true && doc.boundary_ops_outside_request === 0,
    `bootOps=${doc?.boundary_ops_outside_request} offlineSupported=${doc?.offline_replay_supported}`);
  rmSync(outDir, { recursive: true, force: true });
}

// --- positive case: parse-server, captured through its OWN route
{
  const PORT = 49911;
  const DIR = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3-1/parse-server/buggy";
  const QUERY = "/parse/classes/_User?where=" + encodeURIComponent(JSON.stringify({ _tombstone: { $exists: true } }));
  const outDir = mkdtempSync(join(tmpdir(), "v32psd-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, join(root, "large-app", "server.mjs")], {
    env: { ...base, PARSE_ROOT: DIR, DATABASE_URI: "postgres://wira@localhost:5432/parse_v31_buggy",
           APP_ID: "v31app", MASTER_KEY: "v31master", PORT: String(PORT),
           RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
           RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /parse/classes/_User" },
    stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise((res, rej) => { const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("boot timeout")); }, 120000);
    child.stdout.on("data", (d) => { out += d; if (/READY|listening/i.test(out)) { clearTimeout(t); res(); } });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", () => { clearTimeout(t); rej(new Error("exit")); }); });
  const resp = await fetch("http://127.0.0.1:" + PORT + QUERY, { headers: { "X-Parse-Application-Id": "v31app", "X-Parse-Master-Key": "v31master" } });
  await new Promise((x) => setTimeout(x, 1200));
  child.kill("SIGKILL");
  const f = readdirSync(outDir).filter((x) => x.endsWith(".json"));
  const docs = f.map((x) => JSON.parse(readFileSync(join(outDir, x), "utf8")));
  const flagged = docs.filter((d) => d.unsupported_condition === "BOOT_TIME_DEPENDENCY_ACCESS");
  rec("UND-pos-parse-server", "parse-server capture is flagged BOOT_TIME_DEPENDENCY_ACCESS at capture time",
    docs.length > 0 && flagged.length === docs.length && flagged.every((d) => d.offline_replay_supported === false),
    "triggerStatus=" + resp.status + " artifacts=" + docs.length + " flagged=" + flagged.length +
    " bootOps=" + docs.map((d) => d.boundary_ops_outside_request).join(",") +
    " fingerprintPreserved=" + docs.every((d) => (d.fingerprint?.fingerprint_hash ?? "").startsWith("d8a95e92")));
  rmSync(outDir, { recursive: true, force: true });
}

const doc = { schema: "v3-2-unsupported-detection-1", generatedAt: new Date().toISOString(),
  mechanism: "boundary operations observed before the first inbound request are counted; a non-zero count marks the artifact offline_replay_supported=false with unsupported_condition=BOOT_TIME_DEPENDENCY_ACCESS",
  findings, allPassed: findings.every((f) => f.pass) };
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "unsupported-detection.json"), JSON.stringify(doc, null, 2));
console.log(`\nall passed: ${doc.allPassed}`);
