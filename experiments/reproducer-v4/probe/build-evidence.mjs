// Builds the CONTROL evidence pack for a case: strong conventional incident
// telemetry, produced by actually running the buggy revision under a generic
// observability shim. Both arms receive this pack BYTE-IDENTICALLY.
//
// Frozen exclusions enforced here: no DB result rows, no outbound response
// bodies, no captured time/random streams, no upstream fix data, no issue or
// CVE identifier, no hand-written root-cause prose, no hidden evaluator.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { byId, CORPUS, PG_ENTRY, V3H } from "./cases.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NODE = process.execPath;
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const c = byId(arg("--case"));
const out = arg("--out");
const port = Number(arg("--port", "49760"));
const repoRoot = join(CORPUS, c.buggy);
const obsFile = join("/tmp", `v4obs-${c.id}-${process.pid}.json`);

// --- run the buggy revision and observe the real failure ---------------------
const child = await new Promise((resolve, reject) => {
  const env = { ...process.env, REPO_ROOT: repoRoot, PORT: String(port),
                FAKE_ORIGIN: "http://localhost:47109",
                OBS_OUT: obsFile, OBS_PG_ENTRY: PG_ENTRY };
  const p = spawn(NODE, ["--import", join(HERE, "observe-shim.mjs"), join(V3H, "services", c.service)],
                  { env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`READY timeout: ${buf.slice(-400)}`)); }, 30000);
  p.stdout.on("data", (d) => { buf += String(d); if (buf.includes("READY")) { clearTimeout(t); resolve(p); } });
  p.stderr.on("data", (d) => { buf += String(d); });
  p.on("exit", (code) => { clearTimeout(t); reject(new Error(`exit ${code}: ${buf.slice(-400)}`)); });
});

const rawAbsolute = (target) => new Promise((res) => {
  const s = net.connect(port, "127.0.0.1", () =>
    s.write([`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Connection: close`].join("\r\n") + "\r\n\r\n"));
  let buf = ""; s.on("data", (d) => (buf += d));
  s.on("close", () => {
    const head = buf.split("\r\n"); const m = (head[0] || "").match(/ (\d{3}) /);
    const headers = {};
    for (const line of head.slice(1)) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).toLowerCase().trim()] = line.slice(i + 1).trim(); }
    res({ status: m ? Number(m[1]) : 0, headers, body: (buf.split("\r\n\r\n")[1] || "").slice(0, 600) });
  });
  s.on("error", (e) => res({ status: 0, headers: {}, body: "SOCK_ERR " + e.message }));
});

const t0 = Date.now();
const resp = c.trigger.kind === "raw-absolute"
  ? await rawAbsolute(c.trigger.path)
  : await fetch(`http://127.0.0.1:${port}${c.trigger.path}`)
      .then(async (r) => ({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() }));
const durationMs = Date.now() - t0;
await sleep(700);
child.kill("SIGTERM");
await sleep(500);
const obs = JSON.parse(readFileSync(obsFile, "utf8"));
rmSync(obsFile, { force: true });

// --- sanitize ----------------------------------------------------------------
// Absolute host paths would reveal the corpus layout and the revision
// directory name. Rewrite to the path the agent actually sees.
const scrubPath = (s) => String(s ?? "")
  .split(repoRoot).join("/work/repo")
  .split(join(V3H, "services", c.service)).join("/work/app/server.mjs")
  .split(join(V3H, "services")).join("/work/app")
  .split(HERE.replace(/\/$/, "")).join("/work/.internal");

const RELEASE = `rel-${sha12(`${c.id}:${c.buggy}`)}`;   // opaque internal build id, not an upstream sha
const INCIDENT = `INC-${sha12(`${c.id}:${c.route}`).toUpperCase()}`;

// The application error as an error tracker would report it: the error the
// service's own handler observed. Selected by proximity to the failure, not by
// any bug-specific knowledge.
const appErrors = obs.errors
  .filter((e) => e.stack && !/node:internal/.test(e.stack.split("\n")[1] ?? ""))
  .slice(-3)
  .map((e) => ({ name: e.name, constructor: e.constructor_name, message: e.message,
                 status: e.status, code: e.code, stack: scrubPath(e.stack) }));

