import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeviceCode, MinecraftAccount, SignInPoll } from '../shared/api';

/**
 * Public client that Microsoft keeps registered for device-code samples. It is
 * the only id that still accepts this flow without an Azure registration of our
 * own, and it needs no client secret — the user approves the code in a browser.
 */
const CLIENT_ID = '04f0c124-f2bc-4f59-8241-bf6df9866bbd';
const SCOPE = 'XboxLive.signin offline_access';
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

type Tokens = {
  refreshToken: string;
  /** Minecraft access token, the one the game itself needs. */
  accessToken: string;
  expiresAt: number;
  xuid: string;
  account: MinecraftAccount;
};

type DeviceFlow = {
  deviceCode: string;
  expiresAt: number;
};

let pending: DeviceFlow | null = null;

function authPath(): string {
  return join(app.getPath('userData'), 'accounts.json');
}

function read(): Tokens | null {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), 'utf8')) as Partial<Tokens>;
    if (!parsed.refreshToken || !parsed.account) return null;
    return parsed as Tokens;
  } catch {
    return null;
  }
}

function write(tokens: Tokens | null): void {
  mkdirSync(dirname(authPath()), { recursive: true });
  writeFileSync(authPath(), tokens ? JSON.stringify(tokens, null, 2) : '{}', 'utf8');
}

function networkError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Couldn't reach Microsoft's sign-in servers (${message}).`);
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw networkError(error);
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed as { error?: string; error_description?: string; Message?: string } | null;
    const reason =
      detail?.error_description ?? detail?.Message ?? detail?.error ?? `${response.status}`;
    throw new Error(reason);
  }
  return parsed as T;
}

async function postForm<T>(url: string, fields: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (error) {
    throw networkError(error);
  }
  return (await response.json()) as T;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

type XblResponse = {
  Token: string;
  DisplayClaims: { xui: Array<{ uhs: string }> };
};

type XstsResponse = {
  Token: string;
  DisplayClaims: { xui: Array<{ xid: string }> };
};

function formatUuid(raw: string): string {
  const hex = raw.replace(/-/g, '');
  if (hex.length !== 32) return raw;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Exchange a Microsoft access token for a Minecraft services token + profile. */
async function mintMinecraft(msAccessToken: string): Promise<Omit<Tokens, 'refreshToken'>> {
  const xbl = await postJson<XblResponse>('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  const uhs = xbl.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs) throw new Error('Microsoft returned an unexpected Xbox Live response.');

  let xsts: XstsResponse;
  try {
    xsts = await postJson<XstsResponse>('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('2148916233')) {
      throw new Error('That Microsoft account has no Xbox profile. Sign in at xbox.com once, then retry.');
    }
    if (message.includes('2148916238')) {
      throw new Error('That account is managed by a family group and needs an adult to approve it.');
    }
    throw error;
  }

  const login = await postJson<{ access_token: string; expires_in: number }>(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` },
  );

  let profileResponse: Response;
  try {
    profileResponse = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${login.access_token}`, Accept: 'application/json' },
    });
  } catch (error) {
    throw networkError(error);
  }

  if (profileResponse.status === 404) {
    throw new Error("That account doesn't own Minecraft: Java Edition.");
  }
  if (!profileResponse.ok) {
    throw new Error(`Minecraft profile lookup failed (${profileResponse.status}).`);
  }

  const profile = (await profileResponse.json()) as {
    id: string;
    name: string;
    skins?: Array<{ url?: string }>;
  };

  return {
    accessToken: login.access_token,
    expiresAt: Date.now() + login.expires_in * 1000,
    xuid: xsts.DisplayClaims?.xui?.[0]?.xid ?? '0',
    account: {
      uuid: formatUuid(profile.id),
      name: profile.name,
      skinUrl: profile.skins?.[0]?.url ?? null,
    },
  };
}

export function currentAccount(): MinecraftAccount | null {
  return read()?.account ?? null;
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  const code = await postForm<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    message: string;
  }>(`${AUTHORITY}/devicecode`, { client_id: CLIENT_ID, scope: SCOPE });

  pending = {
    deviceCode: code.device_code,
    expiresAt: Date.now() + code.expires_in * 1000,
  };

  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    message: code.message,
    expiresIn: code.expires_in,
    interval: Math.max(3, code.interval || 5),
  };
}

/** One poll of the device-code endpoint; the renderer calls this on a timer. */
export async function pollDeviceFlow(): Promise<SignInPoll> {
  if (!pending) return { status: 'error', error: 'No sign-in is in progress.' };
  if (Date.now() > pending.expiresAt) {
    pending = null;
    return { status: 'error', error: 'That code expired. Start the sign-in again.' };
  }

  const body = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: CLIENT_ID,
    device_code: pending.deviceCode,
  };

  let response: Response;
  try {
    response = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    return { status: 'error', error: networkError(error).message };
  }

  const payload = (await response.json()) as TokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
      return { status: 'pending' };
    }
    pending = null;
    const reason =
      payload.error === 'authorization_declined'
        ? 'Sign-in was declined.'
        : (payload.error_description ?? 'Microsoft rejected the sign-in.');
    return { status: 'error', error: reason };
  }

  pending = null;

  try {
    const minted = await mintMinecraft(payload.access_token);
    const tokens: Tokens = {
      refreshToken: payload.refresh_token ?? '',
      ...minted,
    };
    write(tokens);
    return { status: 'done', account: tokens.account };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

export function cancelDeviceFlow(): void {
  pending = null;
}

export async function signOut(): Promise<void> {
  pending = null;
  write(null);
}

export type LaunchAuth = {
  accessToken: string;
  uuid: string;
  xuid: string;
  name: string;
};

/**
 * Minecraft token for the game, refreshed when it is close to expiring. Returns
 * null when nobody is signed in, so the caller falls back to offline mode.
 */
export async function launchAuth(): Promise<LaunchAuth | null> {
  const stored = read();
  if (!stored) return null;

  const fresh =
    stored.expiresAt - Date.now() > 60_000 ? stored : await refresh(stored.refreshToken);
  return {
    accessToken: fresh.accessToken,
    uuid: fresh.account.uuid,
    xuid: fresh.xuid,
    name: fresh.account.name,
  };
}

async function refresh(refreshToken: string): Promise<Tokens> {
  if (!refreshToken) throw new Error('Your Microsoft session expired. Sign in again in Settings.');

  const payload = await postForm<TokenResponse & { error_description?: string }>(
    `${AUTHORITY}/token`,
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: SCOPE,
    },
  );

  if (!payload.access_token) throw new Error('Your Microsoft session expired. Sign in again in Settings.');

  const minted = await mintMinecraft(payload.access_token);
  const tokens: Tokens = {
    refreshToken: payload.refresh_token ?? refreshToken,
    ...minted,
  };
  write(tokens);
  return tokens;
}
