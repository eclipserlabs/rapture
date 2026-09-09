// Probe: boot service-b under V3 capture, print what happens.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function waitReady(child, ms = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("TIMEOUT"), ms);
    child.stdout.on("data", (d) => {
      process.stdout.write(`[svc-out] ${d}`);
      if (String(d).includes("READY")) {
        clearTimeout(t);
        resolve("READY");
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[svc-err] ${d}`));
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
console.log("fake:", await waitReady(fake));

const svc = spawn(
  process.execPath,
  ["--import", join(root, "src", "capture", "register.mjs"), join(root, "perf", "service-b.mjs")],
  {
    env: {
      ...process.env,
      PORT: "47102",
      FAKE_ORIGIN: "http://localhost:47109",
      SHOP_API_KEY: "shop-test-key",
      CAPTURE_CONFIG: "FAKE_ORIGIN",
      RAPTURE_V2_MODE: "capture",
      RAPTURE_V2_OUT: "/tmp/cap-b",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
console.log("svc:", await waitReady(svc));
try {
  const r = await fetch("http://localhost:47102/config", { headers: { cookie: "sid=sess-alice" } });
  console.log("config:", r.status, (await r.text()).slice(0, 120));
} catch (e) {
  console.log("fetch failed:", e.message);
}
svc.kill("SIGKILL");
fake.kill("SIGKILL");
process.exit(0);
