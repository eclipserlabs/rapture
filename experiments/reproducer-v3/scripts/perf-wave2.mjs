// Wave-2 perf driver: reps 6-10, concurrency 16 (matches wave 1 per the frozen
// methodology). Skips reps whose raw files already exist, so it is resumable.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const MODES = ["off", "context-only", "intercept-discard", "capture", "failed-persist"];
let seed = 777;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

for (const service of ["a", "b"]) {
  for (let rep = 6; rep <= 10; rep += 1) {
    for (const mode of shuffled(MODES, rand)) {
      const file = join(root, "results", "perf", "raw", `perf-${service}-${mode}-rep${rep}.json`);
      if (existsSync(file)) {
        console.log(`skip service=${service} mode=${mode} rep=${rep} (exists)`);
        continue;
      }
      console.log(`--- service=${service} mode=${mode} rep=${rep}`);
      const r = spawnSync(
        process.execPath,
        [join(root, "scripts", "perf-run.mjs"), "--service", service, "--mode", mode,
          "--requests", "5000", "--concurrency", "16", "--rep", String(rep)],
        { encoding: "utf8", timeout: 600000 },
      );
      process.stdout.write(r.stdout ?? "");
      process.stderr.write(r.stderr ?? "");
      if (r.status !== 0) throw new Error(`perf-run failed: ${service} ${mode} rep${rep}`);
    }
  }
}
console.log("wave 2 complete");
