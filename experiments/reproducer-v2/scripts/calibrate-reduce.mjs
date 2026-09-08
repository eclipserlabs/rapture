// Reduce calibration captures with the FROZEN V1 GREEDY reducer (no changes).
// Usage: node calibrate-reduce.mjs [--captures <dir>] [--app <entry>]
// Atoms: evt:<seq> per boundary event + cfg:<name> per config entry.
// Each trial replays the subset in a fresh offline process via replay-one.mjs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPLAY_ONE = join(root, "src", "replay", "replay-one.mjs");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

let portCounter = 48400;

function trialReplay(app, captureFile, keepIds) {
  portCounter += 1;
  const args = ["--app", app, "--capture", captureFile, "--port", String(portCounter)];
  if (keepIds !== null) args.push("--keep", [...keepIds].join(","));
  const start = Date.now();
  const r = spawnSync(process.execPath, [REPLAY_ONE, ...args], { encoding: "utf8", timeout: 60000 });
  const wallMs = Date.now() - start;
  if (r.status !== 0) {
    return { pass: false, fingerprintHash: "SPAWN_FAIL", wallMs };
  }
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { pass: out.pass === true, fingerprintHash: out.fingerprint?.fingerprint_hash ?? "NO_FP", wallMs };
  } catch {
    return { pass: false, fingerprintHash: "UNPARSEABLE", wallMs };
  }
}

async function main() {
  const capDir = arg("--captures", join(root, "results", "calibration", "captures"));
  const app = arg("--app", join(root, "calibration", "service", "server.mjs"));
  const outDir = join(root, "results", "calibration");
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(capDir).filter((f) => f.endsWith(".json")).sort();
  const rows = [];
  for (const f of files) {
    const capFile = join(capDir, f);
    const doc = JSON.parse(readFileSync(capFile, "utf8"));
    const expectedHash = doc.fingerprint.fingerprint_hash;
    const atoms = [
      ...(doc.events ?? []).map((e) => ({ id: `evt:${e.seq}` })),
      ...Object.keys(doc.config ?? {}).map((k) => ({ id: `cfg:${k}` })),
    ];
    const trials = [];
    const onTrial = (t) => trials.push(t);
    const runTrial = (keepIds) => trialReplay(app, capFile, keepIds);
    const full = trialReplay(app, capFile, null);
    if (!full.pass) {
      rows.push({ file: f, status: "FULL_REPLAY_FAILED" });
      console.log(`${doc.request.path}: FULL replay failed, skipping reduction`);
      continue;
    }
    const gStart = Date.now();
    const greedy = greedyReduce(atoms, runTrial, onTrial);
    const greedyMs = Date.now() - gStart;
    const kept = greedy.keptIds;
    const required_events = (doc.events ?? []).filter((e) => kept.has(`evt:${e.seq}`));
    const required_config = {};
    for (const [k, v] of Object.entries(doc.config ?? {})) {
      if (kept.has(`cfg:${k}`)) required_config[k] = v;
    }
    const artifact = {
      schema: "reproducer-artifact-v2",
      source_capture_hash: doc.capture_hash,
      request: doc.request,
      required_events,
      required_config,
      expected_fingerprint: doc.fingerprint,
      runtime: { entry: "calibration/service/server.mjs" },
    };
    artifact.artifact_hash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
    const artFile = join(outDir, `artifact-${doc.request.path.replaceAll("/", "_")}.json`);
    writeFileSync(artFile, `${JSON.stringify(artifact, null, 2)}\n`);
    // Verify artifact-only replay 20/20: write temp capture-shaped file.
    const verifyDoc = { ...doc, events: required_events, config: required_config };
    const verifyFile = join(outDir, `.verify-${f}`);
    writeFileSync(verifyFile, JSON.stringify(verifyDoc));
    let passes = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = trialReplay(app, verifyFile, null);
      if (r.pass) passes += 1;
    }
    const origBytes = Buffer.byteLength(JSON.stringify({ events: doc.events, config: doc.config }), "utf8");
    const redBytes = Buffer.byteLength(JSON.stringify({ events: required_events, config: required_config }), "utf8");
    rows.push({
      file: f,
      path: doc.request.path,
      original_atoms: atoms.length,
      reduced_atoms: kept.size,
      original_bytes: origBytes,
      reduced_bytes: redBytes,
      trials: greedy.trials,
      reducer_ms: greedyMs,
      portable: `${passes}/20`,
      status: passes === 20 ? "PASS" : "FAIL",
    });
    console.log(
      `${doc.request.path}: atoms ${atoms.length}->${kept.size} bytes ${origBytes}->${redBytes} portable ${passes}/20`,
    );
  }
  writeFileSync(join(outDir, "reduction.json"), `${JSON.stringify(rows, null, 2)}\n`);
}

await main();
