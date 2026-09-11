// express 9dd0e7af — res.jsonp() with an undefined body threw because the
// escape path assumed a string.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: express } = await import(`${root}/index.js`);
const app = express();
app.set("jsonp callback name", "cb");
app.get("/lookup", (req, res) => {
  const found = req.query.id === "known" ? { id: "known" } : undefined;
  try { res.jsonp(found); }
  catch (err) {
    res.status(500).json({ error: "jsonp serialization failed", code: "E_JSONP_UNDEFINED", detail: String(err?.message ?? err).slice(0, 90) });
  }
});
app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(Number(process.env["PORT"] ?? 51110), () => console.log("READY"));
