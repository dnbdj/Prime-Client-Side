import { app } from 'electron';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  closeOnLaunch: false,
  updateFeed: null,
  javaPath: null,
  gameDir: null,
  versionId: null,
  instances: [],
  recent: [],
};

function configPath(): string {
  return join(app.getPath('userData'), 'prime-config.json');
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

/** Read fresh from disk: another instance may have written since the last call. */
export function loadConfig(): PrimeConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<PrimeConfig>;
    const merged = { ...DEFAULTS, ...parsed };
    // Older configs stored a plain list of version ids for instances.
    return { ...merged, instances: normalizeInstances(merged.instances) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch: Partial<PrimeConfig>): PrimeConfig {
  return withLock(() => {
    const next = { ...loadConfig(), ...patch };
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}
