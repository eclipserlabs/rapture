// V3.1 Phase 1 — fast-path attribution.
//
// Question: does a request that was NOT selected actually avoid the expensive
// V3 capture work, or does it merely discover late that it is unselected?
//
// Method: drive each selection mode with traffic that is entirely unselected,
// with RAPTURE_V31_ATTRIB=1, and read the counters. Every counter increments
// only on the expensive path, so unselected traffic must leave all of them at
// zero. A positive control drives SELECTED traffic through the same counters
// to prove they can detect the work they claim is absent.
//
// Nothing here is application-, framework- or bug-specific.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V3 = join(root, "..", "reproducer-v3");
const REGISTER = join(root, "src", "capture", "register.mjs");
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";
const PORT = 47711;
const N = 2000;

const SVC = {
  file: join(V3, "headline", "services", "express-qs.mjs"),
  env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" },
  // the measured (unselected) route
  path: (i) => `/parse?q=a%5B%5D%3D${i % 3},${(i % 3) + 1}`,
};

// Modes, and whether the driven traffic is expected to be selected.
const MODES = {
  OFF:                    { env: null, selectedExpected: false },
  DETECTOR_ONLY_UNARMED:  { env: { RAPTURE_V31_STRATEGY: "detector-only" }, selectedExpected: false },
  SAMPLE_0:               { env: { RAPTURE_V31_STRATEGY: "sampling", RAPTURE_V31_SAMPLE_RATE: "0", RAPTURE_V2_MODE: "capture" }, selectedExpected: false },
  ROUTE_SELECTIVE_UNMATCHED: { env: { RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "POST /never-hit", RAPTURE_V2_MODE: "capture" }, selectedExpected: false },
  ARMED_WINDOW_CLOSED:    { env: { RAPTURE_V31_STRATEGY: "armed-window", RAPTURE_V31_ROUTES: "GET /parse", RAPTURE_V31_WINDOW_BUDGET: "0", RAPTURE_V2_MODE: "capture" }, selectedExpected: false },
  // POSITIVE CONTROLS: the same counters, on traffic that IS selected.
  ROUTE_SELECTIVE_MATCHED: { env: { RAPTURE_V31_STRATEGY: "route-selective", RAPTURE_V31_ROUTES: "GET /parse", RAPTURE_V2_MODE: "capture" }, selectedExpected: true },
  V3_ALWAYS_ON_FULL:      { env: { RAPTURE_V31_STRATEGY: "always-on", RAPTURE_V2_MODE: "capture" }, selectedExpected: true },
};

