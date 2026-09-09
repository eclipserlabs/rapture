// Offline proof: replay every headline portable artifact with the fake
// external DOWN and dead PGPORT (replay-raw always uses PGPORT=54399).
// Run AFTER `pkill -f fake-external`. Any live dependency attempt fails
// closed (infra fingerprint, never the incident hash).
// Usage: node verify-offline.mjs [--reps 5]
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const REPS = Number(arg("--reps", "5"));
const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";

const CASES = {
  "koa-1999": { svc: "koa-1999.mjs", env: { REPO_ROOT: `${CORPUS}koa-1061776` }, host: "127.0.0.1" },
  "koa-1998": { svc: "koa-1998.mjs", env: { REPO_ROOT: `${CORPUS}koa-4a191b1` }, host: "127.0.0.1" },
  "express-cookie": { svc: "express-cookie.mjs", env: { REPO_ROOT: `${CORPUS}express-4.19.2` }, host: "127.0.0.1" },
  "express-qs": { svc: "express-qs.mjs", env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "buggy" }, host: "127.0.0.1" },
  "fastify-32442": { svc: "fastify-32442.mjs", env: { REPO_ROOT: `${CORPUS}fastify-5.3.0` }, host: "127.0.0.1" },
  "express-semver": { svc: "express-semver.mjs", env: { REPO_ROOT: `${CORPUS}express-4.21.1`, SEMVER_MODE: "buggy" }, host: "127.0.0.1" },
  "hapi-4560": { svc: "hapi-4560.mjs", env: { REPO_ROOT: `${CORPUS}hapi-5095382`, HOST: "::1" }, host: "::1" },
  "hapi-4564": { svc: "hapi-4564.mjs", env: { REPO_ROOT: `${CORPUS}hapi-62032e6` }, host: "127.0.0.1" },
};

let port = 47700;
const rows = [];
for (const [id, c] of Object.entries(CASES)) {
  const artifact = join(here, "..", "results", "headline", "artifacts", `${id}.json`);
  let pass = 0;
  for (let i = 0; i < REPS; i++) {
    port += 1;
    const envExtra = { ...c.env, REPLAY_HOST: c.host };
    const r = spawnSync(
      process.execPath,
      [join(here, "replay-raw.mjs"), "--app", join(here, "services", c.svc), "--capture", artifact, "--port", String(port), "--env", JSON.stringify(envExtra)],
      { encoding: "utf8", timeout: 60000 },
    );
    try {
      if (JSON.parse(r.stdout.trim().split("\n").at(-1)).pass === true) pass += 1;
    } catch {
      // fail
    }
  }
  rows.push({ case: id, offline_nofake: `${pass}/${REPS}` });
  console.log(`${id}: fake-down offline ${pass}/${REPS}`);
}
