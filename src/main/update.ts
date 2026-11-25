import type { UpdateStatus } from '../shared/api';

/**
 * A feed is a small JSON document at a URL the user configures:
 *
 *   { "version": "0.2.0", "url": "https://example.com/prime-0.2.0.exe", "notes": "…" }
 *
 * Nothing is fabricated: with no feed Prime reports that no updates are
 * configured instead of inventing a release server.
 */
type Feed = {
  version?: unknown;
  url?: unknown;
  notes?: unknown;
};

function segments(value: string): number[] {
  return value
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

export function isNewer(candidate: string, current: string): boolean {
  const a = segments(candidate);
  const b = segments(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

const TIMEOUT_MS = 8000;

/** Releases live on this project's GitHub; a custom feed still wins if set. */
export const RELEASE_REPO = 'dnbdj/Prime-client';

type GithubRelease = {
  tag_name?: unknown;
  body?: unknown;
  html_url?: unknown;
  assets?: { name?: unknown; browser_download_url?: unknown }[];
};

async function checkGithub(currentVersion: string): Promise<UpdateStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `PrimeLauncher/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'error', error: `GitHub returned HTTP ${response.status}.` };
    }

    const release = (await response.json()) as GithubRelease;
    const version =
      typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/i, '').trim() : '';
    if (version.length === 0) {
      return { status: 'error', error: 'The latest GitHub release has no tag.' };
    }
    if (!isNewer(version, currentVersion)) return { status: 'current', version };

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((entry) => /\.(exe|zip)$/i.test(String(entry.name ?? '')));
    return {
      status: 'available',
      version,
      url: typeof release.html_url === 'string' ? release.html_url : null,
      notes: typeof release.body === 'string' ? release.body : null,
      assetUrl:
        typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null,
      assetName: typeof asset?.name === 'string' ? asset.name : null,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { status: 'error', error: 'GitHub did not answer within 8 seconds.' };
    }
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdates(
  feedUrl: string | null,
  currentVersion: string,
): Promise<UpdateStatus> {
  const url = (feedUrl ?? '').trim();
  if (url.length === 0) return checkGithub(currentVersion);
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'error', error: 'That update feed is not an http(s) URL.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': `PrimeLauncher/${currentVersion}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'error', error: `Update feed returned HTTP ${response.status}.` };
    }

    const feed = (await response.json()) as Feed;
    const version = typeof feed.version === 'string' ? feed.version.trim() : '';
    if (version.length === 0) {
      return { status: 'error', error: 'Update feed has no "version" field.' };
    }
    if (!isNewer(version, currentVersion)) return { status: 'current', version };

    return {
      status: 'available',
      version,
      url: typeof feed.url === 'string' ? feed.url : null,
      notes: typeof feed.notes === 'string' ? feed.notes : null,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { status: 'error', error: 'Update check timed out after 8 seconds.' };
    }
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
