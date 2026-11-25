import { app } from 'electron';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrimeConfig } from '../shared/api';
import { normalizeInstances } from '../shared/instances';

const DEFAULTS: PrimeConfig = {
  username: 'Player',
  ramMb: 4096,
  jvmArgs: '',
  versionJvmArgs: {},
  afterLaunch: 'keep',
  updateFeed: null,
  javaPath: null,
  gameDir: null,
  versionId: null,
  instances: [],
  recent: [],
  curseForgeApiKey: null,
};

function configPath(): string {
  return join(app.getPath('userData'), 'prime-config.json');
}

/**
 * Writes through a temp file so a crash or a shutdown mid-save can never leave
 * a half-written config: the old file stays valid until the rename replaces it.
 */
function writeConfigFile(text: string): void {
  const target = configPath();
  const temp = `${target}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, target);
}

const TICK = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(TICK, 0, 0, ms);
}

/**
 * Prime runs as several processes at once, so writes are serialised through a
 * lock file. A crashed instance can leave one behind, so the wait is bounded and
 * the lock is reclaimed once it looks stale.
 */
function withLock<T>(fn: () => T): T {
  const lock = `${configPath()}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 1500;

  while (true) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        return fn();
      } finally {
        closeSync(fd);
        rmSync(lock, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        rmSync(lock, { force: true });
        return fn();
      }
      sleepSync(25);
    }
  }
}

/** Reads one config file; null when it is missing or not valid JSON. */
function readConfigFile(path: string): PrimeConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrimeConfig> & {
      /** Older configs had a single boolean instead of afterLaunch. */
      closeOnLaunch?: boolean;
    };
    const { closeOnLaunch, ...rest } = parsed;
    const merged = {
      ...DEFAULTS,
      ...rest,
      afterLaunch: rest.afterLaunch ?? (closeOnLaunch ? 'close' : DEFAULTS.afterLaunch),
    };
    // Older configs stored a plain list of version ids for instances.
    return { ...merged, instances: normalizeInstances(merged.instances) };
  } catch {
    return null;
  }
}

/** Read fresh from disk: another instance may have written since the last call. */
export function loadConfig(): PrimeConfig {
  const config = readConfigFile(configPath());
  if (config) return config;

  // A config that cannot be parsed used to fall back to the defaults, and the
  // next save then wrote that empty config over the real one, losing every
  // instance. Prefer the copy saved before the last write instead.
  const backup = readConfigFile(`${configPath()}.bak`);
  if (backup) {
    try {
      writeConfigFile(JSON.stringify(backup, null, 2));
    } catch {
      // The next save retries; the backup is still there to read.
    }
    return backup;
  }
  return { ...DEFAULTS };
}

/**
 * Adds the fields older records do not have straight to the file. Reading goes
 * through normalizeInstances, which already fills them in memory, so this has
 * to look at the raw JSON to know whether a write is needed.
 */
export function backfillInstanceRecords(legacyDir: string): void {
  withLock(() => {
    let raw: { instances?: unknown };
    try {
      raw = JSON.parse(readFileSync(configPath(), 'utf8')) as { instances?: unknown };
    } catch {
      return;
    }
    if (!Array.isArray(raw.instances)) return;

    let changed = false;
    const instances = raw.instances.map((value) => {
      if (!value || typeof value !== 'object') return value;
      const record = { ...(value as Record<string, unknown>) };
      if (typeof record.id !== 'string' || record.id.length === 0) {
        record.id = `v:${String(record.versionId ?? '')}`;
        changed = true;
      }
      if (typeof record.gameDir !== 'string' || record.gameDir.length === 0) {
        record.gameDir = legacyDir;
        changed = true;
      }
      return record;
    });
    if (!changed) return;
    raw.instances = instances;
    writeConfigFile(JSON.stringify(raw, null, 2));
  });
}

export function saveConfig(patch: Partial<PrimeConfig>): PrimeConfig {
  return withLock(() => {
    const next = { ...loadConfig(), ...patch };
    try {
      if (existsSync(configPath())) copyFileSync(configPath(), `${configPath()}.bak`);
    } catch {
      // A missing backup only costs the recovery path, never the save itself.
    }
    writeConfigFile(JSON.stringify(next, null, 2));
    return next;
  });
}
