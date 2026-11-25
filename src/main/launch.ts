import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ProgressEvent } from '../shared/api';
import { prepare, type ArgEntry, type VersionJson } from './install';
import { resolveJava } from './java';
import { rulesAllow } from './rules';

export type LaunchAccount = {
  accessToken: string;
  uuid: string;
  xuid: string;
};

export type LaunchOptions = {
  versionId: string;
  rootDir: string;
  gameDir: string;
  username: string;
  ramMb: number;
  javaPath: string | null;
  /** Extra JVM flags from settings, split on whitespace. */
  jvmArgs?: string;
  /** Signed-in Microsoft account; null launches offline. */
  auth?: LaunchAccount | null;
  progress: (event: ProgressEvent) => void;
  log: (line: string) => void;
  exit: (code: number | null) => void;
};

export type LaunchHandle = {
  pid: number | undefined;
  kill: () => void;
};

function flatten(entries: ArgEntry[] | undefined, features: Record<string, boolean>): string[] {
  if (!entries) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (!rulesAllow(entry.rules, features)) continue;
    out.push(...(Array.isArray(entry.value) ? entry.value : [entry.value]));
  }
  return out;
}

/**
 * Offline UUID, computed exactly like the vanilla launcher so worlds and
 * player data stay stable between runs.
 */
export function offlineUuid(username: string): string {
  const digest = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildCommand(
  version: VersionJson,
  prepared: { classpath: string; nativesDir: string; assetIndexId: string },
  options: {
    rootDir: string;
    gameDir: string;
    username: string;
    ramMb: number;
    auth?: LaunchAccount | null;
    extraJvm?: string[];
  },
): { jvm: string[]; mainClass: string; game: string[] } {
  const { classpath, nativesDir, assetIndexId } = prepared;
  const { rootDir, gameDir, username, ramMb, auth } = options;
  const features: Record<string, boolean> = {};

  const vars: Record<string, string> = {
    auth_player_name: username,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: join(rootDir, 'assets'),
    game_assets: join(rootDir, 'assets', 'virtual', assetIndexId),
    assets_index_name: version.assetIndex?.id ?? version.assets ?? 'legacy',
    auth_uuid: auth?.uuid ?? offlineUuid(username),
    auth_access_token: auth?.accessToken ?? '0',
    auth_session: auth?.accessToken ?? '0',
    auth_xuid: auth?.xuid ?? '0',
    clientid: '',
    user_type: auth ? 'msa' : 'legacy',
    version_type: version.type,
    resolution_width: '854',
    resolution_height: '480',
    quickPlayPath: join(gameDir, 'quickPlay', 'quickPlay.log'),
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
    natives_directory: nativesDir,
    launcher_name: 'prime',
    launcher_version: '0.1.0',
    classpath,
    classpath_separator: process.platform === 'win32' ? ';' : ':',
    library_directory: join(rootDir, 'libraries'),
  };

  // Launcher placeholders are case-insensitive: Forge and Fabric both use forms
  // like ${library_directory} and ${version_name} that must resolve here.
  const lowerVars = new Map(Object.entries(vars).map(([key, value]) => [key.toLowerCase(), value]));
  const substitute = (value: string) =>
    value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, key: string) => lowerVars.get(key.toLowerCase()) ?? whole);

  let jvm = flatten(version.arguments?.jvm, features);
  if (!jvm.includes('-cp') && !jvm.some((arg) => arg.includes('${classpath}'))) {
    jvm = [...jvm, '-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
  }

  const jvmArgs = [
    `-Xmx${Math.max(512, ramMb)}M`,
    `-Xms${Math.min(Math.max(512, ramMb), 1024)}M`,
    ...(options.extraJvm ?? []),
    '-Dlog4j2.formatMsgNoLookups=true',
    ...jvm.map(substitute),
  ];

  const rawGame = version.arguments?.game
    ? flatten(version.arguments.game, features)
    : (version.minecraftArguments ?? '').split(' ').filter(Boolean);

  return {
    jvm: jvmArgs,
    mainClass: version.mainClass,
    game: rawGame.map(substitute),
  };
}

export async function launch(options: LaunchOptions): Promise<LaunchHandle> {
  const { progress, log } = options;

  const prepared = await prepare(options.versionId, options.rootDir, (phase, current, total, label) =>
    progress({ phase, current, total, label }),
  );

  const requiredMajor = prepared.version.javaVersion?.majorVersion ?? 8;
  progress({ phase: 'java', current: 0, total: 1, label: `Locating Java ${requiredMajor}+` });
  const javaPath = await resolveJava(options.javaPath, requiredMajor, {
    runtimeRoot: join(options.rootDir, 'runtimes'),
    // Old versions have no javaVersion block; vanilla runs them on Java 8.
    component: prepared.version.javaVersion?.component ?? 'jre-legacy',
    onProgress: (label, current, total) => progress({ phase: 'java', current, total, label }),
  });
  progress({ phase: 'java', current: 1, total: 1, label: `Using ${javaPath}` });

  const command = buildCommand(prepared.version, prepared, {
    rootDir: options.rootDir,
    gameDir: options.gameDir,
    username: options.username,
    ramMb: options.ramMb,
    auth: options.auth ?? null,
    extraJvm: (options.jvmArgs ?? '').split(/\s+/).filter(Boolean),
  });

  progress({ phase: 'launch', current: 1, total: 1, label: 'Starting Minecraft' });
  log(`[prime] Java: ${javaPath}`);
  log(`[prime] Version: ${prepared.version.id}  RAM: ${options.ramMb} MB`);
  log(`[prime] Account: ${options.username} (${options.auth ? 'Microsoft' : 'offline'})`);
  log(`[prime] Game directory: ${options.gameDir}`);

  const child: ChildProcess = spawn(javaPath, [...command.jvm, command.mainClass, ...command.game], {
    cwd: options.gameDir,
    env: { ...process.env },
    windowsHide: true,
  });

  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim().length > 0) log(line);
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);

  child.on('error', (error) => {
    log(`[prime] Failed to start Java: ${error.message}`);
    options.exit(null);
  });
  child.on('exit', (code) => {
    log(`[prime] Minecraft exited with code ${code ?? 'unknown'}`);
    options.exit(code);
  });

  return {
    pid: child.pid,
    kill: () => {
      child.kill();
    },
  };
}
