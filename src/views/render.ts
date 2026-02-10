import fs from "node:fs";
import path from "node:path";
import type { Stats } from "../stats.ts";

const template = fs.readFileSync(
  path.join(import.meta.dirname, "stats.html"),
  "utf-8",
);

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

export function renderStatsPage(s: Stats, host?: string): string {
  const treasuryWallet = process.env.TREASURY_WALLET_ADDRESS ?? "";
  const registryUrl = host ? `https://${host}` : "https://registry.utopian.build";

  const vars: Record<string, string> = {
    registryUrl,
    "cache.packages": fmtNum(s.cache.packages),
    "cache.totalBytes": fmtBytes(s.cache.totalBytes),
    "requests.total": fmtNum(s.requests.total),
    "requests.hits": fmtNum(s.requests.hits),
    "requests.misses": fmtNum(s.requests.misses),
    "requests.passthroughs": fmtNum(s.requests.passthroughs),
    "requests.hitRate": fmtPct(s.requests.hitRate),
    "bandwidth.totalServed": fmtBytes(s.bandwidth.totalServed),
    "bandwidth.totalSaved": fmtBytes(s.bandwidth.totalSaved),
    "bandwidth.savedPct": fmtPct(s.bandwidth.savedPct),
    "sync.packagesUpdated": fmtNum(s.sync.packagesUpdated),
    "sync.lastSync": s.sync.lastSync ?? "\u2014",
    uptime: fmtUptime(s.uptime),
    treasuryWallet,
  };

  // Process conditional blocks: {{#key}}...{{/key}} — kept if key is truthy, removed otherwise
  let html = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, key, content) => (vars[key] ? content : ""),
  );

  // Replace value placeholders
  html = html.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => vars[key] ?? "");

  return html;
}
