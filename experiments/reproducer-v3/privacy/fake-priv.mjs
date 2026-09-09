// Fake external for the privacy attack suite. SECRET_SENTINEL_JSON env carries
// a JSON blob with sentinel secrets the fake reflects (tests outbound
// response capture). Deterministic per run (values come from env).
import http from "node:http";

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

let secrets = {};
try {
  secrets = JSON.parse(process.env["SECRET_SENTINEL_JSON"] ?? "{}");
} catch {}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake.invalid");
  if (url.pathname === "/echo") {
    json(res, 200, {
      gotAuth: req.headers["authorization"] ?? null,
      gotKey: req.headers["x-api-key"] ?? null,
      debug: url.searchParams.get("debug"),
    });
    return;
  }
  if (url.pathname === "/submit") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => json(res, 200, { received: raw.slice(0, 2000) }));
    return;
  }
  if (url.pathname === "/secret-profile") {
    json(res, 200, { apiKey: secrets.sk2 ?? null, owner: secrets.email ?? null, jwt: secrets.jwt ?? null });
    return;
  }
  json(res, 404, { error: "unknown" });
});

server.listen(Number(process.env["PORT"] ?? 47129), () => console.log(`READY ${process.env["PORT"] ?? 47129}`));
