import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { stripMetadata, type NpmPackageMetadata } from "./strip.ts";
import {
  recordHit,
  recordMiss,
  recordStrip,
  recordPassthrough,
} from "./stats.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "cache");
const CACHE_RAW = path.join(__dirname, "..", "cache", "raw");
const UPSTREAM = "registry.npmjs.org";
const PORT = Number(process.env.PORT) || 4873;

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(CACHE_RAW, { recursive: true });

let counter = 0;

// Map URL path to cache file path: "/express" → "cache/express.json"
function pkgCachePath(dir: string, url: string): string {
  const name = url.replace(/^\//, "");
  return path.join(dir, name + ".json");
}

function decompress(buf: Buffer, encoding: string | undefined): Buffer {
  if (encoding === "br") return zlib.brotliDecompressSync(buf);
  if (encoding === "gzip") return zlib.gunzipSync(buf);
  if (encoding === "deflate") return zlib.inflateSync(buf);
  return buf;
}

function pkgFromUrl(url: string): string {
  return url.replace(/^\//, "");
}

function serveFromCache(
  id: string,
  pkg: string,
  filePath: string,
  clientRes: http.ServerResponse,
): void {
  const body = fs.readFileSync(filePath);
  console.log(`  ← ${id} CACHE ${body.length} bytes`);
  recordHit(pkg, body.length);
  clientRes.writeHead(200, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  clientRes.end(body);
}

// Async: decompress, parse, strip, write to cache, delete raw
function stripAndCache(
  rawPath: string,
  cachePath: string,
  encoding: string | undefined,
): void {
  setImmediate(() => {
    try {
      const compressed = fs.readFileSync(rawPath);
      const decompressed = decompress(compressed, encoding);
      const raw = decompressed.toString("utf8");
      const data = JSON.parse(raw);
      if (data.versions && data["dist-tags"]) {
        const stripped = JSON.stringify(
          stripMetadata(data as NpmPackageMetadata),
        );
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, stripped);
        const rawLen = Buffer.byteLength(raw);
        const strippedLen = Buffer.byteLength(stripped);
        const pct = ((1 - strippedLen / rawLen) * 100).toFixed(0);
        recordStrip(data.name, rawLen, strippedLen);
        console.log(`  ⚡ stripped ${data.name} (${pct}% smaller)`);
      } else {
        // Not a package metadata document, cache as-is
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, raw);
      }
      fs.unlinkSync(rawPath);
    } catch (err) {
      console.error(`  ✗ strip error: ${(err as Error).message}`);
    }
  });
}

// Proxy a request directly to npm without caching
function proxyPassthrough(
  id: string,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): void {
  const fwdHeaders = { ...clientReq.headers, host: UPSTREAM };

  const proxyReq = https.request(
    {
      hostname: UPSTREAM,
      port: 443,
      path: clientReq.url,
      method: clientReq.method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      const relayHeaders = { ...proxyRes.headers };
      clientRes.writeHead(proxyRes.statusCode!, relayHeaders);
      proxyRes.pipe(clientRes);
    },
  );

  const startTime = Date.now();

  proxyReq.on("error", (err) => {
    console.error(`  ✗ ${id} proxy error: ${err.message}`);
    clientRes.writeHead(502);
    clientRes.end("Bad Gateway");
  });

  proxyReq.on("close", () => {
    const elapsed = Date.now() - startTime;
    recordPassthrough(clientReq.url!, elapsed);
    console.log(`  ← ${id} passthrough (${elapsed}ms)`);
  });

  clientReq.pipe(proxyReq);
}

const server = http.createServer((clientReq, clientRes) => {
  const id = String(++counter).padStart(4, "0");
  console.log(`→ ${id} ${clientReq.method} ${clientReq.url}`);

  // Non-GET: proxy directly with auth (publish, unpublish, etc.)
  if (clientReq.method !== "GET") {
    proxyPassthrough(id, clientReq, clientRes);
    return;
  }

  // Tarball / special endpoints (/-/ in path): proxy directly
  if (clientReq.url!.includes("/-/")) {
    proxyPassthrough(id, clientReq, clientRes);
    return;
  }

  // Metadata GET: check stripped cache first
  const cachePath = pkgCachePath(CACHE_DIR, clientReq.url!);
  if (fs.existsSync(cachePath)) {
    serveFromCache(id, pkgFromUrl(clientReq.url!), cachePath, clientRes);
    return;
  }

  // Cache miss: fetch from npm, relay raw, then async strip
  const fwdHeaders = { ...clientReq.headers, host: UPSTREAM };
  delete fwdHeaders["if-none-match"];
  delete fwdHeaders["if-modified-since"];

  const proxyReq = https.request(
    {
      hostname: UPSTREAM,
      port: 443,
      path: clientReq.url,
      method: "GET",
      headers: fwdHeaders,
    },
    (proxyRes) => {
      const chunks: Buffer[] = [];

      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));

      proxyRes.on("end", () => {
        const compressed = Buffer.concat(chunks);
        const elapsed = Date.now() - startTime;
        const encoding = proxyRes.headers["content-encoding"];

        console.log(
          `  ← ${id} ${proxyRes.statusCode} ${compressed.length} bytes [${encoding || "identity"}] (${elapsed}ms)`,
        );
        recordMiss(
          pkgFromUrl(clientReq.url!),
          compressed.length,
          compressed.length,
          elapsed,
        );

        // Save raw compressed response for async decompression + stripping
        const rawPath = pkgCachePath(CACHE_RAW, clientReq.url!);
        fs.mkdirSync(path.dirname(rawPath), { recursive: true });
        fs.writeFileSync(rawPath, compressed);

        // Kick off async decompress + strip
        stripAndCache(rawPath, cachePath, encoding);

        // Relay original compressed response to client
        const relayHeaders = { ...proxyRes.headers };
        delete relayHeaders["transfer-encoding"];
        relayHeaders["content-length"] = String(compressed.length);

        clientRes.writeHead(proxyRes.statusCode!, relayHeaders);
        clientRes.end(compressed);
      });
    },
  );

  const startTime = Date.now();

  proxyReq.on("error", (err) => {
    console.error(`  ✗ ${id} proxy error: ${err.message}`);
    clientRes.writeHead(502);
    clientRes.end("Bad Gateway");
  });

  clientReq.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`upm-registry listening on http://localhost:${PORT}`);
  console.log(`Cache: ${CACHE_DIR}`);
  console.log();
});
