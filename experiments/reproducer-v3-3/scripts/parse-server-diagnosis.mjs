// V3.2 Phase 3 — parse-server nondeterminism, causal diagnosis.
//
// V3.1 recorded 16/20 across two outcome classes and left the cause unknown.
// This establishes the real outcome distribution over the preregistered 100
// replays per arm, and tests the pg ownership correction as a CONTROLLED
// INTERVENTION rather than inferring causation from "parse-server uses a pool".
//
//   arm A  full pre-fix V3.1 implementation          (baseline distribution)
//   arm B  full post-fix V3.2 implementation         (corrected)
//   arm C  V3.2 with ONLY patch-pg reverted to V3.1  (single-variable revert)
//
// If the ownership defect is causal, the second outcome class must be present
// in A and C and absent in B. If C is clean, the ownership fix is NOT the
// explanation and the preregistered decision tree continues.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SLOWBOOT = join(root, "large-app", "replay-raw-slowboot.mjs");
const APP = join(root, "large-app", "server.mjs");
const CAPTURE = join(root, "results", "large-app", "capture.json");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const RUNS = Number(arg("--runs", "100"));

const ENV = JSON.stringify({
  PARSE_ROOT: "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3-1/parse-server/buggy",
  DATABASE_URI: "postgres://wira@localhost:5432/parse_v31_buggy",
  APP_ID: "v31app", MASTER_KEY: "v31master", REPLAY_HOST: "127.0.0.1",
});
const ARMS = {
  A_prefix_v31: join(root, "..", ".v32-armA", "src", "capture", "register.mjs"),
  B_postfix_v32: join(root, "src", "capture", "register.mjs"),
  C_only_pg_reverted: join(root, "..", ".v32-armC", "src", "capture", "register.mjs"),
};

let port = 49400;
function replay(registerPath) {
  port += 1;
  const r = spawnSync(process.execPath, [SLOWBOOT, "--app", APP, "--capture", CAPTURE, "--port", String(port), "--env", ENV], {
    encoding: "utf8", timeout: 90000,
    env: { ...process.env, RAPTURE_REGISTER: registerPath, REPLAY_BOOT_TIMEOUT_MS: "120000", REPLAY_TOTAL_TIMEOUT_MS: "180000" },
  });
  const last = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    const j = JSON.parse(last);
    return {
      pass: j.pass === true,
      hash: j.fingerprint?.fingerprint_hash ?? null,
      klass: j.fingerprint?.normalized_class ?? null,
      status: j.status ?? j.fingerprint?.http_status ?? null,
      error: j.error ? String(j.error).slice(0, 160) : null,
      ms: j.ms ?? null,
    };
  } catch { return { pass: false, hash: null, klass: null, status: null, error: "UNPARSEABLE:" + last.slice(0, 120), ms: null }; }
}

const expected = JSON.parse(await import("node:fs").then(m => m.promises.readFile(CAPTURE, "utf8"))).fingerprint?.fingerprint_hash ?? null;
const results = {};
for (const [arm, reg] of Object.entries(ARMS)) {
  const runs = [];
  process.stdout.write(`${arm}: `);
  for (let i = 0; i < RUNS; i++) {
    const r = replay(reg);
    runs.push(r);
    process.stdout.write(r.pass ? "." : "X");
    if ((i + 1) % 50 === 0) process.stdout.write(` ${i + 1}\n${" ".repeat(arm.length + 2)}`);
  }
  // Outcome classes: a class is (pass, normalized_class, error-signature).
  const classes = new Map();
  for (const r of runs) {
    const key = r.pass ? `PASS:${r.klass}:${r.hash?.slice(0, 12)}` : `FAIL:${r.klass ?? "none"}:${(r.error ?? "").split(";")[0].slice(0, 60)}`;
    classes.set(key, (classes.get(key) ?? 0) + 1);
  }
  const passCount = runs.filter((r) => r.pass && r.hash === expected).length;
  results[arm] = {
    register: reg, runs: RUNS,
    exact: `${passCount}/${RUNS}`,
    exactRate: +(passCount / RUNS).toFixed(3),
    outcomeClasses: [...classes.entries()].map(([k, n]) => ({ class: k, count: n })).sort((a, b) => b.count - a.count),
    outcomeClassCount: classes.size,
    medianMs: runs.map((r) => r.ms).filter(Boolean).sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? null,
    raw: runs,
  };
  console.log(`\n  ${arm}: exact=${results[arm].exact} classes=${classes.size}`);
  for (const c of results[arm].outcomeClasses) console.log(`     ${String(c.count).padStart(3)}x  ${c.class}`);
}

const doc = {
  schema: "v3-2-parse-server-diagnosis-1",
  generatedAt: new Date().toISOString(),
  expected_fingerprint: expected,
  runs_per_arm: RUNS,
  design: "same capture artifact, same application revision, same host; the ONLY variable across arms is the capture implementation. Arm C differs from arm B in exactly one file (patch-pg.mjs), which is the controlled intervention.",
  harness_note: "the V3.1 large-app replay harness never exited after firing its own total timeout (the boot-poll timer chain kept rescheduling), so a single replay could run for many minutes. Fixed in the V3.2 copy; recorded outcomes are unaffected, only the time to report them.",
  arms: results,
};
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "parse-server-diagnosis.json"), JSON.stringify(doc, null, 2));
console.log("\nwrote results/parse-server-diagnosis.json");
