import http from "node:http";
import { getStats } from "./stats.ts";
import { renderStatsPage } from "./views/render.ts";

const PORT = Number(process.env.API_PORT) || 4000;

const server = http.createServer((req, res) => {
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
    const body = renderStatsPage(getStats());
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
