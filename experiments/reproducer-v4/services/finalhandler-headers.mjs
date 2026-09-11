// finalhandler 7bfa2f71 — err.headers was copied with Object.keys() without
// checking it was an object, so a non-object value produced garbage response
// headers (a string yields numeric indices) on the error response.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const finalhandler = require(root);
const http = await import("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
  const done = finalhandler(req, res);
  // An upstream dependency raises an error whose `headers` is not an object.
  const err = new Error("upstream rejected the request");
  err.status = 503;          // the header-copy branch only runs with a status
  err.headers = "retry-after"; // not an object

  done(err);
});
server.listen(Number(process.env["PORT"] ?? 51230), "127.0.0.1", () => console.log("READY"));
