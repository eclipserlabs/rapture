// V3.1 copy of the frozen V3 raw-socket replay harness, with the BOOT WAIT and
// overall timeout made configurable. A substantial application takes far longer
// than 25s to start, and a boot timeout is an experiment-harness limit, not a
// property of the capture/replay mechanism under test. Nothing else is changed:
// the frozen oracle, the dead PGPORT, and the request bytes are identical.
//
// Original V3 header follows.
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
const BOOT_TIMEOUT = Number(process.env["REPLAY_BOOT_TIMEOUT_MS"] ?? "25000");
// V3.2: the capture implementation under test is selectable so the diagnosis
// can run pre-fix, post-fix and single-variable-reverted arms against the
// SAME capture artifact and the same application revision.
const REGISTER = process.env["RAPTURE_REGISTER"] ?? join(here, "..", "src", "capture", "register.mjs");

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
  // V3.2 harness lifecycle fix (experiment harness only; no capture-runtime
  // behaviour changes). Previously finish() killed the child and logged, but
  // never exited: the boot-poll setTimeout chain kept rescheduling, so the
  // process lingered indefinitely after its result was already decided. That
  // is why a single replay could outlive a 180s total timeout by many minutes
  // and why the prior sessions 6-iteration loop ran for 15 hours. The recorded
  // outcome is unchanged; only the time taken to report it is.
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    const line = JSON.stringify({ ...result, ms: Date.now() - started });
    process.stdout.write(line + "\n", () => process.exit(0));
    // Backstop in case the stdout callback never fires (closed pipe).
    setTimeout(() => process.exit(0), 2000).unref();
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
  }, Number(process.env["REPLAY_TOTAL_TIMEOUT_MS"] ?? "45000"));
  // Fail fast when the application process has already exited: polling the
  // port for the full timeout tells us nothing extra once the child is dead.
  // This changes only how quickly a boot failure is NOTICED, never whether it
  // happened.
  // Fail fast once the application has visibly failed to reach its dependency.
  // The process does not exit -- the driver keeps retrying -- so polling the
  // app's port for the full timeout only delays a verdict already determined.
  // This changes how quickly a boot failure is NOTICED, never whether one
  // happened: the recorded outcome is identical, and a boot that succeeds is
  // unaffected because it never emits these strings.
  let bootFailed = false;
  const failSignal = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|password authentication failed|database .* does not exist/i;
  child.stderr.on("data", (d) => {
    if (failSignal.test(String(d))) bootFailed = true;
  });
  const up = await Promise.race([
    waitBoot(port, host, BOOT_TIMEOUT),
    (async () => {
      for (;;) {
        if (bootFailed) {
          // Give a successful-but-slow boot a moment to win the race anyway.
          await new Promise((r) => setTimeout(r, 1500));
          return false;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })(),
  ]);
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
