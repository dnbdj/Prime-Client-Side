import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { JavaCandidate, JavaCheckResult } from '../shared/api';
import { downloadFile, fetchJson, mapLimit } from './net';

const JAVA_BIN = process.platform === 'win32' ? 'javaw.exe' : 'java';

/** Mojang's per-platform Java runtime catalog, keyed by version component. */
const RUNTIME_CATALOG =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

type RuntimeFile = {
  type: 'file' | 'directory' | 'link';
  downloads?: { raw?: { url: string; sha1: string; size: number } };
  target?: string;
};

type RuntimeManifest = { files: Record<string, RuntimeFile> };

type Catalog = Record<
  string,
  Record<string, { manifest: { url: string; sha1: string; size: number } }[]>
>;

function runtimePlatform(): string {
  const arch = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `windows-${arch}`;
  if (process.platform === 'darwin') return `mac-os${arch === 'arm64' ? '-arm64' : ''}`;
  return `linux${arch === 'x86' ? '-i386' : ''}`;
}

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

export async function discoverJava(runtimeRoot?: string): Promise<JavaCandidate[]> {
  const candidates = new Set(await collectCandidates());
  if (runtimeRoot) await walkForJava(runtimeRoot, 4, candidates);
  const existing = [...candidates].filter((path) => existsSync(path));
  const results: JavaCandidate[] = [];
  const seen = new Set<string>();

  const chunkSize = 8;
  for (let i = 0; i < existing.length; i += chunkSize) {
    const chunk = existing.slice(i, i + chunkSize);
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

/**
 * Downloads the Mojang runtime named by a version's `javaVersion.component` into
 * `runtimeRoot/component` and returns its launcher executable. Restartable: files
 * already on disk are skipped, so a half-finished fetch simply continues.
 */
export async function installRuntime(
  component: string,
  runtimeRoot: string,
  progress?: (label: string, done: number, total: number) => void,
): Promise<string> {
  const platform = runtimePlatform();
  const target = join(runtimeRoot, component);
  const launcher = join(target, 'bin', JAVA_BIN);
  if (existsSync(launcher)) return launcher;

  progress?.(`Looking up Java runtime ${component}`, 0, 1);
  const catalog = await fetchJson<Catalog>(RUNTIME_CATALOG);
  const entry = catalog[platform]?.[component]?.[0]?.manifest?.url;
  if (!entry) throw new Error(`Mojang does not publish a ${component} runtime for ${platform}.`);

  const manifest = await fetchJson<RuntimeManifest>(entry);
  const files = Object.entries(manifest.files).filter(
    ([, file]) => file.type === 'file' && file.downloads?.raw,
  );

  let done = 0;
  progress?.(`Downloading Java ${component}`, 0, files.length);
  await mapLimit(files, 8, async ([relative, file]) => {
    const dest = join(target, relative);
    await fs.mkdir(dirname(dest), { recursive: true });
    if (!existsSync(dest) || (file.downloads?.raw?.size && (await fs.stat(dest)).size === 0)) {
      await downloadFile(file.downloads!.raw!.url, dest, file.downloads!.raw!.sha1);
    }
    done += 1;
    if (progress && (done % 10 === 0 || done === files.length)) {
      progress(`Java runtime ${done}/${files.length}`, done, files.length);
    }
  });

  if (!existsSync(launcher)) {
    throw new Error(`Downloaded ${component}, but ${launcher} is missing.`);
  }
  return launcher;
}

export type ResolveOptions = {
  /** Where auto-fetched runtimes are stored, e.g. <minecraftRoot>/runtimes. */
  runtimeRoot?: string;
  /** Mojang runtime component name from the version json. */
  component?: string;
  onProgress?: (label: string, done: number, total: number) => void;
};

export async function resolveJava(
  preferred: string | null,
  requiredMajor: number,
  options: ResolveOptions = {},
): Promise<string> {
  if (preferred) {
    if (!existsSync(preferred)) throw new Error(`Configured Java not found: ${preferred}`);
    return toConsoleJava(preferred);
  }

  const found = await discoverJava(options.runtimeRoot);
  const exact = found.find((c) => c.major === requiredMajor);
  if (exact) return toConsoleJava(exact.path);

  // Older versions break on newer JVMs, so fetch the runtime the version asks
  // for instead of silently using whatever happens to be installed.
  if (options.runtimeRoot && options.component) {
    try {
      const fetched = await installRuntime(
        options.component,
        options.runtimeRoot,
        options.onProgress,
      );
      const major = await probe(fetched);
      if (major !== null && major >= requiredMajor) return toConsoleJava(fetched);
    } catch (error) {
      options.onProgress?.(
        `Could not fetch Java ${requiredMajor}: ${error instanceof Error ? error.message : String(error)}`,
        1,
        1,
      );
    }
  }

  const newer = found
    .filter((c) => c.major > requiredMajor)
    .sort((a, b) => a.major - b.major)[0];
  if (newer) return toConsoleJava(newer.path);

  throw new Error(
    `This version needs Java ${requiredMajor}+. Found only: ${found.map((c) => c.major).join(', ')}. Set a Java path in Settings.`,
  );
}
