// express 58553394 — res.cookie() with a null/undefined maxAge produced an
// "Invalid Date" Expires attribute instead of omitting expiry, so the
// Set-Cookie header was malformed.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: express } = await import(`${root}/index.js`);
const app = express();
app.get("/session", (req, res) => {
  const ttl = req.query.ttl === "persist" ? 3600000 : undefined; // no TTL configured
  res.cookie("sid", "abc123", { maxAge: ttl, httpOnly: true });
  const set = res.getHeader("Set-Cookie");
  const header = Array.isArray(set) ? set.join("; ") : String(set ?? "");
  // Invariant: a session cookie must never carry an unparseable Expires.
  if (/Invalid Date/i.test(header)) {
    res.status(500).json({ error: "malformed Set-Cookie expiry", code: "E_COOKIE_INVALID_DATE", header: header.slice(0, 100) });
    return;
  }
  res.json({ ok: true });
});
app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(Number(process.env["PORT"] ?? 51180), () => console.log("READY"));
