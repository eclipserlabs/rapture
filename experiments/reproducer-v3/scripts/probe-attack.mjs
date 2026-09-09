import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const a = JSON.parse(readFileSync(join(root, "results", "privacy", "attack.json"), "utf8"));
console.log("FAILS:", JSON.stringify(a.gate.replay_failures));
console.log("DIVERG:", a.gate.replay_divergences, "LEAKS:", a.gate.gate_secret_leaks.length);
const dir = join(root, "results", "privacy", "captures");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  console.log(f.slice(-12), d.request.method, d.request.path, d.fingerprint.normalized_class);
}
