// V4 fresh candidate definitions. Selected under the FROZEN eligibility rules
// only: public historical Node/TS backend bug, unused in V0-V3.3, real
// service/framework request path, exact buggy+fixed revisions, bounded
// HTTP-facing failure. NOT selected on expected agent difficulty, expected
// .repro usefulness, statefulness or captured event count.
import net from "node:net";
const B = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/";
const V4 = "/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v4/repos/";

const http = (port, path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, opts)
  .then(async (r) => ({ status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers) }))
  .catch((e) => ({ status: 0, body: "FETCH_ERR " + String(e?.message ?? e).slice(0, 80) }));

const raw = (port, lines) => new Promise((res) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
  let buf = ""; s.on("data", (d) => (buf += d));
  s.on("close", () => { const head = buf.split("\r\n")[0] || ""; const m = head.match(/ (\d{3}) /);
    res({ status: m ? Number(m[1]) : 0, body: (buf.split("\r\n\r\n")[1] || "").slice(0, 200) }); });
  s.on("error", (e) => res({ status: 0, body: "SOCK_ERR " + e.message }));
});

const failed = (b, f, code) => b.status === 500 && String(b.body).includes(code) && f.status !== 500;

export const CASES = [
  { id: "koa-1961", repo: "koa", repoPath: V4 + "koa", repository: "koajs/koa", stack: "koa", issue: "#1961",
    fixSha: "3f3ac489", service: "koa-1961.mjs", port: 51001, routeKey: "GET /upload",
    summary: "ctx.request.length used ~~len, truncating Content-Length to a signed 32-bit integer",
    trigger: (p) => raw(p, [`GET /upload HTTP/1.1`, `Host: 127.0.0.1:${p}`, `Content-Length: 4294967296`, `Connection: close`]),
    discriminates: (b, f) => failed(b, f, "E_LENGTH_OVERFLOW") },

  { id: "express-cookie-maxage", repo: "express", repoPath: B + "corpus/express", repository: "expressjs/express", stack: "express", issue: "58553394",
    fixSha: "58553394", service: "express-cookie-maxage.mjs", port: 51180, routeKey: "GET /session",
    summary: "res.cookie() with a null/undefined maxAge produced an Invalid Date Expires attribute",
    trigger: (p) => http(p, "/session"),
    // The buggy revision throws inside res.cookie rather than reaching the
    // service invariant, which is a faithful reproduction of the historical
    // defect; discrimination is on the failure itself.
    discriminates: (b, f) => b.status === 500 && f.status === 200 },

  { id: "express-jsonp", repo: "express", repoPath: B + "corpus/express", repository: "expressjs/express", stack: "express", issue: "9dd0e7af",
    fixSha: "9dd0e7af", service: "express-jsonp.mjs", port: 51110, routeKey: "GET /lookup",
    summary: "res.jsonp() threw when the body was undefined because the escape path assumed a string",
    trigger: (p) => http(p, "/lookup?id=missing&cb=render"),
    discriminates: (b, f) => failed(b, f, "E_JSONP_UNDEFINED") },

  { id: "fastify-prefix", repo: "fastify", repoPath: B + "corpus/fastify", repository: "fastify/fastify", stack: "fastify", issue: "#6803",
    fixSha: "2f597a92", service: "fastify-prefix.mjs", port: 51130, routeKey: "GET /api/v1/orders",
    summary: "nested plugin prefixes joined without a separator when the parent prefix already ended in '/'",
    trigger: (p) => http(p, "/api/v1/orders"),
    discriminates: (b, f) => failed(b, f, "E_PREFIX_JOIN") },

  { id: "hapi-failaction", repo: "hapi", repoPath: B + "corpus/hapi", repository: "hapijs/hapi", stack: "hapi", issue: "#4350",
    fixSha: "619380ab", service: "hapi-failaction.mjs", port: 51150, routeKey: "POST /orders",
    summary: "the default validation error was not exposed to a custom failAction",
    trigger: (p) => http(p, "/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 0 }) }),
    discriminates: (b, f) => failed(b, f, "E_NO_DEFAULT_ERROR") },

  { id: "send-416", repo: "send", repoPath: V4 + "send", repository: "pillarjs/send", stack: "node:http+send", issue: "24b4af2e",
    fixSha: "24b4af2e", service: "send-416.mjs", port: 51170, routeKey: "GET /asset.txt",
    dependency_through_service: true,
    summary: "the emitted 416 error lacked a headers property, so Content-Range was missing",
    trigger: (p) => http(p, "/asset.txt", { headers: { range: "bytes=9999-99999" } }),
    discriminates: (b, f) => failed(b, f, "E_416_NO_HEADERS") },
  { id: "fastify-port", repo: "fastify", repoPath: B + "corpus/fastify", repository: "fastify/fastify", stack: "fastify", issue: "#6680",
    fixSha: "6ac2e953", service: "fastify-port.mjs", port: 51210, routeKey: "GET /callback-url",
    summary: "request.port was derived from the raw Host header rather than the normalized request.host",
    trigger: (p) => http(p, "/callback-url", { headers: { "x-forwarded-host": "api.example.com:8443" } }),
    discriminates: (b, f) => failed(b, f, "E_PORT_DERIVATION") },
  { id: "finalhandler-headers", repo: "finalhandler", repoPath: V4 + "finalhandler", repository: "pillarjs/finalhandler", stack: "node:http+finalhandler", issue: "7bfa2f71",
    fixSha: "7bfa2f71", service: "finalhandler-headers.mjs", port: 51230, routeKey: "GET /charge",
    dependency_through_service: true,
    summary: "err.headers was copied with Object.keys() without checking it was an object, producing garbage response headers",
    trigger: (p) => http(p, "/charge"),
    // Both revisions return 500; the defect shows as numeric header keys.
    discriminates: (b, f) => {
      const numeric = (h) => Object.keys(h ?? {}).some((k) => /^\d+$/.test(k));
      return b.status >= 500 && numeric(b.headers) && !numeric(f.headers);
    } },
];
