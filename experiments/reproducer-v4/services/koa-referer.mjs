// koa 769fd75c — ctx.redirect('back') trusted the Referrer header without
// normalizing it, so a crafted referrer produced an off-site redirect.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: Koa } = await import(`${root}/lib/application.js`);
const app = new Koa();
app.use(async (ctx) => {
  if (ctx.path === "/health") { ctx.body = { ok: true }; return; }
  if (ctx.path === "/logout") {
    ctx.redirect("back", "/");
    const loc = ctx.response.get("Location") ?? "";
    // Invariant: logout must only ever redirect within this site.
    if (!(loc === "/" || loc.startsWith("/") && !loc.startsWith("//"))) {
      ctx.status = 500;
      ctx.body = { error: "off-site redirect from referrer", code: "E_OPEN_REDIRECT", location: loc };
    }
    return;
  }
  ctx.status = 404; ctx.body = { error: "not found" };
});
app.listen(Number(process.env["PORT"] ?? 51120), () => console.log("READY"));
