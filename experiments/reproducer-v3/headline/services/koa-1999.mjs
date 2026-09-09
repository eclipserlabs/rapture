// HL_KOA_1999 — koa/koa #1999: absolute-form request targets.
// Buggy 1061776: ctx.URL is garbage for absolute-form (protocol://host
// concatenated onto an already-absolute URL). Fixed 571938d: parses as-is.
// Real stack: koa app.listen + logging + error middleware, pg session
// lookup (auth), outbound fetch (config), multi-module service route.
import { pool, sessionLookup, fetchFlags, telemetry } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const KoaMod = await import(`${root}/lib/application.js`);
const Koa = KoaMod.default ?? KoaMod;

const app = new Koa();
const db = pool();

app.use(async (ctx, next) => {
  ctx.set("x-logged", "1");
  await next();
});
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.status = err.status ?? 500;
    ctx.body = { error: "unhandled", code: "E_UNHANDLED" };
  }
});

app.use(async (ctx) => {
  if (ctx.path === "/health") {
    ctx.body = { ok: true };
    return;
  }
  if (ctx.path === "/__stats") {
    ctx.body = telemetry();
    return;
  }
  if (ctx.path === "/u") {
    ctx.state.session = await sessionLookup(db);
    await fetchFlags();
    // Invariant: URL and href must agree on the request target.
    if (ctx.URL.href !== ctx.href) {
      ctx.status = 500;
      ctx.body = { error: "URL mismatch", code: "E_URL_MISMATCH" };
      return;
    }
    ctx.body = { ok: true, href: ctx.href };
    return;
  }
  ctx.status = 404;
  ctx.body = { error: "not found" };
});

app.listen(Number(process.env["PORT"] ?? 47401), () => console.log("READY"));
