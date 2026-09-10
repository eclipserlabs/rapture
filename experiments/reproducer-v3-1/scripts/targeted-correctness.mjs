// V3.1 Phase 6: correctness of TARGETED artifacts.
//
// Takes the artifacts produced by targeted arming in Phase 5 — that is,
// artifacts captured from a LATER occurrence, never from the failure that
// merely armed capture — and puts them through exactly the V3 standard:
//
//   exact offline replay 20/20 (dead PGPORT, fake external stopped)
//   -> frozen GREEDY reduction (unchanged)
//   -> portable replay 20/20 from an isolated temp directory
//   -> the historical FIXED revision no longer produces the failure
//   -> secret audit
//
// It additionally checks the property that only matters for V3.1: the
// fingerprint of the targeted artifact must EQUAL the fingerprint V3 recorded
// for the same historical incident. Capturing "some 500 on that route" would
// not be the same result.
//
// Run with the fake external DOWN.
// Usage: node scripts/targeted-correctness.mjs [--reps 20]
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INCIDENTS, loadV3Fingerprint, serviceEnv } from "./incidents.mjs";
import { greedyReduce } from "../../reproducer-v0/src/reducer.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPLAY_RAW = join(root, "..", "reproducer-v3", "headline", "replay-raw.mjs");
const ART_DIR = join(root, "results", "recurrence", "artifacts");
const OUT = join(root, "results", "targeted-correctness");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const REPS = Number(arg("--reps", "20"));
let port = 47800;

function trial(incidentId, capturePath, keepIds, revision = "buggy") {
  const def = INCIDENTS[incidentId];
  port += 1;
  const args = ["--app", def.svc, "--capture", capturePath, "--port", String(port)];
  if (keepIds != null) args.push("--keep", [...keepIds].join(","));
  const env = { ...serviceEnv(incidentId, revision), REPLAY_HOST: def.host };
  const r = spawnSync(process.execPath, [REPLAY_RAW, ...args, "--env", JSON.stringify(env)], {
    encoding: "utf8",
    timeout: 60000,
  });
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    // The frozen reducer records `fingerprint_hash: r.fingerprintHash`, so the
    // trial function must expose that exact camelCase field. Without it the
    // reducer logs `undefined` and every PASSING trial is miscounted as a
    // wrong-failure acceptance.
    out.fingerprintHash = out.fingerprint?.fingerprint_hash ?? null;
    return out;
  } catch {
    return { pass: false, fingerprint: null, error: "UNPARSEABLE", raw: (r.stdout ?? "").slice(-200) };
  }
}

const GATE = [
  /sk-live-[A-Za-z0-9]{8,}/,
  /ghp_[A-Za-z0-9]{8,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /AKIA[0-9A-Z]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/,
  /sess-alice/,
  /"passwd"|"dbpass"/,
];

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "artifacts"), { recursive: true });

// One targeted artifact per incident: the first TARGETED trial that captured.
const candidates = readdirSync(ART_DIR).filter((f) => f.endsWith(".json"));
const chosen = new Map();
for (const f of candidates.sort()) {
  const [incident, , strategy] = f.replace(/\.json$/, "").split("__");
  if (strategy !== "targeted") continue;
  if (!chosen.has(incident)) chosen.set(incident, join(ART_DIR, f));
}

