// HIDDEN generalization oracle. Host-only.
// Root cause under test: res.jsonp() must handle an undefined body rather than
// assuming the serialized value is a string. The exposed incident used callback
// name "cb" on /lookup; these variants use different callback names, a
// different callback setting and different routes.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: express } = await import(`${root}/index.js`);

const mount = (app, path) => app.get(path, (req, res) => {
  try {
    res.jsonp(undefined);
    if (!res.headersSent) res.end();
  } catch (err) {
    res.status(500).json({ ok: false, code: "E_JSONP_NOT_GENERALIZED", detail: String(err?.message ?? err).slice(0, 120) });
  }
});

const app = express();
app.set("jsonp callback name", "render2");
mount(app, "/hv-a");

const app2 = express();           // default callback name
mount(app2, "/hv-b");
app.use(app2);

app.listen(Number(process.env["PORT"] ?? 49812), () => console.log("READY"));
