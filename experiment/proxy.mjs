import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ORIGINAL = path.join(__dirname, "cache", "original");
const CACHE_STRIPPED = path.join(__dirname, "cache", "stripped");
const UPSTREAM = "registry.npmjs.org";
const PORT = 4873;

const STRIPPED = process.env.STRIPPED === "1";

fs.mkdirSync(CACHE_ORIGINAL, { recursive: true });
fs.mkdirSync(CACHE_STRIPPED, { recursive: true });

let counter = 0;
let totalBytesServed = 0;

// Package name from URL: "/<name>" or "/<@scope/name>"
function pkgCachePath(dir, url) {
  const name = url.replace(/^\//, "");
  const p = path.join(dir, name + ".json");
  return p;
}

function decompress(buf, encoding) {
  if (encoding === "br") return zlib.brotliDecompressSync(buf);
  if (encoding === "gzip") return zlib.gunzipSync(buf);
  if (encoding === "deflate") return zlib.inflateSync(buf);
  return buf;
}

function serveFromCache(id, filePath, clientRes) {
  const body = fs.readFileSync(filePath);
  totalBytesServed += body.length;
  console.log(`  ← ${id} CACHE ${body.length} bytes  ${filePath}`);
  clientRes.writeHead(200, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  clientRes.end(body);
}

const server = http.createServer((clientReq, clientRes) => {
  const id = String(++counter).padStart(4, "0");

  console.log(`→ ${id} ${clientReq.method} ${clientReq.url}`);

  // Stripped mode: serve from stripped cache
  if (STRIPPED) {
    const cached = pkgCachePath(CACHE_STRIPPED, clientReq.url);
    if (fs.existsSync(cached)) {
      serveFromCache(id, cached, clientRes);
      return;
    }
    // Fall through to upstream if not in stripped cache
  }

  // Recording mode: serve from original cache if available
  if (!STRIPPED) {
    const cached = pkgCachePath(CACHE_ORIGINAL, clientReq.url);
    if (fs.existsSync(cached)) {
      serveFromCache(id, cached, clientRes);
      return;
    }
  }

  // Fetch from upstream
  const fwdHeaders = { ...clientReq.headers, host: UPSTREAM };
  delete fwdHeaders["if-none-match"];
  delete fwdHeaders["if-modified-since"];

  const proxyReq = https.request(
    {
      hostname: UPSTREAM,
      port: 443,
      path: clientReq.url,
      method: clientReq.method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      const chunks = [];

      proxyRes.on("data", (chunk) => chunks.push(chunk));

      proxyRes.on("end", () => {
        const compressed = Buffer.concat(chunks);
        const elapsed = Date.now() - startTime;
        const encoding = proxyRes.headers["content-encoding"];
        const decompressed = decompress(compressed, encoding);

        console.log(
          `  ← ${id} ${proxyRes.statusCode} ${compressed.length} → ${decompressed.length} bytes [${encoding || "identity"}] (${elapsed}ms)`
        );

        // Cache the decompressed response by package name
        const cachePath = pkgCachePath(CACHE_ORIGINAL, clientReq.url);
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, decompressed);

        // Count decompressed bytes as served
        totalBytesServed += decompressed.length;

        // Relay original compressed response to client
        const relayHeaders = { ...proxyRes.headers };
        delete relayHeaders["transfer-encoding"];
        relayHeaders["content-length"] = compressed.length;

        clientRes.writeHead(proxyRes.statusCode, relayHeaders);
        clientRes.end(compressed);
      });
    }
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
  console.log(`npm recording proxy listening on http://localhost:${PORT}`);
  console.log(`Mode: ${STRIPPED ? "STRIPPED" : "RECORDING"}`);
  console.log(`Cache: ${STRIPPED ? CACHE_STRIPPED : CACHE_ORIGINAL}`);
  console.log();
});

process.on("SIGINT", () => {
  console.log();
  console.log(`TOTAL_BYTES_SERVED=${totalBytesServed}`);
  process.exit(0);
});
