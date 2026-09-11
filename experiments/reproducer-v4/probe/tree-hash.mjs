// Deterministic tree hash of a repository worktree: sorted relative paths and
// content hashes, excluding .git and node_modules (dependencies are provisioned
// identically and are not part of the submitted patch).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function treeHash(root) {
  const entries = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      entries.push(`${relative(root, p)}\0${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return { tree_sha256: createHash("sha256").update(entries.join("\n")).digest("hex"), file_count: entries.length };
}

if (process.argv[1] && process.argv[1].endsWith("tree-hash.mjs")) {
  console.log(JSON.stringify(treeHash(process.argv[2])));
}
