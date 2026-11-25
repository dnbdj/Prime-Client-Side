import { existsSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import type { ProgressEvent, VersionSummary } from '../shared/api';
import { downloadFile, fetchJson } from './net';
import { discoverJava } from './java';
import { prepare, resolveVersion, type Library, type VersionJson } from './install';

export type LoaderKind =
  | 'fabric'
  | 'forge'
  | 'quilt'
  | 'legacyfabric'
  | 'neoforge'
  | 'liteloader'
  | 'babric'
  | 'ornithe'
  | 'nilloader'
  | 'bta'
  | 'modloader'
  | 'rift'
  | 'java-agent';

export type LoaderInstall = {
  versionId: string;
  kind: LoaderKind;
  gameVersion: string;
  loaderVersion: string;
};

type FabricLoader = { loader: { version: string; stable: boolean } };
type QuiltLoader = { loader: { version: string } };
type LegacyFabricLoader = { loader: { version: string; stable?: boolean } };
type MavenVersions = { versions: string[] };

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
const LEGACY_FABRIC_META = 'https://meta.legacyfabric.net/v2/versions';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NEOFORGE_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const LITELOADER_META = 'https://dl.liteloader.com/versions/versions.json';
const LITELOADER_INSTALLER_JOB = 'https://jenkins.liteloader.com/job/LiteLoaderInstaller';
const BABRIC_META = 'https://meta.babric.glass-launcher.net/v2/versions';
const ORNITHE_META = 'https://meta.ornithemc.net/v3/versions';
const NILLOADER_RELEASES = 'https://git.sleeping.town/api/v1/repos/Nil/NilLoader/releases';
const NILLOADER_MAVEN = 'https://repo.sleeping.town';
const BTA_CLIENT = 'https://downloads.betterthanadventure.net/bta-client/release';
const MODLOADER_ARCHIVE_URL =
  'https://b2.mcarchive.net/file/mcarchive/0b14f5e261c9862989aa74313b59188cce10bea6724bae31130ce1e8e6a1c060/ModLoader%201.6.2.zip';
const MODLOADER_SHA256 = '0b14f5e261c9862989aa74313b59188cce10bea6724bae31130ce1e8e6a1c060';
const RIFT_VERSION = '1.0.4-87';
const RIFT_JAR_URL = `https://github.com/DimensionalDevelopment/Rift/releases/download/v${RIFT_VERSION}/Rift-${RIFT_VERSION}.jar`;
const RIFT_SHA1 = '3c6ad224026a4ffc7c1758ed070b0a32bb72d9d7';
/** dimdev.org's maven is gone; the archive copy is the same published jar. */
const RIFT_MAVEN = 'https://web.archive.org/web/2019id_/https://www.dimdev.org/maven';
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

/**
 * Legacy Fabric keeps its own meta and intermediary for old versions, but it
 * serves the same Fabric-shaped profile, so the install follows Fabric's.
 */
export async function installLegacyFabric(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({
    phase: 'loader',
    current: 0,
    total: 3,
    label: `Looking up Legacy Fabric for ${gameVersion}`,
  });
  const loaders = await fetchJson<LegacyFabricLoader[]>(
    `${LEGACY_FABRIC_META}/loader/${encodeURIComponent(gameVersion)}`,
  );
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Legacy Fabric has no loader build for Minecraft ${gameVersion}.`);
  }
  const loader = loaders.find((entry) => entry.loader.stable) ?? loaders[0];
  log(`[prime] Legacy Fabric loader ${loader.loader.version} for ${gameVersion}`);

  progress({ phase: 'loader', current: 1, total: 3, label: 'Fetching Legacy Fabric profile' });
  const profile = await fetchJson<VersionJson>(
    `${LEGACY_FABRIC_META}/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loader.loader.version)}/profile/json`,
  );
  if (!profile.id || profile.inheritsFrom !== gameVersion) {
    throw new Error(`Legacy Fabric returned an unexpected profile for ${gameVersion}.`);
  }
  profile.primeLoader = 'legacyfabric';
  profile.releaseTime = profile.releaseTime ?? new Date().toISOString();
  log(
    `[prime] Legacy Fabric profile ${profile.id} inherits ${profile.inheritsFrom}, main ${profile.mainClass}`,
  );

  await writeProfile(rootDir, profile);
  try {
    // The vanilla half plus Legacy Fabric's intermediary and loader libraries.
    await prepare(profile.id, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, profile.id);
    throw error;
  }

  progress({ phase: 'loader', current: 3, total: 3, label: 'Legacy Fabric installed' });
  return {
    versionId: profile.id,
    kind: 'legacyfabric',
    gameVersion,
    loaderVersion: loader.loader.version,
  };
}

type InstallerOptions = { label?: string; args?: string[] };

/** Runs a Java process and keeps the tail of its output for error messages. */
async function runJava(
  javaPath: string,
  args: string[],
  cwd: string,
  log: Log,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, args, {
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
        log(`[${label.toLowerCase()}] ${text}`);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) =>
      reject(new Error(`Could not start the ${label} installer: ${error.message}`)),
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${label} installer exited with code ${code ?? 'unknown'}: ${lines.slice(-3).join(' | ')}`,
          ),
        );
    });
  });
}

