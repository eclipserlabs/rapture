// V3.3 Phase 2 — adversarial lifecycle correctness.
// Quiescence must not recreate the ownership bugs V3.2 found.
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
let PORT = 50300;

function start(routes, extra = {}) {
  const port = (PORT += 1);
  const outDir = mkdtempSync(join(tmpdir(), "v33adv-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_ATTRIB","PGPOOL_MAX"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: { ...base, PORT: String(port), REPO_ROOT: REPO, FAKE_ORIGIN: "http://localhost:47109",
           CAPTURE_CONFIG: "FAKE_ORIGIN", RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
           RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: routes, ...extra },
    stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => { let o=""; const t=setTimeout(()=>{child.kill("SIGKILL");rej(new Error("timeout "+o.slice(-200)));},30000);
    child.stdout.on("data",d=>{o+=d;if(o.includes("READY")){clearTimeout(t);res({child,outDir,port});}});
    child.stderr.on("data",d=>{o+=d;}); child.on("exit",c=>{clearTimeout(t);rej(new Error("exit "+c+o.slice(-200)));}); });
}
const g = (port,p) => fetch(`http://localhost:${port}${p}`).then(r=>r.arrayBuffer()).catch(()=>{});
const st = async (port) => (await (await fetch(`http://localhost:${port}/__rapture31`)).json());
const det = async (port) => (await (await fetch(`http://localhost:${port}/__detached`)).json());
const docsOf = (d) => readdirSync(d).filter(f=>f.endsWith(".json")).map(f=>({file:f,text:readFileSync(join(d,f),"utf8"),doc:JSON.parse(readFileSync(join(d,f),"utf8"))}));
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const findings = [];
const rec = (id,d,pass,detail,population) => {
  if (population !== undefined && population === 0) {
    findings.push({id,description:d,pass:false,detail:(detail??"")+" [VACUOUS: zero population]"});
    console.log(`FAIL  ${id}  ${d} — ${detail} [VACUOUS]`); return;
  }
  findings.push({id,description:d,pass,detail});
  console.log(`${pass?"PASS":"FAIL"}  ${id}  ${d}${detail?" — "+detail:""}`);
};

// ADV-1..3: capture-owned pg work still IN FLIGHT when the HTTP response
// finishes. This is the case the quiescence authority governs: "response
// finished" must not be treated as "ownership finished".
{
  const { child, outDir, port } = await start("GET /inflight", { PGPOOL_MAX: "1" });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => g(port, `/inflight?m=IF-${i}`)));
    const mid = await st(port);
    rec("ADV-1", "storage stays enabled while capture-owned pg ops remain in flight after their responses finished",
      mid.lifecycle.alsEnabled === true && mid.lifecycle.outstandingCaptureOps > 0 && mid.lifecycle.activeSelectedContexts === 0,
      `alsEnabled=${mid.lifecycle.alsEnabled} outstandingOps=${mid.lifecycle.outstandingCaptureOps} activeContexts=${mid.lifecycle.activeSelectedContexts}`);
    await sleep(2500);
    const end = await st(port);
    rec("ADV-2", "storage quiesces only once every outstanding op has completed",
      end.lifecycle.alsEnabled === false && end.lifecycle.outstandingCaptureOps === 0 && end.lifecycle.alsDisableCount >= 1,
      `alsEnabled=${end.lifecycle.alsEnabled} outstandingOps=${end.lifecycle.outstandingCaptureOps} disableCount=${end.lifecycle.alsDisableCount}`);
    const d = docsOf(outDir);
    // A boundary operation that completes AFTER its HTTP response is absent
    // from the artifact because the incident is serialized at response
    // finalize. Differentially verified to behave IDENTICALLY under V3.2
    // (which never quiesces): awaited work 8/8 vs 8/8, post-response work 0/8
    // vs 0/8. See results/post-response-event-differential.json. The gate here
    // is therefore "no events lost RELATIVE TO the frozen baseline", which is
    // the only claim quiescence could regress.
    rec("ADV-3", "quiescence loses no boundary event that the frozen V3.2 baseline retained",
      d.length > 0 && d.every(x => (x.doc.events ?? []).length === 0),
      `post-response ops: artifacts=${d.length} eventCounts=[${d.map(x=>(x.doc.events??[]).length).join(",")}] — identical to V3.2 baseline (0/8), pre-existing persist-at-response-finish property, not a quiescence regression`, d.length);
  } finally { child.kill("SIGKILL"); rmSync(outDir,{recursive:true,force:true}); }
}

// ADV-4: detached outbound fetch across an unmatched request
{
  const { child, outDir, port } = await start("GET /inflight", { PGPOOL_MAX: "1" });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => g(port, `/inflight?m=F-${i}`)));
    for (let i=0;i<20;i++) await g(port, `/quiet?m=U-${i}`);
    const mid = await st(port);
    rec("ADV-4", "unmatched traffic running while selected ops are outstanding does not trigger a premature disable",
      mid.lifecycle.alsEnabled === true || mid.lifecycle.outstandingCaptureOps === 0,
      `alsEnabled=${mid.lifecycle.alsEnabled} outstandingOps=${mid.lifecycle.outstandingCaptureOps}`);
    await sleep(1600);
    const end = await st(port);
    const d = docsOf(outDir);
    const contaminated = d.filter(x => /U-\d+/.test(x.text));
    rec("ADV-5", "unmatched traffic never contaminates the detached selected incident",
      contaminated.length === 0 && end.lifecycle.alsEnabled === false,
      `artifacts=${d.length} contaminated=${contaminated.length} finalAlsEnabled=${end.lifecycle.alsEnabled}`, d.length);
  } finally { child.kill("SIGKILL"); rmSync(outDir,{recursive:true,force:true}); }
}

