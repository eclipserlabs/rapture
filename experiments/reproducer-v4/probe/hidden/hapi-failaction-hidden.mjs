// HIDDEN generalization oracle. Host-only.
// Root cause under test: the framework must surface the default validation
// error to a custom failAction. The exposed incident validated a payload object
// with an integer minimum on POST /orders; these variants use a different
// schema kind, a different validation source (query) and different methods.
const root = process.env["REPO_ROOT"]; if (!root) throw new Error("REPO_ROOT required");
const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const Hapi = require(root);
const Joi = require(`${root}/node_modules/@hapi/validate`);

const server = Hapi.server({ port: Number(process.env["PORT"] ?? 49818), host: "127.0.0.1" });

const failAction = (request, h, err) => {
  const dflt = err?.data?.defaultError;
  if (!dflt) {
    return h.response({ ok: false, code: "E_DEFAULT_ERROR_NOT_GENERALIZED" }).code(500).takeover();
  }
  return h.response({ ok: true, detail: String(dflt.message).slice(0, 80) }).code(200).takeover();
};

server.route({
  method: "PUT", path: "/hv-a",
  options: { validate: { payload: Joi.object({ label: Joi.string().min(8).required() }), failAction } },
  handler: () => ({ ok: true, unreached: true }),
});
server.route({
  method: "GET", path: "/hv-b",
  options: { validate: { query: Joi.object({ page: Joi.number().integer().min(1).required() }), failAction } },
  handler: () => ({ ok: true, unreached: true }),
});

await server.start();
console.log("READY");
