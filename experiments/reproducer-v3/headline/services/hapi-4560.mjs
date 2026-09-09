// HL_HAPI_4560 — hapijs/hapi #4560 (fixed ee8475b8): request.url getter
// fails when the Host header is absent and the server is bound to a bare
// IPv6 address (no brackets around host:port -> new URL throws -> 500).
// Buggy 50953827: 500 E_URL_GETTER. Fixed ee8475b8: 200 with correct URL.
// Real stack: hapi server bound to ::1 + onPreResponse logging extension,
// pg session lookup, fetch config.
import { pool, sessionLookup, fetchFlags } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const HapiMod = await import(`${root}/lib/index.js`);
const Hapi = HapiMod.default ?? HapiMod;

const db = pool();
const server = Hapi.server({
  host: process.env["HOST"] ?? "::1",
  port: Number(process.env["PORT"] ?? 47407),
});

server.ext("onPreResponse", (req, h) => {
  if (!req.response.isBoom) req.response.header("x-logged", "1");
  return h.continue;
});

server.route({
  method: "GET",
  path: "/health",
  handler: () => ({ ok: true }),
});

server.route({
  method: "GET",
  path: "/u",
  handler: async (req, h) => {
    req.session = await sessionLookup(db);
    await fetchFlags();
    let href;
    try {
      href = req.url.href;
    } catch {
      return h.response({ error: "url getter failed", code: "E_URL_GETTER" }).code(500);
    }
    return { ok: true, href };
  },
});

await server.start();
console.log("READY");
