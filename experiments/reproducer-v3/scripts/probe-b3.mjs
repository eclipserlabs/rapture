// Patch-by-patch bisect: install only selected patches, then boot service-b.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const which = (process.argv[2] || "http").split(",");

const { state, MODES } = await import(join(root, "src", "capture", "state.mjs"));
state.mode = MODES.CAPTURE;
state.outDir = "/tmp/cap-b";
state.configAllowlist = ["FAKE_ORIGIN"];
process.env["FAKE_ORIGIN"] = "http://localhost:47109";
if (which.includes("http")) (await import(join(root, "src", "capture", "patch-http.mjs"))).installHttpPatch();
if (which.includes("pg")) (await import(join(root, "src", "capture", "patch-pg.mjs"))).installPgHook();
if (which.includes("fetch")) (await import(join(root, "src", "capture", "patch-fetch.mjs"))).installFetchPatch();
if (which.includes("time")) (await import(join(root, "src", "capture", "patch-time.mjs"))).installTimePatch();
state.installed = true;

function waitReady(child, ms = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("TIMEOUT"), ms);
    child.stdout.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(t);
        resolve("READY");
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[child] ${d}`));
    child.on("exit", (c) => {
      clearTimeout(t);
      resolve(`EXIT(${c})`);
    });
  });
}

const fake = spawn(process.execPath, [join(root, "perf", "fake-external.mjs")], {
  env: { ...process.env, PORT: "47109" },
  stdio: ["ignore", "pipe", "pipe"],
});
await waitReady(fake);
// Import service-b IN-PROCESS (shares module state set above).
process.env["PORT"] = "47103";
await import(join(root, "perf", "service-b.mjs"));
await new Promise((r) => setTimeout(r, 800));
try {
  const t = Date.now();
  const r = await fetch("http://localhost:47103/events", {
    method: "POST",
    headers: { cookie: "sid=sess-alice", "content-type": "application/json" },
    body: JSON.stringify({ kind: "click", payload: {} }),
    signal: AbortSignal.timeout(8000),
  });
  console.log(`patches=[${which}] POST /events:`, r.status, `${Date.now() - t}ms`);
} catch (e) {
  console.log(`patches=[${which}] POST /events FAILED:`, e.message);
}
fake.kill("SIGKILL");
process.exit(0);
