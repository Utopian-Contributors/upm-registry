import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripMetadata, type NpmPackageMetadata } from "./strip.ts";
import { recordPrefetch } from "./stats.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "cache");
const REGISTRY = "https://registry.npmjs.org";

const MAX_CONCURRENT = 5;
const MAX_PREFETCH = 200;

// Cross-request dedup: packages currently being fetched
const inflight = new Set<string>();

// Semaphore for concurrency control
let activeCount = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      activeCount++;
      resolve();
    });
  });
}

function release(): void {
  activeCount--;
  const next = waiting.shift();
  if (next) next();
}

function cachePath(pkgName: string): string {
  return path.join(CACHE_DIR, pkgName.replace("/", "%2f") + ".json");
}

function extractDeps(data: NpmPackageMetadata): string[] {
  const latest = data["dist-tags"]?.latest;
  if (!latest) return [];
  const entry = data.versions[latest];
  if (!entry) return [];

  const deps = new Set<string>();
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const map = entry[field];
    if (map) {
      for (const name of Object.keys(map)) deps.add(name);
    }
  }
  return [...deps];
}

async function fetchAndCache(
  pkgName: string,
): Promise<NpmPackageMetadata | null> {
  try {
    const res = await fetch(`${REGISTRY}/${pkgName}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`  ✗ prefetch ${pkgName}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as NpmPackageMetadata;
    if (!data.versions || !data["dist-tags"]) return null;

    const raw = JSON.stringify(data);
    const stripped = JSON.stringify(stripMetadata(data));
    const dest = cachePath(pkgName);

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, stripped);

    recordPrefetch(
      pkgName,
      Buffer.byteLength(raw),
      Buffer.byteLength(stripped),
    );
    console.log(`  ⚡ prefetched ${pkgName}`);
    return data;
  } catch (err) {
    console.error(`  ✗ prefetch ${pkgName}: ${(err as Error).message}`);
    return null;
  }
}

async function prefetchTree(rootData: NpmPackageMetadata): Promise<void> {
  const visited = new Set<string>();
  visited.add(rootData.name);
  let count = 0;

  const queue: NpmPackageMetadata[] = [rootData];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const depNames = extractDeps(current);

    const toFetch: string[] = [];
    for (const name of depNames) {
      if (visited.has(name)) continue;
      visited.add(name);
      if (fs.existsSync(cachePath(name))) continue;
      if (inflight.has(name)) continue;
      if (count >= MAX_PREFETCH) break;
      toFetch.push(name);
      count++;
    }

    if (count >= MAX_PREFETCH) break;

    const results = await Promise.all(
      toFetch.map(async (name) => {
        inflight.add(name);
        try {
          await acquire();
          try {
            if (fs.existsSync(cachePath(name))) return null;
            return await fetchAndCache(name);
          } finally {
            release();
          }
        } finally {
          inflight.delete(name);
        }
      }),
    );

    for (const metadata of results) {
      if (metadata) queue.push(metadata);
    }
  }

  if (count > 0) {
    console.log(
      `  ✓ prefetch complete: ${count} packages for ${rootData.name}`,
    );
  }
}

export function prefetchDeps(data: NpmPackageMetadata): void {
  prefetchTree(data).catch((err) => {
    console.error(`  ✗ prefetch tree error: ${(err as Error).message}`);
  });
}
