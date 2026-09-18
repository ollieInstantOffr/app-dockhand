// Front door for the web container. Pages go to the Next.js standalone server
// (on NEXT_PORT); /api, /mcp and the MCP OAuth endpoints — including WebSocket upgrades for terminals and
// live logs — go straight to the Go API. The API container is the usual
// entrypoint, but this keeps the app fully working when the web container is
// reached directly (e.g. via an OrbStack / Docker Desktop container domain).
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 3000);
const NEXT_PORT = Number(process.env.NEXT_PORT ?? 3001);
const api = new URL(process.env.DOCKHAND_API_URL ?? "http://api:8080");
const API_HOST = api.hostname;
const API_PORT = Number(api.port || 80);

const toApi = (url = "") =>
  url.startsWith("/api/") || url === "/api" || url === "/mcp" || url.startsWith("/mcp/") || url.startsWith("/mcp?") ||
  url.startsWith("/oauth/") || url.startsWith("/.well-known/oauth-");

function forwardedHeaders(req) {
  const h = { ...req.headers };
  const proto = h["x-forwarded-proto"] ?? "http";
  h["x-forwarded-proto"] = proto;
  h["x-forwarded-host"] = h["x-forwarded-host"] ?? h.host ?? "";
  const ip = req.socket.remoteAddress ?? "";
  h["x-forwarded-for"] = h["x-forwarded-for"] ? `${h["x-forwarded-for"]}, ${ip}` : ip;
  return h;
}

const server = http.createServer((req, res) => {
  const [host, port] = toApi(req.url) ? [API_HOST, API_PORT] : ["127.0.0.1", NEXT_PORT];
  const upstream = http.request({ host, port, method: req.method, path: req.url, headers: forwardedHeaders(req) }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `upstream unavailable: ${err.message}` }));
  });
  req.pipe(upstream);
});

// Raw TCP pass-through for WebSocket upgrades (terminals, logs, Next HMR).
server.on("upgrade", (req, socket, head) => {
  const [host, port] = toApi(req.url) ? [API_HOST, API_PORT] : ["127.0.0.1", NEXT_PORT];
  const upstream = net.connect(port, host, () => {
    const headers = forwardedHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const val of Array.isArray(v) ? v : [v]) if (val !== undefined) raw += `${k}: ${val}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`gateway on :${PORT} → next :${NEXT_PORT}, api ${API_HOST}:${API_PORT}`));
