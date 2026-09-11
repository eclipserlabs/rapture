// V3.2 Phase 1 diagnostic: after route-targeted capture has been ACTIVATED,
// do later UNMATCHED requests find a live capture context?
//
// In this configuration zero measured requests are selected, so any non-null
// return from currentRequest() is a capture context that outlived the request
// that created it. The stack tells us which boundary wrapper saw it.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";
const SVC = {
  "express-qs": { file: join(root, "services", "express-qs.mjs"), env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" }, port: 48711, key: "GET /parse", armed: (i) => `/parse?q=a${i % 3}`, un: (i) => `/parse-b?q=a${i % 3}` },
  "koa-1999": { file: join(root, "services", "koa-1999.mjs"), env: { REPO_ROOT: `${CORPUS}koa-571938d` }, port: 48712, key: "GET /u", armed: (i) => `/u?q=${i % 7}`, un: (i) => `/u-b?q=${i % 7}` },
};
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const ACT = Number(arg("--activate", "150"));
const UN = Number(arg("--unmatched", "500"));
const CONC = Number(arg("--conc", "16"));

function start(def, extra) {
  const outDir = join("/tmp", "v32leak"); mkdirSync(outDir, { recursive: true });
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_ATTRIB"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, def.file], {
    env: { ...base, ...def.env, PORT: String(def.port), FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN",
           RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir, RAPTURE_V31_STRATEGY: "route-selective",
           RAPTURE_V31_ROUTES: def.key, RAPTURE_V31_ATTRIB: "1", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((res, rej) => { let o = ""; const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("timeout " + o.slice(-300))); }, 30000);
    child.stdout.on("data", d => { o += d; if (o.includes("READY")) { clearTimeout(t); res(child); } });
    child.stderr.on("data", d => { o += d; }); child.on("exit", c => { clearTimeout(t); rej(new Error("exit " + c + " " + o.slice(-300))); }); });
}
const stats = async (p) => (await (await fetch(`http://localhost:${p}/__rapture31`)).json());
const seq = async (p, paths) => {
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= paths.length) return;
      try { await (await fetch(`http://localhost:${p}${paths[i]}`)).arrayBuffer(); } catch {}
    }
  }));
};

const rows = [];
for (const [name, def] of Object.entries(SVC)) {
  for (const cond of (arg("--pools","") ? arg("--pools","").split(",") : ["default"])) {
    const child = await start(def, cond === "default" ? {} : { PGPOOL_MAX: cond });
    try {
      // 1. ACTIVATE: selected requests create capture contexts
      await seq(def.port, Array.from({ length: ACT }, (_, i) => def.armed(i)));
      await new Promise(r => setTimeout(r, 400));
      const s0 = await stats(def.port);
      // 2. UNMATCHED ONLY: none of these is selected
      await seq(def.port, Array.from({ length: UN }, (_, i) => def.un(i)));
      await new Promise(r => setTimeout(r, 400));
      const s1 = await stats(def.port);
      const d = (f) => f(s1) - f(s0);
      const lb = {};
      for (const k of new Set([...Object.keys(s0.attrib.leakByModule), ...Object.keys(s1.attrib.leakByModule)])) {
        const v = (s1.attrib.leakByModule[k] ?? 0) - (s0.attrib.leakByModule[k] ?? 0);
        if (v > 0) lb[k] = v;
      }
      const row = {
        service: name, condition: cond + "-conc" + CONC, activationRequests: ACT, unmatchedRequests: UN,
        selectedDuringUnmatched: d(x => x.selector.stats.requestsSelected),
        alsStoresCreated: d(x => x.attrib.alsStoresCreated),
        eventBuffersAllocated: d(x => x.attrib.eventBuffersAllocated),
        boundaryContextHits: d(x => x.attrib.boundaryContextHits),
        eventsRecorded: d(x => x.capture.eventsRecorded),
        leakByModule: lb,
      };
      rows.push(row);
      console.log(`${name}/conc=${CONC}/pool=${cond}: selected=${row.selectedDuringUnmatched} alsStores=${row.alsStoresCreated} buffers=${row.eventBuffersAllocated} LEAKED_CONTEXT_HITS=${row.boundaryContextHits} events=${row.eventsRecorded} by=${JSON.stringify(lb)}`);
    } finally { child.kill("SIGKILL"); await new Promise(r => setTimeout(r, 400)); }
  }
}
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "leak-diagnosis.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  question: "after route-targeted capture is activated, do later UNMATCHED requests find a live capture context?",
  method: "activate N selected requests, then issue M unmatched requests; zero measured requests are selected, so every non-null currentRequest() is a context that outlived its request",
  rows,
}, null, 2));