const rows = [];
for (const [incidentId, capturePath] of chosen) {
  const def = INCIDENTS[incidentId];
  const doc = JSON.parse(readFileSync(capturePath, "utf8"));
  const v3fp = loadV3Fingerprint(incidentId);
  const row = {
    incident: incidentId,
    family: def.family,
    source_artifact: capturePath,
    expected_code: def.code,
    fingerprint_hash: doc.fingerprint?.fingerprint_hash ?? null,
    fingerprint_class: doc.fingerprint?.normalized_class ?? null,
    // The load-bearing V3.1 check: same historical failure, not merely a 500.
    matches_v3_fingerprint: doc.fingerprint?.fingerprint_hash === v3fp.fingerprint_hash,
    v3_fingerprint_hash: v3fp.fingerprint_hash,
    events_total: (doc.events ?? []).length,
    bug_specific_wrappers: 0,
    bug_specific_assertions: 0,
    manual_causal_facts: 0,
  };

  // 1. exact offline replay
  let pass = 0;
  const classes = new Set();
  for (let i = 0; i < REPS; i += 1) {
    const r = trial(incidentId, capturePath, null);
    if (r.pass) pass += 1;
    classes.add(r.fingerprint?.fingerprint_hash ?? "NONE");
  }
  row.offline_pass = `${pass}/${REPS}`;
  row.replay_classes = classes.size;

  // 2. frozen GREEDY reduction (unchanged from V1/V2/V3)
  const atoms = [
    ...(doc.events ?? []).map((e) => ({ id: `evt:${e.seq}` })),
    ...Object.keys(doc.config ?? {}).map((k) => ({ id: `cfg:${k}` })),
  ];
  const trials = [];
  const full = trial(incidentId, capturePath, null);
  if (!full.pass) {
    row.status = "OFFLINE_REPLAY_FAILED";
    rows.push(row);
    continue;
  }
  const g = greedyReduce(atoms, (keep) => trial(incidentId, capturePath, keep), (t) => trials.push(t));
  row.reduce_trials = trials.length;
  row.wrong_accepts = trials.filter(
    (t) => t.pass && t.fingerprint_hash !== row.fingerprint_hash,
  ).length;
  const kept = g.keptIds;
  const keptEvents = (doc.events ?? []).filter((e) => kept.has(`evt:${e.seq}`));
  const keptConfig = {};
  for (const [k, v] of Object.entries(doc.config ?? {})) {
    if (kept.has(`cfg:${k}`)) keptConfig[k] = v;
  }
  const artifact = {
    ...doc,
    events: keptEvents,
    config: keptConfig,
    source_capture_hash: doc.capture_hash,
    expected_fingerprint: doc.fingerprint,
    reducer: "greedy-frozen-v1",
    reduced_from_events: row.events_total,
  };
  const artPath = join(OUT, "artifacts", `${incidentId}.json`);
  writeFileSync(artPath, `${JSON.stringify(artifact, null, 2)}\n`);
  row.artifact = artPath;
  row.atoms = `${keptEvents.length}/${row.events_total}`;
  row.artifact_bytes = readFileSync(artPath, "utf8").length;
  row.artifact_sha = createHash("sha256").update(readFileSync(artPath)).digest("hex");

  // 3. portable replay from an isolated directory (artifact only)
  const iso = mkdtempSync(join(tmpdir(), `v31-portable-${incidentId}-`));
  const isoPath = join(iso, "artifact.json");
  cpSync(artPath, isoPath);
  let pPass = 0;
  for (let i = 0; i < REPS; i += 1) {
    if (trial(incidentId, isoPath, null).pass) pPass += 1;
  }
  row.portable_pass = `${pPass}/${REPS}`;

  // 4. buggy vs fixed
  const fixed = trial(incidentId, isoPath, null, "fixed");
  row.fixed_pass = fixed.pass === true;
  row.fixed_status = fixed.status ?? fixed.error ?? null;
  row.fixed_fingerprint_absent =
    (fixed.fingerprint?.fingerprint_hash ?? null) !== row.fingerprint_hash;
  row.fix_status = row.fixed_pass
    ? "FIX_NOT_CONFIRMED"
    : row.fixed_fingerprint_absent
      ? "FIX_CONFIRMED"
      : "FIX_INCONCLUSIVE";

  // 5. secret audit
  const hay = [readFileSync(artPath, "utf8"), readFileSync(capturePath, "utf8")];
  row.secret_leaks = GATE.filter((re) => hay.some((h) => re.test(h))).length;
  row.abs_path_leak = hay.some((h) => h.includes("/Users/") || h.includes(".rapture/"));

  row.status =
    pass === REPS &&
    pPass === REPS &&
    row.fix_status === "FIX_CONFIRMED" &&
    row.secret_leaks === 0 &&
    row.matches_v3_fingerprint
      ? "TARGETED_CAPTURE_SUPPORTED"
      : "NEEDS_REVIEW";
  rows.push(row);
  console.log(
    `${incidentId}: offline ${row.offline_pass} portable ${row.portable_pass} fix=${row.fix_status} v3fp=${row.matches_v3_fingerprint} leaks=${row.secret_leaks} => ${row.status}`,
  );
  writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
}
writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log(`wrote ${join(OUT, "summary.json")}`);
