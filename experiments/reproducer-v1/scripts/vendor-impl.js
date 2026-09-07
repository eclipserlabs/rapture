// Vendor a case implementation from a source clone at an exact revision.
// Usage: REPRO_V1_REPOS=/tmp/rb-repos node vendor-impl.js <case_id> <buggy|post> <outDir>
// - Reads VENDOR spec + rev from real-bugs/<case_id>/case.js (buggy) — for
//   `post`, the revision comes from bug-corpus.json POST_REV via --post-rev.
//   (This construction script may know both revs; the REDUCER scripts may not.)
// - git archive -> outDir, apply transforms, stage extraTrees, write manifest.
// Usage for post: node vendor-impl.js <case_id> post <outDir> --post-rev <SHA>
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function shaFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main() {
  const [caseId, which, outDirArg] = process.argv.slice(2);
  const outDir = resolve(outDirArg);
  const postRevIdx = process.argv.indexOf("--post-rev");
  const postRev = postRevIdx === -1 ? null : process.argv[postRevIdx + 1];
  if (!caseId || !which || !outDir || (which === "post" && !postRev)) {
    console.error("usage: vendor-impl.js <case_id> <buggy|post> <outDir> [--post-rev SHA]");
    process.exitCode = 2;
    return;
  }
  const reposRoot = process.env["REPRO_V1_REPOS"] ?? "/tmp/rb-repos";
  const caseMod = await import(join(root, "real-bugs", caseId, "case.js"));
  const spec = caseMod.VENDOR;
  const repoDir = join(reposRoot, spec.repo);
  const corpus = JSON.parse(readFileSync(join(root, "real-bugs", "bug-corpus.json"), "utf8"));
  const entry = corpus.cases.find((c) => c.case_id === caseId);
  if (!entry) throw new Error(`case ${caseId} not in frozen corpus`);
  const rev = which === "buggy" ? entry.bug_rev : postRev;
  if (which === "post" && postRev !== entry.post_rev) {
    throw new Error(`post rev mismatch: ${postRev} !== frozen ${entry.post_rev}`);
  }
  mkdirSync(outDir, { recursive: true });
  // Extract via git archive (never checks out; source clones untouched).
  // Empty paths = nothing lives in git (e.g. compiled dist staged separately).
  const paths = spec.paths === "ALL" ? ["."] : spec.paths;
  if (paths.length > 0) {
    execSync(`git archive ${rev} ${paths.map((p) => `'${p}'`).join(" ")} | tar -x -C '${outDir}'`, {
      cwd: repoDir,
      stdio: "pipe",
    });
  }
  for (const t of spec.transforms ?? []) {
    const f = join(outDir, t.path);
    const content = readFileSync(f, "utf8").split(t.search).join(t.replace);
    writeFileSync(f, content);
  }
  const extras = (() => {
    if (which === "post") {
      // Repaired-revision trees may live in a sidecar file so case.js itself
      // never references repaired-revision sources (reducer isolation).
      try {
        const sidecar = JSON.parse(
          readFileSync(join(root, "real-bugs", caseId, "post-vendor.json"), "utf8"),
        );
        if (sidecar.extraTreesPost) return sidecar.extraTreesPost;
      } catch {
        // no sidecar; fall through to spec
      }
      return spec.extraTreesPost ?? spec.extraTrees ?? [];
    }
    return spec.extraTreesBuggy ?? spec.extraTrees ?? [];
  })();
  for (const extra of extras) {
    const dest = join(outDir, extra.dest);
    mkdirSync(dest, { recursive: true });
    cpSync(extra.src, dest, { recursive: true });
  }
  for (const prune of spec.prune ?? []) {
    execSync(`rm -rf '${join(outDir, prune)}'`);
  }
  // Force CJS interpretation for vendored .js files: without this, a repo-root
  // "type": "module" scope makes require() return an empty object. Only when
  // the tree has no root package.json of its own (full-tree vendors keep theirs).
  if (!existsSync(join(outDir, "package.json"))) {
    writeFileSync(join(outDir, "package.json"), '{"type":"commonjs"}\n');
  }
  const files = execSync(`find '${outDir}' -type f | sort`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const manifest = {
    case_id: caseId,
    which,
    repo: spec.repo,
    rev,
    files: files.map((f) => ({
      path: f.slice(outDir.length + 1),
      sha256: shaFile(f),
      bytes: readFileSync(f).length,
    })),
  };
  writeFileSync(join(outDir, "impl-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Note: the file list covers implementation bytes present before this
  // manifest was written (impl-manifest.json itself excluded).
  const totalBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  console.log(`vendored ${manifest.files.length} files, ${totalBytes} bytes from ${spec.repo}@${rev.slice(0, 12)}`);
}

await main();
