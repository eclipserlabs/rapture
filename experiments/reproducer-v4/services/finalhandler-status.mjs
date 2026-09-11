// finalhandler 05d38645 — an error carrying an out-of-range status was passed
// straight through to res.statusCode instead of being normalized to 500, so
// the response failed to serialize.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const finalhandler = require(root);
const http = await import("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
  const done = finalhandler(req, res);
  try {
    // An upstream dependency raises an error carrying a nonsense status.
    const err = new Error("upstream rejected the request");
    err.status = 299;           // not an error status: invalid for an error response
    err.statusCode = 299;
    done(err);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid status not normalized", code: "E_INVALID_STATUS",
                             detail: String(e?.message ?? e).slice(0, 80) }));
  }
});
server.listen(Number(process.env["PORT"] ?? 51220), "127.0.0.1", () => console.log("READY"));
