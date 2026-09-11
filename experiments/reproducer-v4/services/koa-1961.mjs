// V4 fresh case: koa #1961 — ctx.request.length truncates Content-Length to a
// signed 32-bit integer (`~~len`), so declared sizes above 2 GB wrap.
//
// Experiment-authored service scaffolding, in the V3 pattern: the historical
// defect is exercised through koa's real request pipeline, and a realistic
// upload-guard invariant turns it into an HTTP 500.
const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const { default: Koa } = await import(`${root}/lib/application.js`);

const MAX_UPLOAD = 8 * 1024 * 1024 * 1024; // 8 GB ceiling
const app = new Koa();

app.use(async (ctx) => {
  if (ctx.path === "/health") { ctx.body = { ok: true }; return; }
  if (ctx.path === "/upload") {
    const declared = ctx.request.header["content-length"];
    const parsed = ctx.request.length;
    // Upload guard: the parsed length must agree with the declared header and
    // must never be negative. A 32-bit truncation breaks both.
    if (declared != null && (parsed == null || parsed < 0 || String(parsed) !== String(declared))) {
      ctx.status = 500;
      ctx.body = { error: "content length guard failed", code: "E_LENGTH_OVERFLOW",
                   declared: String(declared), parsed: String(parsed) };
      return;
    }
    if (parsed != null && parsed > MAX_UPLOAD) { ctx.status = 413; ctx.body = { error: "too large" }; return; }
    ctx.body = { ok: true, accepted: parsed };
    return;
  }
  ctx.status = 404; ctx.body = { error: "not found" };
});
app.listen(Number(process.env["PORT"] ?? 51001), () => console.log("READY"));
