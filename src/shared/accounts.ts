import type { AccountEntry, PrimeConfig } from './api';

/** Offline ids stay stable for a name so a rename does not orphan the record. */
export function offlineAccountId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `offline:${slug || 'player'}`;
}

export function microsoftAccountId(uuid: string): string {
  return `ms:${uuid}`;
}

/**
 * Cleans the account list and guarantees an active one. Older configs only had
 * `username`, so the first offline account is seeded from it.
 */
export function normalizeAccounts(
  config: Pick<PrimeConfig, 'accounts' | 'activeAccountId' | 'username'>,
): { accounts: AccountEntry[]; activeAccountId: string | null } {
  const accounts: AccountEntry[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(config.accounts) ? config.accounts : []) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const name =
      typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : 'Player';
    accounts.push({
      id: raw.id,
      kind: raw.kind === 'microsoft' ? 'microsoft' : 'offline',
      name,
      uuid: typeof raw.uuid === 'string' && raw.uuid.length > 0 ? raw.uuid : null,
    });
  }

  if (accounts.length === 0) {
    const name = (config.username ?? '').trim() || 'Player';
    accounts.push({ id: offlineAccountId(name), kind: 'offline', name, uuid: null });
  }

  const activeAccountId =
    typeof config.activeAccountId === 'string' &&
    accounts.some((entry) => entry.id === config.activeAccountId)
      ? config.activeAccountId
      : accounts[0].id;

  return { accounts, activeAccountId };
}
