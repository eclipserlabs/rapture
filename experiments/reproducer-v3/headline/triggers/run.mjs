// Headline triggers: one trigger per incident id. Prints status+body.
// Usage: node triggers/run.mjs <incident> <port>
import net from "node:net";

const incident = process.argv[2];
const port = Number(process.argv[3] ?? 47401);

function raw(opts, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: opts.host ?? "127.0.0.1", port }, () => {
      sock.write(payload);
    });
    let data = "";
    sock.on("data", (c) => {
      data += c;
    });
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
    setTimeout(() => {
      sock.end();
    }, 800);
  });
}

function parseStatus(rawRes) {
  const m = /^HTTP\/\S+ (\d+)/.exec(rawRes);
  return m ? Number(m[1]) : -1;
}

let out;
switch (incident) {
  case "koa-1999": {
    // Absolute-form request target (proxies / health checks send these).
    const req =
      `GET http://example.com/u?q=1 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Connection: close\r\n\r\n`;
    out = await raw({}, req);
    console.log(parseStatus(out));
    console.log(out.slice(out.indexOf("\r\n\r\n") + 4));
    break;
  }
  case "koa-1998": {
    const r = await fetch(`http://127.0.0.1:${port}/admin`);
    console.log(r.status);
    console.log(await r.text());
    break;
  }
  case "express-cookie": {
    const r = await fetch(`http://127.0.0.1:${port}/c?n=a%20b`);
    console.log(r.status);
    console.log(await r.text());
    break;
  }
  case "express-qs": {
    const r = await fetch(`http://127.0.0.1:${port}/parse?q=a%5B%5D%3D1%2C2%2C3%2C4`);
    console.log(r.status);
    console.log(await r.text());
    break;
  }
  case "fastify-32442": {
    const r = await fetch(`http://127.0.0.1:${port}/v`, {
      method: "POST",
      headers: {
        "content-type": "Application/JSON ; charset=utf-8",
      },
      body: JSON.stringify({ wrong: 1 }),
    });
    console.log(r.status);
    console.log(await r.text());
    break;
  }
  case "fastify-33806": {
    // NOTE: retained for screening honesty; the historical trigger (leading
    // space in Content-Type) is erased by node:http OWS trimming AND by
    // undici, so it cannot be delivered within the frozen V3 boundary.
    // Excluded from the frozen corpus (see exclusions.json).
    throw new Error("fastify-33806 excluded: trigger outside V3 transport boundary");
  }
  case "express-semver": {
    const r = await fetch(`http://127.0.0.1:${port}/check`);
    console.log(r.status);
    console.log(await r.text());
    break;
  }
  case "hapi-4560": {
    // HTTP/1.0 has no mandatory Host header; against an IPv6-bound server
    // the buggy request.url getter falls back to a bare-IPv6 host:port.
    const req = `GET /u HTTP/1.0\r\n\r\n`;
    out = await raw({ host: "::1" }, req);
    console.log(parseStatus(out));
    console.log(out.slice(out.indexOf("\r\n\r\n") + 4));
    break;
  }
  case "hapi-4564": {
    // Bracketed IPv6 Host header over plain IPv4 loopback.
    const req =
      `GET /who HTTP/1.1\r\n` +
      `Host: [::1]:${port}\r\n` +
      
      `Connection: close\r\n\r\n`;
    out = await raw({}, req);
    console.log(parseStatus(out));
    console.log(out.slice(out.indexOf("\r\n\r\n") + 4));
    break;
  }
  default:
    throw new Error(`unknown incident ${incident}`);
}
