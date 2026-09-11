// HIDDEN generalization oracle for koa-1998. Host-only. NEVER mounted into a
// subject workspace and never referenced by any evidence pack.
//
// Root cause under test: ctx.assert must throw an error that is an instance of
// the framework's HttpError. The exposed incident used status 401 on /admin;
// these variants use DIFFERENT statuses, messages and paths, so a patch that
// special-cases 401 or /admin does not pass.
const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const KoaMod = await import(`${root}/lib/application.js`);
const Koa = KoaMod.default ?? KoaMod;

const app = new Koa();

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    // The generalization check: the thrown assertion error must be a real
    // HttpError carrying its status, whatever the status or message was.
    if (err instanceof Koa.HttpError) {
      ctx.status = err.status;
      ctx.body = { ok: true, variant: "httperror", message: err.message };
    } else {
      ctx.status = 500;
      ctx.body = { ok: false, code: "E_ASSERT_NOT_HTTPERROR", got: err?.constructor?.name ?? typeof err };
    }
  }
});

app.use(async (ctx) => {
  if (ctx.path === "/hidden-a") { ctx.assert(false, 403, "forbidden-variant-a"); return; }
  if (ctx.path === "/hidden-b") { ctx.assert(false, 402, "payment-required-variant-b"); return; }
  ctx.status = 404;
  ctx.body = { error: "not found" };
});

app.listen(Number(process.env["PORT"] ?? 49801), () => console.log("READY"));
