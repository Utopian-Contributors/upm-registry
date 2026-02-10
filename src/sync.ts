import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripMetadata, type NpmPackageMetadata } from "./strip.ts";
import { recordSync } from "./stats.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "cache");
const SEQ_FILE = path.join(__dirname, "..", "data", ".sync-seq");
const CHANGES_BASE = "https://replicate.npmjs.com/registry/_changes";
const REGISTRY = "https://registry.npmjs.org";
const POLL_INTERVAL = 10_000; // 10 seconds
const CHANGES_LIMIT = 1000;

interface Change {
  seq: number;
  id: string;
  deleted?: boolean;
  changes: { rev: string }[];
}

interface ChangesResponse {
  results: Change[];
  last_seq: number | string;
}

function readSeq(): string {
  try {
    return fs.readFileSync(SEQ_FILE, "utf8").trim();
  } catch {
    return "0";
  }
}

function writeSeq(seq: string | number): void {
  fs.writeFileSync(SEQ_FILE, String(seq));
}

function pkgCachePath(url: string): string {
  const name = url.replace(/^\//, "");
  return path.join(CACHE_DIR, name + ".json");
}

async function fetchMetadata(
  pkgName: string,
): Promise<NpmPackageMetadata | null> {
  try {
    const res = await fetch(`${REGISTRY}/${pkgName}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`  ✗ fetch ${pkgName}: ${res.status}`);
      return null;
    }
    return (await res.json()) as NpmPackageMetadata;
  } catch (err) {
    console.error(`  ✗ fetch ${pkgName}: ${(err as Error).message}`);
    return null;
  }
}

async function pollChanges(): Promise<void> {
  let backoff = POLL_INTERVAL;

  while (true) {
    try {
      const since = readSeq();
      const url = `${CHANGES_BASE}?since=${since}&limit=${CHANGES_LIMIT}`;

      const res = await fetch(url);

      if (res.status === 429) {
        console.log(`  ⏳ rate limited, backing off ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 300_000); // max 5 min
        continue;
      }

      if (!res.ok) {
        console.error(`  ✗ changes feed: ${res.status}`);
        await sleep(backoff);
        continue;
      }

      // Reset backoff on success
      backoff = POLL_INTERVAL;

      const data = (await res.json()) as ChangesResponse;
      let deleted = 0;
      let skipped = 0;

      // Handle deletions synchronously (fast, no network)
      const toFetch: { id: string; cachePath: string }[] = [];
      for (const change of data.results) {
        // Skip legacy uppercase package names — npm enforces lowercase,
        // and on case-insensitive filesystems (macOS) "Fresh" would match "fresh.json"
        if (change.id !== change.id.toLowerCase()) {
          skipped++;
          continue;
        }

        const cachePath = pkgCachePath("/" + change.id);

        if (!fs.existsSync(cachePath)) {
          skipped++;
          continue;
        }

        if (change.deleted) {
          fs.unlinkSync(cachePath);
          console.log(`  🗑 deleted ${change.id}`);
          deleted++;
          continue;
        }

        toFetch.push({ id: change.id, cachePath });
      }

      // Fetch and strip all changed cached packages concurrently
      const results = await Promise.all(
        toFetch.map(async ({ id, cachePath }) => {
          const metadata = await fetchMetadata(id);
          if (metadata && metadata.versions && metadata["dist-tags"]) {
            const oldSize = fs.statSync(cachePath).size;
            const stripped = JSON.stringify(stripMetadata(metadata));
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, stripped);
            recordSync(id, oldSize, Buffer.byteLength(stripped));
            console.log(`  ↻ updated ${id}`);
            return true;
          }
          return false;
        }),
      );
      const updated = results.filter(Boolean).length;

      writeSeq(data.last_seq);

      if (updated > 0 || deleted > 0) {
        console.log(
          `sync: ${data.results.length} changes — ${updated} updated, ${deleted} deleted, ${skipped} skipped (seq: ${data.last_seq})`,
        );
      }

      // If we got a full page, there are more changes — continue immediately
      if (data.results.length >= CHANGES_LIMIT) {
        continue;
      }

      await sleep(POLL_INTERVAL);
    } catch (err) {
      console.error(`sync error: ${(err as Error).message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 300_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("upm-registry sync starting...");
console.log(`Cache: ${CACHE_DIR}`);
console.log(`Seq file: ${SEQ_FILE}`);
console.log(`Poll interval: ${POLL_INTERVAL / 1000}s`);
console.log();

pollChanges();
