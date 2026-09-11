// V3.2 Phase 2, step 1: determine EXACTLY where raw cookie/session data
// enters a persisted capture. No fix is designed until this is known.
//
// A sentinel session value is planted in the Cookie header. The service then
// uses it the way real applications do -- including as a bare pg lookup
// parameter, with no "sess=" prefix. Every JSON path in the persisted capture
// containing the raw value is reported.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const SVC = join(root, "services", "session-probe.mjs");
const REPO = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/express-4.21.1";
const PORT = 49001;

const SENT = {
  opaque: "sess-OPAQUE0011223344",              // bare opaque handle
  signed: "s:abc123.SIGNATUREdeadbeefcafe",     // signed (cookie-signature style)
  bearerish: "eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG", // JWT-shaped session token
  irrelevant: "theme-dark-not-a-secret",
};

function start() {
  const outDir = mkdtempSync(join(tmpdir(), "v32sess-"));
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE","RAPTURE_V3_MODE","RAPTURE_V31_STRATEGY","RAPTURE_V31_ROUTES","RAPTURE_V31_ATTRIB"]) delete base[k];
  const child = spawn(process.execPath, ["--import", REGISTER, SVC], {
    env: { ...base, PORT: String(PORT), REPO_ROOT: REPO, FAKE_ORIGIN: "http://localhost:47109",
           CAPTURE_CONFIG: "FAKE_ORIGIN", RAPTURE_V2_MODE: "capture", RAPTURE_V2_OUT: outDir,
           RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /sess" },
    stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => {
    let o = ""; const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("timeout " + o.slice(-300))); }, 30000);
    child.stdout.on("data", (d) => { o += d; if (o.includes("READY")) { clearTimeout(t); res({ child, outDir }); } });
    child.stderr.on("data", (d) => { o += d; });
    child.on("exit", (c) => { clearTimeout(t); rej(new Error(`exit ${c} ${o.slice(-300)}`)); });
  });
}

/** Every JSON path whose stringified value contains `needle`. */
function findPaths(node, needle, path = "$", out = []) {
  if (node == null) return out;
  if (typeof node === "string") { if (node.includes(needle)) out.push({ path, sample: node.slice(0, 120) }); return out; }
  if (typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((v, i) => findPaths(v, needle, `${path}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k.includes(needle)) out.push({ path: `${path}.${k} (KEY)`, sample: k.slice(0, 120) });
    findPaths(v, needle, `${path}.${k}`, out);
  }
  return out;
}

const { child, outDir } = await start();
let doc = null;
try {
  await fetch(`http://localhost:${PORT}/sess`, {
    headers: { cookie: `sess=${SENT.opaque}; auth=${SENT.signed}; jwt=${SENT.bearerish}; theme=${SENT.irrelevant}` },
  }).then((r) => r.arrayBuffer());
  await new Promise((r) => setTimeout(r, 800));
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Error("no incident persisted");
  doc = JSON.parse(readFileSync(join(outDir, files[0]), "utf8"));
  const raw = readFileSync(join(outDir, files[0]), "utf8");
  const report = {
    schema: "v3-2-session-location-1",
    generatedAt: new Date().toISOString(),
    note: "measured against the CURRENT V3.2 tree; redact.mjs is byte-identical to frozen V3, so these locations are inherited V3 behaviour",
    existing_mechanism: "redact.mjs SESSION_PAIR maps `(sess|session|sid)=<value>` to `[SESS:sha12]`; SENSITIVE_HEADER covers cookie/set-cookie/authorization/x-api-key/*token*/*secret*",
    sentinels: SENT,
    locations: {},
    surrogates_present: [...new Set(raw.match(/\[SESS:[0-9a-f]{12}\]/g) ?? [])],
  };
  for (const [name, value] of Object.entries(SENT)) {
    const paths = findPaths(doc, value);
    report.locations[name] = { value, rawOccurrences: paths.length, paths };
  }
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "results", "session-location.json"), JSON.stringify(report, null, 2));
  for (const [name, r] of Object.entries(report.locations)) {
    console.log(`${name.padEnd(11)} rawOccurrences=${r.rawOccurrences}${r.rawOccurrences ? "  -> " + r.paths.map((p) => p.path).join(", ") : ""}`);
  }
  console.log(`surrogates present: ${report.surrogates_present.join(", ") || "none"}`);
} finally { child.kill("SIGKILL"); rmSync(outDir, { recursive: true, force: true }); }
