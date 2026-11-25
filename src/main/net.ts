import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';

const USER_AGENT = 'PrimeLauncher/0.1.0';

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Downloads `url` to `dest`, writing through a .part file so an interrupted
 * download can never leave a half-written jar in the library directory.
 */
export async function downloadFile(
  url: string,
  dest: string,
  expectedSha1?: string,
): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`GET ${url} failed with HTTP ${res.status}`);

  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = createHash('sha1');
  const out = createWriteStream(part);

  try {
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      stream.on('data', (chunk: Buffer) => hash.update(chunk));
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    });

    const actual = hash.digest('hex');
    if (expectedSha1 && expectedSha1.length === 40 && actual !== expectedSha1) {
      throw new Error(`Checksum mismatch for ${dest} (expected ${expectedSha1}, got ${actual})`);
    }
    await fs.rename(part, dest);
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function exists(path: string): boolean {
  return existsSync(path);
}
