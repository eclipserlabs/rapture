// Preregistered repository regression check.
//
// Each repository snapshot has PRE-EXISTING failures unrelated to the bug under
// repair (Node-version-dependent assertions in express, 5 unrelated failures in
// hapi). A whole-suite-green requirement would therefore be unsatisfiable even
// on the unmodified buggy tree. The check is instead differential: a baseline is
// recorded on the UNMODIFIED buggy snapshot before any subject run, and
// REGRESSION_INTRODUCED fires only when the patched tree fails a test that the
// baseline did not.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNERS = {
  express: {
    cmd: ["npx", "mocha", "--require", "test/support/env", "--reporter", "json",
          "--check-leaks", "test/", "test/acceptance/"],
    parse: (out) => {
      const i = out.indexOf("{");
      const d = JSON.parse(out.slice(i));
      return { total: d.stats.tests, failed: d.stats.failures,
               failing: d.failures.map((f) => f.fullTitle) };
    },
  },
  hapi: {
    cmd: ["npx", "lab", "-a", "@hapi/code", "-m", "5000", "-r", "json"],
    parse: (out) => {
      const i = out.indexOf("{");
      const d = JSON.parse(out.slice(i));
      const failing = [];
      let total = 0;
      for (const [suite, tests] of Object.entries(d.tests ?? {})) {
        for (const t of tests) { total += 1; if (t.err) failing.push(`${suite} :: ${t.title}`); }
      }
      return { total, failed: failing.length, failing };
    },
  },
  fastify: {
    cmd: ["npx", "borp", "--reporter", "tap"],
    parse: (out) => {
      const failing = [];
      let total = 0;
      for (const line of out.split("\n")) {
        const m = /^\s*(not ok|ok)\s+\d+\s*-?\s*(.*)$/.exec(line);
        if (!m) continue;
        total += 1;
        if (m[1] === "not ok" && !/# (SKIP|TODO)/i.test(line)) failing.push(m[2].trim().slice(0, 160));
      }
      return { total, failed: failing.length, failing };
    },
  },
};

export function runRegression(stack, repoRoot, timeoutMs = 600000) {
  const r = RUNNERS[stack];
  if (!r) return { supported: false, reason: `no regression runner for stack ${stack}` };
  const t0 = Date.now();
  // Redirect stdout to a FILE rather than reading a pipe. hapi's lab calls
  // process.exit() immediately after writing its JSON report, which truncates
  // the report at the 8 KB pipe buffer; a file write completes. Parsing stdout
  // only also keeps lab's stderr progress output out of the JSON document.
  const dir = mkdtempSync(join(tmpdir(), "v4reg-"));
  const outFile = join(dir, "stdout.txt");
  const shell = `${r.cmd.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ")} > '${outFile}'`;
  const p = spawnSync("bash", ["-c", shell], { cwd: repoRoot, encoding: "utf8",
                                               timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  let stdout = "";
  try { stdout = readFileSync(outFile, "utf8"); } catch { /* command produced nothing */ }
  rmSync(dir, { recursive: true, force: true });
  const out = `${stdout}\n${p.stderr ?? ""}`;
  let parsed;
  try { parsed = r.parse(stdout); }
  catch (e) { return { supported: true, parse_error: String(e?.message ?? e).slice(0, 200),
                       exit: p.status, seconds: Math.round((Date.now() - t0) / 1000),
                       tail: out.trim().split("\n").slice(-8).join("\n") }; }
  return { supported: true, exit: p.status, seconds: Math.round((Date.now() - t0) / 1000), ...parsed };
}

// REGRESSION_INTRODUCED iff the patched tree fails something the baseline did not.
export function compareToBaseline(baseline, current) {
  if (!baseline || !current || current.parse_error || current.failing == null) {
    return { comparable: false, regression: null,
             reason: current?.parse_error ?? "regression output unparseable" };
  }
  const base = new Set(baseline.failing ?? []);
  const introduced = (current.failing ?? []).filter((t) => !base.has(t));
  return {
    comparable: true,
    baseline_failed: baseline.failed, current_failed: current.failed,
    newly_failing: introduced.slice(0, 20),
    newly_failing_count: introduced.length,
    regression: introduced.length > 0,
  };
}

if (process.argv[1] && process.argv[1].endsWith("regression.mjs")) {
  const [, , stack, root] = process.argv;
  console.log(JSON.stringify(runRegression(stack, root), null, 2).slice(0, 4000));
}
