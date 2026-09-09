// Baseline matrix: boot each incident's buggy + fixed revisions WITHOUT
// capture, run the trigger, record status/body. Expects fake external on
// FAKE_ORIGIN and local Postgres (v3dir_sessions seeded).
// Usage: node baseline.mjs (runs all, prints table)
import { spawn } from "node:child_process";

const NODE = process.env["NODE22"] ?? process.argv[2] ?? process.execPath;
const HL = new URL("/Users/wira/Documents/rapture/rapture/experiments/reproducer-v3/headline/", import.meta.url)
  .pathname;
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

const CASES = [
  { id: "koa-1999", svc: "koa-1999.mjs", port: 47401, buggy: "koa-1061776", fixed: "koa-571938d" },
  { id: "koa-1998", svc: "koa-1998.mjs", port: 47402, buggy: "koa-4a191b1", fixed: "koa-1061776" },
  { id: "express-cookie", svc: "express-cookie.mjs", port: 47403, buggy: "express-4.19.2", fixed: "express-4.21.1" },
  { id: "express-qs", svc: "express-qs.mjs", port: 47404, buggy: "express-4.21.1", fixed: "express-4.21.1", qs: true },
  { id: "fastify-32442", svc: "fastify-32442.mjs", port: 47405, buggy: "fastify-5.3.0", fixed: "fastify-5.3.2" },
  { id: "express-semver", svc: "express-semver.mjs", port: 47409, buggy: "express-4.21.1", fixed: "express-4.21.1", semver: true },
  { id: "hapi-4560", svc: "hapi-4560.mjs", port: 47407, buggy: "hapi-5095382", fixed: "hapi-ee8475b" },
  { id: "hapi-4564", svc: "hapi-4564.mjs", port: 47408, buggy: "hapi-62032e6", fixed: "hapi-97c435f" },
];

function start(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [env.svc], { env: { ...process.env, ...env.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting READY for ${env.id}: ${out}`));
    }, 30000);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (c) => {
      out += c;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exit ${code} for ${env.id}: ${out.slice(-2000)}`));
    });
  });
}

function trigger(id, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [`${HL}triggers/run.mjs`, id, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("close", () => resolve({ out: out.trim(), err: err.trim() }));
    setTimeout(() => {
      child.kill();
      reject(new Error("trigger timeout"));
    }, 20000);
  });
}

const rows = [];
for (const c of CASES) {
  for (const rev of ["buggy", "fixed"]) {
    const repoRoot = CORPUS + c[rev];
    const env = {
      id: `${c.id}/${rev}`,
      svc: `${HL}services/${c.svc}`,
      env: {
        REPO_ROOT: repoRoot,
        PORT: String(c.port),
        QS_MODE: c.qs ? rev : "buggy",
        SEMVER_MODE: c.semver ? rev : "buggy",
      },
    };
    let child;
    try {
      child = await start(env);
      const t = await trigger(c.id, c.port);
      rows.push({ case: c.id, rev, status: t.out.split("\n")[0], body: t.out.split("\n").slice(1).join(" ").slice(0, 160), err: t.err.slice(0, 200) });
    } catch (e) {
      rows.push({ case: c.id, rev, status: "BOOT_FAIL", body: String(e).slice(0, 300) });
    } finally {
      child?.kill();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

console.log("case/rev status body");
for (const r of rows) console.log(`${r.case}/${r.rev} ${r.status} ${r.body} ${r.err ? "STDERR:" + r.err.slice(0, 120) : ""}`);
