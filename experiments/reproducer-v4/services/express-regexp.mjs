// express 99a369f3 — a middleware mounted with an unanchored RegExp executed
// for paths it should not match, so an admin-guard middleware could run (and
// authorize) on unrelated routes.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: express } = await import(`${root}/index.js`);
const app = express();
let guardRan = false;
app.use(/\/admin/, (req, res, next) => { guardRan = true; req.adminScope = true; next(); });
app.get("/public/admin", (req, res) => {
  // Invariant: the admin guard must never have run for a public route.
  if (guardRan || req.adminScope) {
    res.status(500).json({ error: "admin middleware executed on a public route", code: "E_UNANCHORED_MIDDLEWARE" });
    return;
  }
  res.json({ ok: true });
});
app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(Number(process.env["PORT"] ?? 51100), () => console.log("READY"));
