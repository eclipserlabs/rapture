// fastify 2f597a92 — when an instance prefix already ended with '/', joining a
// nested plugin prefix produced a concatenated path, so the nested route was
// registered somewhere nobody addresses.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: Fastify } = await import(`${root}/fastify.js`);
const app = Fastify();
await app.register(async (api) => {
  await api.register(async (v1) => {
    v1.get("/orders", async () => ({ ok: true, scope: "v1-orders" }));
  }, { prefix: "v1" });
}, { prefix: "/api/" });
app.get("/health", async () => ({ ok: true }));
app.setNotFoundHandler((req, reply) => {
  // Invariant: the nested route must be addressable at its intended path.
  if (req.url.startsWith("/api/v1/orders")) {
    reply.code(500).send({ error: "nested prefix joined incorrectly", code: "E_PREFIX_JOIN", url: req.url });
    return;
  }
  reply.code(404).send({ error: "not found" });
});
await app.listen({ port: Number(process.env["PORT"] ?? 51130), host: "127.0.0.1" });
console.log("READY");
