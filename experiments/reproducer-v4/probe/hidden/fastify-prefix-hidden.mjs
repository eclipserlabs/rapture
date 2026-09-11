// HIDDEN generalization oracle. Host-only.
// Root cause under test: a nested plugin prefix must join correctly when the
// parent prefix already ends with '/'. The exposed incident used /api/ + v1;
// these variants use different prefixes and different leading-slash forms.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: Fastify } = await import(`${root}/fastify.js`);
const app = Fastify();

await app.register(async (svc) => {
  await svc.register(async (v2) => { v2.get("/items", async () => ({ ok: true, scope: "hv-a" })); },
                     { prefix: "v2" });
}, { prefix: "/svc/" });

await app.register(async (z) => {
  await z.register(async (w) => { w.get("/thing", async () => ({ ok: true, scope: "hv-b" })); },
                   { prefix: "w" });
}, { prefix: "/z/" });

app.setNotFoundHandler((req, reply) => {
  reply.code(500).send({ ok: false, code: "E_PREFIX_NOT_GENERALIZED", url: req.url });
});
await app.listen({ port: Number(process.env["PORT"] ?? 49814), host: "127.0.0.1" });
console.log("READY");