function start(mode) {
  const cfg = MODES[mode];
  const outDir = join("/tmp", `v31attrib-${mode}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const base = { ...process.env };
  for (const k of ["RAPTURE_V2_MODE", "RAPTURE_V3_MODE", "RAPTURE_V31_STRATEGY", "RAPTURE_V31_ROUTES", "RAPTURE_V31_SAMPLE_RATE", "RAPTURE_V31_WINDOW_BUDGET"]) delete base[k];
  const env = {
    ...base, ...SVC.env, PORT: String(PORT),
    FAKE_ORIGIN: "http://localhost:47109", CAPTURE_CONFIG: "FAKE_ORIGIN",
    RAPTURE_V2_OUT: outDir, RAPTURE_V31_SEED: "20260910",
    RAPTURE_V31_ATTRIB: "1",
    ...(cfg.env ?? {}),
  };
  const args = cfg.env == null ? [SVC.file] : ["--import", REGISTER, SVC.file];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout ${mode}: ${out.slice(-400)}`)); }, 30000);
    child.stdout.on("data", (d) => { out += String(d); if (out.includes("READY")) { clearTimeout(t); resolve({ child, outDir }); } });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exit ${c} ${mode}: ${out.slice(-400)}`)); });
  });
}

async function run(mode) {
  const { child, outDir } = await start(mode);
  try {
    for (let i = 0; i < 100; i += 1) await fetch(`http://localhost:${PORT}${SVC.path(i)}`).then((r) => r.arrayBuffer());
    // reset is not possible (counters are cumulative); take a before/after delta
    const before = MODES[mode].env == null ? null : await (await fetch(`http://localhost:${PORT}/__rapture31`)).json();
    for (let i = 0; i < N; i += 1) await fetch(`http://localhost:${PORT}${SVC.path(i)}`).then((r) => r.arrayBuffer());
    const after = MODES[mode].env == null ? null : await (await fetch(`http://localhost:${PORT}/__rapture31`)).json();
    const artifacts = readdirSync(outDir).filter((f) => f.endsWith(".json")).length;
    if (after == null) {
      return { mode, instrumented: false, artifacts, note: "OFF: Rapture not installed at all" };
    }
    const d = (k) => after.attrib[k] - before.attrib[k];
    const sel = after.selector.stats.requestsSelected - before.selector.stats.requestsSelected;
    return {
      mode,
      instrumented: true,
      selectedExpected: MODES[mode].selectedExpected,
      requestsDriven: N,
      requestsSelected: sel,
      alsEnabled: after.alsEnabled,
      alsStoresCreated: d("alsStoresCreated"),
      eventBuffersAllocated: d("eventBuffersAllocated"),
      boundaryContextHits: d("boundaryContextHits"),
      boundaryContextMisses: d("boundaryContextMisses"),
      eventsRecorded: after.capture.eventsRecorded - before.capture.eventsRecorded,
      requestsPersisted: after.capture.requestsPersisted - before.capture.requestsPersisted,
      artifacts,
    };
  } finally {
    child.kill("SIGKILL");
  }
}

const results = [];
for (const mode of Object.keys(MODES)) {
  process.stdout.write(`  ${mode} ... `);
  const r = await run(mode);
  results.push(r);
  console.log(r.instrumented ? `selected=${r.requestsSelected} als=${r.alsStoresCreated} buf=${r.eventBuffersAllocated} hits=${r.boundaryContextHits} ev=${r.eventsRecorded} art=${r.artifacts}` : "not instrumented");
}

// Gate evaluation
const unselected = results.filter((r) => r.instrumented && !r.selectedExpected);
const controls = results.filter((r) => r.instrumented && r.selectedExpected);
const zeroFail = unselected.filter((r) =>
  r.requestsSelected !== 0 || r.alsStoresCreated !== 0 || r.eventBuffersAllocated !== 0 ||
  r.boundaryContextHits !== 0 || r.eventsRecorded !== 0 || r.requestsPersisted !== 0 || r.artifacts !== 0);
const controlFail = controls.filter((r) =>
  r.alsStoresCreated === 0 || r.eventBuffersAllocated === 0 || r.boundaryContextHits === 0 || r.eventsRecorded === 0);

const doc = {
  generatedAt: new Date().toISOString(),
  manifest: "manifests/V3.1-MANIFEST.json",
  requestsPerMode: N,
  results,
  gate: {
    unselected_modes: unselected.map((r) => r.mode),
    unselected_all_zero: zeroFail.length === 0,
    violations: zeroFail,
    positive_controls: controls.map((r) => r.mode),
    positive_controls_nonzero: controlFail.length === 0,
    control_violations: controlFail,
  },
  interpretation:
    "Every counter increments only on the expensive capture path. Zero across all of them for unselected traffic means an unselected request creates no AsyncLocalStorage store, allocates no event buffer, and never reaches a boundary wrapper with a live capture context — so pg result capture, fetch teeing, time/random recording, serialization and redaction cannot have run. The positive controls prove the counters detect that work when it does happen.",
};
writeFileSync(join(root, "results", "fastpath-attribution.json"), JSON.stringify(doc, null, 2));
console.log(`\nunselected all-zero: ${doc.gate.unselected_all_zero}`);
console.log(`positive controls non-zero: ${doc.gate.positive_controls_nonzero}`);
