import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  InstanceLoader,
  ModProvider,
  ModSearchResult,
} from '../shared/api';

const USER_AGENT = 'prime-client/0.1 (Minecraft launcher; mod picker)';
const MODRINTH = 'https://api.modrinth.com/v2';
const CURSEFORGE = 'https://api.curseforge.com/v1';

const CF_LOADER: Partial<Record<InstanceLoader, number>> = { forge: 1, fabric: 4, quilt: 4 };

/** Loaders both mod platforms know by name. */
function modLoaderName(loader: InstanceLoader): 'fabric' | 'forge' | 'quilt' | null {
  return loader === 'fabric' || loader === 'forge' || loader === 'quilt' ? loader : null;
}

const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** fetch with a deadline, so a stalled provider cannot spin forever in the UI. */
async function request(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timed? ?out/i.test(message)) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s contacting ${url.hostname}.`);
    }
    throw new Error(`Could not reach ${url.hostname}: ${message}`);
  }
}

async function getJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
  const response = await request(
    url,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers } },
    REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403 ? ' (check the API key)' : '';
    throw new Error(`${response.status} ${response.statusText} from ${url.hostname}${detail}`);
  }
  return (await response.json()) as T;
}

function safeJarName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const file = basename(name).trim();
  if (!file || !/\.(jar|zip)$/i.test(file)) return null;
  return file;
}

/** Only the two CDNs these APIs actually serve mod jars from. */
function downloadHostAllowed(provider: ModProvider, url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  return provider === 'modrinth'
    ? url.hostname === 'cdn.modrinth.com'
    : url.hostname === 'edge.forgecdn.net' || url.hostname === 'mediafilez.forgecdn.net';
}

type ModrinthHit = {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  icon_url: string | null;
};

async function searchModrinth(
  query: string,
  gameVersion: string,
  loader: InstanceLoader,
): Promise<ModSearchResult[]> {
  const url = new URL(`${MODRINTH}/search`);
  if (query.trim()) url.searchParams.set('query', query.trim());
  url.searchParams.set('limit', '20');
  const facets: string[][] = [['project_type:mod']];
  const loaderName = modLoaderName(loader);
  if (loaderName) facets.push([`categories:${loaderName}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  url.searchParams.set('facets', JSON.stringify(facets));

  const body = await getJson<{ hits: ModrinthHit[] }>(url);
  return (body.hits ?? []).map((hit) => ({
    provider: 'modrinth' as const,
    id: hit.project_id,
    name: hit.title,
    summary: hit.description,
    author: hit.author,
    downloads: hit.downloads,
    iconUrl: hit.icon_url ?? null,
    url: `https://modrinth.com/mod/${hit.slug}`,
  }));
}

type ModrinthVersion = {
  date_published: string;
  files: { url: string; filename: string; primary: boolean }[];
};

