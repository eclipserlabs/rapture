// Summarize a --cpu-prof .cpuprofile by self-time per function.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const p = JSON.parse(readFileSync(file, "utf8"));
const agg = new Map();
for (const n of p.nodes) {
  const h = n.hitCount || 0;
  if (!h) continue;
  const f = n.callFrame;
  const url = f.url || "";
  const short = url.startsWith("file://")
    ? "FILE:" + url.split("/").slice(-1)[0]
    : url.replace("node:internal/", "ni:");
  const key = `${f.functionName || "(anon)"} @ ${short}`;
  agg.set(key, (agg.get(key) ?? 0) + h);
}
const total = [...agg.values()].reduce((a, b) => a + b, 0);
console.log("total samples:", total);
for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`${((100 * v) / total).toFixed(1).padStart(5)}%  ${v}  ${k}`);
}
