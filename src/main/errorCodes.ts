import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Codes live in the repository (docs/error-codes.json) so they can be fixed or
 * extended without shipping a build. The copy is cached next to the config and
 * refreshed at most once every six hours.
 */
import type { ErrorEntry } from '../shared/api';

export type { ErrorEntry };

const SOURCE = 'https://raw.githubusercontent.com/dnbdj/Prime-client/main/docs/error-codes.json';
const CACHE_TTL = 6 * 60 * 60 * 1000;

function cachePath(): string {
  return join(app.getPath('userData'), 'error-codes.json');
}

let catalog: ErrorEntry[] | null = null;
let fetchedAt = 0;

function readCache(): ErrorEntry[] | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (entry): entry is ErrorEntry =>
        Boolean(entry) && typeof (entry as ErrorEntry).code === 'string',
    );
  } catch {
    return null;
  }
}

export async function loadCatalog(force = false): Promise<ErrorEntry[]> {
  if (!force && catalog && Date.now() - fetchedAt < CACHE_TTL) return catalog;

  if (!force) {
    const cached = readCache();
    if (cached && cached.length > 0) {
      catalog = cached;
      // Treat the cache as fresh enough to skip a network round trip this run.
      fetchedAt = Date.now() - CACHE_TTL + 60_000;
      return catalog;
    }
  }

  try {
    const response = await fetch(SOURCE, {
      headers: { Accept: 'application/json', 'User-Agent': 'PrimeLauncher' },
    });
    if (!response.ok) return catalog ?? [];
    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed)) return catalog ?? [];
    catalog = parsed.filter(
      (entry): entry is ErrorEntry =>
        Boolean(entry) && typeof (entry as ErrorEntry).code === 'string',
    );
    fetchedAt = Date.now();
    try {
      mkdirSync(dirname(cachePath()), { recursive: true });
      writeFileSync(cachePath(), JSON.stringify(catalog, null, 2), 'utf8');
    } catch {
      // A read-only profile still uses the in-memory copy.
    }
    return catalog;
  } catch {
    return catalog ?? [];
  }
}

/** Most specific patterns first: a message can match more than one rule. */
const RULES: { pattern: RegExp; code: string }[] = [
  { pattern: /Unknown Minecraft version/i, code: 'PRM-001' },
  { pattern: /checksum|sha-?1/i, code: 'PRM-003' },
  { pattern: /already running/i, code: 'PRM-011' },
  { pattern: /inherits too deeply/i, code: 'PRM-012' },
  { pattern: /duplicate ASM/i, code: 'PRM-016' },
  { pattern: /mixin/i, code: 'PRM-015' },
  { pattern: /ClassNotFoundException|Class not found/i, code: 'PRM-014' },
  { pattern: /needs Java|requires Java|Java \d+\+/i, code: 'PRM-022' },
  { pattern: /not a Java executable|Java path/i, code: 'PRM-023' },
  { pattern: /runtime.*download|download.*runtime/i, code: 'PRM-024' },
  { pattern: /OutOfMemory|heap/i, code: 'PRM-027' },
  { pattern: /signed out/i, code: 'PRM-031' },
  { pattern: /no Xbox profile/i, code: 'PRM-032' },
  { pattern: /family group/i, code: 'PRM-033' },
  { pattern: /doesn'?t own Minecraft|does not own/i, code: 'PRM-034' },
  { pattern: /blocked this sign-in|first party application/i, code: 'PRM-035' },
  { pattern: /code expired/i, code: 'PRM-036' },
  { pattern: /declined/i, code: 'PRM-037' },
  { pattern: /session expired|refresh token/i, code: 'PRM-038' },
  { pattern: /CurseForge.*key|API key/i, code: 'PRM-052' },
  { pattern: /No compatible Modrinth|No downloadable CurseForge/i, code: 'PRM-051' },
  { pattern: /BTA mods come from/i, code: 'PRM-058' },
  { pattern: /GitHub returned HTTP|GitHub did not answer/i, code: 'PRM-071' },
  { pattern: /update feed/i, code: 'PRM-080' },
  { pattern: /no space|not enough (free )?space|disk full/i, code: 'PRM-008' },
  { pattern: /EACCES|EPERM|permission denied/i, code: 'PRM-009' },
  { pattern: /timed out|timeout/i, code: 'PRM-045' },
  { pattern: /Couldn't reach|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i, code: 'PRM-041' },
];

export function codeFor(message: string): string | null {
  for (const rule of RULES) if (rule.pattern.test(message)) return rule.code;
  return null;
}

/** Adds the matching code and its fix, so the message explains itself. */
export function withCode(message: string): string {
  const code = codeFor(message);
  if (!code) return message;
  if (message.includes(code)) return message;
  const entry = catalog?.find((candidate) => candidate.code === code);
  return entry ? `${message} [${entry.code} — ${entry.fix}]` : `${message} [${code}]`;
}

export function lookupError(code: string): ErrorEntry | null {
  if (!catalog) return null;
  return catalog.find((entry) => entry.code === code) ?? null;
}
