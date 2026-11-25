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

export async function listVersions(): Promise<VersionSummary[]> {
  const manifest = await fetchJson<Manifest>(VERSION_MANIFEST_URL);
  return manifest.versions.map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
}

export async function fetchVersion(versionId: string): Promise<VersionJson> {
  const manifest = await fetchJson<Manifest>(VERSION_MANIFEST_URL);
  const summary = manifest.versions.find((v) => v.id === versionId);
  if (!summary) throw new Error(`Minecraft version "${versionId}" is not in the version manifest.`);
  return fetchJson<VersionJson>(summary.url);
}

function mavenArtifact(name: string): Artifact | null {
  const [group, artifact, version, classifier] = name.split(':');
  if (!group || !artifact || !version) return null;
  const path = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${
    classifier ? `-${classifier}` : ''
  }.jar`;
  return { path, sha1: '', size: 0, url: `${LIBRARIES_URL}/${path}` };
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
  const version = await fetchVersion(versionId);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(join(versionDir, 'version.json'), JSON.stringify(version, null, 2)).catch(() => undefined);

  // --- client jar + libraries -------------------------------------------------
  const files: { artifact: Artifact; dest: string }[] = [];
  const natives: { artifact: Artifact; dest: string }[] = [];
  const classpathEntries: string[] = [];

  const clientJar = join(versionDir, `${versionId}.jar`);
  if (version.downloads?.client && needsDownload(clientJar)) {
    files.push({ artifact: version.downloads.client, dest: clientJar });
  }

  for (const library of version.libraries ?? []) {
    if (!rulesAllow(library.rules)) continue;

    const nativeClassifier = library.natives?.[osKey()];
    if (nativeClassifier) {
      const key = nativeClassifier.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const artifact = library.downloads?.classifiers?.[key];
      if (artifact) {
        const dest = join(librariesDir, artifact.path);
        natives.push({ artifact, dest });
        if (needsDownload(dest)) files.push({ artifact, dest });
      }
      // Pre-1.9 libraries can ship a classpath jar next to their natives, so
      // fall through instead of skipping them.
    }

    if (library.name.includes(':natives-')) {
      const artifact = library.downloads?.artifact;
      if (artifact && !nativeClassifier) {
        const dest = join(librariesDir, artifact.path);
        natives.push({ artifact, dest });
        if (needsDownload(dest)) files.push({ artifact, dest });
      }
      continue;
    }

    const artifact = library.downloads?.artifact ?? (library.downloads ? null : mavenArtifact(library.name));
    if (!artifact) continue;
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
  for (const native of natives) {
    if (!existsSync(native.dest)) continue;
    try {
      extractNatives(native.dest, nativesDir);
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
