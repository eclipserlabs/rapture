// Recurrence workload definitions for the frozen V3 headline incidents.
//
// For each incident: the historical TRIGGER request (fails on the buggy
// revision, exactly as V3 captured it) and, where one exists, a BENIGN request
// that succeeds on the SAME buggy revision and produces the SAME detector
// incident key. The benign variant is what makes a failure RATE expressible:
// a stream of matching traffic in which only some requests fail.
//
// Nothing here touches Rapture, the application, or the frozen capture tree.
// These are workload generators for the experiment harness only.
import { readdirSync, readFileSync } from "node:fs";

const CORPUS = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-hl/";
const V3_SERVICES = "/Users/wira/Documents/rapture/rapture/experiments/reproducer-v3/headline/services/";

const raw = (lines, body = "") =>
  `${lines.join("\r\n")}\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}Connection: close\r\n\r\n${body}`;

export const INCIDENTS = {
  "express-qs": {
    family: "express",
    svc: `${V3_SERVICES}express-qs.mjs`,
    env: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "buggy" },
    fixedEnv: { REPO_ROOT: `${CORPUS}express-4.21.1`, QS_MODE: "fixed" },
    host: "127.0.0.1",
    key: "GET /parse",
    code: "E_QS_LIMIT_BYPASS",
    probabilistic: true,
    // arrayLimit 3 bypassed by comma-joined values -> flat length 4 -> 500
    trigger: (port) => raw([`GET /parse?q=a%5B%5D%3D1%2C2%2C3%2C4 HTTP/1.1`, `Host: 127.0.0.1:${port}`]),
    // same route, same key, two values -> within the limit -> 200
    benign: (port, i) =>
      raw([`GET /parse?q=a%5B%5D%3D${i % 3}%2C${(i % 3) + 1} HTTP/1.1`, `Host: 127.0.0.1:${port}`]),
  },

  "fastify-32442": {
    family: "fastify",
    svc: `${V3_SERVICES}fastify-32442.mjs`,
    env: { REPO_ROOT: `${CORPUS}fastify-5.3.0` },
    fixedEnv: { REPO_ROOT: `${CORPUS}fastify-5.3.2` },
    host: "127.0.0.1",
    key: "POST /v",
    code: "E_VALIDATION_BYPASS",
    probabilistic: true,
    // altered content-type casing/whitespace bypasses per-content-type schema
    trigger: (port) =>
      raw(
        [`POST /v HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Content-Type: Application/JSON ; charset=utf-8`],
        JSON.stringify({ wrong: 1 }),
      ),
    benign: (port, i) =>
      raw(
        [`POST /v HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Content-Type: application/json`],
        JSON.stringify({ allow: true, n: i % 11 }),
      ),
  },

  "hapi-4564": {
    family: "hapi",
    svc: `${V3_SERVICES}hapi-4564.mjs`,
    env: { REPO_ROOT: `${CORPUS}hapi-62032e6` },
    fixedEnv: { REPO_ROOT: `${CORPUS}hapi-97c435f` },
    host: "127.0.0.1",
    key: "GET /who",
    code: "E_HOST_PARSE",
    probabilistic: true,
    // bracketed IPv6 Host over plain IPv4 loopback mis-parses the hostname
    trigger: (port) => raw([`GET /who HTTP/1.1`, `Host: [::1]:${port}`]),
    benign: (port) => raw([`GET /who HTTP/1.1`, `Host: 127.0.0.1:${port}`]),
  },

  "koa-1999": {
    family: "koa",
    svc: `${V3_SERVICES}koa-1999.mjs`,
    env: { REPO_ROOT: `${CORPUS}koa-1061776` },
    fixedEnv: { REPO_ROOT: `${CORPUS}koa-571938d` },
    host: "127.0.0.1",
    // Absolute-form request targets arrive as req.url = "http://example.com/u",
    // so their normalized detector key differs from ordinary origin-form
    // traffic to the same route ("GET /u"). Every request carrying this key
    // fails, so no benign traffic can share it: this incident admits only the
    // DETERMINISTIC and ONE_OFF profiles. Recorded as a finding, not hidden.
    key: "GET http://example.com/u",
    code: "E_URL_MISMATCH",
    probabilistic: false,
    trigger: (port) => raw([`GET http://example.com/u?q=1 HTTP/1.1`, `Host: 127.0.0.1:${port}`]),
    benign: null,
    // Ordinary origin-form traffic to the same ROUTE. It does not share the
    // incident key (that is the finding above), so it cannot express a failure
    // rate -- but it is the realistic surrounding traffic for a ONE_OFF trial,
    // where the point is simply that the failure never recurs.
    background: (port, i) => raw([`GET /u?q=${i % 7} HTTP/1.1`, `Host: 127.0.0.1:${port}`]),
    backgroundSharesKey: false,
  },
};

// For probabilistic incidents the surrounding traffic IS the benign same-key
// request, so a failure rate is expressible on the incident key itself.
for (const def of Object.values(INCIDENTS)) {
  if (def.background == null) {
    def.background = def.benign;
    def.backgroundSharesKey = true;
  }
}

export function serviceEnv(incident, revision) {
  const def = INCIDENTS[incident];
  return revision === "fixed" ? def.fixedEnv : def.env;
}

/** The fingerprint V3 recorded for this incident, used to prove the targeted
 *  artifact reproduces the SAME historical failure, not merely some 500. */
export function loadV3Fingerprint(incident) {
  const dir = `/Users/wira/Documents/rapture/rapture/experiments/reproducer-v3/results/headline/captures/${incident}`;
  const f = readdirSync(dir).filter((x) => x.endsWith(".json")).sort().at(-1);
  return JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).fingerprint;
}
