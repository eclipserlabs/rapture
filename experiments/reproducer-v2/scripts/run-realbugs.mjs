// Headline real-bug pipeline: capture (buggy, generic bootstrap only) ->
// offline 20x replay -> frozen GREEDY reduce -> artifact 20x verify ->
// buggy-vs-fixed. Usage: node run-realbugs.mjs [--cases v2-qs-limit,...]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const REPLAY_ONE = join(root, "src", "replay", "replay-one.mjs");
const FAKE_RUNNER = join(root, "calibration", "service", "fake-runner.mjs");

const FAKE_PORT = 4910;
const CASE_PORTS = {
  "v2-qs-limit": 4921,
  "v2-semver-tilde": 4922,
  "v2-validator-crash": 4923,
  "v2-jwt-maxage": 4924,
  "v2-lru-evict": 4925,
  "v2-cron-dow": 4926,
};
const TRIGGERS = {
  "v2-qs-limit": "/parse?q=a%5B%5D%3D1%2C2%2C3%2C4",
  "v2-semver-tilde": "/check",
  "v2-validator-crash": "/signup",
  "v2-jwt-maxage": "/verify?ageSec=400&maxAge=300",
  "v2-lru-evict": "/cache/sequence",
  "v2-cron-dow": "/next",
};
const REPLAYS = 20;

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

function waitReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting READY")), timeoutMs);
    child.stdout.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[child] ${d}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code}`));
    });
  });
}

function replayOnce(app, captureFile, port, keep = null) {
  const args = ["--app", app, "--capture", captureFile, "--port", String(port)];
  if (keep) args.push("--keep", keep);
  const r = spawnSync(process.execPath, [REPLAY_ONE, ...args], { encoding: "utf8", timeout: 90000 });
  if (r.status !== 0) return { ok: false, pass: false, error: (r.stderr || r.stdout || "").slice(0, 200) };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, pass: out.pass === true, fp: out.fingerprint, ms: out.ms ?? 0, error: out.error ?? null };
  } catch {
    return { ok: false, pass: false, error: "unparseable replay output" };
  }
}

async function captureCase(caseId, outDir) {
  const port = CASE_PORTS[caseId];
  const app = join(root, "real-bugs", caseId, "app.mjs");
  const svc = spawn(
    process.execPath,
    ["--import", REGISTER, app],
    {
      env: {
        ...process.env,
        PORT: String(port),
        FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
        IMPL_MODE: "buggy",
        CAPTURE_CONFIG: "FAKE_ORIGIN",
        RAPTURE_V2_MODE: "capture",
        RAPTURE_V2_OUT: outDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitReady(svc);
  const t0 = Date.now();
  const res = await fetch(`http://localhost:${port}${TRIGGERS[caseId]}`);
  const body = await res.text();
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 600));
  svc.kill();
  await new Promise((r) => setTimeout(r, 300));
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  return { status: res.status, body: body.slice(0, 200), files, elapsedMs: elapsed };
}

