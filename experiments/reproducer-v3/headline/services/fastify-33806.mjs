// HL_FASTIFY_33806 — fastify/fastify CVE-2026-33806: per-content-type body
// validation bypass via leading space in Content-Type (" application/json"
// is parsed but validation is skipped). Buggy 5.3.2..5.8.4 -> handler sees
// invalid body. Fixed 5.8.5: 400. Same real stack as HL_FASTIFY_32442.
import { pool, sessionLookup, fetchFlags } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const { default: Fastify } = await import(`${root}/fastify.js`);

const app = Fastify({ logger: false });
const db = pool();

app.addHook("onRequest", async (req, reply) => {
  reply.header("x-logged", "1");
});

app.get("/health", async () => ({ ok: true }));

app.post(
  "/v",
  {
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
  },
  async (req, reply) => {
    const sid = req.headers["x-sid"];
    req.session = await sessionLookup(db);
    await fetchFlags();
    if (req.body == null || typeof req.body !== "object" || req.body.allow !== true) {
      reply.code(500).send({ error: "validation bypassed", code: "E_VALIDATION_BYPASS" });
      return;
    }
    return { ok: true };
  },
);

await app.listen({ port: Number(process.env["PORT"] ?? 47406) });
console.log("READY");
