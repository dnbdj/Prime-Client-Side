import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { downloadFile, fetchJson, mapLimit } from './net';
import { osKey, rulesAllow, type Rule } from './rules';
import type { VersionSummary } from '../shared/api';

export const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const RESOURCES_URL = 'https://resources.download.minecraft.net';
export const LIBRARIES_URL = 'https://libraries.minecraft.net';

export type Artifact = { path: string; sha1: string; size: number; url: string };

export type ArgEntry = string | { rules?: Rule[]; value: string | string[] };

export type Library = {
  name: string;
  /** Maven repository for `name`; absent means Mojang's library host. */
  url?: string;
  sha1?: string;
  size?: number;
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> };
  natives?: Record<string, string>;
  rules?: Rule[];
};

export type VersionJson = {
  id: string;
  type: string;
  mainClass: string;
  assets?: string;
  assetIndex?: { id: string; url: string; sha1: string; size: number };
  downloads?: { client?: Artifact };
  javaVersion?: { component: string; majorVersion: number };
  libraries?: Library[];
  arguments?: { game?: ArgEntry[]; jvm?: ArgEntry[] };
  minecraftArguments?: string;
  /** Vanilla version a loader profile builds on. */
  inheritsFrom?: string;
  releaseTime?: string;
  /** Set on profiles Prime installed itself. */
  primeLoader?: 'fabric' | 'forge' | 'quilt' | 'legacyfabric';
};

type Manifest = {
  latest: { release: string; snapshot: string };
  versions: (VersionSummary & { url: string; sha1: string })[];
};

type AssetIndex = {
  objects: Record<string, { hash: string; size: number }>;
  virtual?: boolean;
  map_to_resources?: boolean;
};

export type ProgressFn = (phase: 'meta' | 'files' | 'assets', current: number, total: number, label: string) => void;

export type Prepared = {
  version: VersionJson;
  versionDir: string;
  classpath: string;
  nativesDir: string;
  assetIndexId: string;
};

function toSummaries(manifest: Manifest): VersionSummary[] {
  return manifest.versions.map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
}

/** Loader profiles Prime installed itself, which no manifest lists. */
async function localSummaries(rootDir?: string): Promise<VersionSummary[]> {
  if (!rootDir) return [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(join(rootDir, 'versions'));
  } catch {
    return [];
  }
  const found: VersionSummary[] = [];
  for (const id of entries) {
    const version = await readLocalVersion(rootDir, id);
    if (!version?.primeLoader) continue;
    found.push({
      id: version.id ?? id,
      type: version.type ?? 'release',
      releaseTime: version.releaseTime ?? new Date(0).toISOString(),
      loader: version.primeLoader,
    });
  }
  return found.sort((a, b) => b.releaseTime.localeCompare(a.releaseTime));
}

/**
 * Fetches the version manifest, keeping a copy on disk so the version list
 * still loads when the network (or just Mojang) is unavailable.
 */
export async function listVersions(rootDir?: string): Promise<VersionSummary[]> {
  const cachePath = rootDir ? join(rootDir, 'version_manifest_v2.json') : null;
  try {
    const manifest = await fetchJson<Manifest>(VERSION_MANIFEST_URL);
    if (cachePath) {
      await fs.mkdir(rootDir as string, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(manifest)).catch(() => undefined);
    }
    return [...(await localSummaries(rootDir)), ...toSummaries(manifest)];
  } catch (error) {
    const installed = await localSummaries(rootDir);
    if (cachePath) {
      try {
        const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as Manifest;
        return [...installed, ...toSummaries(cached)];
      } catch {
        // No usable cache: fall back to whatever is installed locally.
      }
    }
    if (installed.length > 0) return installed;
    throw error;
  }
}

export async function fetchVersion(versionId: string): Promise<VersionJson> {
  const manifest = await fetchJson<Manifest>(VERSION_MANIFEST_URL);
  const summary = manifest.versions.find((v) => v.id === versionId);
  if (!summary) throw new Error(`Minecraft version "${versionId}" is not in the version manifest.`);
  return fetchJson<VersionJson>(summary.url);
}

