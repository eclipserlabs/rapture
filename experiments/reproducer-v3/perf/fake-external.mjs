// Deterministic fake external dependency for V3 perf calibration.
import http from "node:http";

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake.invalid");
  if (url.pathname === "/pricing") {
    json(res, 200, { sku: url.searchParams.get("sku") ?? "", price: 999, currency: "USD" });
    return;
  }
  if (url.pathname === "/shipping") {
    const qty = Number(url.searchParams.get("qty") ?? "0");
    json(res, 200, { cost: qty > 5 ? 150 : 20 });
    return;
  }
  if (url.pathname.startsWith("/avatar/")) {
    const id = decodeURIComponent(url.pathname.slice("/avatar/".length));
    if (id === "batch") {
      json(res, 200, { avatars: (url.searchParams.get("ids") ?? "").split(",").filter(Boolean) });
      return;
    }
    json(res, 200, { id, url: `https://cdn.invalid/a/${id}.png` });
    return;
  }
  if (url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  json(res, 404, { error: "unknown fake endpoint" });
});

server.listen(Number(process.env["PORT"] ?? 47109), () => console.log(`READY ${process.env["PORT"] ?? 47109}`));
