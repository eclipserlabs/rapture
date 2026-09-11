// V3.2 session-credential probe (experiment fixture, not application code).
// Uses the session value the way real applications do: read from the Cookie
// header, then used as a BARE pg lookup parameter and echoed into app state.
import { pool, fetchFlags } from "./shared.mjs";
const repoRoot = process.env["REPO_ROOT"];
if (!repoRoot) throw new Error("REPO_ROOT is required");
const { default: express } = await import(`${repoRoot}/index.js`);

const app = express();
const db = pool();

function cookieVal(req, name) {
  const raw = req.headers.cookie ?? "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

app.get("/sess", async (req, res) => {
  const sid = cookieVal(req, "sess");
  // The threat class: the session identifier is reused as a DB lookup
  // parameter with no `name=` prefix around it.
  await db.query("SELECT sid, uid, role FROM v3dir_sessions WHERE sid = $1", [sid]);
  await fetchFlags();
  res.status(500).json({ error: "session probe incident", code: "E_SESS_PROBE" });
});

app.listen(Number(process.env["PORT"] ?? 49001), () => console.log("READY"));