const pack = {
  schema: "v4-probe-control-evidence-1",
  incident_id: INCIDENT,
  service: { name: `svc-${c.stack}-api`, release: RELEASE,
             runtime: `node ${process.version}`, framework: c.stack, platform: process.platform },
  request: {
    method: c.route.split(" ")[0],
    route: c.route.slice(c.route.indexOf(" ") + 1),
    target_form: c.trigger.kind === "raw-absolute" ? "absolute-form request target" : "origin-form request target",
    headers_shape: { host: "<service-host>", connection: "close", accept: "*/*", "user-agent": "<client>" },
    body: null,
  },
  response: { status: resp.status, headers: resp.headers,
              body: String(resp.body).slice(0, 600), duration_ms: durationMs },
  error: {
    normalized_code: (() => { const m = /"code":"([A-Z_0-9]+)"/.exec(String(resp.body)); return m ? m[1] : null; })(),
    normalized_message: (() => { const m = /"error":"([^"]+)"/.exec(String(resp.body)); return m ? m[1] : null; })(),
    application_errors_observed: appErrors,
    note: appErrors.length ? null : "the application handled this error internally; no unhandled stack was exposed to the error tracker",
  },
  operations: obs.ops.map((o, i) => ({
    seq: i + 1, kind: o.kind,
    // DB: operation name, statement text, row COUNT, duration. Never the rows.
    ...(o.kind === "db" ? { operation: o.operation, statement: o.statement, status: o.status, row_count: o.row_count, duration_ms: o.ms } : {}),
    // Outbound HTTP: destination, method, status, duration. Never the body.
    ...(o.kind === "http" ? { method: o.method, destination: o.url, status: o.status, duration_ms: o.ms } : {}),
  })),
  logs: obs.logs.map((l) => ({ level: l.level, message: scrubPath(l.msg) })),
  excluded_by_policy: [
    "historical issue number", "CVE identifier", "upstream fixing commit or diff",
    "upstream regression test that reveals the fix", "captured database result rows",
    "captured outbound response bodies", "captured time/random streams",
    "hand-written root-cause explanation", "the hidden evaluator",
  ],
};

const md = `# Incident ${pack.incident_id}

**Service** \`${pack.service.name}\` · release \`${pack.service.release}\` · ${pack.service.framework} on ${pack.service.runtime}

## Failure

\`${pack.request.method} ${pack.request.route}\` returned **HTTP ${pack.response.status}** in ${pack.response.duration_ms} ms.

Request target was supplied in ${pack.request.target_form}.

\`\`\`json
${pack.response.body}
\`\`\`

Normalized error code: \`${pack.error.normalized_code ?? "none"}\`${pack.error.normalized_message ? ` — ${pack.error.normalized_message}` : ""}

## Application errors observed

${appErrors.length
  ? appErrors.map((e) => `- \`${e.constructor ?? e.name}\`${e.status ? ` (status ${e.status})` : ""}: ${e.message}\n\n\`\`\`\n${e.stack}\n\`\`\``).join("\n\n")
  : "_" + pack.error.note + "_"}

## Operation timeline

| # | kind | operation | status | ms |
|---|---|---|---|---|
${pack.operations.map((o) => `| ${o.seq} | ${o.kind} | ${o.kind === "db" ? "`" + String(o.statement).slice(0, 70) + "`" : `${o.method} ${o.destination}`} | ${o.status} | ${o.duration_ms} |`).join("\n")}

Database result rows and outbound response bodies are not retained by the
observability pipeline.

## Logs

${pack.logs.length ? pack.logs.map((l) => `- \`${l.level}\` ${l.message}`).join("\n") : "_none recorded around the failure_"}

## Environment

- runtime: ${pack.service.runtime}
- framework: ${pack.service.framework}
- platform: ${pack.service.platform}
- release: ${pack.service.release}
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "incident-evidence.json"), JSON.stringify(pack, null, 2) + "\n");
writeFileSync(join(out, "incident-evidence.md"), md);
const h = (f) => createHash("sha256").update(readFileSync(join(out, f))).digest("hex");
console.log(JSON.stringify({ case: c.id, out, status: resp.status,
  operations: pack.operations.length, app_errors: appErrors.length, logs: pack.logs.length,
  json_sha256: h("incident-evidence.json"), md_sha256: h("incident-evidence.md") }, null, 2));
