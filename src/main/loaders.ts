import { existsSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ProgressEvent } from '../shared/api';
import { downloadFile, fetchJson } from './net';
import { discoverJava } from './java';
import { prepare, resolveVersion, type VersionJson } from './install';

export type LoaderKind = 'fabric' | 'forge' | 'quilt';

export type LoaderInstall = {
  versionId: string;
  kind: LoaderKind;
  gameVersion: string;
  loaderVersion: string;
};

type FabricLoader = { loader: { version: string; stable: boolean } };
type QuiltLoader = { loader: { version: string } };

/** 0.30.2 / 0.31.0-beta.6 -> numbers; a stable release outranks its prereleases. */
function quiltRank(version: string): { parts: number[]; prerelease: number } {
  const [core, tag] = version.split('-', 2);
  const parts = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  const prerelease = tag ? Number.parseInt(/(\d+)\s*$/.exec(tag)?.[1] ?? '0', 10) : Number.MAX_SAFE_INTEGER;
  return { parts, prerelease };
}

/**
 * Quilt's meta lists builds in no useful order and its build numbers restart
 * per version line, so the newest loader is picked by comparing versions.
 */
function newestQuiltLoader(loaders: QuiltLoader[]): string {
  // Fabric's install prefers a stable loader; Quilt's meta mixes betas into the
  // same list, so stable builds win and betas are only used when there are none.
  const stable = loaders.filter((entry) => !entry.loader.version.includes('-'));
  const ranked = [...(stable.length > 0 ? stable : loaders)].sort((a, b) => {
    const left = quiltRank(a.loader.version);
    const right = quiltRank(b.loader.version);
    for (let i = 0; i < 3; i += 1) {
      if (left.parts[i] !== right.parts[i]) return right.parts[i] - left.parts[i];
    }
    return right.prerelease - left.prerelease;
  });
  return ranked[0].loader.version;
}
type Promotions = { promos: Record<string, string> };

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions';
const QUILT_META = 'https://meta.quiltmc.org/v3/versions';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

type Progress = (event: ProgressEvent) => void;
type Log = (line: string) => void;

async function writeProfile(rootDir: string, profile: VersionJson): Promise<void> {
  const dir = join(rootDir, 'versions', profile.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${profile.id}.json`), JSON.stringify(profile, null, 2));
}

/** Removes a profile that never finished installing, so it cannot look launchable. */
async function discardProfile(rootDir: string, versionId: string): Promise<void> {
  await fs.rm(join(rootDir, 'versions', versionId), { recursive: true, force: true }).catch(() => undefined);
}

export async function pickGameVersion(gameVersion: string, rootDir: string): Promise<string> {
  try {
    const { version } = await resolveVersion(gameVersion, rootDir);
    return version.id;
  } catch {
    throw new Error(`Unknown Minecraft version "${gameVersion}".`);
  }
}

/** Real Fabric install: loader list from Fabric meta, profile served by Fabric itself. */
export async function installFabric(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 3, label: `Looking up Fabric for ${gameVersion}` });
  const loaders = await fetchJson<FabricLoader[]>(`${FABRIC_META}/loader/${encodeURIComponent(gameVersion)}`);
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Fabric has no loader build for Minecraft ${gameVersion}.`);
  }
  const loader = loaders.find((entry) => entry.loader.stable) ?? loaders[0];
  log(`[prime] Fabric loader ${loader.loader.version} for ${gameVersion}`);

  progress({ phase: 'loader', current: 1, total: 3, label: 'Fetching Fabric profile' });
  const profile = await fetchJson<VersionJson>(
    `${FABRIC_META}/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loader.loader.version)}/profile/json`,
  );
  if (!profile.id || profile.inheritsFrom !== gameVersion) {
    throw new Error(`Fabric returned an unexpected profile for ${gameVersion}.`);
  }
  profile.primeLoader = 'fabric';
  profile.releaseTime = profile.releaseTime ?? new Date().toISOString();
  log(`[prime] Fabric profile ${profile.id} inherits ${profile.inheritsFrom}, main ${profile.mainClass}`);

  await writeProfile(rootDir, profile);
  try {
    // Downloads the vanilla half and Fabric's libraries into the normal store.
    await prepare(profile.id, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, profile.id);
    throw error;
  }

  progress({ phase: 'loader', current: 3, total: 3, label: 'Fabric installed' });
  return { versionId: profile.id, kind: 'fabric', gameVersion, loaderVersion: loader.loader.version };
}

/**
 * Real Quilt install: Quilt serves a Fabric-shaped profile of its own, so the
 * loader half is written straight from its meta and prepared like any other
 * profile. Quilt's meta has no stable flag, so the newest build wins.
 */