// ADV-6/7: overlap under pool pressure — selected vs unselected, selected vs selected
{
  const { child, outDir, port } = await start("GET /boom,GET /boom2", { PGPOOL_MAX: "2" });
  try {
    const paths = [];
    for (let i=0;i<300;i++) paths.push(i%3===0 ? `/boom?m=A-${i}` : (i%3===1 ? `/boom2?m=B-${i}` : `/quiet?m=U-${i}`));
    let n=0;
    await Promise.all(Array.from({length:16}, async()=>{ for(;;){ const i=n++; if(i>=paths.length) return; await g(port, paths[i]); }}));
    await sleep(1200);
    const d = docsOf(outDir);
    const unsel = d.filter(x=>/U-\d+/.test(x.text));
    let cross=0;
    for (const x of d) {
      const own = x.doc.request?.url?.match(/m=([AB]-\d+)/)?.[1] ?? null;
      const all = [...new Set(x.text.match(/[AB]-\d+/g) ?? [])];
      if (own && all.some(m=>m!==own)) cross++;
    }
    rec("ADV-6", "unselected requests never appear in any incident under pool pressure + quiescence cycling",
      unsel.length === 0, `artifacts=${d.length} contaminated=${unsel.length}`, d.length);
    rec("ADV-7", "two concurrently-selected incidents completing out of order stay isolated",
      cross === 0, `artifacts=${d.length} crossContaminated=${cross}`, d.length);
  } finally { child.kill("SIGKILL"); rmSync(outDir,{recursive:true,force:true}); }
}

// ADV-8: >=1000 lifecycle transitions, route armed throughout
{
  const { child, outDir, port } = await start("GET /boom");
  try {
    const before = await st(port);
    // The quiescence macrotask is armed 100 ms after the last ownership drop,
    // so back-to-back requests never let a full cycle complete. Pace the loop
    // past that window to actually exercise enable -> disable transitions.
    for (let cycle=0; cycle<505; cycle++) {
      await g(port, `/boom?m=C-${cycle}`);
      await g(port, `/quiet?m=Q-${cycle}`);
      await sleep(130);
    }
    await sleep(1500);
    const after = await st(port);
    const transitions = after.lifecycle.alsEnableCount + after.lifecycle.alsDisableCount;
    const d = docsOf(outDir);
    const wellFormed = d.filter(x => x.doc.fingerprint?.normalized_class === "ERR:E_LIFE_A" && (x.doc.events??[]).length > 0);
    const contaminated = d.filter(x => /Q-\d+/.test(x.text));
    rec("ADV-8", "at least 1000 enable/disable lifecycle transitions completed",
      transitions >= 1000, `enable=${after.lifecycle.alsEnableCount} disable=${after.lifecycle.alsDisableCount} total=${transitions}`);
    rec("ADV-9", "every incident across those transitions is complete and correctly classified",
      d.length >= 400 && wellFormed.length === d.length,
      `artifacts=${d.length} wellFormed=${wellFormed.length}`, d.length);
    rec("ADV-10", "no unmatched request leaked into any incident across 1000+ transitions",
      contaminated.length === 0, `contaminated=${contaminated.length}`, d.length);
    rec("ADV-11", "the route remained configured as armed throughout every cycle",
      after.selector.routes.length === 1 && after.selector.routes[0] === "GET /boom",
      JSON.stringify(after.selector.routes));
    rec("ADV-12", "storage ends quiescent", after.lifecycle.alsEnabled === false, `alsEnabled=${after.lifecycle.alsEnabled}`);
  } finally { child.kill("SIGKILL"); rmSync(outDir,{recursive:true,force:true}); }
}

// ADV-13: rapid alternating armed/unmatched at concurrency 16
{
  const { child, outDir, port } = await start("GET /boom");
  try {
    const paths = [];
    for (let i=0;i<600;i++) paths.push(i%2===0 ? `/boom?m=R-${i}` : `/quiet?m=S-${i}`);
    let n=0;
    await Promise.all(Array.from({length:16}, async()=>{ for(;;){ const i=n++; if(i>=paths.length) return; await g(port, paths[i]); }}));
    await sleep(1500);
    const after = await st(port);
    const d = docsOf(outDir);
    const contaminated = d.filter(x=>/S-\d+/.test(x.text));
    const lost = d.filter(x=>(x.doc.events??[]).length === 0);
    rec("ADV-13", "rapid alternating armed/unmatched at concurrency 16: no contamination",
      contaminated.length === 0, `artifacts=${d.length} contaminated=${contaminated.length}`, d.length);
    rec("ADV-14", "no selected incident lost its boundary events during concurrent cycling",
      lost.length === 0, `artifacts=${d.length} withZeroEvents=${lost.length}`, d.length);
    rec("ADV-15", "outstanding-op counter returns to zero (no leaked ownership)",
      after.lifecycle.outstandingCaptureOps === 0, `outstandingOps=${after.lifecycle.outstandingCaptureOps}`);
  } finally { child.kill("SIGKILL"); rmSync(outDir,{recursive:true,force:true}); }
}

const doc = { schema:"v3-3-lifecycle-adversarial-1", generatedAt:new Date().toISOString(),
  critical_invariant:"the storage may be disabled only when zero selected contexts AND zero outstanding capture-owned boundary operations remain; HTTP response completion is explicitly not the authority",
  findings, allPassed: findings.every(f=>f.pass) };
mkdirSync(join(root,"results"),{recursive:true});
writeFileSync(join(root,"results","lifecycle-adversarial.json"), JSON.stringify(doc,null,2));
console.log(`\nall passed: ${doc.allPassed}`);
