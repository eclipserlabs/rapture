// V3.1 privacy regression: the FROZEN V3 gate-tier attack suite, re-pointed at
// the V3.1 implementation and run with every sentinel request SELECTED
// (strategy always-on), so the suite has the same coverage it had in V3.
// Any new raw gate-tier leak is a hard failure.
//
// Detector-only / sampling / arming-state privacy is covered separately by
// scripts/privacy-selective.mjs.
//
// Original V3 header follows.
// Privacy attack suite driver. Generates per-run random sentinels, seeds
// sentinel DB rows, captures one failing request per route under the FROZEN
// capture implementation, then asserts:
//  - GATE tier: every provider-shaped credential sentinel absent raw from
//    every capture and reduced artifact; PII absent from credential slots.
//  - replay: gate captures replay offline 5x with exact fingerprint.
//  - GAP tier: JWT/PEM/card/password-value/base64 shapes reported (findings).
// Writes results/privacy/attack.json. Exits nonzero on any gate failure.
// Usage: node scripts/privacy-attack.mjs
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REGISTER = join(root, "src", "capture", "register.mjs");
const REPLAY_ONE = join(root, "src", "replay", "replay-one.mjs");

const SVC_PORT = 47221;
const FAKE_PORT = 47229;
const OUT = join(root, "results", "privacy", "captures");
const ART = join(root, "results", "privacy", "artifacts");
const REPLAYS = 5;

const PG_URL = new URL("../../reproducer-v2/node_modules/pg/lib/index.js", import.meta.url);
const { default: pg } = await import(PG_URL.href);

const hex = (n) => randomBytes(n).toString("hex");
const R = hex(4);
const S = {
  sk1: `sk-live-${hex(8)}`,
  sk2: `sk-live-${hex(8)}`,
  sk3: `sess-sk-live-${hex(6)}`,
  sk4: `sk-live-${hex(8)}`,
  sk5: `sk-live-${hex(8)}`,
  sk6: `sk-live-${hex(8)}`,
  sk7: `sk-live-${hex(8)}`,
  sk8: `sk-live-${hex(8)}`,
  email: `u-${R}@example.com`,
  phone: `+1-415-555-${1000 + (parseInt(R.slice(0, 4), 16) % 9000)}`,
  uid: `user-${R}`,
  jwt: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: R })).toString("base64url")}.${hex(16)}`,
  pem: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(R + R + R).toString("base64")}\n-----END PRIVATE KEY-----`,
  card: `4111111111111111`,
  passval: `hunter2-${R}`,
  b64sk: Buffer.from(`sk-live-${hex(8)}`).toString("base64"),
  cfg: `cfg-sk-live-${hex(8)}`,
};
const GATE_SECRETS = [S.sk1, S.sk2, S.sk3, S.sk4, S.sk5, S.sk6, S.sk7, S.sk8, S.cfg];
const PII = [S.email, S.phone, S.uid];

function waitReady(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("READY timeout")), ms);
    child.stdout.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[child] ${d}`));
    child.on("exit", (c) => {
      clearTimeout(t);
      reject(new Error(`child exited ${c}`));
    });
  });
}

async function seed() {
  const pool = new pg.Pool({
    host: process.env["PGHOST"] ?? "localhost",
    port: Number(process.env["PGPORT"] ?? 5432),
    user: process.env["PGUSER"] ?? "wira",
    database: process.env["PGDATABASE"] ?? "repro_v2",
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS v3priv_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS v3priv_users (id TEXT PRIMARY KEY, profile TEXT NOT NULL)`);
  await pool.query(`DELETE FROM v3priv_kv`);
  await pool.query(`DELETE FROM v3priv_users`);
  await pool.query(`INSERT INTO v3priv_kv(k, v) VALUES ('seed', 'x')`);
  await pool.query(`INSERT INTO v3priv_users(id, profile) VALUES ($1, $2)`, [
    S.email,
    JSON.stringify({ email: S.email, phone: S.phone, apiKey: S.sk6, nested: { uid: S.uid } }),
  ]);
  await pool.end();
}