export async function installQuilt(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 3, label: `Looking up Quilt for ${gameVersion}` });
  const loaders = await fetchJson<QuiltLoader[]>(
    `${QUILT_META}/loader/${encodeURIComponent(gameVersion)}`,
  );
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Quilt has no loader build for Minecraft ${gameVersion}.`);
  }
  const loaderVersion = newestQuiltLoader(loaders);
  log(`[prime] Quilt loader ${loaderVersion} for ${gameVersion}`);

  progress({ phase: 'loader', current: 1, total: 3, label: 'Fetching Quilt profile' });
  const profile = await fetchJson<VersionJson>(
    `${QUILT_META}/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
  );
  if (!profile.id || profile.inheritsFrom !== gameVersion) {
    throw new Error(`Quilt returned an unexpected profile for ${gameVersion}.`);
  }
  profile.primeLoader = 'quilt';
  profile.releaseTime = profile.releaseTime ?? new Date().toISOString();
  log(`[prime] Quilt profile ${profile.id} inherits ${profile.inheritsFrom}, main ${profile.mainClass}`);

  await writeProfile(rootDir, profile);
  try {
    // Downloads the vanilla half and Quilt's libraries into the normal store.
    await prepare(profile.id, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, profile.id);
    throw error;
  }

  progress({ phase: 'loader', current: 3, total: 3, label: 'Quilt installed' });
  return { versionId: profile.id, kind: 'quilt', gameVersion, loaderVersion };
}

async function runInstaller(
  javaPath: string,
  installer: string,
  cwd: string,
  log: Log,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', installer, '--installClient'], {
      cwd,
      windowsHide: true,
      env: { ...process.env },
    });
    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        lines.push(text);
        if (lines.length > 60) lines.shift();
        log(`[forge] ${text}`);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => reject(new Error(`Could not start the Forge installer: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Forge installer exited with code ${code ?? 'unknown'}: ${lines.slice(-3).join(' | ')}`));
    });
  });
}

/**
 * Real Forge install: resolves the published build from Forge's promotions file,
 * downloads that build's official installer, and lets it lay down the profile,
 * libraries and patched artifacts inside the launcher root.
 */
export async function installForge(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 4, label: `Looking up Forge for ${gameVersion}` });
  const promos = (await fetchJson<Promotions>(FORGE_PROMOTIONS)).promos;
  const loaderVersion =
    promos[`${gameVersion}-recommended`] ?? promos[`${gameVersion}-latest`] ?? null;
  if (!loaderVersion) {
    throw new Error(`Forge does not publish a build for Minecraft ${gameVersion}.`);
  }
  const versionId = `${gameVersion}-forge-${loaderVersion}`;
  log(`[prime] Forge build ${loaderVersion} for ${gameVersion} -> ${versionId}`);

  // The installer patches the vanilla client jar, so that has to exist first.
  progress({ phase: 'loader', current: 1, total: 4, label: 'Preparing vanilla files' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );

  const profilesPath = join(rootDir, 'launcher_profiles.json');
  if (!existsSync(profilesPath)) {
    await fs.writeFile(profilesPath, JSON.stringify({ profiles: {} }, null, 2));
  }

  const base = `${FORGE_MAVEN}/${gameVersion}-${loaderVersion}/forge-${gameVersion}-${loaderVersion}-installer`;
  const installerPath = join(rootDir, '.prime-cache', `forge-${gameVersion}-${loaderVersion}-installer.jar`);
  await fs.mkdir(join(rootDir, '.prime-cache'), { recursive: true });

  progress({ phase: 'loader', current: 2, total: 4, label: `Downloading Forge ${loaderVersion} installer` });
  let sha1: string | undefined;
  try {
    const published = await fetch(`${base}.jar.sha1`);
    if (published.ok) sha1 = (await published.text()).trim().split(/\s+/)[0];
  } catch {
    // Without a published checksum the SHA-1 check is skipped, not faked.
  }
  if (!existsSync(installerPath)) {
    await downloadFile(`${base}.jar`, installerPath, sha1);
  }
  log(`[prime] Forge installer ready (${installerPath})`);

  const runtimes = (await discoverJava()).sort((a, b) => b.major - a.major);
  const javaPath = runtimes[0]?.path ?? 'java';

  progress({ phase: 'loader', current: 3, total: 4, label: 'Running the Forge installer' });
  try {
    await runInstaller(javaPath, installerPath, rootDir, log);
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  const profilePath = join(rootDir, 'versions', versionId, `${versionId}.json`);
  if (!existsSync(profilePath)) {
    await discardProfile(rootDir, versionId);
    throw new Error('The Forge installer finished but produced no client profile.');
  }
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8')) as VersionJson;
  profile.primeLoader = 'forge';
  await writeProfile(rootDir, profile);

  progress({ phase: 'loader', current: 4, total: 4, label: 'Forge installed' });
  return { versionId, kind: 'forge', gameVersion, loaderVersion };
}

export async function installLoader(
  kind: LoaderKind,
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  const resolved = await pickGameVersion(gameVersion, rootDir);
  if (kind === 'fabric') return installFabric(resolved, rootDir, progress, log);
  if (kind === 'forge') return installForge(resolved, rootDir, progress, log);
  return installQuilt(resolved, rootDir, progress, log);
}
