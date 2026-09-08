// Replay every calibration capture 20x in fresh offline processes.
// Usage: node calibrate-replay.mjs [--captures <dir>] [--app <entry>]
// Fake external stays down; replay uses PGPORT=54399 (dead) + fail-closed patches.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const REPLAYS = 20;
const REPLAY_ONE = join(root, "src", "replay", "replay-one.mjs");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

function replayOnce(app, captureFile, port, keep = null) {
  const args = ["--app", app, "--capture", captureFile, "--port", String(port)];
  if (keep) args.push("--keep", keep);
  const r = spawnSync(process.execPath, [REPLAY_ONE, ...args], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return { ok: false, pass: false, error: (r.stderr || r.stdout || "").slice(0, 300) };
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    return { ok: true, pass: out.pass === true, fp: out.fingerprint, ms: out.ms ?? 0, error: out.error ?? null };
  } catch (err) {
    return { ok: false, pass: false, error: String(err).slice(0, 300) };
  }
}

async function main() {
  const capDir = arg("--captures", join(root, "results", "calibration", "captures"));
  const app = arg("--app", join(root, "calibration", "service", "server.mjs"));
  const outDir = join(root, "results", "calibration");
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(capDir).filter((f) => f.endsWith(".json")).sort();
  const rows = [];
  let port = 48200;
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(capDir, f), "utf8"));
    const runs = [];
    for (let i = 0; i < REPLAYS; i += 1) {
      port += 1;
      runs.push(replayOnce(app, join(capDir, f), port));
    }
    const passes = runs.filter((r) => r.ok && r.pass).length;
    const codes = {};
    for (const r of runs) {
      const c = r.fp ? `${r.fp.kind}:${r.fp.error_name_or_code ?? r.fp.normalized_class}` : `ERR:${r.error ?? "spawn"}`;
      codes[c] = (codes[c] ?? 0) + 1;
    }
    const walls = runs.map((r) => r.ms ?? 0).sort((a, b) => a - b);
    rows.push({
      file: f,
      path: doc.request.path,
      expected: doc.fingerprint.normalized_class,
      passes,
      total: REPLAYS,
      outcomes: codes,
      median_ms: walls[Math.floor(walls.length / 2)],
      p95_ms: walls[Math.min(walls.length - 1, Math.ceil(walls.length * 0.95) - 1)],
    });
    console.log(`${doc.request.path}: ${passes}/${REPLAYS} ${JSON.stringify(codes)}`);
  }
  writeFileSync(join(outDir, "replay.json"), `${JSON.stringify(rows, null, 2)}\n`);
}

await main();
