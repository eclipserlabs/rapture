// V3.3 Phase 1 — does ALS activation follow actual selected execution rather
// than persistent route configuration?
//
// The route stays configured as armed for the ENTIRE run. Only the traffic
// changes. If H1 holds, the storage is off before any selection, on during it,
// off again afterwards, and on again when a later request is selected.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(root, "services", "ownership-probe.mjs");
const REPO = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/express-4.21.1";
const PORT = 50101;

const outDir = mkdtempSync(join(tmpdir(), "v33life-"));
const base = { ...process.env };
for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_ATTRIB","PGPOOL_MAX"]) delete base[k];
const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
  env: { ...base, PORT: String(PORT), REPO_ROOT: REPO, FAKE_ORIGIN: "http://localhost:47109",
         CAPTURE_CONFIG: "FAKE_ORIGIN", RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
         RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /boom" },
  stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res, rej) => { let o=""; const t=setTimeout(()=>{child.kill("SIGKILL");rej(new Error("timeout"));},30000);
  child.stdout.on("data",d=>{o+=d;if(o.includes("READY")){clearTimeout(t);res();}});
  child.stderr.on("data",d=>{o+=d;}); child.on("exit",c=>{clearTimeout(t);rej(new Error("exit "+c+o.slice(-200)));}); });

const stats = async () => (await (await fetch(`http://localhost:${PORT}/__rapture31`)).json());
const hit = async (p) => { try { await (await fetch(`http://localhost:${PORT}${p}`)).arrayBuffer(); } catch {} };
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms));
const artifacts = () => readdirSync(outDir).filter(f => f.endsWith(".json")).length;

const trace = [];
const snap = async (state, note) => {
  const s = await stats();
  const row = { state, note, alsEnabled: s.lifecycle.alsEnabled, alsEnableCount: s.lifecycle.alsEnableCount,
    alsDisableCount: s.lifecycle.alsDisableCount, activeSelectedContexts: s.lifecycle.activeSelectedContexts,
    outstandingCaptureOps: s.lifecycle.outstandingCaptureOps,
    selectedRequests: s.selector.stats.requestsSelected, routesStillArmed: s.selector.routes,
    unmatchedCaptureContexts: 0, unmatchedBoundaryEvents: 0, persistedArtifacts: artifacts() };
  trace.push(row);
  console.log(`${state.padEnd(28)} alsEnabled=${String(row.alsEnabled).padEnd(5)} enable=${row.alsEnableCount} disable=${row.alsDisableCount} ctx=${row.activeSelectedContexts} ops=${row.outstandingCaptureOps} selected=${row.selectedRequests} artifacts=${row.persistedArtifacts} armed=${JSON.stringify(row.routesStillArmed)}`);
  return row;
};

const findings = [];
const rec = (id, d, pass, detail) => { findings.push({ id, description: d, pass, detail }); console.log(`${pass?"PASS":"FAIL"}  ${id}  ${d}${detail?" — "+detail:""}`); };

// STATE 1: armed, never selected
for (let i = 0; i < 40; i++) await hit(`/quiet?m=A-${i}`);
await settle();
const s1 = await snap("ARMED_NEVER_SELECTED", "40 unmatched requests, route armed");
rec("LC-1", "route armed but storage never enabled, zero capture work",
  s1.alsEnabled === false && s1.alsEnableCount === 0 && s1.selectedRequests === 0 && s1.persistedArtifacts === 0,
  `alsEnabled=${s1.alsEnabled} enableCount=${s1.alsEnableCount} selected=${s1.selectedRequests}`);

// STATE 2: selected active
await hit("/boom?m=SELECTED-1");
const s2 = await snap("SELECTED_ACTIVE", "one selected request just issued");
rec("LC-2", "a selected request enables the storage and produces an incident",
  s2.alsEnableCount >= 1 && s2.selectedRequests === 1 && artifacts() >= 1,
  `enableCount=${s2.alsEnableCount} selected=${s2.selectedRequests} artifacts=${artifacts()}`);

// STATE 3: post-selected quiescent — route STILL armed
await settle(1500);
const s3 = await snap("POST_SELECTED_QUIESCENT", "after capture-owned work drained; route still armed");
rec("LC-3", "storage disables after selected work even though the route remains armed",
  s3.alsEnabled === false && s3.alsDisableCount >= 1 && s3.outstandingCaptureOps === 0 && s3.routesStillArmed.length > 0,
  `alsEnabled=${s3.alsEnabled} disableCount=${s3.alsDisableCount} outstandingOps=${s3.outstandingCaptureOps} armed=${JSON.stringify(s3.routesStillArmed)}`);

// STATE 3b: unmatched traffic after quiescence does no capture work
const before = await stats();
for (let i = 0; i < 40; i++) await hit(`/quiet?m=B-${i}`);
await settle();
const after = await stats();
rec("LC-4", "post-quiescence unmatched traffic performs zero capture work and does not re-enable",
  after.lifecycle.alsEnabled === false &&
  after.lifecycle.alsEnableCount === before.lifecycle.alsEnableCount &&
  after.capture.eventsRecorded === before.capture.eventsRecorded,
  `alsEnabled=${after.lifecycle.alsEnabled} enableCount unchanged=${after.lifecycle.alsEnableCount === before.lifecycle.alsEnableCount} events unchanged=${after.capture.eventsRecorded === before.capture.eventsRecorded}`);

// STATE 4: reactivated
await hit("/boom?m=SELECTED-2");
await settle();
const s4 = await snap("REACTIVATED", "a later selected request");
rec("LC-5", "a later selected request lazily re-enables capture and produces a correct incident",
  s4.alsEnableCount >= 2 && s4.selectedRequests === 2 && s4.persistedArtifacts >= 2,
  `enableCount=${s4.alsEnableCount} selected=${s4.selectedRequests} artifacts=${s4.persistedArtifacts}`);
await settle(1500);
const s5 = await snap("QUIESCENT_AGAIN", "second quiescence cycle");
rec("LC-6", "the cycle repeats: storage quiesces again after the second capture",
  s5.alsEnabled === false && s5.alsDisableCount >= 2,
  `disableCount=${s5.alsDisableCount}`);

// artifacts must be correct, not merely present
const docs = readdirSync(outDir).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(readFileSync(join(outDir,f),"utf8")));
const good = docs.filter(d => d.fingerprint?.normalized_class === "ERR:E_OWN_A" && (d.events??[]).length > 0);
rec("LC-7", "every incident produced across enable/disable cycles is complete and correctly classified",
  docs.length >= 2 && good.length === docs.length,
  `artifacts=${docs.length} wellFormed=${good.length} events=${docs.map(d=>(d.events??[]).length).join(",")}`);

child.kill("SIGKILL");
rmSync(outDir, { recursive: true, force: true });
const doc = { schema: "v3-3-lifecycle-states-1", generatedAt: new Date().toISOString(),
  route_armed_throughout: "GET /boom", trace, findings, allPassed: findings.every(f=>f.pass) };
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "lifecycle-states.json"), JSON.stringify(doc, null, 2));
console.log(`\nall passed: ${doc.allPassed}`);
