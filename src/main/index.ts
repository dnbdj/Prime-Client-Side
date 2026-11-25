import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type {
  InstanceDeleteResult,
  InstanceLoader,
  LaunchResult,
  ModFile,
  ModInstallResult,
  ModProvider,
  ModSearchResponse,
  PrimeConfig,
  ProgressEvent,
} from '../shared/api';
import { installMod, searchMods } from './mods';
import {
  cancelDeviceFlow,
  currentAccount,
  launchAuth,
  pollDeviceFlow,
  signOut,
  startDeviceFlow,
} from './auth';
import { discoverJava, verifyJava } from './java';
import { listVersions } from './install';
import { installLoader, listBtaVersions, type LoaderKind } from './loaders';
import { launch, type LaunchHandle } from './launch';
import { defaultInstance } from '../shared/instances';
import { backfillInstanceRecords, loadConfig, saveConfig } from './store';
import { checkForUpdates } from './update';
import { scheduleWatcher, unscheduleWatcher, watcherStatus } from './watcher';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// Prime deliberately does not take Electron's single-instance lock: a second
// process opens its own window and its own game instead of silently forwarding
// to the first. Shared state is guarded where it is shared — config and
// accounts.json through lock files, libraries and assets through per-process
// .part names, and game logs per session.
let window: BrowserWindow | null = null;
let session: LaunchHandle | null = null;
let sessionLog: WriteStream | null = null;

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#08090d',
    title: 'Prime',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // In-memory session per process: two launchers would otherwise share the
      // default Chromium cache under userData and log "Unable to move the cache".
      // Everything persistent lives in our own JSON files, not web storage.
      partition: `prime-${process.pid}`,
    },
  });

  window.once('ready-to-show', () => window?.show());

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    window = null;
  });
}

function minecraftRoot(): string {
  return join(app.getPath('userData'), 'minecraft');
}

/** One file per game session, named after the version and this launch. */
function startSessionLog(versionId: string): string {
  const dir = join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  const safe = versionId.replace(/[^a-z0-9._-]+/gi, '_');
  const file = join(dir, `game-${safe}-${Date.now()}-${process.pid}.log`);
  sessionLog = createWriteStream(file, { flags: 'a' });
  return file;
}

function endSessionLog(): void {
  sessionLog?.end();
  sessionLog = null;
}

ipcMain.handle('prime:config:get', () => loadConfig());

ipcMain.handle('prime:config:set', (_event, patch: Partial<PrimeConfig>) => saveConfig(patch));

ipcMain.handle('prime:versions', async () => listVersions(minecraftRoot()));

/** BTA lists its own builds; they never appear in Mojang's manifest. */
ipcMain.handle('prime:bta:versions', async () => listBtaVersions());

ipcMain.handle('prime:java:list', async () => discoverJava(join(minecraftRoot(), 'runtimes')));

