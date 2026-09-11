// Copies the transitive runtime dependency closure of a package into a flat,
// dereferenced node_modules tree. Needed because the repo uses pnpm symlinks,
// which do not survive a copy into an isolated workspace.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function vendor(fromPkgDir, intoNodeModules, pnpmStore = null) {
  const require = createRequire(join(fromPkgDir, "package.json"));
  const seen = new Set();
  const queue = [];
  const deps = (dir) => {
    try { return Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {}); }
    catch { return []; }
  };
  const resolveDir = (name, fromDir) => {
    const r = createRequire(join(fromDir, "package.json"));
    try { return dirname(r.resolve(`${name}/package.json`)); }
    catch {
      // packages without an exported package.json: walk up from the entry
      try {
        let d = dirname(r.resolve(name));
        for (let i = 0; i < 6; i++) { if (existsSync(join(d, "package.json"))) return d; d = dirname(d); }
      } catch { /* unresolvable */ }
      // Packages that export neither ./package.json nor a resolvable entry
      // under this resolver (execa's unicorn-magic): fall back to the pnpm
      // content-addressed store, which holds the real directory.
      if (pnpmStore && existsSync(pnpmStore)) {
        const want = `${name.replace("/", "+")}@`;
        for (const entry of readdirSync(pnpmStore)) {
          if (!entry.startsWith(want)) continue;
          const cand = join(pnpmStore, entry, "node_modules", ...name.split("/"));
          if (existsSync(cand)) return cand;
        }
      }
      return null;
    }
  };
  for (const d of deps(fromPkgDir)) queue.push([d, fromPkgDir]);
  mkdirSync(intoNodeModules, { recursive: true });
  const copied = [];
  while (queue.length) {
    const [name, fromDir] = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = resolveDir(name, fromDir);
    if (!src) { copied.push({ name, status: "UNRESOLVED" }); continue; }
    const dst = join(intoNodeModules, ...name.split("/"));
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, dereference: true });
    copied.push({ name, status: "ok" });
    for (const d of deps(src)) if (!seen.has(d)) queue.push([d, src]);
  }
  return copied;
}
