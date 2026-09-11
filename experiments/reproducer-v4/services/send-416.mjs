// send 24b4af2e — the emitted 416 error lacked a headers property, so a service
// relying on it to set Content-Range produced a malformed range response.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const send = require(root);
const http = await import("node:http");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v4send-"));
fs.writeFileSync(path.join(dir, "asset.txt"), "0123456789");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
  send(req, "/asset.txt", { root: dir })
    .on("error", (err) => {
      // Invariant: a 416 must arrive with the headers the range protocol requires.
      if (err.status === 416 && (!err.headers || !err.headers["Content-Range"])) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "416 emitted without Content-Range headers", code: "E_416_NO_HEADERS" }));
        return;
      }
      res.writeHead(err.status ?? 500, err.headers ?? {});
      res.end(JSON.stringify({ error: "range error", status: err.status ?? null }));
    })
    .pipe(res);
});
server.listen(Number(process.env["PORT"] ?? 51170), "127.0.0.1", () => console.log("READY"));
