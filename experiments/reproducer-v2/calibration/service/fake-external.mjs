// Deterministic fake external HTTP dependency (capture mode only).
// Behaviors are fixed functions of the request — no randomness, no clock.
import http from "node:http";

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function createFakeExternal() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    if (url.pathname === "/api/profile") {
      const user = url.searchParams.get("user") ?? "";
      if (user === "u-bad-shape") {
        // Syntactically valid JSON, structurally wrong: email missing.
        json(res, 200, { id: user, meta: { tags: [] } });
        return;
      }
      json(res, 200, { id: user, email: `${user}@example.com` });
      return;
    }
    if (url.pathname === "/api/price") {
      const sku = url.searchParams.get("sku") ?? "";
      if (sku === "FAIL") {
        json(res, 503, { error: "upstream unavailable" });
        return;
      }
      json(res, 200, { sku, price: 999 });
      return;
    }
    if (url.pathname === "/api/shipping") {
      const qty = Number(url.searchParams.get("qty") ?? "0");
      json(res, 200, { cost: qty > 5 ? 150 : 20 });
      return;
    }
    if (url.pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: "unknown fake endpoint" });
  });
}
