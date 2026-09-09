import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const child = spawn(
  process.execPath,
  ["--import", join(root, "src", "capture", "register.mjs"), join(root, "privacy", "sentinel-app.mjs")],
  {
    env: {
      ...process.env,
      RAPTURE_V2_MODE: "replay",
      RAPTURE_V2_CAPTURE_FILE: join(root, "results", "privacy", "surrogate-db.json"),
      PORT: "47398",
      PGPORT: "54399",
      CAPTURE_CONFIG: "FAKE_ORIGIN,SECRET_CONFIG",
    },
    cwd: "/tmp",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stderr.on("data", (d) => process.stderr.write(`[app-err] ${d}`));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("boot timeout")), 15000);
  child.stdout.on("data", (d) => {
    if (String(d).includes("READY")) {
      clearTimeout(t);
      resolve();
    }
  });
  child.on("exit", (c) => {
    clearTimeout(t);
    reject(new Error(`exit ${c}`));
  });
});
console.log("booted");
const doc = JSON.parse((await import("node:fs")).readFileSync(join(root, "results", "privacy", "surrogate-db.json"), "utf8"));
const r = await fetch(`http://localhost:47398${doc.request.path}${doc.request.query ?? ""}`, { method: doc.request.method });
console.log("status", r.status, (await r.text()).slice(0, 200));
child.kill("SIGKILL");
process.exit(0);
