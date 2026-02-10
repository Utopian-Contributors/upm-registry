import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
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

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);

let counter = 0;

function pkgCachePath(dir: string, url: string): string {
  const name = url.replace(/^\//, "");
  return path.join(dir, name + ".json");
}

async function decompress(
  buf: Buffer,
  encoding: string | undefined,
): Promise<Buffer> {
  if (encoding === "br") return brotliDecompress(buf);
  if (encoding === "gzip") return gunzip(buf);
  if (encoding === "deflate") return inflate(buf);
  return buf;
}

function pkgFromUrl(url: string): string {
  return decodeURIComponent(url.replace(/^\//, ""));
}

async function stripAndCache(
  rawPath: string,
  cachePath: string,
  encoding: string | undefined,
): Promise<void> {
  try {
    const compressed = await fsp.readFile(rawPath);
    const decompressed = await decompress(compressed, encoding);
    const raw = decompressed.toString("utf8");
    const data = JSON.parse(raw);
    if (data.versions && data["dist-tags"]) {
      const stripped = JSON.stringify(
        stripMetadata(data as NpmPackageMetadata),
      );
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, stripped);
      const rawLen = Buffer.byteLength(raw);
      const strippedLen = Buffer.byteLength(stripped);
      const pct = ((1 - strippedLen / rawLen) * 100).toFixed(0);
      recordStrip(data.name, rawLen, strippedLen);
      console.log(`  ⚡ stripped ${data.name} (${pct}% smaller)`);
    } else {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, raw);
    }
    await fsp.unlink(rawPath);
  } catch (err) {
    console.error(`  ✗ strip error: ${(err as Error).message}`);
  }
}

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

async function handleMetadata(
  id: string,
  pkg: string,
  cachePath: string,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  // Try cache first (single async read, no separate exists check)
  try {
    const body = await fsp.readFile(cachePath);
    console.log(`  ← ${id} CACHE ${body.length} bytes`);
    recordHit(pkg, body.length);
    clientRes.writeHead(200, {
      "content-type": "application/json",
      "content-length": body.length,
    });
    clientRes.end(body);
    return;
  } catch {
    // Cache miss, fall through to upstream
  }

  // Fetch from upstream
  const fwdHeaders = { ...clientReq.headers, host: UPSTREAM };
  delete fwdHeaders["if-none-match"];
  delete fwdHeaders["if-modified-since"];

  const startTime = Date.now();

  const proxyReq = https.request(
    {
      hostname: UPSTREAM,
      port: 443,
      path: clientReq.url,
      method: "GET",
      headers: fwdHeaders,
    },
    (proxyRes) => {
      const encoding = proxyRes.headers["content-encoding"];

      // Stream response to client immediately
      const relayHeaders = { ...proxyRes.headers };
      clientRes.writeHead(proxyRes.statusCode!, relayHeaders);

      // Collect chunks for async cache while streaming to client
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        clientRes.write(chunk);
      });

      proxyRes.on("end", () => {
        clientRes.end();

        const compressed = Buffer.concat(chunks);
        const elapsed = Date.now() - startTime;

        console.log(
          `  ← ${id} ${proxyRes.statusCode} ${compressed.length} bytes [${encoding || "identity"}] (${elapsed}ms)`,
        );
        recordMiss(pkg, compressed.length, elapsed);

        // Fire-and-forget: save raw + strip asynchronously
        const rawPath = pkgCachePath(CACHE_RAW, clientReq.url!);
        fsp
          .mkdir(path.dirname(rawPath), { recursive: true })
          .then(() => fsp.writeFile(rawPath, compressed))
          .then(() => stripAndCache(rawPath, cachePath, encoding))
          .catch((err) =>
            console.error(`  ✗ cache write error: ${err.message}`),
          );
      });
    },
  );

  proxyReq.on("error", (err) => {
    console.error(`  ✗ ${id} proxy error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end("Bad Gateway");
    }
  });

  clientReq.pipe(proxyReq);
}

const server = http.createServer((clientReq, clientRes) => {
  const id = String(++counter).padStart(4, "0");
  console.log(`→ ${id} ${clientReq.method} ${clientReq.url}`);

  if (clientReq.url === "/-/health") {
    clientRes.writeHead(200, { "content-type": "text/plain" });
    clientRes.end("ok");
    return;
  }

  if (clientReq.method !== "GET") {
    proxyPassthrough(id, clientReq, clientRes);
    return;
  }

  if (clientReq.url!.includes("/-/")) {
    proxyPassthrough(id, clientReq, clientRes);
    return;
  }

  const cachePath = pkgCachePath(CACHE_DIR, clientReq.url!);
  const pkg = pkgFromUrl(clientReq.url!);

  handleMetadata(id, pkg, cachePath, clientReq, clientRes).catch((err) => {
    console.error(`  ✗ ${id} error: ${(err as Error).message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(500);
      clientRes.end("Internal Server Error");
    }
  });
});

server.listen(PORT, () => {
  console.log(`upm-registry listening on http://localhost:${PORT}`);
  console.log(`Cache: ${CACHE_DIR}`);
  console.log();
});