function mavenArtifact(name: string, baseUrl = LIBRARIES_URL): Artifact | null {
  const [group, artifact, version, classifier] = name.split(':');
  if (!group || !artifact || !version) return null;
  const path = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${
    classifier ? `-${classifier}` : ''
  }.jar`;
  return { path, sha1: '', size: 0, url: `${baseUrl.replace(/\/$/, '')}/${path}` };
}

function extractNatives(jarPath: string, outDir: string): void {
  const zip = new AdmZip(jarPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (name.startsWith('META-INF/')) continue;
    if (!/\.(dll|so|dylib|jnilib)$/i.test(name)) continue;
    zip.extractEntryTo(entry, outDir, false, true);
  }
}

function needsDownload(dest: string): boolean {
  return !existsSync(dest);
}

async function readLocalVersion(rootDir: string, versionId: string): Promise<VersionJson | null> {
  for (const name of [`${versionId}.json`, 'version.json']) {
    const file = join(rootDir, 'versions', versionId, name);
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as VersionJson;
    } catch {
      return null;
    }
  }
  return null;
}

/** Installed profile first, then Mojang's manifest. */
export async function readVersion(versionId: string, rootDir: string): Promise<VersionJson> {
  return (await readLocalVersion(rootDir, versionId)) ?? fetchVersion(versionId);
}

export type ResolvedVersion = {
  version: VersionJson;
  /** Version that owns the client jar (the vanilla root of an inheriting profile). */
  clientId: string;
};

function mergeVersions(child: VersionJson, parent: VersionJson): VersionJson {
  const libraries = new Map<string, Library>();
  for (const library of [...(parent.libraries ?? []), ...(child.libraries ?? [])]) {
    // A loader may override a vanilla library; the child wins, like the vanilla launcher.
    libraries.set(library.name, library);
  }
  return {
    id: child.id,
    type: child.type ?? parent.type,
    mainClass: child.mainClass ?? parent.mainClass,
    assets: child.assets ?? parent.assets,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    downloads: child.downloads ?? parent.downloads,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    libraries: [...libraries.values()],
    arguments: {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
    },
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    inheritsFrom: child.inheritsFrom,
    primeLoader: child.primeLoader,
  };
}

/**
 * Reads a version (local profile or manifest) and merges its whole inheritance
 * chain, so loader profiles launch with both the vanilla and loader pieces.
 */
export async function resolveVersion(
  versionId: string,
  rootDir: string,
  depth = 0,
): Promise<ResolvedVersion> {
  if (depth > 4) throw new Error(`Version ${versionId} inherits too deeply; is there a loop?`);
  const version = await readVersion(versionId, rootDir);
  if (!version.inheritsFrom) return { version, clientId: versionId };
  const parent = await resolveVersion(version.inheritsFrom, rootDir, depth + 1);
  return { version: mergeVersions(version, parent.version), clientId: parent.clientId };
}

/**
 * Makes sure every file required to run `versionId` exists locally and returns
 * everything needed to build a launch command.
 */
export async function prepare(versionId: string, rootDir: string, progress: ProgressFn): Promise<Prepared> {
  const versionDir = join(rootDir, 'versions', versionId);
  const librariesDir = join(rootDir, 'libraries');
  const assetsDir = join(rootDir, 'assets');
  const nativesDir = join(versionDir, 'natives');

  progress('meta', 0, 1, `Resolving ${versionId}`);
  const { version, clientId } = await resolveVersion(versionId, rootDir);
  await fs.mkdir(versionDir, { recursive: true });
  if (!existsSync(join(versionDir, `${versionId}.json`))) {
    await fs.writeFile(join(versionDir, 'version.json'), JSON.stringify(version, null, 2)).catch(() => undefined);
  }

  // --- client jar + libraries -------------------------------------------------
  const files: { artifact: Artifact; dest: string }[] = [];
  const natives: { artifact: Artifact; dest: string }[] = [];
  const classpathEntries: string[] = [];

  const clientJar = join(rootDir, 'versions', clientId, `${clientId}.jar`);
  if (version.downloads?.client && needsDownload(clientJar)) {
    files.push({ artifact: version.downloads.client, dest: clientJar });
  }
  // The game classes live in the client jar, so it has to lead the classpath.
  classpathEntries.push(clientJar);

  for (const library of version.libraries ?? []) {
    if (!rulesAllow(library.rules)) continue;

    // Old metadata names the platform jar through a `natives` map; those jars
    // are extracted to disk and are not part of the classpath.
    const nativeClassifier = library.natives?.[osKey()];
    if (nativeClassifier) {
      const key = nativeClassifier.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      // Metadata with `downloads` names the classifier jars outright. Loader
      // profiles that only give a maven repo have natives jars named
      // <artifact>-<version>-<classifier>.jar and no plain jar at all.
      const artifact =
        library.downloads?.classifiers?.[key] ??
        (library.downloads ? null : mavenArtifact(`${library.name}:${key}`, library.url));
      if (artifact) {
        const dest = join(librariesDir, artifact.path);
        natives.push({ artifact, dest });
        if (needsDownload(dest)) files.push({ artifact, dest });
      }
      // Natives-only entries stay off the classpath; asking for their base jar
      // would only fetch a 404.
      if (!library.downloads) continue;
    }

    // Modern metadata ships natives as ordinary `:natives-windows` artifacts.
    // They belong on the classpath so LWJGL can unpack them itself, and older
    // versions can also have a classpath jar beside their natives, so this
    // falls through instead of skipping them.
    const artifact =
      library.downloads?.artifact ?? (library.downloads ? null : mavenArtifact(library.name, library.url));
    if (!artifact) continue;
    if (!artifact.sha1 && library.sha1) artifact.sha1 = library.sha1;
    const dest = join(librariesDir, artifact.path);
    classpathEntries.push(dest);
    if (needsDownload(dest)) files.push({ artifact, dest });
  }

  let done = 0;
  const total = files.length;
  progress('files', 0, total || 1, total ? `Downloading ${total} game files` : 'Game files ready');
  await mapLimit(files, 8, async ({ artifact, dest }) => {
    await downloadFile(artifact.url, dest, artifact.sha1 || undefined);
    done += 1;
    progress('files', done, total, `Game files ${done}/${total}`);
  });

  await fs.rm(nativesDir, { recursive: true, force: true });
  await fs.mkdir(nativesDir, { recursive: true });
  // Modern versions point java.library.path and the LWJGL/JNA extraction paths
  // at subdirectories of the natives dir; the JVM does not create them for us.
  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
    await fs.mkdir(join(nativesDir, sub), { recursive: true });
  }
  for (const native of natives) {
    if (!existsSync(native.dest)) continue;
    try {
      extractNatives(native.dest, nativesDir);
      extractNatives(native.dest, join(nativesDir, 'java'));
    } catch {
      // A corrupt native jar is not fatal for every platform; skip it.
    }
  }

  // --- assets -----------------------------------------------------------------
  const assetIndexId = version.assetIndex?.id ?? version.assets ?? 'legacy';
  const objectsDir = join(assetsDir, 'objects');
  const indexPath = join(assetsDir, 'indexes', `${assetIndexId}.json`);

  let index: AssetIndex = { objects: {} };
  if (version.assetIndex) {
    if (!existsSync(indexPath)) {
      await downloadFile(version.assetIndex.url, indexPath, version.assetIndex.sha1);
    }
    index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as AssetIndex;
  }

  const unique = new Map<string, { hash: string }>();
  for (const object of Object.values(index.objects)) unique.set(object.hash, object);
  const missing = [...unique.values()].filter(({ hash }) => needsDownload(join(objectsDir, hash.slice(0, 2), hash)));

  let assetsDone = 0;
  progress('assets', 0, missing.length || 1, missing.length ? `${missing.length} assets to download` : 'Assets ready');
  await mapLimit(missing, 16, async ({ hash }) => {
    await downloadFile(
      `${RESOURCES_URL}/${hash.slice(0, 2)}/${hash}`,
      join(objectsDir, hash.slice(0, 2), hash),
      hash,
    );
    assetsDone += 1;
    if (assetsDone % 20 === 0 || assetsDone === missing.length) {
      progress('assets', assetsDone, missing.length, `Assets ${assetsDone}/${missing.length}`);
    }
  });

  // Pre-1.7 versions read assets from a flat directory.
  if (index.virtual) {
    const virtualDir = join(assetsDir, 'virtual', assetIndexId);
    for (const [name, object] of Object.entries(index.objects)) {
      const dest = join(virtualDir, name);
      if (existsSync(dest)) continue;
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.copyFile(join(objectsDir, object.hash.slice(0, 2), object.hash), dest).catch(() => undefined);
    }
  }

  return {
    version,
    versionDir,
    classpath: classpathEntries.join(delimiter),
    nativesDir,
    assetIndexId,
  };
}
