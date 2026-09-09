// Generic raw-socket replay for headline captures (experiment harness, not
// part of the frozen capture tree). Delivers the RECORDED (redacted)
// request bytes over TCP so transports that fetch cannot express
// (absolute-form targets, missing Host, bracketed IPv6 Host) replay exactly.
// Request line: `<METHOD> <path><query>` + HTTP/1.0 iff the recorded headers
// carry no host (Host-less capture), else HTTP/1.1. Headers: recorded set
// (minus connection/content-length, plus explicit content-length/close).
// Outcome classification uses the FROZEN oracle (imported, unmodified).
// Usage: node replay-raw.mjs --app <entry> --capture <file> [--keep <ids>] [--port <n>] [--env JSON]
// Prints one JSON line: {pass, fingerprint, expected_hash, status, error, ms}.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReplayOutcome } from "../src/oracle/fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTER = join(here, "..", "src", "capture", "register.mjs");

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

function waitBoot(port, host, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const sock = net.connect(port, host);
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 150);
      });
      setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }, 500);
    };
    tick();
  });
}

function rawRequest(port, host, doc) {
  return new Promise((resolve, reject) => {
    const req = doc.request;
    const headers = { ...(req.headers ?? {}) };
    const hasHost = Object.keys(headers).some((k) => k.toLowerCase() === "host");
    const version = hasHost ? "HTTP/1.1" : "HTTP/1.0";
    const body = req.body ?? "";
    const lines = [`${req.method} ${req.path}${req.query ?? ""} ${version}`];
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk === "connection" || lk === "content-length" || lk === "host") continue;
      lines.push(`${k}: ${v}`);
    }
    if (hasHost) {
      const hk = Object.keys(headers).find((k) => k.toLowerCase() === "host");
      lines.push(`Host: ${headers[hk]}`);
    }
    if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    lines.push("Connection: close", "", body);
    const payload = lines.join("\r\n");
    const sock = net.connect({ host, port }, () => sock.write(payload));
    let data = "";
    const killer = setTimeout(() => {
      try {
        sock.end();
      } catch {
        // ignore
      }
    }, 5000);
    const timeout = setTimeout(() => reject(new Error("raw replay timeout")), 15000);
    sock.on("data", (c) => {
      data += c;
    });
    sock.on("end", () => {
      clearTimeout(killer);
      clearTimeout(timeout);
      resolve(data);
    });
    sock.on("error", (e) => {
      clearTimeout(killer);
      clearTimeout(timeout);
      reject(e);
    });
  });
}

function parseResponse(data) {
  const headEnd = data.indexOf("\r\n\r\n");
  const head = headEnd === -1 ? data : data.slice(0, headEnd);
  const body = headEnd === -1 ? "" : data.slice(headEnd + 4);
  const m = /^HTTP\/\S+ (\d+)/.exec(head);
  return { status: m ? Number(m[1]) : 0, body };
}

async function main() {
  const started = Date.now();
  const app = resolve(arg("--app"));
  const captureFile = resolve(arg("--capture") ?? "");
  const keep = arg("--keep", null);
  const port = Number(arg("--port", "0")) || 48000 + Math.floor(Math.random() * 1000);
  const extraEnv = JSON.parse(arg("--env", "{}"));
  const host = extraEnv.REPLAY_HOST ?? "127.0.0.1";
  if (!app || !captureFile) {
    console.log(JSON.stringify({ error: "missing --app or --capture" }));
    process.exitCode = 2;
    return;
  }
  const doc = JSON.parse(readFileSync(captureFile, "utf8"));
  const sub = subsetCapture(doc, keep);
  const dir = mkdtempSync(join(tmpdir(), "reprov3-replay-"));
  const subFile = join(dir, "subset.json");
  writeFileSync(subFile, JSON.stringify(sub));
  const finish = (result) => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
  };
  const env = {
    ...process.env,
    ...extraEnv,
    RAPTURE_V2_MODE: "replay",
    RAPTURE_V2_CAPTURE_FILE: subFile,
    PORT: String(port),
    PGPORT: "54399",
    CAPTURE_CONFIG: Object.keys(doc.config ?? {}).join(","),
  };
  delete env.REPLAY_HOST;
  const child = spawn(process.execPath, ["--import", REGISTER, app], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: dir,
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const timer = setTimeout(() => {
    finish({
      pass: false,
      fingerprint: null,
      expected_hash: doc.fingerprint?.fingerprint_hash ?? null,
      error: `replay timeout; stderr: ${stderr.slice(0, 300)}`,
    });
  }, 45000);
  const up = await waitBoot(port, host, 25000);
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
  let outcome;
  try {
    const raw = await rawRequest(port, host, sub);
    const { status, body } = parseResponse(raw);
    outcome = {
      request: { method: sub.request.method, path: sub.request.path },
      response: { status, body },
      appError: null,
    };
  } catch (err) {
    outcome = {
      request: { method: sub.request.method, path: sub.request.path },
      response: null,
      appError: { name: err?.name ?? "Error", code: err?.code ?? null, message: String(err?.message ?? err), stack: err?.stack ?? null },
    };
  }
  clearTimeout(timer);
  const classified = classifyReplayOutcome(outcome, doc.fingerprint?.fingerprint_hash);
  finish({
    pass: classified.pass,
    fingerprint: classified.fingerprint,
    expected_hash: doc.fingerprint?.fingerprint_hash ?? null,
    status: outcome.response?.status ?? null,
  });
}

await main();