function replayOnce(app, captureFile, port) {
  const r = spawnSync(process.execPath, [REPLAY_ONE, "--app", app, "--capture", captureFile, "--port", String(port)], {
    encoding: "utf8",
    timeout: 90000,
  });
  if (r.status !== 0) return { ok: false, pass: false };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, pass: out.pass === true, fp: out.fingerprint?.normalized_class ?? null };
  } catch {
    return { ok: false, pass: false };
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(ART, { recursive: true });
  // Purge stale captures from earlier runs (sentinels are per-run).
  const { rmSync } = await import("node:fs");
  rmSync(OUT, { recursive: true, force: true });
  rmSync(ART, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(ART, { recursive: true });
  await seed();

  const fake = spawn(process.execPath, [join(root, "..", "reproducer-v3", "privacy", "fake-priv.mjs")], {
    env: { ...process.env, PORT: String(FAKE_PORT), SECRET_SENTINEL_JSON: JSON.stringify({ sk2: S.sk2, email: S.email, jwt: S.jwt }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(fake);
  const svc = spawn(process.execPath, ["--import", REGISTER, join(root, "..", "reproducer-v3", "privacy", "sentinel-app.mjs")], {
    env: {
      ...process.env,
      PORT: String(SVC_PORT),
      FAKE_ORIGIN: `http://localhost:${FAKE_PORT}`,
      CAPTURE_CONFIG: "FAKE_ORIGIN,SECRET_CONFIG",
      SECRET_CONFIG: S.cfg,
      RAPTURE_V2_MODE: "capture",
      RAPTURE_V31_STRATEGY: "always-on",
      RAPTURE_V2_OUT: OUT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const results = { sentinelsSha: null, routes: {}, gate: {}, gap: {} };
  try {
    await waitReady(svc);
    const get = (p, headers = {}) => fetch(`http://localhost:${SVC_PORT}${p}`, { headers }).then(async (r) => ({ status: r.status, body: await r.text() }));
    const triggers = [
      ["h", () => get("/h", { authorization: `Bearer ${S.sk1}`, cookie: `sess=${S.sk3}; theme=dark` })],
      ["q", () => get(`/q?api_key=${encodeURIComponent(S.sk4)}&email=${encodeURIComponent(S.email)}`)],
      ["j", () => fetch(`http://localhost:${SVC_PORT}/j`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${S.sk1}` }, body: JSON.stringify({ user: { email: S.email, phone: S.phone }, apiKey: S.sk5, note: "n" }) }).then(async (r) => ({ status: r.status, body: await r.text() }))],
      ["db", () => get(`/db?id=${encodeURIComponent(S.email)}`)],
      ["cfg", () => get("/cfg")],
      ["same", () => fetch(`http://localhost:${SVC_PORT}/same?debug=${encodeURIComponent(S.sk7)}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": S.sk7 }, body: JSON.stringify({ echo: S.sk7, nested: { deep: [S.sk7] } }) }).then(async (r) => ({ status: r.status, body: await r.text() }))],
      ["sub", () => fetch(`http://localhost:${SVC_PORT}/sub`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: "ticket-1", note: `reference ${S.sk8} confirmed` }) }).then(async (r) => ({ status: r.status, body: await r.text() }))],
      ["gap", () => fetch(`http://localhost:${SVC_PORT}/gap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jwt: S.jwt, pem: S.pem, card: S.card, password: S.passval, bearer: `Bearer ${hex(12)}`, b64: S.b64sk }) }).then(async (r) => ({ status: r.status, body: await r.text() }))],
    ];
    for (const [name, fire] of triggers) {
      const r = await fire();
      results.routes[name] = { status: r.status, body: r.body.slice(0, 120) };
      console.log(name, r.status, r.body.slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, 800));
  } finally {
    try {
      svc.kill("SIGKILL");
    } catch {}
    try {
      fake.kill("SIGKILL");
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  const files = readdirSync(OUT).filter((f) => f.endsWith(".json")).sort();
  const docs = files.map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(OUT, f), "utf8")) }));
  console.log(`captured ${docs.length} incidents`);

  // GATE: provider-shaped credential sentinels absent raw everywhere.
  let gateLeaks = [];
  for (const { file, doc } of docs) {
    const blob = JSON.stringify(doc);
    for (const s of GATE_SECRETS) {
      if (blob.includes(s)) gateLeaks.push({ file, sentinel: s.slice(0, 12) + "…" });
    }
  }
  // GATE: PII sentinels absent from credential-name slots (auth headers,
  // cookies, secret-named params/config) — checked on raw doc text near
  // credential keys.
  let piiViolations = [];
  for (const { file, doc } of docs) {
    const blob = JSON.stringify(doc);
    for (const p of PII) {
      const i = blob.indexOf(p);
      if (i === -1) continue;
      const window = blob.slice(Math.max(0, i - 120), i);
      if (/(authorization|cookie|x-api-key|api_key|secret|password|token)"\s*:\s*"?[^",}]*$/.test(window)) {
        piiViolations.push({ file, pii: p.slice(0, 10) + "…" });
      }
    }
  }
  // Retained-PII inventory (documented, fidelity-needed).
  let retained = [];
  for (const { file, doc } of docs) {
    const blob = JSON.stringify(doc);
    for (const p of PII) if (blob.includes(p)) retained.push({ file, pii: p.slice(0, 10) + "…" });
  }

  // Replay gate captures offline + reduce + audit artifacts.
  const app = resolve(join(root, "..", "reproducer-v3", "privacy", "sentinel-app.mjs"));
  let port = 47200;
  let replayFails = [];
  let replayDivergences = 0;
  const { createHash } = await import("node:crypto");
  for (const { file, doc } of docs) {
    if (doc.fingerprint?.normalized_class === "ERR:E_PRIV_GAP") continue; // gap tier: no replay gate
    let passes = 0;
    for (let i = 0; i < REPLAYS; i += 1) {
      port += 1;
      const r = replayOnce(app, join(OUT, file), port);
      if (r.ok && r.pass) passes += 1;
      else if (r.ok && r.fp && r.fp !== doc.fingerprint.normalized_class) replayDivergences += 1;
    }
    if (passes !== REPLAYS) replayFails.push({ file, passes });
    // Artifact audit on the full (unreduced) event set; reduction fidelity
    // is headline's job (Phase 7), privacy's job is absence + replay.
    const artifact = { schema: "reproducer-artifact-v2", request: doc.request, required_events: doc.events, required_config: doc.config, expected_fingerprint: doc.fingerprint };
    artifact.artifact_hash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
    writeFileSync(join(ART, file), JSON.stringify(artifact, null, 2));
    const ablob = JSON.stringify(artifact);
    for (const s of GATE_SECRETS) {
      if (ablob.includes(s)) gateLeaks.push({ file: `artifact:${file}`, sentinel: s.slice(0, 12) + "…" });
    }
  }

  // GAP tier: report raw presence per shape (findings, not gates).
  const gapDoc = docs.find((d) => d.doc.fingerprint?.normalized_class === "ERR:E_PRIV_GAP");
  const gapBlob = gapDoc ? JSON.stringify(gapDoc.doc) : "";
  const gapFindings = {
    jwt_raw_present: gapBlob.includes(S.jwt),
    pem_raw_present: gapBlob.includes("BEGIN PRIVATE KEY"),
    card_raw_present: gapBlob.includes(S.card),
    password_value_raw_present: gapBlob.includes(S.passval),
    base64_sk_raw_present: gapBlob.includes(S.b64sk),
  };

  results.gate = { captures: docs.length, gate_secret_leaks: gateLeaks, pii_violations: piiViolations, replay_failures: replayFails, replay_divergences: replayDivergences };
  results.retainedPII = retained;
  results.gap = gapFindings;
  const { createHash: ch } = await import("node:crypto");
  results.sentinelsSha = ch("sha256").update(JSON.stringify(S)).digest("hex").slice(0, 16);
  writeFileSync(join(root, "results", "privacy", "attack.json"), JSON.stringify(results, null, 2));
  console.log(`gate leaks: ${gateLeaks.length}, pii violations: ${piiViolations.length}, replay fails: ${replayFails.length}, divergent: ${replayDivergences}`);
  console.log("gap:", JSON.stringify(gapFindings));
  if (gateLeaks.length || piiViolations.length || replayFails.length || replayDivergences) process.exitCode = 1;
}

await main();
