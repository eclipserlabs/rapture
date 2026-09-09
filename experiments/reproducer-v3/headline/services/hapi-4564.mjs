// HL_HAPI_4564 — hapijs/hapi #4564 (fixed 97c435fe): invalid hostname
// parsing for IPv6-formatted Host headers. Buggy 62032e6d: a request with
// a bracketed IPv6 Host header mis-parses request.info.hostname, so the
// service's host allowlist check fails closed with 500 E_HOST_PARSE.
// Fixed 97c435fe: hostname parses -> 200.
// Real stack: hapi + logging extension, pg session, fetch config.
import { pool, sessionLookup, fetchFlags } from "./shared.mjs";

const root = process.env["REPO_ROOT"];
if (!root) throw new Error("REPO_ROOT is required");
const HapiMod = await import(`${root}/lib/index.js`);
const Hapi = HapiMod.default ?? HapiMod;

const db = pool();
const server = Hapi.server({ port: Number(process.env["PORT"] ?? 47408) });

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
  path: "/who",
  handler: async (req, h) => {
    req.session = await sessionLookup(db);
    await fetchFlags();
    const hostname = req.info.hostname;
    // Service allowlist: loopback only. The fixed parser yields "[::1]"
    // for a bracketed IPv6 Host header; the buggy parser yields "[".
    if (hostname !== "127.0.0.1" && hostname !== "[::1]") {
      return h.response({ error: "host parse failure", code: "E_HOST_PARSE" }).code(500);
    }
    return { ok: true, hostname };
  },
});

await server.start();
console.log("READY");
