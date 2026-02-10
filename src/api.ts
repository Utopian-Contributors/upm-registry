import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getStats } from "./stats.ts";
import { renderStatsPage } from "./views/render.ts";

const PORT = Number(process.env.API_PORT) || 4000;
const favicon = fs.readFileSync(
  path.join(import.meta.dirname, "views", "upm-favicon.svg"),
);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/favicon.svg") {
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      "content-length": favicon.length,
      "cache-control": "public, max-age=86400",
    });
    res.end(favicon);
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    const body = JSON.stringify(getStats());
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    const host = req.headers.host?.replace(/:\d+$/, "");
    const body = renderStatsPage(getStats(), host);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`upm-registry API on http://localhost:${PORT}`);
});
