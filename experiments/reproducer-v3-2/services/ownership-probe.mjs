// V3.2 ownership probe service (experiment fixture, not application code).
//
// Each request plants its OWN marker into the pg query parameters, so a
// captured incident can be checked for boundary observations that belong to a
// different request. /boom and /boom2 fail (capturable); /quiet succeeds.
import { pool, fetchFlags } from "./shared.mjs";

// express comes from the corpus clone, exactly as the other fixtures load it.
const repoRoot = process.env["REPO_ROOT"];
if (!repoRoot) throw new Error("REPO_ROOT is required");
const { default: express } = await import(`${repoRoot}/index.js`);

const app = express();
const db = pool();

async function work(marker) {
  // The marker travels in the SQL PARAMETERS, which is what the pg capture
  // records. If ownership is broken, this value lands in a foreign incident.
  await db.query("SELECT sid, uid, role FROM v3dir_sessions WHERE sid = $1", [`marker=${marker}`]);
  await fetchFlags();
}

app.get("/quiet", async (req, res) => {
  await work(String(req.query.m ?? "none"));
  res.json({ ok: true });
});
app.get("/boom", async (req, res) => {
  await work(String(req.query.m ?? "none"));
  res.status(500).json({ error: "ownership probe A", code: "E_OWN_A" });
});
app.get("/boom2", async (req, res) => {
  await work(String(req.query.m ?? "none"));
  res.status(500).json({ error: "ownership probe B", code: "E_OWN_B" });
});

app.listen(Number(process.env["PORT"] ?? 48901), () => console.log("READY"));
