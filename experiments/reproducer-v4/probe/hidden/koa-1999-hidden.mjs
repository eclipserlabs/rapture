// HIDDEN generalization oracle for koa-1999. Host-only.
//
// Root cause under test: ctx.URL must parse an absolute-form request target
// as-is rather than concatenating protocol://host onto an already-absolute
// URL. The exposed incident used http://example.com/u?q=1; these variants use
// DIFFERENT schemes, authorities and queries.
const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const KoaMod = await import(`${root}/lib/application.js`);
const Koa = KoaMod.default ?? KoaMod;

const app = new Koa();

app.use(async (ctx) => {
  const expectHost = ctx.get("x-expect-host");
  if (!expectHost) { ctx.status = 404; ctx.body = { error: "not found" }; return; }
  let host = null, href = null, parseError = null;
  try { host = ctx.URL.host; href = ctx.URL.href; } catch (err) { parseError = String(err?.message ?? err); }
  const ok = parseError == null && host === expectHost && href === ctx.href;
  ctx.status = ok ? 200 : 500;
  ctx.body = ok
    ? { ok: true, host, href }
    : { ok: false, code: "E_URL_NOT_GENERALIZED", host, href, ctx_href: ctx.href, parseError };
});

app.listen(Number(process.env["PORT"] ?? 49901), () => console.log("READY"));
