// hapi 619380ab — the default validation error was not made available to a
// custom failAction, so a handler that relies on it produced an unusable
// response.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const Hapi = require(root);
const Joi = require(`${root}/node_modules/@hapi/validate`);
const server = Hapi.server({ port: Number(process.env["PORT"] ?? 51150), host: "127.0.0.1" });
server.route({
  method: "POST", path: "/orders",
  options: {
    validate: {
      payload: Joi.object({ qty: Joi.number().integer().min(1).required() }),
      failAction: (request, h, err) => {
        // Invariant: the framework must surface the default error so the
        // service can return a structured validation response.
        const dflt = err?.data?.defaultError;
        if (!dflt) {
          return h.response({ error: "default validation error unavailable", code: "E_NO_DEFAULT_ERROR" }).code(500).takeover();
        }
        return h.response({ error: "validation failed", detail: String(dflt.message).slice(0, 60) }).code(400).takeover();
      },
    },
  },
  handler: () => ({ ok: true }),
});
server.route({ method: "GET", path: "/health", handler: () => ({ ok: true }) });
await server.start();
console.log("READY");
