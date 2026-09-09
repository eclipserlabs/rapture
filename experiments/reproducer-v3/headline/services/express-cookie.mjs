// HL_EXPRESS_COOKIE — expressjs/express + jshttp/cookie CVE-2024-47764.
// Buggy express 4.19.2 (cookie 0.6.0): res.cookie() serializes names with
// invalid characters (e.g. "a b") into a malformed Set-Cookie header.
// Fixed 4.21.1 (cookie 0.7.1): serialize throws -> service maps to 400.
// Real stack: express.json + logging middleware, pg session, fetch config.
import { pool, sessionLookup, fetchFlags } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const { default: express } = await import(`${root}/index.js`);

const app = express();
const db = pool();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("x-logged", "1");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/c", async (req, res) => {
  req.session = await sessionLookup(db);
  await fetchFlags();
  const name = String(req.query.n ?? "theme");
  try {
    res.cookie(name, "v");
  } catch {
    res.status(400).json({ error: "cookie rejected", code: "E_COOKIE_REJECTED" });
    return;
  }
  const setCookie = res.getHeader("set-cookie") ?? "";
  // RFC 6265 token characters only; anything else is header injection.
  if (/[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/.test(String(setCookie))) {
    res.status(500).json({ error: "cookie header injection", code: "E_COOKIE_INJECT" });
    return;
  }
  res.json({ ok: true });
});

app.listen(Number(process.env["PORT"] ?? 47403), () => console.log("READY"));
