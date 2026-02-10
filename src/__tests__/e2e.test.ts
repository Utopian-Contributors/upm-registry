import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const CACHE_DIR = path.join(PROJECT_ROOT, "cache");

const REGISTRY_PORT = 14873;
const API_PORT = 14000;
const REGISTRY_URL = `http://localhost:${REGISTRY_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

const TEST_PACKAGE = "express";
const CACHE_FILE = path.join(CACHE_DIR, `${TEST_PACKAGE}.json`);

async function waitForOutput(
  proc: Subprocess,
  marker: string,
  timeoutMs: number = 15_000,
): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(
        () => ({ done: true, value: undefined }) as const,
      ),
    ]);

    if (result.value) {
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.includes(marker)) {
        reader.releaseLock();
        return;
      }
    }
    if (result.done) break;
  }
  reader.releaseLock();
  throw new Error(`Did not see "${marker}" in output within ${timeoutMs}ms`);
}

describe("upm-registry e2e", () => {
  let serverProc: Subprocess;
  let apiProc: Subprocess;

  beforeAll(async () => {
    // Remove cached express metadata to guarantee a miss on first fetch
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {}
    try {
      fs.unlinkSync(path.join(CACHE_DIR, "raw", `${TEST_PACKAGE}.json`));
    } catch {}

    // Start the registry proxy server
    serverProc = Bun.spawn(["bun", path.join(SRC_DIR, "server.ts")], {
      env: { ...process.env, PORT: String(REGISTRY_PORT) },
      stdout: "pipe",
      stderr: "inherit",
    });

    // Start the API server
    apiProc = Bun.spawn(["bun", path.join(SRC_DIR, "api.ts")], {
      env: { ...process.env, API_PORT: String(API_PORT) },
      stdout: "pipe",
      stderr: "inherit",
    });

    // Wait for both to be ready
    await Promise.all([
      waitForOutput(
        serverProc,
        `listening on http://localhost:${REGISTRY_PORT}`,
      ),
      waitForOutput(apiProc, `API on http://localhost:${API_PORT}`),
    ]);
  }, 30_000);

  afterAll(async () => {
    serverProc?.kill();
    apiProc?.kill();
    await Promise.all([serverProc?.exited, apiProc?.exited]);

    // Clean up test cache entry
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {}
  });

  test("strips metadata and reports correct bandwidth savings", async () => {
    // Snapshot stats before
    const statsBefore = await fetch(`${API_URL}/stats`).then((r) => r.json());

    // First fetch: cache miss — server relays original upstream response
    const res1 = await fetch(`${REGISTRY_URL}/${TEST_PACKAGE}`, {
      headers: { accept: "application/json" },
    });
    expect(res1.status).toBe(200);

    const body1 = await res1.text();
    const meta1 = JSON.parse(body1);
    const firstFetchSize = Buffer.byteLength(body1);

    // Verify it's valid npm metadata
    expect(meta1.name).toBe(TEST_PACKAGE);
    expect(meta1["dist-tags"]).toBeDefined();
    expect(meta1.versions).toBeDefined();
    expect(Object.keys(meta1.versions).length).toBeGreaterThan(0);

    // Wait for async strip to complete (cache file appears on disk)
    const cacheDeadline = Date.now() + 10_000;
    while (!fs.existsSync(CACHE_FILE) && Date.now() < cacheDeadline) {
      await Bun.sleep(200);
    }
    expect(fs.existsSync(CACHE_FILE)).toBe(true);

    const strippedSize = fs.statSync(CACHE_FILE).size;
    expect(strippedSize).toBeLessThan(firstFetchSize);

    // Second fetch: cache hit — served from stripped cache
    const res2 = await fetch(`${REGISTRY_URL}/${TEST_PACKAGE}`, {
      headers: { accept: "application/json" },
    });
    expect(res2.status).toBe(200);

    const body2 = await res2.text();
    const meta2 = JSON.parse(body2);
    const secondFetchSize = Buffer.byteLength(body2);

    // Stripped response should be smaller and match the cache file
    expect(secondFetchSize).toBeLessThan(firstFetchSize);
    expect(secondFetchSize).toBe(strippedSize);

    // Verify stripped metadata structure
    expect(meta2.name).toBe(TEST_PACKAGE);
    expect(meta2["dist-tags"]).toBeDefined();
    expect(meta2.versions).toBeDefined();

    // Verify version entries only contain allowed fields
    const someVersion = Object.values(meta2.versions)[0] as Record<
      string,
      unknown
    >;
    const allowedFields = new Set([
      "name",
      "version",
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "bin",
      "engines",
      "os",
      "cpu",
      "dist",
    ]);
    for (const key of Object.keys(someVersion)) {
      expect(allowedFields.has(key)).toBe(true);
    }

    // Bloat fields should be gone
    expect(someVersion).not.toHaveProperty("description");
    expect(someVersion).not.toHaveProperty("readme");
    expect(someVersion).not.toHaveProperty("maintainers");

    // Verify dist only has allowed fields
    const dist = someVersion.dist as Record<string, unknown>;
    expect(dist).toBeDefined();
    const allowedDistFields = new Set(["tarball", "integrity", "shasum"]);
    for (const key of Object.keys(dist)) {
      expect(allowedDistFields.has(key)).toBe(true);
    }

    // Small delay to ensure stats are flushed
    await Bun.sleep(500);

    // Verify stats reflect correct savings
    const statsAfter = await fetch(`${API_URL}/stats`).then((r) => r.json());

    const missDelta =
      (statsAfter as any).requests.misses -
      (statsBefore as any).requests.misses;
    const hitDelta =
      (statsAfter as any).requests.hits - (statsBefore as any).requests.hits;
    expect(missDelta).toBe(1);
    expect(hitDelta).toBe(1);

    // Bandwidth: the hit should show savings
    const savedDelta =
      (statsAfter as any).bandwidth.totalSaved -
      (statsBefore as any).bandwidth.totalSaved;
    const servedDelta =
      (statsAfter as any).bandwidth.totalServed -
      (statsBefore as any).bandwidth.totalServed;

    expect(savedDelta).toBeGreaterThan(0);
    expect(servedDelta).toBe(strippedSize);

    // Savings ratio should be significant (express metadata strips > 30%)
    const pct = savedDelta / (servedDelta + savedDelta);
    expect(pct).toBeGreaterThan(0.3);
  }, 60_000);
});
