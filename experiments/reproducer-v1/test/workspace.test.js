// Workspace honesty tests: no product changes; pre-existing check errors pinned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");

describe("workspace", () => {
  it("workspace build/typecheck/test status reported honestly", () => {
    const status = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const product = status.filter((l) => /\bpackages\/|\bapps\/|\barchive\//.test(l));
    assert.deepEqual(product, [], `no product/archive files may change: ${product.join("; ")}`);
    const diff = execSync("git diff HEAD --stat -- packages apps archive", { cwd: repo, encoding: "utf8" });
    assert.equal(diff.trim(), "");
  });

  it("existing pre-existing lint/check errors remain distinguished from experiment regressions", () => {
    // pnpm check exits nonzero (pre-existing archive errors); capture output anyway.
    let out;
    try {
      out = execSync("pnpm check --max-diagnostics=1000 2>&1", { cwd: repo, encoding: "utf8", timeout: 120000 });
    } catch (err) {
      out = String(err.stdout ?? err.message);
    }
    const errors = out.split("\n").find((l) => l.startsWith("Found") && l.includes("errors"));
    assert.ok(errors && errors.includes("30 errors"), `expected the 30 pre-existing errors, got: ${errors}`);
    assert.ok(!out.includes("reproducer-v1"), "no diagnostics may come from the V1 experiment");
  });
});
