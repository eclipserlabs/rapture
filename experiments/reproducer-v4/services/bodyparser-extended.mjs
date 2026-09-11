// body-parser 744a350d — urlencoded() defaulted the `extended` option
// inconsistently, so nested bracket syntax was not parsed into an object and a
// handler relying on it received a flat key.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const expressRoot = process.env["EXPRESS_ROOT"]; if (!expressRoot) throw new Error("EXPRESS_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const bodyParser = require(root);
const { default: express } = await import(`${expressRoot}/index.js`);
const app = express();
app.post("/profile", bodyParser.urlencoded(), (req, res) => {
  const addr = req.body?.address;
  // Invariant: nested bracket syntax must arrive as a nested object.
  if (addr == null || typeof addr !== "object" || addr.city == null) {
    res.status(500).json({ error: "nested body not parsed", code: "E_URLENCODED_EXTENDED",
                           got: JSON.stringify(req.body).slice(0, 90) });
    return;
  }
  res.json({ ok: true, city: addr.city });
});
app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(Number(process.env["PORT"] ?? 51200), () => console.log("READY"));
