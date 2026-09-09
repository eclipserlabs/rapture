// Probe every service-b route under V3 capture with per-request timeouts.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

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
const svc = spawn(
  process.execPath,
  ["--import", join(root, "src", "capture", "register.mjs"), join(root, "perf", "service-b.mjs")],
  {
    env: {
      ...process.env,
      PORT: "47102",
      FAKE_ORIGIN: "http://localhost:47109",
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_MODE: "capture",
      RAPTURE_V2_OUT: "/tmp/cap-b",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
console.log("svc:", await waitReady(svc));

const routes = [
  ["GET", "/users/u-1", { cookie: "sid=sess-alice" }, undefined],
  ["GET", "/search?q=ali", { cookie: "sid=sess-alice" }, undefined],
  ["GET", "/config", { cookie: "sid=sess-alice" }, undefined],
  ["POST", "/events", { cookie: "sid=sess-alice", "content-type": "application/json" }, JSON.stringify({ kind: "click", payload: {} })],
  ["GET", "/users/u-2", { cookie: "sid=sess-alice" }, undefined],
];
for (const [m, p, h, b] of routes) {
  try {
    const t = Date.now();
    const r = await fetch(`http://localhost:47102${p}`, { method: m, headers: h, body: b, signal: AbortSignal.timeout(10000) });
    await r.text();
    console.log(m, p, r.status, `${Date.now() - t}ms`);
  } catch (e) {
    console.log(m, p, "FAILED:", e.message);
  }
}
svc.kill("SIGKILL");
fake.kill("SIGKILL");
process.exit(0);
