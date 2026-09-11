// restify cb2e7177 — a handler throwing a non-Error value (e.g. `throw 'x'`)
// was mishandled: the value's statusCode was trusted without checking it was
// really an Error, producing an incorrect response.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const restify = require(root);
const server = restify.createServer({ handleUncaughtExceptions: true });
server.get("/charge", (req, res, next) => {
  // A dependency throws a bare string rather than an Error.
  throw { statusCode: 200, message: "not a real error" };
});
server.get("/health", (req, res, next) => { res.send({ ok: true }); next(); });
server.on("restifyError", (req, res, err, cb) => cb());
server.listen(Number(process.env["PORT"] ?? 51140), "127.0.0.1", () => console.log("READY"));
