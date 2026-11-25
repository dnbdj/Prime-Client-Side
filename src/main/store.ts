import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrimeConfig } from '../shared/api';

const DEFAULTS: PrimeConfig = {
  username: 'Player',
  ramMb: 4096,
  jvmArgs: '',
  closeOnLaunch: false,
  javaPath: null,
  gameDir: null,
  versionId: null,
};

let cached: PrimeConfig | null = null;

function configPath(): string {
  return join(app.getPath('userData'), 'prime-config.json');
}

export function loadConfig(): PrimeConfig {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<PrimeConfig>;
    cached = { ...DEFAULTS, ...parsed };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

export function saveConfig(patch: Partial<PrimeConfig>): PrimeConfig {
  const next = { ...loadConfig(), ...patch };
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}
