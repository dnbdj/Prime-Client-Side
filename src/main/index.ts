import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { LaunchResult, PrimeConfig, ProgressEvent } from '../shared/api';
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
import { installLoader, type LoaderKind } from './loaders';
import { launch, type LaunchHandle } from './launch';
import { defaultInstance } from '../shared/instances';
import { loadConfig, saveConfig } from './store';
import { checkForUpdates } from './update';

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

ipcMain.handle('prime:java:list', async () => discoverJava(join(minecraftRoot(), 'runtimes')));

ipcMain.handle('prime:loader:install', async (_event, kind: LoaderKind, gameVersion: string) => {
  if (kind !== 'fabric' && kind !== 'forge') return { ok: false, error: 'Unknown loader.' };
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

ipcMain.handle('prime:launch', async (_event, versionId: string): Promise<LaunchResult> => {
  if (session) return { ok: false, error: 'Minecraft is already running in this window.' };
  if (!versionId) return { ok: false, error: 'No Minecraft version selected.' };

  const config = loadConfig();
  const rootDir = minecraftRoot();
  const gameDir = config.gameDir ?? rootDir;

  let auth: Awaited<ReturnType<typeof launchAuth>> = null;
  try {
    auth = await launchAuth();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const username = auth?.name ?? (config.username.trim() || 'Player');
  // A version-level override wins; the Settings value is the fallback.
  const override = config.versionJvmArgs?.[versionId]?.trim();
  const jvmArgs = override && override.length > 0 ? override : config.jvmArgs;

  try {
    mkdirSync(gameDir, { recursive: true });
    const logPath = startSessionLog(versionId);
    const writeLog = (line: string) => {
      sessionLog?.write(`${line}\n`);
      send('prime:log', line);
    };

    session = await launch({
      versionId,
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
      { versionId, playedAt: new Date().toISOString() },
      ...(config.recent ?? []).filter((entry) => entry.versionId !== versionId),
    ].slice(0, 6);
    saveConfig({
      versionId,
      recent,
      // Keep a named instance the user made for this version; only add a plain
      // record when the version was never set up.
      instances: config.instances.some((entry) => entry.versionId === versionId)
        ? config.instances
        : [defaultInstance(versionId), ...config.instances],
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
});

// Validate that a Java runtime is usable before the user commits to it.
ipcMain.handle('prime:java:check', async (_event, path: string) => verifyJava(path));

void app.whenReady().then(() => {
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
