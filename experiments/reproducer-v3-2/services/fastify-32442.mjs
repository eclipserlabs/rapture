// HL_FASTIFY_32442 — fastify/fastify CVE-2025-32442: per-content-type body
// validation bypass via altered content-type (casing / whitespace before ;).
// Buggy <=5.3.0/4.29.0: validation skipped -> handler sees invalid body.
// Fixed 5.3.2/4.29.1 (commits 436da4c/f3d2bcb): 400.
// Real stack: fastify + onRequest logging hook, pg session, fetch config,
// per-content-type schema validation, multi-module handler.
import { pool, sessionLookup, fetchFlags, telemetry } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const { default: Fastify } = await import(`${root}/fastify.js`);

const app = Fastify({ logger: false });
const db = pool();

app.addHook("onRequest", async (req, reply) => {
  reply.header("x-logged", "1");
});

app.get("/health", async () => ({ ok: true }));
app.get("/__stats", async () => telemetry());

// V3.2: the same options object and the same handler are registered at two
// paths, so the armed and unmatched populations perform byte-identical
// application work while normalizing to distinct route keys.
const vOpts = {
  schema: {
    body: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["allow"],
            properties: { allow: { type: "boolean" } },
          },
        },
      },
    },
  },
};

const vHandler = async (req, reply) => {
  req.session = await sessionLookup(db);
  await fetchFlags();
  if (req.body == null || typeof req.body !== "object" || req.body.allow !== true) {
    reply.code(500).send({ error: "validation bypassed", code: "E_VALIDATION_BYPASS" });
    return;
  }
  return { ok: true };
};

app.post("/v", vOpts, vHandler);
app.post("/v-b", vOpts, vHandler);

await app.listen({ port: Number(process.env["PORT"] ?? 47405) });
console.log("READY");
