// HL_EXPRESS_QS — ljharb/qs CVE-2026-2391 follow-up (arrayLimit bypass),
// exercised through a real express service stack.
// Vendored historical implementations reused unmodified from V1
// (exact SHAs 8079adc7 buggy / 8859c374 fixed, selected via QS_MODE).
// Buggy: parse('a[]=1,2,3,4',{comma,arrayLimit:3,throwOnLimitExceeded:true})
// silently returns -> service invariant violated -> 500 E_QS_LIMIT_BYPASS.
// Fixed: throws RangeError -> 400. Plus pg noise + fetch noise.
import { createRequire } from "node:module";
import { pool, sessionLookup, fetchFlags, telemetry } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const { default: express } = await import(`${root}/index.js`);

const qsMode = process.env["QS_MODE"] ?? "buggy";
const qsSub = qsMode === "fixed" ? "post" : "buggy";
const qsPkg = new URL(
  `../../reproducer-v1/real-bugs/rb-qs-comma-arraylimit/impl/${qsSub}/package.json`,
  import.meta.url,
);
const qs = createRequire(qsPkg.href)("./lib/index.js");

const app = express();
const db = pool();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("x-logged", "1");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/__stats", (_req, res) => res.json(telemetry()));

app.get(["/parse", "/parse-b"], async (req, res) => {
  req.session = await sessionLookup(db);
  await fetchFlags();
  const q = String(req.query.q ?? "a[]=1,2,3,4");
  let parsed;
  try {
    parsed = qs.parse(q, { comma: true, arrayLimit: 3, throwOnLimitExceeded: true });
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: "limit enforced", code: "E_QS_LIMIT_OK" });
      return;
    }
    throw err;
  }
  const arr = parsed?.a;
  const flat = Array.isArray(arr) ? arr.flat(Infinity) : [];
  if (flat.length > 3) {
    res.status(500).json({ error: "array limit bypassed", code: "E_QS_LIMIT_BYPASS" });
    return;
  }
  res.json({ ok: true, parsed });
});

app.listen(Number(process.env["PORT"] ?? 47404), () => console.log("READY"));
