// V3.2 Phase 2 — session-credential safety.
//
// Required cases (preregistered):
//   1 opaque session id where only equality matters -> surrogate, replay intact
//   2 session value reused as a pg lookup parameter -> same surrogate in both places
//   3 signed / cryptographically meaningful cookie  -> PRIVACY_BLOCKED, never raw
//   4 same credential across request and boundary events -> one stable surrogate
//   5 irrelevant cookie values -> preserved, not mangled
//   6 cross-request confidentiality under pg pool contention
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(root, "services", "session-probe.mjs");
const REPLAY_RAW = join(root, "..", "reproducer-v3", "headline", "replay-raw.mjs");
const REPO = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/express-4.21.1";
let PORT = 49100;

const OPAQUE = "sess-OPAQUE0011223344";
const SIGNED = "s:userid42.SIGNATUREdeadbeefcafe1234";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM";
const PLAIN = "dark";

function start(extra = {}, poolMax = null) {
  const port = (PORT += 1);
  const outDir = mkdtempSync(join(tmpdir(), "v32ss2-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_ATTRIB","PGPOOL_MAX"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: { ...base, PORT: String(port), REPO_ROOT: REPO, FAKE_ORIGIN: "http://localhost:47109",
           CAPTURE_CONFIG: "FAKE_ORIGIN", RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
           RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /sess",
           ...(poolMax ? { PGPOOL_MAX: String(poolMax) } : {}), ...extra },
    stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => {
    let o = ""; const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("timeout " + o.slice(-300))); }, 30000);
    child.stdout.on("data", (d) => { o += d; if (o.includes("READY")) { clearTimeout(t); res({ child, outDir, port }); } });
    child.stderr.on("data", (d) => { o += d; });
    child.on("exit", (c) => { clearTimeout(t); rej(new Error(`exit ${c} ${o.slice(-300)}`)); });
  });
}
const files = (d) => readdirSync(d).filter((f) => f.endsWith(".json"));
const findings = [];
const rec = (id, description, pass, detail) => {
  findings.push({ id, description, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${description}${detail ? " — " + detail : ""}`);
};

// --- Case 1/2/4/5: opaque handle, reused as a pg param, plus an irrelevant cookie
let opaqueCapture = null;
{
  const { child, outDir, port } = await start();
  try {
    await fetch(`http://localhost:${port}/sess`, { headers: { cookie: `sess=${OPAQUE}; theme=${PLAIN}` } }).then((r) => r.arrayBuffer());
    await new Promise((r) => setTimeout(r, 800));
    const f = files(outDir);
    const text = f.length ? readFileSync(join(outDir, f[0]), "utf8") : "";
    const doc = f.length ? JSON.parse(text) : null;
    const surr = [...new Set(text.match(/\[SESS:[0-9a-f]{12}\]/g) ?? [])];
    rec("SESS-1", "opaque session handle never persists raw", !text.includes(OPAQUE),
      `artifacts=${f.length} rawPresent=${text.includes(OPAQUE)}`);
    rec("SESS-2", "the same credential yields ONE stable surrogate everywhere it appears",
      surr.length === 1, `distinctSurrogates=${surr.length} ${surr.join(",")}`);
    const cookieHdr = doc?.request?.headers?.cookie ?? "";
    const pgVals = (doc?.events ?? []).filter((e) => e.kind === "pg").flatMap((e) => e.request?.values ?? []);
    rec("SESS-3", "cookie header and pg parameter carry the identical surrogate",
      surr.length === 1 && cookieHdr.includes(surr[0]) && pgVals.some((v) => String(v).includes(surr[0])),
      `cookie="${cookieHdr}" pgValues=${JSON.stringify(pgVals)}`);
    rec("SESS-4", "irrelevant cookie value is preserved, not mangled",
      cookieHdr.includes(`theme=${PLAIN}`), `cookie="${cookieHdr}"`);
    if (f.length) { opaqueCapture = join(tmpdir(), `v32keep-${Date.now()}.json`); writeFileSync(opaqueCapture, text); }
  } finally { child.kill("SIGKILL"); rmSync(outDir, { recursive: true, force: true }); }
}

// --- Replay fidelity: the surrogated artifact must still reproduce the failure
if (opaqueCapture) {
  const port = (PORT += 1);
  const r = spawnSync(process.execPath, [REPLAY_RAW, "--app", SVC, "--capture", opaqueCapture, "--port", String(port),
    "--env", JSON.stringify({ REPO_ROOT: REPO, REPLAY_HOST: "127.0.0.1", PGPORT: "54399" })],
    { encoding: "utf8", timeout: 60000 });
  let out = null;
  try { out = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1)); } catch { /* left null */ }
  rec("SESS-5", "surrogated artifact still replays the exact failure offline",
    out?.pass === true && out?.fingerprint?.normalized_class === "ERR:E_SESS_PROBE",
    `pass=${out?.pass} class=${out?.fingerprint?.normalized_class ?? "none"} status=${out?.status ?? "?"}`);
  rmSync(opaqueCapture, { force: true });
}

