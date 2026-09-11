// HIDDEN generalization oracle. Host-only. Never mounted into a subject workspace.
// Root cause under test: res.cookie() with an absent maxAge must omit expiry
// rather than emitting an unparseable Expires (or throwing). The exposed
// incident used cookie "sid" on /session; these variants use different cookie
// names, different options and different paths.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: express } = await import(`${root}/index.js`);
const app = express();

const probe = (name, value, opts) => (req, res) => {
  try {
    res.cookie(name, value, opts);
    const set = res.getHeader("Set-Cookie");
    const header = Array.isArray(set) ? set.join("; ") : String(set ?? "");
    if (/Invalid Date/i.test(header)) {
      res.status(500).json({ ok: false, code: "E_COOKIE_NOT_GENERALIZED", header: header.slice(0, 120) });
      return;
    }
    res.json({ ok: true, header: header.slice(0, 120) });
  } catch (err) {
    res.status(500).json({ ok: false, code: "E_COOKIE_THREW", detail: String(err?.message ?? err).slice(0, 120) });
  }
};

app.get("/hv-a", probe("token", "xyz789", { maxAge: undefined, path: "/api", httpOnly: true }));
app.get("/hv-b", probe("pref", "dark", { maxAge: undefined, domain: "example.test", sameSite: "lax" }));
app.listen(Number(process.env["PORT"] ?? 49810), () => console.log("READY"));
