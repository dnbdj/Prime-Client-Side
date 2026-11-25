import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { JavaCandidate, JavaCheckResult } from '../shared/api';

const JAVA_BIN = process.platform === 'win32' ? 'javaw.exe' : 'java';

function probe(candidate: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(candidate, ['-version'], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      const output = `${stdout}\n${stderr}`;
      const match = output.match(/version "(?:1\.)?(\d+)/);
      if (!match) return resolve(null);
      resolve(Number(match[1]));
    });
  });
}

async function walkForJava(root: string, depth: number, out: Set<string>): Promise<void> {
  if (!root || !existsSync(root)) return;
  let level = [root];
  for (let d = 0; d < depth && level.length > 0; d += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === JAVA_BIN.toLowerCase()) out.add(full);
        else if (entry.isDirectory()) next.push(full);
      }
    }
    level = next;
  }
}

async function collectCandidates(): Promise<Set<string>> {
  const found = new Set<string>();

  if (process.env.JAVA_HOME) found.add(join(process.env.JAVA_HOME, 'bin', JAVA_BIN));

  // Runtimes bundled by the vanilla launcher are the most reliable matches.
  const appData = process.env.APPDATA;
  const runtimeRoots = [join(homedir(), '.minecraft', 'runtime')];
  if (appData) runtimeRoots.push(join(appData, '.minecraft', 'runtime'));
  for (const root of runtimeRoots) await walkForJava(root, 5, found);

  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Eclipse Foundation',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Semeru',
      'C:\\Program Files\\AdoptOpenJDK',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : '',
    ];
    for (const root of roots) await walkForJava(root, 4, found);
  } else if (process.platform === 'darwin') {
    await walkForJava('/Library/Java/JavaVirtualMachines', 5, found);
    await walkForJava(join(homedir(), 'Library/Java/JavaVirtualMachines'), 5, found);
  } else {
    for (const root of ['/usr/lib/jvm', '/usr/java', '/opt/java']) await walkForJava(root, 4, found);
  }

  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH ?? '').split(separator)) {
    if (dir) found.add(join(dir, JAVA_BIN));
  }

  return found;
}

export async function discoverJava(): Promise<JavaCandidate[]> {
  const candidates = [...(await collectCandidates())].filter((path) => existsSync(path));
  const results: JavaCandidate[] = [];
  const seen = new Set<string>();

  const chunkSize = 8;
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const probed = await Promise.all(
      chunk.map(async (path) => ({ path, major: await probe(path) })),
    );
    for (const item of probed) {
      if (item.major === null) continue;
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      results.push({ path: item.path, major: item.major });
    }
  }

  return results.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
}

/** javaw.exe hides stdout, which we need for the live console. */
export function toConsoleJava(path: string): string {
  if (process.platform !== 'win32') return path;
  if (basename(path).toLowerCase() !== 'javaw.exe') return path;
  const sibling = join(dirname(path), 'java.exe');
  return existsSync(sibling) ? sibling : path;
}

export async function verifyJava(path: string): Promise<JavaCheckResult> {
  if (!existsSync(path)) return { ok: false, error: `No file at ${path}` };
  const major = await probe(path);
  if (major === null) return { ok: false, error: 'That executable did not report a Java version.' };
  return { ok: true, major };
}

export async function resolveJava(preferred: string | null, requiredMajor: number): Promise<string> {
  if (preferred) {
    if (!existsSync(preferred)) throw new Error(`Configured Java not found: ${preferred}`);
    return toConsoleJava(preferred);
  }

  const found = await discoverJava();
  if (found.length === 0) {
    throw new Error(`No Java runtime found. Install Java ${requiredMajor} and restart Prime.`);
  }

  const exact = found.find((c) => c.major === requiredMajor);
  if (exact) return toConsoleJava(exact.path);

  const newer = found
    .filter((c) => c.major > requiredMajor)
    .sort((a, b) => a.major - b.major)[0];
  if (newer) return toConsoleJava(newer.path);

  throw new Error(
    `This version needs Java ${requiredMajor}+. Found only: ${found.map((c) => c.major).join(', ')}. Set a Java path in Settings.`,
  );
}
