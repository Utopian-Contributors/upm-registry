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

interface NpmDist {
  tarball?: string;
  integrity?: string;
  shasum?: string;
  [key: string]: unknown;
}

interface NpmVersionEntry {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  dist?: NpmDist;
  [key: string]: unknown;
}

export interface NpmPackageMetadata {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, NpmVersionEntry>;
  [key: string]: unknown;
}

interface StrippedMetadata {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, Record<string, unknown>>;
}

export function stripMetadata(original: NpmPackageMetadata): StrippedMetadata {
  const stripped: StrippedMetadata = {
    name: original.name,
    "dist-tags": original["dist-tags"],
    versions: {},
  };

  for (const [ver, entry] of Object.entries(original.versions)) {
    const slim: Record<string, unknown> = {};
    for (const key of KEEP_VERSION_FIELDS) {
      if (entry[key] !== undefined) slim[key] = entry[key];
    }
    if (entry.dist) {
      const dist: Record<string, unknown> = {};
      for (const key of KEEP_DIST_FIELDS) {
        if (entry.dist[key as keyof NpmDist] !== undefined)
          dist[key] = entry.dist[key as keyof NpmDist];
      }
      slim.dist = dist;
    }
    stripped.versions[ver] = slim;
  }

  return stripped;
}
