// Re-freeze the V3.1 implementation tree after the brief-mandated addition of
// ROUTE_SELECTIVE / ARMED_WINDOW and the Phase 1 attribution counters.
// Records the new hash WITHOUT overwriting results/impl-freeze.json, so the
// hash the prior campaign ran under stays auditable.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) => readdirSync(d).sort().flatMap((e) => {
  const p = join(d, e);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".mjs") ? [p] : [];
});
const files = ["capture", "oracle", "replay", "detector"].flatMap((d) => walk(join(root, "src", d)));
const h = createHash("sha256");
const manifest = files.map((f) => {
  const c = readFileSync(f);
  h.update(c);
  return { path: f.slice(root.length + 1), sha256: createHash("sha256").update(c).digest("hex"), bytes: c.length };
});
const treeHash = h.digest("hex");
const prior = { tree_hash: "ed03834d3f4be1c24c932e23f2247a5ea274949dbe323998330e028dabe40002", files: JSON.parse(readFileSync(join(root, "..", "reproducer-v3-1", "results", "impl-freeze-v2.json"), "utf8")).files };
const v3 = JSON.parse(readFileSync(join(root, "../reproducer-v3/results/capture-freeze.json"), "utf8"));
const v3map = new Map(v3.files.map((f) => [f.path, f.sha256]));
const stillIdentical = manifest.filter((f) => v3map.get(f.path) === f.sha256).map((f) => f.path);
writeFileSync(join(root, "results/impl-freeze.json"), JSON.stringify({
  frozen_at: new Date().toISOString(),
  tree_hash: treeHash,
  prior_tree_hash: prior.tree_hash,
  changed_since_prior: manifest.filter((f) => {
    const p = prior.files.find((x) => x.path === f.path);
    return p == null || p.sha256 !== f.sha256;
  }).map((f) => f.path),
  byte_identical_to_frozen_v3: stillIdentical,
  byte_identical_count: stillIdentical.length,
  files: manifest,
}, null, 2));
console.log(`impl tree re-frozen: ${treeHash} (${manifest.length} files)`);
console.log(`prior: ${prior.tree_hash}`);
console.log(`still byte-identical to V3: ${stillIdentical.length}`);
