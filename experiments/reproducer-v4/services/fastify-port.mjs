// fastify 6ac2e953 — request.port was derived from the raw Host header rather
// than the normalized request.host, so a forwarded/authority form yielded the
// wrong port and a self-referential URL was built incorrectly.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: Fastify } = await import(`${root}/fastify.js`);
const app = Fastify({ trustProxy: true });
app.get("/callback-url", async (req, reply) => {
  const port = req.port;
  const host = req.host;
  // Invariant: the derived port must agree with the host the request reports.
  const expected = host && host.includes(":") ? Number(host.split(":").pop()) : null;
  if (expected != null && port !== expected) {
    return reply.code(500).send({ error: "derived port disagrees with host", code: "E_PORT_DERIVATION",
                                  host: String(host), port: String(port) });
  }
  return { ok: true, url: `https://${host}/cb` };
});
app.get("/health", async () => ({ ok: true }));
await app.listen({ port: Number(process.env["PORT"] ?? 51210), host: "127.0.0.1" });
console.log("READY");