ipcMain.handle('prime:loader:install', async (_event, kind: LoaderKind, gameVersion: string) => {
  const kinds = [
    'fabric',
    'forge',
    'quilt',
    'legacyfabric',
    'neoforge',
    'liteloader',
    'babric',
    'ornithe',
    'nilloader',
    'bta',
  ];
  if (!kinds.includes(kind)) return { ok: false, error: 'Unknown loader.' };
  if (!gameVersion) return { ok: false, error: 'Pick a Minecraft version first.' };
  const rootDir = minecraftRoot();
  const log = (line: string) => send('prime:log', line);
  try {
    const installed = await installLoader(
      kind,
      gameVersion,
      rootDir,
      (event: ProgressEvent) => send('prime:progress', event),
      log,
    );
    // Only the selection changes here. Callers that create a named instance
    // (the setup wizard) add their own record once the profile exists.
    saveConfig({ versionId: installed.versionId });
    return { ok: true, versionId: installed.versionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send('prime:log', `[prime] ${kind} install failed: ${message}`);
    return { ok: false, error: message };
  }
});

ipcMain.handle('prime:dir:default', () => minecraftRoot());

ipcMain.handle('prime:app:version', () => app.getVersion());

ipcMain.handle('prime:update:check', async () =>
  checkForUpdates(loadConfig().updateFeed, app.getVersion()),
);

ipcMain.handle('prime:open', async (_event, target: string) => {
  if (typeof target === 'string' && target.length > 0) await shell.openPath(target);
});

/**
 * Instances each boot from their own game folder. Instances that existed before
 * per-instance folders keep the old shared folder, so their saves, options and
 * resource packs stay exactly where they were.
 */
function legacyGameDir(): string {
  return loadConfig().gameDir ?? minecraftRoot();
}

function safeDirName(versionId: string): string {
  return versionId.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'instance';
}

/**
 * The folder belongs to the instance record, not to the Minecraft version, so
 * two instances of the same version never share mods or worlds. Instance ids
 * derived from a version (v:<version>) keep the plain version folder used by
 * earlier builds; records created since get a suffixed folder of their own.
 */
function instanceGameDir(instanceId: string, versionId: string): string {
  const entry = loadConfig().instances.find((candidate) => candidate.id === instanceId);
  if (typeof entry?.gameDir === 'string' && entry.gameDir.length > 0) return entry.gameDir;
  const version = entry?.versionId ?? versionId;
  const key = instanceId.startsWith('v:')
    ? safeDirName(version)
    : `${safeDirName(version)}-${instanceId.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
  return join(legacyGameDir(), 'instances', key);
}

/** Pins records written before per-instance folders/ids, straight to the file. */
function migrateInstanceDirs(): void {
  backfillInstanceRecords(legacyGameDir());
}

function modsDirectory(instanceId: string, versionId: string): string {
  return join(instanceGameDir(instanceId, versionId), 'mods');
}

/** CurseForge key: Settings wins, then the environment for CLI runs. */
function curseForgeKey(): string | null {
  const stored = loadConfig().curseForgeApiKey;
  if (typeof stored === 'string' && stored.trim().length > 0) return stored.trim();
  const fromEnv = process.env.CURSEFORGE_API_KEY;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}

/** Loader profiles inherit the actual Minecraft version from their parent. */
function gameVersionOf(versionId: string): string {
  try {
    const meta = JSON.parse(
      readFileSync(join(minecraftRoot(), 'versions', versionId, `${versionId}.json`), 'utf8'),
    ) as { inheritsFrom?: unknown };
    if (typeof meta.inheritsFrom === 'string' && meta.inheritsFrom.length > 0) {
      return meta.inheritsFrom;
    }
  } catch {
    // Not installed locally yet: fall back to the profile naming below.
  }
  const forge = /^(.+)-forge-[\d.]+$/.exec(versionId);
  if (forge) return forge[1];
  const fabric = /^fabric-loader-[\d.]+-(.+)$/.exec(versionId);
  if (fabric) return fabric[1];
  const quilt = /^quilt-loader-[\d.]+-(.+)$/.exec(versionId);
  if (quilt) return quilt[1];
  // Ornithe ids keep the Fabric loader prefix plus its own suffix.
  const ornithe = /^fabric-loader-[\d.]+-(.+)-ornithe-/.exec(versionId);
  if (ornithe) return ornithe[1];
  const nilloader = /^nilloader-[\d.]+-(.+)$/.exec(versionId);
  if (nilloader) return nilloader[1];
  // NeoForge builds are numbered <mc>.<mc>.<build>, e.g. neoforge-26.3.0.118.
  const neoforge = /^neoforge-(\d+\.\d+)(?:\.|$)/.exec(versionId);
  if (neoforge) return neoforge[1];
  // LiteLoader ids look like 1.12.2-LiteLoader1.12.2.
  const liteloader = /^(\d+\.\d+(?:\.\d+)?)-LiteLoader/.exec(versionId);
  if (liteloader) return liteloader[1];
  // BTA builds are beta 1.7.3 with their own classes and a launchwrapper main.
  if (versionId.startsWith('bta-')) return 'b1.7.3';
  return versionId;
}

function listModFiles(instanceId: string, versionId: string): ModFile[] {
  const dir = modsDirectory(instanceId, versionId);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(jar|zip)$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, size: statSync(join(dir, entry.name)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Shared by the file dialog and the explicit-path entry point. */
function copyMods(instanceId: string, versionId: string, files: string[]): ModFile[] {
  const dir = modsDirectory(instanceId, versionId);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    try {
      copyFileSync(file, join(dir, basename(file)));
    } catch {
      // A file that vanished or is locked is skipped; the list shows what landed.
    }
  }
  return listModFiles(instanceId, versionId);
}

ipcMain.handle('prime:instance:dir', (_event, instanceId: string, versionId: string) =>
  instanceGameDir(instanceId, versionId),
);

ipcMain.handle('prime:mods:list', (_event, instanceId: string, versionId: string) =>
  listModFiles(instanceId, versionId),
);

ipcMain.handle('prime:mods:dir', (_event, instanceId: string, versionId: string) =>
  modsDirectory(instanceId, versionId),
);

ipcMain.handle('prime:mods:open', async (_event, instanceId: string, versionId: string) => {
  const dir = modsDirectory(instanceId, versionId);
  mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
});

ipcMain.handle(
  'prime:mods:add',
  async (_event, instanceId: string, versionId: string): Promise<ModFile[]> => {
    const options: OpenDialogOptions = {
      title: 'Add mods',
      buttonLabel: 'Add to mods',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Mod jars', extensions: ['jar', 'zip'] }],
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return listModFiles(instanceId, versionId);
    }
    return copyMods(instanceId, versionId, picked.filePaths);
  },
);

// Explicit-path entry point: the same copy the dialog performs, without the
// native picker, so the add path is testable.
ipcMain.handle(
  'prime:mods:addFrom',
  (_event, instanceId: string, versionId: string, paths: string[]): ModFile[] => {
    if (!Array.isArray(paths)) return listModFiles(instanceId, versionId);
    return copyMods(
      instanceId,
      versionId,
      paths.filter((path): path is string => typeof path === 'string' && path.length > 0),
    );
  },
);

ipcMain.handle(
  'prime:mods:search',
  async (
    _event,
    provider: ModProvider,
    query: string,
    versionId: string,
    loader: InstanceLoader,
  ): Promise<ModSearchResponse> => {
    try {
      if (provider !== 'modrinth' && provider !== 'curseforge') {
        return { ok: false, results: [], error: 'Unknown mod provider.' };
      }
      const results = await searchMods(
        provider,
        typeof query === 'string' ? query : '',
        gameVersionOf(String(versionId ?? '')),
        loader,
        curseForgeKey(),
      );
      return { ok: true, results };
    } catch (error) {
      return {
        ok: false,
        results: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle(
  'prime:mods:install',
  async (
    _event,
    provider: ModProvider,
    projectId: string,
    instanceId: string,
    versionId: string,
  ): Promise<ModInstallResult> => {
    try {
      if (provider !== 'modrinth' && provider !== 'curseforge') {
        return { ok: false, error: 'Unknown mod provider.' };
      }
      if (typeof projectId !== 'string' || projectId.length === 0) {
        return { ok: false, error: 'No mod selected.' };
      }
      const entry = loadConfig().instances.find((candidate) => candidate.id === instanceId);
      const dir = modsDirectory(instanceId, versionId);
      const name = await installMod(
        provider,
        projectId,
        dir,
        gameVersionOf(versionId),
        entry?.loader ?? 'vanilla',
        curseForgeKey(),
      );
      return { ok: true, file: { name, size: statSync(join(dir, name)).size } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
);

ipcMain.handle(
  'prime:instance:delete',
  (_event, instanceId: string, versionId: string, deleteFolder: boolean): InstanceDeleteResult => {
    const config = loadConfig();
    const entry = config.instances.find((candidate) => candidate.id === instanceId) ?? null;
    const targetVersion = entry?.versionId ?? versionId;
    const instances = entry
      ? config.instances.filter((candidate) => candidate.id !== instanceId)
      : config.instances;
    const stillCovered = new Set(instances.map((candidate) => candidate.versionId));
    // Dropping the record is not enough: recently played entries would turn it
    // back into a derived card on the instances page.
    const recent = config.recent.filter(
      (item) => item.versionId !== targetVersion || stillCovered.has(item.versionId),
    );
    const nextVersionId =
      config.versionId === targetVersion && !stillCovered.has(targetVersion)
        ? (instances[0]?.versionId ?? null)
        : config.versionId;

    let folderDeleted = false;
    if (deleteFolder && entry?.gameDir) {
      const instancesRoot = resolve(legacyGameDir(), 'instances');
      const target = resolve(entry.gameDir);
      // The legacy shared folder is never touched: it holds the original
      // worlds, config and Forge profile.
      if (target !== resolve(legacyGameDir()) && target.startsWith(`${instancesRoot}${sep}`)) {
        rmSync(target, { recursive: true, force: true });
        folderDeleted = true;
      }
    }

    return {
      config: saveConfig({ instances, recent, versionId: nextVersionId }),
      folderDeleted,
    };
  },
);

ipcMain.handle(
  'prime:mods:remove',
  (_event, instanceId: string, versionId: string, name: string): ModFile[] => {
    if (typeof name !== 'string' || name.length === 0 || name !== basename(name)) {
      return listModFiles(instanceId, versionId);
    }
    rmSync(join(modsDirectory(instanceId, versionId), name), { force: true });
    return listModFiles(instanceId, versionId);
  },
);

ipcMain.handle('prime:external', async (_event, url: string) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) await shell.openExternal(url);
});

ipcMain.handle('prime:kill', () => {
  if (!session) return false;
  session.kill();
  session = null;
  endSessionLog();
  return true;
});

ipcMain.handle('prime:auth:account', () => currentAccount());

ipcMain.handle('prime:auth:start', () => startDeviceFlow());

ipcMain.handle('prime:auth:poll', () => pollDeviceFlow());

ipcMain.handle('prime:auth:cancel', () => {
  cancelDeviceFlow();
});

ipcMain.handle('prime:auth:signout', async () => {
  await signOut();
});

ipcMain.handle(
  'prime:launch',
  async (_event, versionId: string, instanceId?: string): Promise<LaunchResult> => {
    if (session) return { ok: false, error: 'Minecraft is already running in this window.' };
    if (!versionId) return { ok: false, error: 'No Minecraft version selected.' };

    const config = loadConfig();
    const rootDir = minecraftRoot();
    // The instance record decides version and folder; the version id is only a
    // fallback for launches that did not come from a card (Home's Play button).
    const instance = instanceId
      ? config.instances.find((entry) => entry.id === instanceId)
      : config.instances.find((entry) => entry.versionId === versionId);
    const launchVersion = instance?.versionId ?? versionId;
    const launchId = instance?.id ?? `v:${launchVersion}`;
    const gameDir = instanceGameDir(launchId, launchVersion);

  let auth: Awaited<ReturnType<typeof launchAuth>> = null;
  try {
    auth = await launchAuth();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const username = auth?.name ?? (config.username.trim() || 'Player');
  // A version-level override wins; the Settings value is the fallback.
  const override = config.versionJvmArgs?.[launchVersion]?.trim();
  const jvmArgs = override && override.length > 0 ? override : config.jvmArgs;

  try {
    mkdirSync(gameDir, { recursive: true });
    // A fresh instance folder still gets the player's video settings, so they
    // do not have to redo them; worlds stay where they were, per instance.
    const legacyOptions = join(legacyGameDir(), 'options.txt');
    const instanceOptions = join(gameDir, 'options.txt');
    if (gameDir !== legacyGameDir() && !existsSync(instanceOptions) && existsSync(legacyOptions)) {
      copyFileSync(legacyOptions, instanceOptions);
    }
    const logPath = startSessionLog(launchVersion);
    const writeLog = (line: string) => {
      sessionLog?.write(`${line}\n`);
      send('prime:log', line);
    };

    session = await launch({
      versionId: launchVersion,
      rootDir,
      gameDir,
      username,
      ramMb: config.ramMb,
      javaPath: config.javaPath,
      jvmArgs,
      auth,
      // In close-on-launch mode the game is detached with its output in the log
      // file, so quitting the launcher does not take the game down with it.
      detachedLogFile: config.afterLaunch === 'close' ? logPath : undefined,
      progress: (event: ProgressEvent) => send('prime:progress', event),
      log: writeLog,
      exit: (code) => {
        session = null;
        endSessionLog();
        send('prime:exit', code);
      },
    });
    writeLog(`[prime] Launcher instance ${process.pid}`);
    writeLog(`[prime] Session log: ${logPath}`);
    writeLog(`[prime] JVM flags: ${jvmArgs.trim() || '(none)'}${override ? ' (version override)' : ' (global)'}`);
    writeLog(`[prime] After launch: ${config.afterLaunch}`);
    const recent = [
      { versionId: launchVersion, playedAt: new Date().toISOString() },
      ...(config.recent ?? []).filter((entry) => entry.versionId !== launchVersion),
    ].slice(0, 6);
    saveConfig({
      versionId: launchVersion,
      recent,
      // Pin the folder on the record that actually launched; only add a plain
      // record when the version was never set up.
      instances: instance
        ? config.instances.map((entry) =>
            entry.id === instance.id ? { ...entry, gameDir } : entry,
          )
        : config.instances.some((entry) => entry.versionId === launchVersion)
          ? config.instances
          : [defaultInstance(launchVersion, { gameDir }), ...config.instances],
    });

    if (config.afterLaunch === 'close') {
      // Forget the handle first: before-quit only kills a session it still owns,
      // so the game keeps running once the launcher is gone.
      session = null;
      setTimeout(() => app.quit(), 900);
    } else if (config.afterLaunch === 'minimise') {
      setTimeout(() => {
        if (window && !window.isDestroyed()) window.minimize();
      }, 900);
    }

    return { ok: true, pid: session?.pid, logPath };
  } catch (error) {
    session = null;
    endSessionLog();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  },
);

// Validate that a Java runtime is usable before the user commits to it.
ipcMain.handle('prime:java:check', async (_event, path: string) => verifyJava(path));

// The Wi-Fi watcher as a Windows scheduled task, so it outlives this window.
ipcMain.handle('prime:watcher:status', () => watcherStatus());
ipcMain.handle('prime:watcher:schedule', () => scheduleWatcher());
ipcMain.handle('prime:watcher:unschedule', () => unscheduleWatcher());

void app.whenReady().then(() => {
  migrateInstanceDirs();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  session?.kill();
  endSessionLog();
});
