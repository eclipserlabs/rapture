// V3 perf campaign: services × modes × reps with rotated mode order.
// Usage: node scripts/perf-campaign.mjs [--services a,b] [--modes off,capture] [--reps 5] [--requests 5000]
// Stores raw per-rep files under results/perf/raw (never aggregated in place;
// aggregation happens in perf-aggregate.mjs so raw repetitions are preserved).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const services = (arg("--services", "a,b") || "").split(",").filter(Boolean);
  const modes = (arg("--modes", "off,context-only,intercept-discard,capture,failed-persist") || "").split(",").filter(Boolean);
  const reps = Number(arg("--reps", "5"));
  const requests = Number(arg("--requests", "5000"));
  mkdirSync(join(root, "results", "perf", "raw"), { recursive: true });
  rmSync(join(root, "results", "perf", "tmp-persist"), { recursive: true, force: true });
  let seed = Number(arg("--seed", "42"));
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const service of services) {
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const mode of shuffled(modes, rand)) {
        console.log(`--- service=${service} mode=${mode} rep=${rep}/${reps}`);
        const r = spawnSync(
          process.execPath,
          [
            join(root, "scripts", "perf-run.mjs"),
            "--service", service,
            "--mode", mode,
            "--requests", String(requests),
            "--concurrency", "16",
            "--rep", String(rep),
          ],
          { encoding: "utf8", timeout: 600000 },
        );
        process.stdout.write(r.stdout ?? "");
        process.stderr.write(r.stderr ?? "");
        if (r.status !== 0) throw new Error(`perf-run failed: service=${service} mode=${mode} rep=${rep}`);
      }
    }
  }
  console.log("campaign complete");
}

await main();
