// V3.3 adversarial lifecycle probe (experiment fixture, not application code).
//
// /boom          selected failure, awaits its work normally
// /detach        selected failure whose pg query is deliberately NOT awaited:
//                the HTTP response finishes FIRST and the query completes
//                later. This is the case where "response finished" is not
//                "ownership finished".
// /slowfetch     selected failure whose outbound fetch is not awaited
// /quiet         unmatched success
import { pool, fetchFlags } from "./shared.mjs";
const repoRoot = process.env["REPO_ROOT"];
if (!repoRoot) throw new Error("REPO_ROOT is required");
const { default: express } = await import(`${repoRoot}/index.js`);

const app = express();
const db = pool();
const DELAY = Number(process.env["DETACH_DELAY_MS"] ?? "250");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tracks detached work so the harness can tell when it has truly finished.
let detachedPending = 0;
let detachedDone = 0;

async function q(marker) {
  await db.query("SELECT sid, uid, role FROM v3dir_sessions WHERE sid = $1", [`marker=${marker}`]);
}

app.get("/quiet", async (req, res) => { await q(String(req.query.m ?? "none")); await fetchFlags(); res.json({ ok: true }); });

app.get("/boom", async (req, res) => {
  await q(String(req.query.m ?? "none"));
  await fetchFlags();
  res.status(500).json({ error: "lifecycle probe", code: "E_LIFE_A" });
});

app.get("/boom2", async (req, res) => {
  await q(String(req.query.m ?? "none"));
  await fetchFlags();
  res.status(500).json({ error: "lifecycle probe B", code: "E_LIFE_B" });
});

// The critical case: respond first, let the capture-owned pg query land later.
app.get("/detach", (req, res) => {
  const m = String(req.query.m ?? "none");
  detachedPending += 1;
  const work = (async () => {
    await sleep(DELAY);
    await q(m);
    detachedDone += 1;
    detachedPending -= 1;
  })();
  work.catch(() => { detachedDone += 1; detachedPending -= 1; });
  res.status(500).json({ error: "detached lifecycle probe", code: "E_LIFE_DETACH" });
});

// Same shape for an outbound call.
app.get("/slowfetch", (req, res) => {
  detachedPending += 1;
  const work = (async () => { await sleep(DELAY); await fetchFlags(); detachedDone += 1; detachedPending -= 1; })();
  work.catch(() => { detachedDone += 1; detachedPending -= 1; });
  res.status(500).json({ error: "detached fetch probe", code: "E_LIFE_FETCH" });
});

// The genuinely outstanding case: the query is ISSUED immediately and is
// still in flight when the response finishes. This is what the quiescence
// authority must actually wait for.
app.get("/inflight", (req, res) => {
  const m = String(req.query.m ?? "none");
  detachedPending += 1;
  const work = q(m).then(() => { detachedDone += 1; detachedPending -= 1; });
  work.catch(() => { detachedDone += 1; detachedPending -= 1; });
  res.status(500).json({ error: "in-flight lifecycle probe", code: "E_LIFE_INFLIGHT" });
});

app.get("/__detached", (_req, res) => res.json({ pending: detachedPending, done: detachedDone }));

app.listen(Number(process.env["PORT"] ?? 50201), () => console.log("READY"));
