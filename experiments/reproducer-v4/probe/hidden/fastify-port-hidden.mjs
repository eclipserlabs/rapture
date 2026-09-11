// HIDDEN generalization oracle. Host-only.
// Root cause under test: request.port must be derived from the NORMALIZED
// request.host rather than the raw Host header. The exposed incident used
// api.example.com:8443; these variants use different authorities and ports,
// supplied through a different forwarding header form.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { default: Fastify } = await import(`${root}/fastify.js`);
const app = Fastify({ trustProxy: true });

app.get("/hv-a", async (req, reply) => check(req, reply));
app.get("/hv-b", async (req, reply) => check(req, reply));

function check(req, reply) {
  const host = req.host;
  const port = req.port;
  const expected = host && String(host).includes(":") ? Number(String(host).split(":").pop()) : null;
  if (expected == null) {
    return reply.code(500).send({ ok: false, code: "E_PORT_NO_HOST", host: String(host) });
  }
  if (port !== expected) {
    return reply.code(500).send({ ok: false, code: "E_PORT_NOT_GENERALIZED", host: String(host), port: String(port) });
  }
  return { ok: true, host: String(host), port };
}

await app.listen({ port: Number(process.env["PORT"] ?? 49816), host: "127.0.0.1" });
console.log("READY");
