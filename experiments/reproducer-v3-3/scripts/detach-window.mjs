// V3.3 — precisely where quiescence loses detached capture-owned work.
//
// The quiescence macrotask is armed 100 ms after the last ownership drop. Work
// detached from the response and STARTING after that point finds no context.
// This sweeps the detach delay to locate the exact boundary rather than
// asserting one.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(root, "services", "lifecycle-probe.mjs");
const REPO = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/express-4.21.1";
let PORT = 50500;
const rows = [];
for (const delay of [0, 25, 50, 75, 100, 150, 300, 600]) {
  const port = (PORT += 1);
  const outDir = mkdtempSync(join(tmpdir(), "v33win-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: { ...base, PORT: String(port), REPO_ROOT: REPO, FAKE_ORIGIN: "http://localhost:47109",
           CAPTURE_CONFIG: "FAKE_ORIGIN", RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
           RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /detach",
           DETACH_DELAY_MS: String(delay) },
    stdio: ["ignore","pipe","pipe"] });
  await new Promise((res,rej)=>{let o="";const t=setTimeout(()=>{child.kill("SIGKILL");rej(new Error("timeout"));},30000);
    child.stdout.on("data",d=>{o+=d;if(o.includes("READY")){clearTimeout(t);res();}});
    child.stderr.on("data",d=>{o+=d;});child.on("exit",c=>{clearTimeout(t);rej(new Error("exit"+c));});});
  for (let i=0;i<5;i++) await fetch(`http://localhost:${port}/detach?m=D${delay}-${i}`).then(r=>r.arrayBuffer()).catch(()=>{});
  await new Promise(r=>setTimeout(r, delay + 1500));
  const docs = readdirSync(outDir).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(readFileSync(join(outDir,f),"utf8")));
  const withPg = docs.filter(d=>(d.events??[]).some(e=>e.kind==="pg")).length;
  rows.push({ detachDelayMs: delay, incidents: docs.length, incidentsRetainingDetachedPgEvent: withPg,
    retained: docs.length ? `${withPg}/${docs.length}` : "0/0" });
  console.log(`detach delay ${String(delay).padStart(4)}ms -> incidents=${docs.length} retaining detached pg event=${withPg}`);
  child.kill("SIGKILL"); rmSync(outDir,{recursive:true,force:true});
  await new Promise(r=>setTimeout(r,300));
}
const doc = { schema:"v3-3-detach-window-1", generatedAt:new Date().toISOString(),
  quiesce_timer_ms: 100,
  question:"how long after its HTTP response can a selected request start capture-owned work and still have it recorded?",
  rows,
  finding:"work detached from the response and starting after the quiescence macrotask fires is not recorded; the storage has already been disabled and currentRequest() returns null",
  significance:"this is undecidable in general: nothing observable distinguishes a selected context that will schedule more work from one that is finished, so no counter-based authority can be sound for arbitrarily detached work" };
mkdirSync(join(root,"results"),{recursive:true});
writeFileSync(join(root,"results","detach-window.json"), JSON.stringify(doc,null,2));
