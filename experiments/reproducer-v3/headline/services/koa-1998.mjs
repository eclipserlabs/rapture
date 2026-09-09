// HL_KOA_1998 — koa/koa #1998 (fixes #1925): ctx.assert errors must be
// HttpError instances. Buggy 4a191b1: assert throws a non-HttpError, so the
// service error middleware cannot map it to 401 and returns 500 instead.
// Fixed 1061776: 401 with proper HttpError.
// Real stack: koa + logging + error middleware, pg session, fetch config.
import { pool, sessionLookup, fetchFlags } from "./shared.mjs";

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
// Service error mapping: Koa.HttpError -> its status; the historical
// assertion failure (thrown by ctx.assert with 401) -> E_ASSERT_REGRESSION;
// anything else (including replay-infrastructure throws, which never carry
// the guard's 401 status) propagates to the framework default so an infra
// failure can NEVER satisfy the incident fingerprint (oracle safety rule).
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof Koa.HttpError) {
      ctx.status = err.status;
      ctx.body = { error: err.message, code: "E_UNAUTH" };
    } else if (
      err != null &&
      typeof err === "object" &&
      err.status === 401 &&
      err.expose === true
    ) {
      ctx.status = 500;
      ctx.body = { error: "assert regression", code: "E_ASSERT_REGRESSION" };
    } else {
      throw err;
    }
  }
});

app.use(async (ctx) => {
  if (ctx.path === "/health") {
    ctx.body = { ok: true };
    return;
  }
  if (ctx.path === "/admin") {
    ctx.state.session = await sessionLookup(db);
    await fetchFlags();
    ctx.assert(ctx.state.session != null, 401, "unauthenticated");
    ctx.body = { ok: true, uid: ctx.state.session.uid };
    return;
  }
  ctx.status = 404;
  ctx.body = { error: "not found" };
});

app.listen(Number(process.env["PORT"] ?? 47402), () => console.log("READY"));