// --- Case 3: signed cookie and JWT must fail closed, never persist raw
for (const [label, value] of [["signed cookie", SIGNED], ["JWT-shaped token", JWT]]) {
  const { child, outDir, port } = await start();
  try {
    await fetch(`http://localhost:${port}/sess`, { headers: { cookie: `auth=${value}` } }).then((r) => r.arrayBuffer());
    await new Promise((r) => setTimeout(r, 800));
    const f = files(outDir);
    const text = f.map((x) => readFileSync(join(outDir, x), "utf8")).join("\n");
    const docs = f.map((x) => JSON.parse(readFileSync(join(outDir, x), "utf8")));
    const blockedDocs = docs.filter((d) => d.status === "PRIVACY_BLOCKED_SESSION_CREDENTIAL");
    rec(`SESS-6-${label.split(" ")[0]}`, `${label} is privacy-blocked and never persists raw`,
      !text.includes(value) && blockedDocs.length === 1 && docs.every((d) => d.executable !== true),
      `raw=${text.includes(value)} blocked=${blockedDocs.length} executable=${docs.map((d) => d.executable ?? "n/a").join(",")}`);
  } finally { child.kill("SIGKILL"); rmSync(outDir, { recursive: true, force: true }); }
}

// --- Case 6: cross-request confidentiality under pg pool contention.
//     An UNSELECTED request's session credential must never reach a SELECTED
//     incident, even though that value would be transformable if it were the
//     selected request's own.
{
  const { child, outDir, port } = await start({ RAPTURE_V31_ROUTES: "GET /sess" }, 2);
  try {
    const UNSEL = "sess-UNSELECTED99887766";
    const paths = [];
    for (let i = 0; i < 300; i++) paths.push(i % 10 === 0 ? { p: "/sess", c: `sess=${OPAQUE}` } : { p: "/quiet", c: `sess=${UNSEL}` });
    let n = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      for (;;) { const i = n++; if (i >= paths.length) return;
        try { await (await fetch(`http://localhost:${port}${paths[i].p}`, { headers: { cookie: paths[i].c } })).arrayBuffer(); } catch {} }
    }));
    await new Promise((r) => setTimeout(r, 900));
    const text = files(outDir).map((x) => readFileSync(join(outDir, x), "utf8")).join("\n");
    const unselSurrogate = null; // surrogates are shape-derived, so compare on the raw value AND its surrogate
    rec("SESS-7", "an unselected request's session credential never reaches a selected incident (raw)",
      !text.includes(UNSEL), `incidents=${files(outDir).length} rawUnselectedPresent=${text.includes(UNSEL)}`);
    // The surrogate of the unselected credential must also be absent: a
    // transformed foreign credential is still a cross-request disclosure.
    const { createHash } = await import("node:crypto");
    const unselSurr = `[SESS:${createHash("sha256").update(UNSEL).digest("hex").slice(0, 12)}]`;
    rec("SESS-8", "not even the SURROGATE of an unselected credential reaches a selected incident",
      !text.includes(unselSurr), `surrogate=${unselSurr} present=${text.includes(unselSurr)}`);
  } finally { child.kill("SIGKILL"); rmSync(outDir, { recursive: true, force: true }); }
}

const doc = {
  schema: "v3-2-session-safety-1", generatedAt: new Date().toISOString(),
  mechanism: "shape-derived standalone credential classification: markers are fixed points, signature-bearing values are blocked, opaque handles become a deterministic [SESS:sha12] surrogate applied identically to headers, pg parameters and replay keys",
  findings, allPassed: findings.every((f) => f.pass),
};
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "session-safety.json"), JSON.stringify(doc, null, 2));
console.log(`\nall passed: ${doc.allPassed}`);
