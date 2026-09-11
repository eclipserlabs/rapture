// V4 frozen treatment-artifact requirement:
//   "reproduces the exact original failure against the buggy revision"
//   "the historical fixed revision removes the original failure"
// Verified with frozen V3.3 capture + replay ONLY. The hidden oracle is not
// used and cannot substitute for artifact discrimination.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V4 = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v4";
const REG = "/Users/wira/Documents/rapture/rapture/experiments/reproducer-v3-3/src/capture/register.mjs";
const REPLAY = "/Users/wira/Documents/rapture/rapture/experiments/reproducer-v3/headline/replay-raw.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 51400;
const rows = [];
for (const c of CASES) {
  const row = { id: c.id, repository: c.repository };
  const out = mkdtempSync(join(tmpdir(), "v4disc-"));
  try {
    const buggy = join(V4, "work", `${c.id}-buggy`), fixed = join(V4, "work", `${c.id}-fixed`);
    const p = (port += 3);
    const env = { ...process.env, REPO_ROOT: buggy, PORT: String(p), ...(c.env ?? {}),
      RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: out,
      RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: c.routeKey };
    const child = spawn(process.execPath, ["--import", REG, join(root, "services", c.service)], { env, stdio: ["ignore","pipe","pipe"] });
    await new Promise((res, rej) => { let o=""; const t=setTimeout(()=>{child.kill("SIGKILL");rej(new Error("boot"));},30000);
      child.stdout.on("data",d=>{o+=d;if(o.includes("READY")){clearTimeout(t);res();}});
      child.stderr.on("data",d=>{o+=d;}); child.on("exit",()=>{clearTimeout(t);rej(new Error("exit "+o.slice(-120)));}); });
    await c.trigger(p); await sleep(900); child.kill("SIGKILL"); await sleep(400);
    const files = readdirSync(out).filter(f => f.endsWith(".json"));
    if (!files.length) { row.verdict = "NO_ARTIFACT"; rows.push(row); console.log(fmt(row)); rmSync(out,{recursive:true,force:true}); continue; }
    const art = join(out, files[0]);
    row.captured_class = JSON.parse(readFileSync(art,"utf8")).fingerprint?.normalized_class;
    for (const rev of ["buggy","fixed"]) {
      const envArg = JSON.stringify({ REPO_ROOT: rev === "buggy" ? buggy : fixed, REPLAY_HOST: "127.0.0.1", PGPORT: "54399", ...(c.env ?? {}) });
      let res;
      try {
        const o = execFileSync(process.execPath, [REPLAY, "--app", join(root,"services",c.service), "--capture", art,
          "--port", String(port += 1), "--env", envArg], { encoding: "utf8", timeout: 60000 });
        res = JSON.parse(o.trim().split("\n").at(-1));
      } catch { res = { pass: null }; }
      row[rev === "buggy" ? "replay_buggy_pass" : "replay_fixed_pass"] = res.pass;
    }
    row.verdict = row.replay_buggy_pass === true && row.replay_fixed_pass === false
      ? "DISCRIMINATING" : row.replay_buggy_pass === true && row.replay_fixed_pass === true
      ? "NON_DISCRIMINATING_ARTIFACT" : "INCONCLUSIVE";
  } catch (e) { row.verdict = "ERROR"; row.reason = String(e?.message ?? e).slice(0,120); }
  rmSync(out, { recursive: true, force: true });
  rows.push(row); console.log(fmt(row));
}
function fmt(r){return `${(r.id||"").padEnd(22)} ${String(r.verdict).padEnd(28)} buggy=${r.replay_buggy_pass} fixed=${r.replay_fixed_pass} ${r.captured_class??""}`;}
writeFileSync(join(root,"results","artifact-discrimination.json"), JSON.stringify({
  schema:"v4-artifact-discrimination-1", generatedAt:new Date().toISOString(),
  frozen_requirement:"the historical fixed revision removes the original failure (phase_4_treatment_artifact)",
  method:"frozen V3.3 capture from the buggy revision, then frozen V3.3 replay of that artifact against BOTH revisions. The hidden oracle is not used.",
  rows,
  discriminating: rows.filter(r=>r.verdict==="DISCRIMINATING").map(r=>r.id),
  non_discriminating: rows.filter(r=>r.verdict==="NON_DISCRIMINATING_ARTIFACT").map(r=>r.id),
}, null, 2));
console.log("\nDISCRIMINATING:", rows.filter(r=>r.verdict==="DISCRIMINATING").length, "| NON_DISCRIMINATING:", rows.filter(r=>r.verdict==="NON_DISCRIMINATING_ARTIFACT").length);
