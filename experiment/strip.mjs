import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ORIGINAL = path.join(__dirname, "cache", "original");
const CACHE_STRIPPED = path.join(__dirname, "cache", "stripped");

fs.mkdirSync(CACHE_STRIPPED, { recursive: true });

// Fields to keep per version entry
const KEEP_VERSION_FIELDS = new Set([
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
]);

// Fields to keep inside dist
const KEEP_DIST_FIELDS = new Set(["tarball", "integrity", "shasum"]);

function stripMetadata(original) {
  const stripped = {
    name: original.name,
    "dist-tags": original["dist-tags"],
    versions: {},
  };

  for (const [ver, entry] of Object.entries(original.versions)) {
    const slim = {};
    for (const key of KEEP_VERSION_FIELDS) {
      if (entry[key] !== undefined) slim[key] = entry[key];
    }
    if (entry.dist) {
      slim.dist = {};
      for (const key of KEEP_DIST_FIELDS) {
        if (entry.dist[key] !== undefined) slim.dist[key] = entry.dist[key];
      }
    }
    stripped.versions[ver] = slim;
  }

  return stripped;
}

// Walk cache/original/ recursively to find all .json files
function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.name.endsWith(".json")) {
      results.push(full);
    }
  }
  return results;
}

const files = walk(CACHE_ORIGINAL);
let totalOriginal = 0;
let totalStripped = 0;
let skipped = 0;

for (const srcPath of files) {
  // Mirror the relative path into cache/stripped/
  const rel = path.relative(CACHE_ORIGINAL, srcPath);
  const dstPath = path.join(CACHE_STRIPPED, rel);

  // Skip if already stripped
  if (fs.existsSync(dstPath)) {
    skipped++;
    continue;
  }

  const raw = fs.readFileSync(srcPath, "utf8");

  let stripped;
  try {
    const data = JSON.parse(raw);
    if (data.versions && data["dist-tags"]) {
      stripped = JSON.stringify(stripMetadata(data));
    } else {
      stripped = raw;
    }
  } catch {
    stripped = raw;
  }

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, stripped);

  const origSize = Buffer.byteLength(raw);
  const stripSize = Buffer.byteLength(stripped);
  totalOriginal += origSize;
  totalStripped += stripSize;

  const pct = ((1 - stripSize / origSize) * 100).toFixed(1);
  console.log(
    `${rel.padEnd(45)} ${origSize.toString().padStart(8)} → ${stripSize.toString().padStart(8)}  (${pct}% smaller)`,
  );
}

console.log();
if (skipped > 0) {
  console.log(`Skipped: ${skipped} already stripped`);
}
if (totalOriginal > 0) {
  console.log(
    `Stripped: ${files.length - skipped} new  (${(totalOriginal / 1024).toFixed(0)} KB → ${(totalStripped / 1024).toFixed(0)} KB, ${((1 - totalStripped / totalOriginal) * 100).toFixed(1)}% smaller)`,
  );
} else {
  console.log("Nothing new to strip.");
}
