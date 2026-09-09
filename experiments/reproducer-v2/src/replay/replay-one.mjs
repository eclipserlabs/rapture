// Generic offline replay: boot any --import-compatible app in replay mode,
// issue the recorded request, classify the outcome with the frozen oracle.
// Usage: node replay-one.mjs --app <entry> --capture <file> [--keep <ids>] [--port <n>]
// Prints one JSON line: {pass, fingerprint, expected_hash, live:{...}, ms}.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReplayOutcome } from "../oracle/fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTER = join(here, "..", "capture", "register.mjs");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

function subsetCapture(doc, keep) {
  if (!keep) return doc;
  const keepSet = new Set(keep.split(",").filter(Boolean));
  const events = (doc.events ?? []).filter((e) => keepSet.has(`evt:${e.seq}`));
  const config = {};
  for (const [k, v] of Object.entries(doc.config ?? {})) {
    if (keepSet.has(`cfg:${k}`)) config[k] = v;
  }
  return { ...doc, events, config };
}

async function waitPort(port, timeoutMs) {
  const net = await import("node:net");
  const start = Date.now();
  for (;;) {
    const open = await new Promise((resolve) => {
      const sock = net.connect(port, "localhost");
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve(false);
      }, 500);
    });
    if (open) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  const started = Date.now();
  const { resolve } = await import("node:path");
  const app = resolve(arg("--app"));
  const captureFile = resolve(arg("--capture") ?? "");
  const keep = arg("--keep", null);
  const port = Number(arg("--port", "0")) || 48000 + Math.floor(Math.random() * 1000);
  if (!app || !captureFile) {
    console.log(JSON.stringify({ error: "missing --app or --capture" }));
    process.exitCode = 2;
    return;
  }
  const doc = JSON.parse(readFileSync(captureFile, "utf8"));
  const sub = subsetCapture(doc, keep);
  const dir = mkdtempSync(join(tmpdir(), "reprov2-replay-"));
  const subFile = join(dir, "subset.json");
  writeFileSync(subFile, JSON.stringify(sub));
  const env = {
    ...process.env,
    RAPTURE_V2_MODE: "replay",
    RAPTURE_V2_CAPTURE_FILE: subFile,
    PORT: String(port),
    PGPORT: "54399",
    CAPTURE_CONFIG: Object.keys(doc.config ?? {}).join(","),
  };
  const child = spawn(process.execPath, ["--import", REGISTER, app], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: dir,
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const finish = (result) => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
  };
  const timer = setTimeout(() => {
    finish({
      pass: false,
      fingerprint: null,
      expected_hash: doc.fingerprint?.fingerprint_hash ?? null,
      error: `replay timeout; stderr: ${stderr.slice(0, 300)}`,
    });
  }, 30000);
  const up = await waitPort(port, 20000);
  if (!up) {
    clearTimeout(timer);
    finish({
      pass: false,
      fingerprint: null,
      expected_hash: doc.fingerprint?.fingerprint_hash ?? null,
      error: `app did not boot; stderr: ${stderr.slice(0, 500)}`,
    });
    return;
  }
  const req = doc.request;
  let outcome;
  try {
    const headers = { ...(req.headers ?? {}) };
    delete headers["host"];
    delete headers["content-length"];
    delete headers["connection"];
    const res = await fetch(`http://localhost:${port}${req.path}${req.query ?? ""}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : (req.body ?? undefined),
    });
    const body = await res.text();
    const resHeaders = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    outcome = { request: { method: req.method, path: req.path }, response: { status: res.status, body }, appError: null };
  } catch (err) {
    outcome = {
      request: { method: req.method, path: req.path },
      response: null,
      appError: { name: err?.name ?? "FetchError", code: err?.code ?? null, message: String(err?.message ?? err), stack: err?.stack ?? null },
    };
  }
  clearTimeout(timer);
  const classified = classifyReplayOutcome(outcome, doc.fingerprint?.fingerprint_hash);
  finish({
    pass: classified.pass,
    fingerprint: classified.fingerprint,
    expected_hash: doc.fingerprint?.fingerprint_hash ?? null,
  });
}

await main();
