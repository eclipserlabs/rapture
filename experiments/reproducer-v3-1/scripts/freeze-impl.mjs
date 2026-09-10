// Freeze the V3.1 selection/detector/capture implementation tree.
// Usage: node scripts/freeze-impl.mjs
// Records sha256 over every .mjs under src/ into results/impl-freeze.json.
// Post-freeze changes are forbidden for headline work; a change here without a
// recorded amendment is an INVALID_EXPERIMENT, not a fix.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const files = ["capture", "detector", "oracle", "replay"].flatMap((d) => walk(join(root, "src", d)));
const h = createHash("sha256");
const manifest = files.map((f) => {
  const rel = f.slice(root.length + 1);
  const content = readFileSync(f);
  h.update(content);
  return { path: rel, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
});
const treeHash = h.digest("hex");
writeFileSync(
  join(root, "results", "impl-freeze.json"),
  `${JSON.stringify({ frozen_at: new Date().toISOString(), tree_hash: treeHash, files: manifest }, null, 2)}\n`,
);
console.log(`V3.1 implementation tree frozen: ${treeHash} (${manifest.length} files)`);
