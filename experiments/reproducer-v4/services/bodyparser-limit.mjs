// body-parser 2a2f4719 — when a gzip-inflated body exceeded the configured
// limit, an internal error escaped instead of the documented 413, so a size
// guard returned a 500 to the caller.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const expressRoot = process.env["EXPRESS_ROOT"]; if (!expressRoot) throw new Error("EXPRESS_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const bodyParser = require(root);
const { default: express } = await import(`${expressRoot}/index.js`);
const app = express();
app.post("/ingest", bodyParser.json({ limit: "1kb" }), (req, res) => res.json({ ok: true }));
app.use((err, req, res, _next) => {
  // Invariant: an over-limit payload must surface as a client error (413),
  // never as an opaque internal failure.
  const status = err?.status ?? err?.statusCode;
  if (status !== 413) {
    res.status(500).json({ error: "over-limit body produced a non-413 failure", code: "E_LIMIT_INTERNAL",
                           type: err?.type ?? null, got: status ?? null, msg: String(err?.message ?? err).slice(0, 80) });
    return;
  }
  res.status(413).json({ error: "payload too large" });
});
app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(Number(process.env["PORT"] ?? 51160), () => console.log("READY"));