async function installModrinth(
  projectId: string,
  modsDir: string,
  gameVersion: string,
  loader: InstanceLoader,
): Promise<string> {
  const url = new URL(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version`);
  const loaderName = modLoaderName(loader);
  if (loaderName) {
    url.searchParams.set('loaders', JSON.stringify([loaderName]));
  }
  if (gameVersion) url.searchParams.set('game_versions', JSON.stringify([gameVersion]));

  const versions = await getJson<ModrinthVersion[]>(url);
  const ordered = [...versions].sort((a, b) => b.date_published.localeCompare(a.date_published));
  for (const version of ordered) {
    const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
    if (!file) continue;
    const filename = safeJarName(file.filename);
    const download = new URL(file.url);
    if (!filename || !downloadHostAllowed('modrinth', download)) continue;

    const response = await request(
      download,
      { headers: { 'User-Agent': USER_AGENT } },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok) continue;
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(join(modsDir, filename), Buffer.from(await response.arrayBuffer()));
    return filename;
  }
  throw new Error('No compatible Modrinth file available for this version and loader.');
}

type CurseForgeMod = {
  id: number;
  name: string;
  summary: string;
  downloadCount: number;
  authors?: { name: string }[];
  logo?: { thumbnailUrl?: string } | null;
  links?: { websiteUrl?: string | null } | null;
};

async function searchCurseforge(
  key: string,
  query: string,
  gameVersion: string,
  loader: InstanceLoader,
): Promise<ModSearchResult[]> {
  const url = new URL(`${CURSEFORGE}/mods/search`);
  url.searchParams.set('gameId', '432');
  url.searchParams.set('classId', '6');
  url.searchParams.set('sortField', '2');
  url.searchParams.set('sortOrder', 'desc');
  url.searchParams.set('pageSize', '20');
  if (query.trim()) url.searchParams.set('searchFilter', query.trim());
  if (gameVersion) url.searchParams.set('gameVersion', gameVersion);
  const loaderType = CF_LOADER[loader];
  if (loaderType) url.searchParams.set('modLoaderType', String(loaderType));

  const body = await getJson<{ data: CurseForgeMod[] }>(url, { 'x-api-key': key });
  return (body.data ?? []).map((mod) => ({
    provider: 'curseforge' as const,
    id: String(mod.id),
    name: mod.name,
    summary: mod.summary,
    author: mod.authors?.[0]?.name ?? '',
    downloads: mod.downloadCount,
    iconUrl: mod.logo?.thumbnailUrl ?? null,
    url: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${mod.id}`,
  }));
}

type CurseForgeFile = {
  fileName: string;
  fileDate: string;
  downloadUrl: string | null;
};

async function installCurseforge(
  key: string,
  projectId: string,
  modsDir: string,
  gameVersion: string,
  loader: InstanceLoader,
): Promise<string> {
  const url = new URL(`${CURSEFORGE}/mods/${encodeURIComponent(projectId)}/files`);
  url.searchParams.set('pageSize', '50');
  if (gameVersion) url.searchParams.set('gameVersion', gameVersion);
  const loaderType = CF_LOADER[loader];
  if (loaderType) url.searchParams.set('modLoaderType', String(loaderType));

  const body = await getJson<{ data: CurseForgeFile[] }>(url, { 'x-api-key': key });
  const ordered = [...(body.data ?? [])].sort((a, b) => b.fileDate.localeCompare(a.fileDate));
  for (const file of ordered) {
    const filename = safeJarName(file.fileName);
    if (!filename || !file.downloadUrl) continue;
    const download = new URL(file.downloadUrl);
    if (!downloadHostAllowed('curseforge', download)) continue;

    const response = await request(
      download,
      { headers: { 'User-Agent': USER_AGENT } },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok) continue;
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(join(modsDir, filename), Buffer.from(await response.arrayBuffer()));
    return filename;
  }
  throw new Error('No downloadable CurseForge file available for this version and loader.');
}

export async function searchMods(
  provider: ModProvider,
  query: string,
  gameVersion: string,
  loader: InstanceLoader,
  curseForgeKey: string | null,
): Promise<ModSearchResult[]> {
  if (provider === 'curseforge') {
    if (!curseForgeKey) {
      throw new Error(
        'CurseForge needs an API key. Add one in Settings → Game → Mod picker.',
      );
    }
    return searchCurseforge(curseForgeKey, query, gameVersion, loader);
  }
  return searchModrinth(query, gameVersion, loader);
}

export async function installMod(
  provider: ModProvider,
  projectId: string,
  modsDir: string,
  gameVersion: string,
  loader: InstanceLoader,
  curseForgeKey: string | null,
): Promise<string> {
  if (provider === 'curseforge') {
    if (!curseForgeKey) {
      throw new Error(
        'CurseForge needs an API key. Add one in Settings → Game → Mod picker.',
      );
    }
    return installCurseforge(curseForgeKey, projectId, modsDir, gameVersion, loader);
  }
  return installModrinth(projectId, modsDir, gameVersion, loader);
}
