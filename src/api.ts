import http from "node:http";
import { getStats } from "./stats.ts";

const PORT = Number(process.env.API_PORT) || 4000;

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function renderStatsPage(): string {
  const s = getStats();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>upm-registry stats</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
      background: #0d1117; color: #c9d1d9;
      padding: 2rem; max-width: 720px; margin: 0 auto;
    }
    h1 { color: #58a6ff; font-size: 1.3rem; margin-bottom: 1.5rem; font-weight: 600; }
    section {
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      padding: 1rem 1.25rem; margin-bottom: 1rem;
    }
    section h2 {
      font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: #8b949e; margin-bottom: 0.75rem; font-weight: 600;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem 1.5rem; }
    .stat-label { font-size: 0.7rem; color: #8b949e; }
    .stat-value { font-size: 1.1rem; color: #e6edf3; font-weight: 600; }
    .highlight { color: #3fb950; }
    footer { margin-top: 1.5rem; font-size: 0.7rem; color: #484f58; text-align: center; }
  </style>
</head>
<body>
  <h1>upm-registry</h1>

  <section>
    <h2>Cache</h2>
    <div class="grid">
      <div><div class="stat-label">Packages</div><div class="stat-value">${fmtNum(s.cache.packages)}</div></div>
      <div><div class="stat-label">Total Size</div><div class="stat-value">${fmtBytes(s.cache.totalBytes)}</div></div>
    </div>
  </section>

  <section>
    <h2>Requests</h2>
    <div class="grid">
      <div><div class="stat-label">Total</div><div class="stat-value">${fmtNum(s.requests.total)}</div></div>
      <div><div class="stat-label">Hits</div><div class="stat-value">${fmtNum(s.requests.hits)}</div></div>
      <div><div class="stat-label">Misses</div><div class="stat-value">${fmtNum(s.requests.misses)}</div></div>
      <div><div class="stat-label">Passthroughs</div><div class="stat-value">${fmtNum(s.requests.passthroughs)}</div></div>
      <div><div class="stat-label">Hit Rate</div><div class="stat-value highlight">${fmtPct(s.requests.hitRate)}</div></div>
    </div>
  </section>

  <section>
    <h2>Bandwidth</h2>
    <div class="grid">
      <div><div class="stat-label">Served</div><div class="stat-value">${fmtBytes(s.bandwidth.totalServed)}</div></div>
      <div><div class="stat-label">Saved</div><div class="stat-value highlight">${fmtBytes(s.bandwidth.totalSaved)}</div></div>
      <div><div class="stat-label">Savings</div><div class="stat-value highlight">${fmtPct(s.bandwidth.savedPct)}</div></div>
    </div>
  </section>

  <section>
    <h2>Sync</h2>
    <div class="grid">
      <div><div class="stat-label">Packages Updated</div><div class="stat-value">${fmtNum(s.sync.packagesUpdated)}</div></div>
      <div><div class="stat-label">Last Sync</div><div class="stat-value">${s.sync.lastSync ?? "—"}</div></div>
    </div>
  </section>

  <section>
    <h2>Uptime</h2>
    <div class="grid">
      <div><div class="stat-label">API Server</div><div class="stat-value">${fmtUptime(s.uptime)}</div></div>
    </div>
  </section>

  <footer>auto-refreshes every 30s &middot; <a href="/stats" style="color:#484f58">json</a></footer>
</body>
</html>`;
}

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
    const body = renderStatsPage();
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
