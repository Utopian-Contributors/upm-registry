import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "stats.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT    NOT NULL DEFAULT (datetime('now')),
    kind       TEXT    NOT NULL,
    package    TEXT,
    raw_bytes  INTEGER,
    size_bytes INTEGER,
    elapsed_ms INTEGER
  )
`);

const startedAt = Date.now();

// In-memory map: package name → original raw bytes (from strip events)
// Used to calculate bandwidth savings on cache hits
const rawSizeMap = new Map<string, number>();

// Populate rawSizeMap from existing strip events
const rows = db
  .query(
    "SELECT package, raw_bytes FROM events WHERE kind = 'strip' AND raw_bytes IS NOT NULL ORDER BY id ASC",
  )
  .all() as { package: string; raw_bytes: number }[];
for (const row of rows) {
  rawSizeMap.set(row.package, row.raw_bytes);
}

// Prepared statements
const insertEvent = db.query(
  "INSERT INTO events (kind, package, raw_bytes, size_bytes, elapsed_ms) VALUES ($kind, $package, $rawBytes, $sizeBytes, $elapsedMs)",
);

export function recordHit(pkg: string, sizeBytes: number): void {
  const rawBytes = rawSizeMap.get(pkg) ?? null;
  insertEvent.run({
    $kind: "hit",
    $package: pkg,
    $rawBytes: rawBytes,
    $sizeBytes: sizeBytes,
    $elapsedMs: null,
  });
}

export function recordMiss(
  pkg: string,
  sizeBytes: number,
  elapsedMs: number,
): void {
  insertEvent.run({
    $kind: "miss",
    $package: pkg,
    $rawBytes: null,
    $sizeBytes: sizeBytes,
    $elapsedMs: elapsedMs,
  });
}

export function recordStrip(
  pkg: string,
  rawBytes: number,
  sizeBytes: number,
): void {
  rawSizeMap.set(pkg, rawBytes);
  insertEvent.run({
    $kind: "strip",
    $package: pkg,
    $rawBytes: rawBytes,
    $sizeBytes: sizeBytes,
    $elapsedMs: null,
  });
}

export function recordSync(
  pkg: string,
  rawBytes: number,
  sizeBytes: number,
): void {
  rawSizeMap.set(pkg, rawBytes);
  insertEvent.run({
    $kind: "sync",
    $package: pkg,
    $rawBytes: rawBytes,
    $sizeBytes: sizeBytes,
    $elapsedMs: null,
  });
}

export function recordPrefetch(
  pkg: string,
  rawBytes: number,
  sizeBytes: number,
): void {
  rawSizeMap.set(pkg, rawBytes);
  insertEvent.run({
    $kind: "prefetch",
    $package: pkg,
    $rawBytes: rawBytes,
    $sizeBytes: sizeBytes,
    $elapsedMs: null,
  });
}

export function recordPassthrough(reqPath: string, elapsedMs: number): void {
  insertEvent.run({
    $kind: "passthrough",
    $package: reqPath,
    $rawBytes: null,
    $sizeBytes: null,
    $elapsedMs: elapsedMs,
  });
}

export interface Stats {
  cache: {
    packages: number;
    totalBytes: number;
  };
  requests: {
    total: number;
    hits: number;
    misses: number;
    passthroughs: number;
    hitRate: number;
  };
  bandwidth: {
    totalServed: number;
    totalSaved: number;
    savedPct: number;
  };
  sync: {
    packagesUpdated: number;
    lastSync: string | null;
  };
  prefetch: {
    packagesPrefetched: number;
  };
  uptime: number;
}

export function getStats(): Stats {
  const counts = db
    .query(
      `SELECT
        SUM(CASE WHEN kind IN ('hit','miss','passthrough') THEN 1 ELSE 0 END) as total,
        SUM(CASE WHEN kind = 'hit' THEN 1 ELSE 0 END) as hits,
        SUM(CASE WHEN kind = 'miss' THEN 1 ELSE 0 END) as misses,
        SUM(CASE WHEN kind = 'passthrough' THEN 1 ELSE 0 END) as passthroughs
      FROM events`,
    )
    .get() as {
    total: number;
    hits: number;
    misses: number;
    passthroughs: number;
  };

  const bandwidth = db
    .query(
      `SELECT
        COALESCE(SUM(size_bytes), 0) as total_served,
        COALESCE(SUM(CASE WHEN raw_bytes IS NOT NULL THEN raw_bytes - size_bytes ELSE 0 END), 0) as total_saved
      FROM events
      WHERE kind = 'hit'`,
    )
    .get() as { total_served: number; total_saved: number };

  const syncStats = db
    .query(
      `SELECT
        COUNT(*) as packages_updated,
        MAX(ts) as last_sync
      FROM events
      WHERE kind = 'sync'`,
    )
    .get() as { packages_updated: number; last_sync: string | null };

  const cacheStats = db
    .query(
      `SELECT
        COUNT(DISTINCT package) as packages,
        COALESCE(SUM(size_bytes), 0) as total_bytes
      FROM events
      WHERE kind = 'strip'
        AND id IN (SELECT MAX(id) FROM events WHERE kind = 'strip' GROUP BY package)`,
    )
    .get() as { packages: number; total_bytes: number };

  const prefetchStats = db
    .query(
      "SELECT COUNT(*) as count FROM events WHERE kind = 'prefetch'",
    )
    .get() as { count: number };

  const hitsPlusMisses = counts.hits + counts.misses;

  return {
    cache: {
      packages: cacheStats.packages,
      totalBytes: cacheStats.total_bytes,
    },
    requests: {
      total: counts.total,
      hits: counts.hits,
      misses: counts.misses,
      passthroughs: counts.passthroughs,
      hitRate: hitsPlusMisses > 0 ? counts.hits / hitsPlusMisses : 0,
    },
    bandwidth: {
      totalServed: bandwidth.total_served,
      totalSaved: bandwidth.total_saved,
      savedPct:
        bandwidth.total_served + bandwidth.total_saved > 0
          ? bandwidth.total_saved /
            (bandwidth.total_served + bandwidth.total_saved)
          : 0,
    },
    sync: {
      packagesUpdated: syncStats.packages_updated,
      lastSync: syncStats.last_sync,
    },
    prefetch: {
      packagesPrefetched: prefetchStats.count,
    },
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  };
}
