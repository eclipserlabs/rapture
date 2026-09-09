// HL_EXPRESS_SEMVER — npm/node-semver PR #878 (closes #512), exercised
// through a real express service stack.
// Vendored historical implementations reused unmodified from V1
// (exact SHAs 8640bd68 buggy / 9c8692ae fixed, selected via SEMVER_MODE).
// Buggy: satisfies('1.2.0-rc','~1.2',{includePrerelease:true}) is false.
// Service compares against the DB-seeded rollout expectation
// (v2_expect/semver-tilde = 'true'): mismatch -> 500 E_SEMVER_MISMATCH,
// match -> 200. pg is causal here; fetch is noise.
import { createRequire } from "node:module";
import { pool, sessionLookup, fetchFlags } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const { default: express } = await import(`${root}/index.js`);

const semMode = process.env["SEMVER_MODE"] ?? "buggy";
const semSub = semMode === "fixed" ? "post" : "buggy";
const semPkg = new URL(
  `../../../reproducer-v1/real-bugs/rb-semver-tilde-prerelease/impl/${semSub}/package.json`,
  import.meta.url,
);
const semver = createRequire(semPkg.href)("./index.js");

const app = express();
const db = pool();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("x-logged", "1");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/check", async (req, res) => {
  req.session = await sessionLookup(db);
  await fetchFlags();
  const exp = await db.query("SELECT value FROM v2_expect WHERE key = $1", ["semver-tilde"]);
  const expected = exp.rows[0]?.value ?? "true";
  const got = String(semver.satisfies("1.2.0-rc", "~1.2", { includePrerelease: true }));
  if (got !== expected) {
    res.status(500).json({ error: "semver mismatch", code: "E_SEMVER_MISMATCH" });
    return;
  }
  res.json({ ok: true, satisfies: got });
});

app.listen(Number(process.env["PORT"] ?? 47409), () => console.log("READY"));