async function runInstaller(
  javaPath: string,
  installer: string,
  cwd: string,
  log: Log,
  { label = 'Forge', args = ['--installClient'] }: InstallerOptions = {},
): Promise<void> {
  await runJava(javaPath, ['-jar', installer, ...args], cwd, log, label);
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

/**
 * NeoForge publishes build numbers like 26.3.0.118, where 26.3 is the Minecraft
 * version, so the newest patch line for a game version is the highest number.
 */
async function newestNeoforge(gameVersion: string, log: Log): Promise<string> {
  const body = await fetchJson<MavenVersions>(NEOFORGE_VERSIONS);
  const prefix = `${gameVersion}.`;
  const matches = (body.versions ?? []).filter(
    (version) => version.startsWith(prefix) && /^\d+(\.\d+)+$/.test(version),
  );
  if (matches.length === 0) {
    throw new Error(`NeoForge does not publish a build for Minecraft ${gameVersion}.`);
  }
  const ranked = [...matches].sort((a, b) => {
    const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (right[i] ?? 0) - (left[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  log(`[prime] NeoForge publishes ${matches.length} builds for ${gameVersion}, newest ${ranked[0]}`);
  return ranked[0];
}

/**
 * NeoForge has no meta endpoint that serves a launcher profile: it ships a Java
 * installer that patches the vanilla client and writes the profile itself, so
 * this runs that jar against a prepared vanilla version and then adopts the
 * profile it produced.
 */
export async function installNeoforge(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 4, label: `Looking up NeoForge for ${gameVersion}` });
  const build = await newestNeoforge(gameVersion, log);
  const versionId = `neoforge-${build}`;
  log(`[prime] NeoForge build ${build} for ${gameVersion} -> ${versionId}`);

  // The installer patches the vanilla client jar, so that has to exist first.
  progress({ phase: 'loader', current: 1, total: 4, label: 'Preparing vanilla files' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );

  const profilesPath = join(rootDir, 'launcher_profiles.json');
  if (!existsSync(profilesPath)) {
    await fs.writeFile(profilesPath, JSON.stringify({ profiles: {} }, null, 2));
  }

  const base = `${NEOFORGE_MAVEN}/${build}/neoforge-${build}-installer`;
  const installerPath = join(rootDir, '.prime-cache', `neoforge-${build}-installer.jar`);
  await fs.mkdir(join(rootDir, '.prime-cache'), { recursive: true });

  progress({ phase: 'loader', current: 2, total: 4, label: `Downloading NeoForge ${build} installer` });
  if (!existsSync(installerPath)) {
    let sha1: string | undefined;
    try {
      const published = await fetch(`${base}.jar.sha1`);
      if (published.ok) sha1 = (await published.text()).trim().split(/\s+/)[0];
    } catch {
      // No published checksum means the SHA-1 check is skipped, not faked.
    }
    await downloadFile(`${base}.jar`, installerPath, sha1);
  }
  log(`[prime] NeoForge installer ready (${installerPath})`);

  // The installer and the patched profile need a modern JDK, like Forge's.
  const runtimes = (await discoverJava()).sort((a, b) => b.major - a.major);
  const javaPath = runtimes[0]?.path ?? 'java';
  log(`[prime] NeoForge installer Java: ${javaPath}`);

  progress({ phase: 'loader', current: 3, total: 4, label: 'Running the NeoForge installer' });
  try {
    // Unlike Forge's, this installer ignores the working directory and falls
    // back to %APPDATA%\.minecraft, so the target has to be named outright.
    await runInstaller(javaPath, installerPath, rootDir, log, {
      label: 'NeoForge',
      args: ['--installClient', rootDir],
    });
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  const profilePath = join(rootDir, 'versions', versionId, `${versionId}.json`);
  if (!existsSync(profilePath)) {
    await discardProfile(rootDir, versionId);
    throw new Error('The NeoForge installer finished but produced no client profile.');
  }
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8')) as VersionJson;
  profile.primeLoader = 'neoforge';
  await writeProfile(rootDir, profile);

  // The installer lays down its own libraries; prepare resolves the rest.
  progress({ phase: 'loader', current: 4, total: 4, label: 'NeoForge installed' });
  return { versionId, kind: 'neoforge', gameVersion, loaderVersion: build };
}

type LiteLoaderMeta = {
  versions: Record<
    string,
    { snapshots?: { 'com.mumfrey:liteloader'?: Record<string, { version?: string }> } }
  >;
};

type LiteLoaderInstallProfile = {
  install?: { target?: string; version?: string };
  versionInfo?: { id?: string; inheritsFrom?: string; mainClass?: string };
};

/**
 * LiteLoader's installer has no command line at all: its main method ignores
 * every argument and only opens a Swing window. This driver presses the same
 * "install client" action that window runs, against the same directory.
 */
const LITELOADER_DRIVER = `import java.io.File;
import java.util.ArrayList;
import com.mumfrey.liteloader.installer.actions.ClientInstallAction;
import com.mumfrey.liteloader.installer.actions.InstallerAction;

public class LlDriver {
  static class Boot extends com.mumfrey.liteloader.installer.gui.InstallerPanel {
    Boot() { super(true); }
  }

  public static void main(String[] args) throws Exception {
    new Boot();
    File dir = new File(args[0]).getAbsoluteFile();
    ClientInstallAction action = new ClientInstallAction();
    action.refresh(dir);
    boolean ok = action.run(dir, new ArrayList<>(), InstallerAction.CLIENT);
    System.out.println("client install result=" + ok);
    System.exit(ok ? 0 : 1);
  }
}
`;

/** The installer jar carries its own profile description, so read the id from it. */
function readLiteLoaderProfile(installerPath: string): {
  target: string;
  inheritsFrom: string | null;
  mainClass: string | null;
} {
  let zip: AdmZip;
  try {
    zip = new AdmZip(installerPath);
  } catch {
    throw new Error('The LiteLoader installer jar could not be read.');
  }
  const entry = zip.getEntry('install_profile.json');
  if (!entry) throw new Error('The LiteLoader installer is missing its install profile.');
  const data = JSON.parse(entry.getData().toString('utf8')) as LiteLoaderInstallProfile;
  const target = data.install?.target ?? data.versionInfo?.id;
  if (!target) throw new Error('The LiteLoader installer does not name the profile it writes.');
  return {
    target,
    inheritsFrom: data.versionInfo?.inheritsFrom ?? null,
    mainClass: data.versionInfo?.mainClass ?? null,
  };
}

/**
 * LiteLoader ships a GUI-only installer per Minecraft version. The install
 * prepares that vanilla version, runs the installer's own client-install action
 * headlessly, then adopts the profile it wrote - the loader never changes.
 */
export async function installLiteLoader(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({
    phase: 'loader',
    current: 0,
    total: 5,
    label: `Looking up LiteLoader for ${gameVersion}`,
  });
  const meta = await fetchJson<LiteLoaderMeta>(LITELOADER_META).catch(() => null);
  const entry = meta?.versions?.[gameVersion];
  if (!entry) {
    throw new Error(
      `LiteLoader has no build for Minecraft ${gameVersion} - its last versions are 1.12.2 and older.`,
    );
  }
  const loaderVersion =
    entry.snapshots?.['com.mumfrey:liteloader']?.latest?.version ?? `${gameVersion}-SNAPSHOT`;
  log(`[prime] LiteLoader ${loaderVersion} for ${gameVersion}`);

  // The installer merges into the vanilla profile, so that has to exist first.
  progress({ phase: 'loader', current: 1, total: 5, label: 'Preparing vanilla files' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );

  const profilesPath = join(rootDir, 'launcher_profiles.json');
  if (!existsSync(profilesPath)) {
    await fs.writeFile(profilesPath, JSON.stringify({ profiles: {} }, null, 2));
  }

  const jarName = `liteloader-installer-${gameVersion}-00-SNAPSHOT.jar`;
  const installerUrl = `${LITELOADER_INSTALLER_JOB}%20${encodeURIComponent(
    gameVersion,
  )}/lastSuccessfulBuild/artifact/build/libs/${jarName}`;
  const installerPath = join(rootDir, '.prime-cache', jarName);
  await fs.mkdir(join(rootDir, '.prime-cache'), { recursive: true });

  progress({
    phase: 'loader',
    current: 2,
    total: 5,
    label: `Downloading LiteLoader ${gameVersion} installer`,
  });
  if (!existsSync(installerPath)) await downloadFile(installerUrl, installerPath);
  log(`[prime] LiteLoader installer ready (${installerPath})`);

  const profileInfo = readLiteLoaderProfile(installerPath);
  if (profileInfo.inheritsFrom && profileInfo.inheritsFrom !== gameVersion) {
    throw new Error(
      `This LiteLoader installer builds ${profileInfo.inheritsFrom}, not ${gameVersion}.`,
    );
  }
  log(
    `[prime] LiteLoader installer writes ${profileInfo.target} (inherits ${profileInfo.inheritsFrom}, main ${profileInfo.mainClass})`,
  );

  progress({ phase: 'loader', current: 3, total: 5, label: 'Running the LiteLoader installer' });
  const driverDir = join(rootDir, '.prime-cache', 'liteloader-driver');
  await fs.mkdir(driverDir, { recursive: true });
  const driverPath = join(driverDir, 'LlDriver.java');
  await fs.writeFile(driverPath, LITELOADER_DRIVER);
  try {
    // Source-file mode compiles the driver in memory with the installer jar on
    // the classpath, so no javac call or build step is involved.
    const runtimes = (await discoverJava()).sort((a, b) => b.major - a.major);
    const javaPath = runtimes.find((runtime) => runtime.major >= 11)?.path ?? null;
    if (!javaPath) {
      throw new Error(
        'Driving the LiteLoader installer needs a JDK 11 or newer, and none is installed.',
      );
    }
    log(`[prime] LiteLoader installer Java: ${javaPath}`);
    await runJava(
      javaPath,
      ['-Djava.awt.headless=true', '-cp', installerPath, driverPath, rootDir],
      rootDir,
      log,
      'LiteLoader',
    );
  } catch (error) {
    await discardProfile(rootDir, profileInfo.target);
    throw error;
  } finally {
    await fs.rm(driverDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const versionId = profileInfo.target;
  const profilePath = join(rootDir, 'versions', versionId, `${versionId}.json`);
  if (!existsSync(profilePath)) {
    await discardProfile(rootDir, versionId);
    throw new Error('The LiteLoader installer finished but produced no client profile.');
  }
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8')) as VersionJson;
  profile.primeLoader = 'liteloader';
  await writeProfile(rootDir, profile);

  progress({ phase: 'loader', current: 4, total: 5, label: 'Downloading LiteLoader libraries' });
  try {
    // launchwrapper, ASM and the loader jar itself into the normal store.
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  progress({ phase: 'loader', current: 5, total: 5, label: 'LiteLoader installed' });
  return { versionId, kind: 'liteloader', gameVersion, loaderVersion };
}

/**
 * Babric is Fabric for beta 1.7.3 and serves the same Fabric-shaped profile
 * from its own meta, so the install is Fabric's against Babric's endpoints.
 */
export async function installBabric(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 3, label: `Looking up Babric for ${gameVersion}` });
  const loaders = await fetchJson<FabricLoader[]>(
    `${BABRIC_META}/loader/${encodeURIComponent(gameVersion)}`,
  );
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`Babric has no loader build for Minecraft ${gameVersion}.`);
  }
  const loader = loaders.find((entry) => entry.loader.stable) ?? loaders[0];
  log(`[prime] Babric loader ${loader.loader.version} for ${gameVersion}`);

  progress({ phase: 'loader', current: 1, total: 3, label: 'Fetching Babric profile' });
  const profile = await fetchJson<VersionJson>(
    `${BABRIC_META}/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(
      loader.loader.version,
    )}/profile/json`,
  );
  if (!profile.id || profile.inheritsFrom !== gameVersion) {
    throw new Error(`Babric returned an unexpected profile for ${gameVersion}.`);
  }
  profile.primeLoader = 'babric';
  profile.releaseTime = profile.releaseTime ?? new Date().toISOString();
  // Beta 1.7.3 bundles asm-all 4.1 and Fabric's loader refuses to start with a
  // second ASM on the classpath, so the game's copy is dropped.
  const vanilla = await resolveVersion(gameVersion, rootDir).catch(() => null);
  const vanillaAsm = (vanilla?.version.libraries ?? [])
    .map((library) => library.name)
    .filter((name) => name.startsWith('org.ow2.asm:'));
  if (vanillaAsm.length > 0) {
    profile.primeDropLibraries = vanillaAsm;
    log(`[prime] Babric drops the game's ${vanillaAsm.join(', ')}`);
  }
  log(`[prime] Babric profile ${profile.id} inherits ${profile.inheritsFrom}, main ${profile.mainClass}`);

  await writeProfile(rootDir, profile);
  try {
    // The beta client jar, pre-1.6 assets and Babric's own libraries.
    await prepare(profile.id, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, profile.id);
    throw error;
  }

  progress({ phase: 'loader', current: 3, total: 3, label: 'Babric installed' });
  return { versionId: profile.id, kind: 'babric', gameVersion, loaderVersion: loader.loader.version };
}

type OrnitheMeta = { installer?: { version: string; stable?: boolean; url: string }[] };

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Ornithe ships a Quilt-derived installer with a real command line, so the
 * install downloads it from Ornithe's maven and lets it write the profile.
 */
export async function installOrnithe(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 4, label: `Looking up Ornithe for ${gameVersion}` });
  const meta = await fetchJson<OrnitheMeta>(ORNITHE_META);
  const installers = [...(meta.installer ?? [])].sort((a, b) => compareVersionsDesc(a.version, b.version));
  const installer = installers.find((entry) => entry.stable) ?? installers[0];
  if (!installer) throw new Error('Ornithe does not publish an installer.');
  log(`[prime] Ornithe installer ${installer.version}`);

  // The installer builds on the vanilla version and its own gen2 profile.
  progress({ phase: 'loader', current: 1, total: 4, label: 'Preparing vanilla files' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );

  const profilesPath = join(rootDir, 'launcher_profiles.json');
  if (!existsSync(profilesPath)) {
    await fs.writeFile(profilesPath, JSON.stringify({ profiles: {} }, null, 2));
  }

  const installerPath = join(rootDir, '.prime-cache', `ornithe-installer-${installer.version}.jar`);
  await fs.mkdir(join(rootDir, '.prime-cache'), { recursive: true });
  progress({ phase: 'loader', current: 2, total: 4, label: 'Downloading the Ornithe installer' });
  if (!existsSync(installerPath)) await downloadFile(installer.url, installerPath);
  log(`[prime] Ornithe installer ready (${installerPath})`);

  const runtimes = (await discoverJava()).sort((a, b) => b.major - a.major);
  const javaPath = runtimes.find((runtime) => runtime.major >= 17)?.path ?? runtimes[0]?.path;
  if (!javaPath) throw new Error('The Ornithe installer needs a Java runtime and none is installed.');
  log(`[prime] Ornithe installer Java: ${javaPath}`);

  const versionsDir = join(rootDir, 'versions');
  const before = new Set(await fs.readdir(versionsDir).catch(() => [] as string[]));
  progress({ phase: 'loader', current: 3, total: 4, label: 'Running the Ornithe installer' });
  await runJava(
    javaPath,
    [
      '-jar',
      installerPath,
      'install',
      'client',
      gameVersion,
      'Official',
      'Fabric',
      `--install-dir=${rootDir}`,
    ],
    rootDir,
    log,
    'Ornithe',
  );

  const after = await fs.readdir(versionsDir).catch(() => [] as string[]);
  const versionId =
    after.find((name) => !before.has(name) && /-ornithe-/.test(name)) ??
    after.find((name) => /-ornithe-/.test(name) && name.includes(gameVersion));
  if (!versionId) {
    throw new Error('The Ornithe installer finished but produced no client profile.');
  }
  const profilePath = join(rootDir, 'versions', versionId, `${versionId}.json`);
  if (!existsSync(profilePath)) {
    await discardProfile(rootDir, versionId);
    throw new Error('The Ornithe installer produced a version folder without a profile.');
  }
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8')) as VersionJson;
  profile.primeLoader = 'ornithe';
  await writeProfile(rootDir, profile);
  log(`[prime] Ornithe profile ${versionId} inherits ${profile.inheritsFrom}, main ${profile.mainClass}`);

  progress({ phase: 'loader', current: 4, total: 4, label: 'Downloading Ornithe libraries' });
  try {
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  const loaderVersion = /^fabric-loader-([\d.]+)-/.exec(versionId)?.[1] ?? 'ornithe';
  return { versionId, kind: 'ornithe', gameVersion, loaderVersion };
}

type NilLoaderRelease = {
  tag_name: string;
  assets?: { name: string; browser_download_url: string }[];
};

/**
 * NilLoader is a JVM agent, not a profile provider: it publishes a jar and the
 * exact maven coordinates Prism uses. The install writes a profile that puts
 * that jar on the classpath and starts the game with -javaagent.
 */
export async function installNilLoader(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  progress({ phase: 'loader', current: 0, total: 3, label: 'Looking up NilLoader' });
  const releases = await fetchJson<NilLoaderRelease[]>(`${NILLOADER_RELEASES}?limit=1`);
  const release = Array.isArray(releases) ? releases[0] : null;
  if (!release?.tag_name) throw new Error('NilLoader does not publish a release.');
  const version = release.tag_name;
  const versionId = `nilloader-${version}-${gameVersion}`;
  log(`[prime] NilLoader ${version} for ${gameVersion} -> ${versionId}`);

  // The agent wraps the vanilla game, so the vanilla profile comes first and
  // supplies the main class this profile keeps.
  progress({ phase: 'loader', current: 1, total: 3, label: 'Preparing vanilla files' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );
  const vanilla = await resolveVersion(gameVersion, rootDir);

  const agentPath = `com/unascribed/nilloader/${version}/nilloader-${version}.jar`;
  const profile: VersionJson = {
    id: versionId,
    inheritsFrom: gameVersion,
    type: 'release',
    releaseTime: new Date().toISOString(),
    mainClass: vanilla.version.mainClass,
    libraries: [{ name: `com.unascribed:nilloader:${version}`, url: NILLOADER_MAVEN }],
    arguments: { jvm: [`-javaagent:\${library_directory}/${agentPath}`], game: [] },
  };
  profile.primeLoader = 'nilloader';
  await writeProfile(rootDir, profile);

  progress({ phase: 'loader', current: 2, total: 3, label: 'Downloading the NilLoader agent' });
  try {
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  const agentFile = join(rootDir, 'libraries', agentPath);
  if (!existsSync(agentFile)) {
    await discardProfile(rootDir, versionId);
    throw new Error('NilLoader published no agent jar at its maven coordinates.');
  }

  progress({ phase: 'loader', current: 3, total: 3, label: 'NilLoader installed' });
  return { versionId, kind: 'nilloader', gameVersion, loaderVersion: version };
}

type BtaVersions = { versions: Record<string, { release?: string }> };

type BtaPatch = {
  mainClass?: string;
  minecraftArguments?: string;
  compatibleJavaMajors?: number[];
  compatibleJavaName?: string;
  libraries?: Library[];
};

/** The MultiMC patches BTA's own installer writes, read from its instance zip. */
function readBtaPatch(zip: AdmZip, name: string): BtaPatch {
  const entry = zip.getEntry(`patches/${name}.json`);
  if (!entry) throw new Error(`missing patches/${name}.json`);
  return JSON.parse(entry.getData().toString('utf8')) as BtaPatch;
}

/**
 * BTA is its own game: it numbers builds v8.0.1 and up and publishes a build
 * index beside the client jars, so its versions come from there, not Mojang.
 */
export async function listBtaVersions(): Promise<VersionSummary[]> {
  const body = await fetchJson<BtaVersions>(`${BTA_CLIENT}/versions-new.json`);
  return Object.entries(body.versions ?? {})
    .map(([version, info]) => {
      const released = info.release ? Date.parse(`${info.release.replace(' ', 'T')}Z`) : Number.NaN;
      return {
        id: `bta-${version}`,
        type: 'release',
        releaseTime: Number.isFinite(released)
          ? new Date(released).toISOString()
          : new Date(0).toISOString(),
      };
    })
    .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime));
}

/**
 * BTA publishes a complete vanilla-launcher profile for every build
 * (manifest.json beside the client jar), with its own main class, libraries and
 * LWJGL. The install adopts that profile and lets the normal prepare step fetch
 * the client jar, libraries and pre-1.6 assets.
 */
export async function installBta(
  btaVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  const version = btaVersion.startsWith('bta-') ? btaVersion.slice(4) : btaVersion;
  const versionId = `bta-${version}`;
  progress({ phase: 'loader', current: 0, total: 4, label: `Looking up BTA ${version}` });
  const builds = await listBtaVersions().catch(() => [] as VersionSummary[]);
  if (builds.length > 0 && !builds.some((entry) => entry.id === versionId)) {
    throw new Error(`BTA does not publish a build called ${version}.`);
  }

  progress({ phase: 'loader', current: 1, total: 4, label: `Fetching BTA ${version} files` });
  const manifest = await fetchJson<VersionJson>(
    `${BTA_CLIENT}/${encodeURIComponent(version)}/manifest.json`,
  );
  if (!manifest.downloads?.client) {
    throw new Error(`BTA ${version} published no client jar.`);
  }

  // The manifest beside the jar still names launchwrapper 1.5, which cannot run
  // on the Java 17 these classes need (it casts the system loader to
  // URLClassLoader). BTA's instance archive carries the patches its own
  // installer writes - main class, launch arguments, library set, Java - so
  // those are what the profile is built from.
  const archive = join(rootDir, '.prime-cache', `bta-${version}-instance.zip`);
  await fs.mkdir(join(rootDir, '.prime-cache'), { recursive: true });
  progress({ phase: 'loader', current: 2, total: 4, label: `Downloading BTA ${version} instance` });
  if (!existsSync(archive)) {
    await downloadFile(`${BTA_CLIENT}/${encodeURIComponent(version)}/instance.zip`, archive);
  }

  let game: BtaPatch;
  let graphics: BtaPatch;
  try {
    const zip = new AdmZip(archive);
    game = readBtaPatch(zip, 'net.minecraft');
    graphics = readBtaPatch(zip, 'org.lwjgl');
  } catch (error) {
    throw new Error(
      `BTA's instance archive could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!game.minecraftArguments) throw new Error(`BTA ${version} does not name its launch arguments.`);

  const libraries = new Map<string, Library>();
  for (const library of [...(game.libraries ?? []), ...(graphics.libraries ?? [])]) {
    if (library?.name) libraries.set(library.name, library);
  }
  const major = game.compatibleJavaMajors?.[0] ?? 17;

  const profile: VersionJson = {
    id: versionId,
    type: 'old_beta',
    mainClass: game.mainClass ?? 'net.minecraft.client.Minecraft',
    minecraftArguments: game.minecraftArguments,
    libraries: [...libraries.values()],
    downloads: { client: manifest.downloads.client },
    javaVersion: {
      component: game.compatibleJavaName ?? 'java-runtime-gamma',
      majorVersion: major,
    },
    releaseTime: manifest.releaseTime ?? new Date().toISOString(),
  };
  profile.primeLoader = 'bta';
  log(
    `[prime] BTA profile ${versionId}: main ${profile.mainClass}, ${libraries.size} libraries, Java ${major}`,
  );

  await writeProfile(rootDir, profile);
  try {
    // BTA's own client jar, its LWJGL build and the pre-1.6 asset index.
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  progress({ phase: 'loader', current: 4, total: 4, label: 'BTA installed' });
  return { versionId, kind: 'bta', gameVersion: 'b1.7.3', loaderVersion: version };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(path)).digest('hex');
}

/**
 * Risugami's ModLoader is not a launcher: it is 26 class files that go straight
 * into the 1.6.2 client jar, most of them replacing obfuscated base classes.
 * The install patches a copy of that jar and points the profile at the copy.
 */
export async function installModLoader(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  if (gameVersion !== '1.6.2') {
    throw new Error(`Risugami's ModLoader ships for Minecraft 1.6.2, not ${gameVersion}.`);
  }
  const versionId = `${gameVersion}-modloader`;

  progress({ phase: 'loader', current: 0, total: 5, label: 'Preparing vanilla 1.6.2' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );
  const vanillaJar = join(rootDir, 'versions', gameVersion, `${gameVersion}.jar`);
  if (!existsSync(vanillaJar)) throw new Error('The vanilla 1.6.2 client jar is missing.');

  progress({ phase: 'loader', current: 1, total: 5, label: 'Downloading ModLoader 1.6.2' });
  const archive = join(rootDir, '.prime-cache', 'ModLoader 1.6.2.zip');
  await fs.mkdir(dirname(archive), { recursive: true });
  if (!existsSync(archive)) await downloadFile(MODLOADER_ARCHIVE_URL, archive);
  const digest = await sha256File(archive);
  if (digest !== MODLOADER_SHA256) {
    await fs.rm(archive, { force: true }).catch(() => undefined);
    throw new Error(`ModLoader archive checksum mismatch (expected ${MODLOADER_SHA256}, got ${digest}).`);
  }

  progress({ phase: 'loader', current: 2, total: 5, label: 'Patching the 1.6.2 client jar' });
  const game = new AdmZip(vanillaJar);
  const patch = new AdmZip(archive);
  let replaced = 0;
  let added = 0;
  for (const entry of patch.getEntries()) {
    if (entry.isDirectory) continue;
    const data = entry.getData();
    if (game.getEntry(entry.entryName)) {
      game.updateFile(entry.entryName, data);
      replaced += 1;
    } else {
      game.addFile(entry.entryName, data);
      added += 1;
    }
  }
  // A jar signed before the classes were added refuses to load them.
  for (const entry of [...game.getEntries()]) {
    if (/^META-INF\/(MOJANG_C|.*\.(SF|RSA|DSA|EC))$/i.test(entry.entryName)) {
      game.deleteFile(entry.entryName);
    }
  }
  log(`[prime] ModLoader patched ${gameVersion}.jar: ${replaced} classes replaced, ${added} added`);

  const versionDir = join(rootDir, 'versions', versionId);
  await fs.mkdir(versionDir, { recursive: true });
  const patchedJar = join(versionDir, `${versionId}.jar`);
  game.writeZip(patchedJar);

  // A standalone profile: no downloads.client, so prepare keeps this patched jar
  // instead of fetching the vanilla one again.
  const { version: vanilla } = await resolveVersion(gameVersion, rootDir);
  const profile: VersionJson = {
    id: versionId,
    type: vanilla.type ?? 'release',
    mainClass: vanilla.mainClass,
    assets: vanilla.assets,
    assetIndex: vanilla.assetIndex,
    javaVersion: vanilla.javaVersion,
    libraries: vanilla.libraries,
    arguments: vanilla.arguments,
    minecraftArguments: vanilla.minecraftArguments,
    releaseTime: vanilla.releaseTime ?? new Date().toISOString(),
  };
  profile.primeLoader = 'modloader';
  await writeProfile(rootDir, profile);

  progress({ phase: 'loader', current: 3, total: 5, label: 'Checking the patched client' });
  try {
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  progress({ phase: 'loader', current: 5, total: 5, label: 'ModLoader installed' });
  return { versionId, kind: 'modloader', gameVersion, loaderVersion: '1.6.2' };
}

/**
 * Rift publishes a complete launch profile inside its own jar (launchwrapper
 * plus its tweak class), so the install adopts that and only re-points the
 * libraries whose maven hosts are gone: the Rift jar comes from its GitHub
 * release and the dimdev mixin fork from the Internet Archive copy.
 */
export async function installRift(
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  if (gameVersion !== '1.13') {
    throw new Error(`Rift ${RIFT_VERSION} ships one profile, for Minecraft 1.13 (not ${gameVersion}).`);
  }

  progress({ phase: 'loader', current: 0, total: 4, label: `Downloading Rift ${RIFT_VERSION}` });
  const jarPath = join(rootDir, '.prime-cache', `Rift-${RIFT_VERSION}.jar`);
  await fs.mkdir(dirname(jarPath), { recursive: true });
  if (!existsSync(jarPath)) await downloadFile(RIFT_JAR_URL, jarPath, RIFT_SHA1);

  const archive = new AdmZip(jarPath);
  const entry = archive.getEntry('profile.json');
  if (!entry) throw new Error('The Rift jar carries no profile.json.');
  const published = JSON.parse(entry.getData().toString('utf8')) as VersionJson;
  if (!published.id || published.inheritsFrom !== '1.13') {
    throw new Error('The Rift jar published an unexpected profile.');
  }
  const versionId = published.id;

  const riftPath = `org/dimdev/rift/${RIFT_VERSION}/rift-${RIFT_VERSION}.jar`;
  const mixinPath = 'org/dimdev/mixin/0.7.11-SNAPSHOT/mixin-0.7.11-SNAPSHOT.jar';
  const libraries = (published.libraries ?? []).map((library) => {
    if (library.name === `org.dimdev:rift:${RIFT_VERSION}`) {
      return {
        ...library,
        downloads: {
          artifact: { path: riftPath, url: RIFT_JAR_URL, sha1: RIFT_SHA1, size: 142432 },
        },
      };
    }
    if (library.name === 'org.dimdev:mixin:0.7.11-SNAPSHOT') {
      return {
        ...library,
        downloads: {
          artifact: { path: mixinPath, url: `${RIFT_MAVEN}/${mixinPath}`, sha1: '', size: 0 },
        },
      };
    }
    // The published profile points at plain http maven URLs; https is the same
    // artifact on the same host.
    return library.url?.startsWith('http://')
      ? { ...library, url: library.url.replace('http://', 'https://') }
      : library;
  });

  const profile: VersionJson = {
    ...published,
    id: versionId,
    libraries,
  };
  profile.primeLoader = 'rift';
  log(
    `[prime] Rift profile ${versionId}: main ${profile.mainClass}, ${libraries.length} libraries`,
  );
  await writeProfile(rootDir, profile);

  progress({ phase: 'loader', current: 2, total: 4, label: 'Downloading Rift libraries' });
  try {
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  progress({ phase: 'loader', current: 4, total: 4, label: 'Rift installed' });
  return { versionId, kind: 'rift', gameVersion, loaderVersion: RIFT_VERSION };
}

/**
 * A Java Agent loader is just a jar the JVM runs before the game: the install
 * copies it into the library store and starts the vanilla main class with
 * -javaagent pointing at it, which is how NilLoader-style loaders attach.
 */
export async function installJavaAgent(
  gameVersion: string,
  agentJar: string | undefined,
  rootDir: string,
  progress: Progress,
  log: Log,
): Promise<LoaderInstall> {
  const source = (agentJar ?? '').trim();
  if (source.length === 0) throw new Error('Pick an agent jar first.');
  if (!existsSync(source)) throw new Error(`There is no file at ${source}.`);
  if (!/\.jar$/i.test(source)) throw new Error('A JVM agent has to be a .jar file.');
  const slug =
    basename(source)
      .replace(/\.jar$/i, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'agent';
  const versionId = `agent-${slug}-${gameVersion}`;

  progress({ phase: 'loader', current: 0, total: 4, label: 'Preparing vanilla files' });
  await prepare(gameVersion, rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );
  const { version: vanilla } = await resolveVersion(gameVersion, rootDir);

  const relative = `prime/agents/${slug}.jar`;
  const dest = join(rootDir, 'libraries', relative);
  progress({ phase: 'loader', current: 1, total: 4, label: `Copying ${basename(source)}` });
  await fs.mkdir(dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);

  const profile: VersionJson = {
    id: versionId,
    inheritsFrom: gameVersion,
    type: 'release',
    releaseTime: new Date().toISOString(),
    mainClass: vanilla.mainClass,
    libraries: [],
    arguments: { jvm: [`-javaagent:\${library_directory}/${relative}`], game: [] },
  };
  profile.primeLoader = 'java-agent';
  await writeProfile(rootDir, profile);
  log(`[prime] Java Agent profile ${versionId}: -javaagent:${relative}`);

  progress({ phase: 'loader', current: 2, total: 4, label: 'Checking the agent classpath' });
  try {
    await prepare(versionId, rootDir, (phase, current, total, label) =>
      progress({ phase, current, total, label }),
    );
  } catch (error) {
    await discardProfile(rootDir, versionId);
    throw error;
  }

  progress({ phase: 'loader', current: 4, total: 4, label: 'Java Agent installed' });
  return { versionId, kind: 'java-agent', gameVersion, loaderVersion: slug };
}

export async function installLoader(
  kind: LoaderKind,
  gameVersion: string,
  rootDir: string,
  progress: Progress,
  log: Log,
  agentJar?: string,
): Promise<LoaderInstall> {
  // BTA numbers its own builds, so there is no Mojang version to resolve first.
  if (kind === 'bta') return installBta(gameVersion, rootDir, progress, log);
  const resolved = await pickGameVersion(gameVersion, rootDir);
  if (kind === 'modloader') return installModLoader(resolved, rootDir, progress, log);
  if (kind === 'rift') return installRift(resolved, rootDir, progress, log);
  if (kind === 'java-agent') return installJavaAgent(resolved, agentJar, rootDir, progress, log);
  if (kind === 'fabric') return installFabric(resolved, rootDir, progress, log);
  if (kind === 'forge') return installForge(resolved, rootDir, progress, log);
  if (kind === 'quilt') return installQuilt(resolved, rootDir, progress, log);
  if (kind === 'legacyfabric') return installLegacyFabric(resolved, rootDir, progress, log);
  if (kind === 'liteloader') return installLiteLoader(resolved, rootDir, progress, log);
  if (kind === 'babric') return installBabric(resolved, rootDir, progress, log);
  if (kind === 'ornithe') return installOrnithe(resolved, rootDir, progress, log);
  if (kind === 'nilloader') return installNilLoader(resolved, rootDir, progress, log);
  return installNeoforge(resolved, rootDir, progress, log);
}