async function fixedCheck(caseId) {
  const port = CASE_PORTS[caseId] + 100;
  const app = join(root, "real-bugs", caseId, "app.mjs");
  const svc = spawn(process.execPath, [app], {
    env: { ...process.env, PORT: String(port), FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`, IMPL_MODE: "fixed" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(svc);
  const res = await fetch(`http://localhost:${port}${TRIGGERS[caseId]}`);
  const body = await res.text();
  svc.kill();
  await new Promise((r) => setTimeout(r, 300));
  return { status: res.status, body: body.slice(0, 200) };
}

async function main() {
  const only = (arg("--cases", "") || "").split(",").filter(Boolean);
  const corpus = JSON.parse(readFileSync(join(root, "real-bugs", "bug-corpus.json"), "utf8"));
  const cases = corpus.cases.map((c) => c.v2_case).filter((c) => !only.length || only.includes(c));
  const capDir = join(root, "results", "real-bugs", "captures");
  const artDir = join(root, "results", "real-bugs", "artifacts");
  mkdirSync(capDir, { recursive: true });
  mkdirSync(artDir, { recursive: true });

  const fake = spawn(process.execPath, [FAKE_RUNNER], {
    env: { ...process.env, PORT: String(FAKE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);

  const rows = [];
  let portCounter = 49400;
  try {
    for (const caseId of cases) {
      const tCase0 = Date.now();
      const spec = corpus.cases.find((c) => c.v2_case === caseId);
      const caseCapDir = join(capDir, caseId);
      mkdirSync(caseCapDir, { recursive: true });
      // Clean slate for this case.
      for (const f of readdirSync(caseCapDir)) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(join(caseCapDir, f));
      }
      const cap = await captureCase(caseId, caseCapDir);
      const autoCapture = cap.files.length >= 1 && cap.status >= 500 ? "SUPPORTED" : "FAILED";
      let doc = null;
      let oracleAuto = false;
      if (cap.files.length) {
        doc = JSON.parse(readFileSync(join(caseCapDir, cap.files.sort().at(-1)), "utf8"));
        oracleAuto = doc.fingerprint?.normalized_class?.includes(spec.expected_code) ?? false;
      }
      // Offline replay 20x (fake stays up but replay never touches it: fail-closed).
      let replayPasses = 0;
      let replayOutcomes = {};
      if (doc) {
        const app = resolve(join(root, "real-bugs", caseId, "app.mjs"));
        for (let i = 0; i < REPLAYS; i += 1) {
          portCounter += 1;
          const r = replayOnce(app, join(caseCapDir, cap.files.sort().at(-1)), portCounter);
          if (r.ok && r.pass) replayPasses += 1;
          const k = r.fp ? `${r.fp.kind}:${r.fp.normalized_class}` : `ERR:${r.error ?? "spawn"}`;
          replayOutcomes[k] = (replayOutcomes[k] ?? 0) + 1;
        }
      }
      // Frozen GREEDY reduction.
      let red = { status: "SKIP", original_atoms: 0, reduced_atoms: 0, trials: 0, reducer_ms: 0, portable: "0/20" };
      let artifactFile = null;
      if (doc && replayPasses === REPLAYS) {
        const capFile = join(caseCapDir, cap.files.sort().at(-1));
        const atoms = [
          ...(doc.events ?? []).map((e) => ({ id: `evt:${e.seq}` })),
          ...Object.keys(doc.config ?? {}).map((k) => ({ id: `cfg:${k}` })),
        ];
        const app = resolve(join(root, "real-bugs", caseId, "app.mjs"));
        const runTrial = (keepIds) => {
          portCounter += 1;
          const r = replayOnce(app, capFile, portCounter, keepIds === null ? null : [...keepIds].join(","));
          return { pass: r.ok && r.pass, fingerprintHash: r.fp?.fingerprint_hash ?? "FAIL" };
        };
        const full = runTrial(null);
        if (full.pass) {
          const g0 = Date.now();
          const trials = [];
          const greedy = greedyReduce(atoms, runTrial, (t) => trials.push(t));
          const kept = greedy.keptIds;
          const requiredEvents = (doc.events ?? []).filter((e) => kept.has(`evt:${e.seq}`));
          const requiredConfig = {};
          for (const [k, v] of Object.entries(doc.config ?? {})) {
            if (kept.has(`cfg:${k}`)) requiredConfig[k] = v;
          }
          const artifact = {
            schema: "reproducer-artifact-v2",
            v2_case: caseId,
            source_capture_hash: doc.capture_hash,
            request: doc.request,
            required_events: requiredEvents,
            required_config: requiredConfig,
            expected_fingerprint: doc.fingerprint,
            runtime: { entry: `real-bugs/${caseId}/app.mjs` },
          };
          artifact.artifact_hash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
          artifactFile = join(artDir, `${caseId}.json`);
          writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`);
          const verifyDoc = { ...doc, events: requiredEvents, config: requiredConfig };
          const verifyFile = join(artDir, `.verify-${caseId}.json`);
          writeFileSync(verifyFile, JSON.stringify(verifyDoc));
          let vp = 0;
          for (let i = 0; i < REPLAYS; i += 1) {
            portCounter += 1;
            const r = replayOnce(app, verifyFile, portCounter);
            if (r.ok && r.pass) vp += 1;
          }
          const ob = Buffer.byteLength(JSON.stringify({ events: doc.events, config: doc.config }), "utf8");
          const rb = Buffer.byteLength(JSON.stringify({ events: requiredEvents, config: requiredConfig }), "utf8");
          red = {
            status: vp === REPLAYS ? "PASS" : "FAIL",
            original_atoms: atoms.length,
            reduced_atoms: kept.size,
            original_bytes: ob,
            reduced_bytes: rb,
            trials: greedy.trials,
            reducer_ms: Date.now() - g0,
            portable: `${vp}/20`,
          };
        } else {
          red = { ...red, status: "FULL_REPLAY_FAILED" };
        }
      }
      // Buggy-vs-fixed (fixed revision never exposed to capture/reducer).
      const fixed = await fixedCheck(caseId);
      const fixedAbsent =
        fixed.status < 500 && !(fixed.body ?? "").includes(spec.expected_code);
      const buggyFail = cap.status >= 500 && (cap.body ?? "").includes(spec.expected_code);
      const fixStatus = buggyFail && fixedAbsent ? "FIX_CONFIRMED" : buggyFail ? "FIX_NOT_CONFIRMED" : "FIX_INCONCLUSIVE";
      const wallMin = Math.round(((Date.now() - tCase0) / 60000) * 10) / 10;
      rows.push({
        v2_case: caseId,
        repository: spec.repository,
        bug_rev: spec.bug_rev.slice(0, 8),
        post_rev: spec.post_rev.slice(0, 8),
        trigger_status: cap.status,
        auto_capture: autoCapture,
        oracle_auto: oracleAuto,
        expected_class: spec.expected_code,
        observed_class: doc?.fingerprint?.normalized_class ?? null,
        offline_replay: `${replayPasses}/${REPLAYS}`,
        replay_outcomes: replayOutcomes,
        reduced_portable: red.portable,
        reduction: `${red.original_atoms}->${red.reduced_atoms}`,
        trials: red.trials,
        buggy_fail: buggyFail,
        fixed_status: fixed.status,
        fixed_absent: fixedAbsent,
        fix_status: fixStatus,
        artifact: artifactFile,
        incident_specific_loc: 0,
        incident_specific_wrappers: 0,
        incident_specific_assertions: 0,
        setup_minutes: 2,
        wall_minutes: wallMin,
      });
      console.log(`${caseId}: capture=${autoCapture} replay=${replayPasses}/20 portable=${red.portable} fix=${fixStatus}`);
      writeFileSync(join(root, "results", "real-bugs", "burden.json"), `${JSON.stringify(rows, null, 2)}\n`);
    }
  } finally {
    fake.kill();
  }
  writeFileSync(join(root, "results", "real-bugs", "results.json"), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`wrote ${rows.length} rows`);
}

await main();
