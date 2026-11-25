export type VersionSummary = {
  id: string;
  type: string;
  releaseTime: string;
  /** 'fabric' or 'forge' for loader profiles Prime installed. */
  loader?: 'fabric' | 'forge';
};

export type LoaderKind = 'fabric' | 'forge';

export type LoaderInstallResult = {
  ok: boolean;
  error?: string;
  versionId?: string;
};

export type PrimeConfig = {
  /** Offline-mode player name used for the ${auth_player_name} argument. */
  username: string;
  ramMb: number;
  /** Global JVM flags, used when a version has no override of its own. */
  jvmArgs: string;
  /** Per-version JVM flag overrides, keyed by Minecraft version id. */
  versionJvmArgs: Record<string, string>;
  /** Quit the launcher once the game process has started. */
  closeOnLaunch: boolean;
  /** JSON update feed URL, or null when updates are not configured. */
  updateFeed: string | null;
  /** Explicit Java executable, or null to auto-detect. */
  javaPath: string | null;
  /** Override for the working directory Minecraft runs in. */
  gameDir: string | null;
  /** Last selected version id. */
  versionId: string | null;
  /** Instances that were actually played, newest first. */
  recent: RecentInstance[];
};

export type RecentInstance = {
  versionId: string;
  playedAt: string;
};

export type ProgressEvent = {
  phase: 'meta' | 'java' | 'files' | 'assets' | 'loader' | 'launch';
  current: number;
  total: number;
  label: string;
};

export type JavaCandidate = {
  path: string;
  major: number;
};

export type JavaCheckResult = {
  ok: boolean;
  major?: number;
  error?: string;
};

export type LaunchResult = {
  ok: boolean;
  error?: string;
  pid?: number;
  /** Path of this session's log file. */
  logPath?: string;
};

/** A signed-in Microsoft account that owns Minecraft: Java Edition. */
export type MinecraftAccount = {
  uuid: string;
  name: string;
  skinUrl: string | null;
};

/** One step of the Microsoft device-code sign-in flow. */
export type DeviceCode = {
  userCode: string;
  verificationUri: string;
  message: string;
  /** Seconds the code stays valid for. */
  expiresIn: number;
  /** Seconds to wait between polling attempts. */
  interval: number;
};

export type SignInPoll = {
  status: 'pending' | 'done' | 'error';
  error?: string;
  account?: MinecraftAccount;
};

export type UpdateStatus =
  | { status: 'unconfigured' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string; url: string | null; notes: string | null }
  | { status: 'error'; error: string };

export type PrimeApi = {
  getConfig(): Promise<PrimeConfig>;
  setConfig(patch: Partial<PrimeConfig>): Promise<PrimeConfig>;
  listVersions(): Promise<VersionSummary[]>;
  listJava(): Promise<JavaCandidate[]>;
  checkJava(path: string): Promise<JavaCheckResult>;
  launch(versionId: string): Promise<LaunchResult>;
  installLoader(kind: LoaderKind, gameVersion: string): Promise<LoaderInstallResult>;
  kill(): Promise<boolean>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  defaultGameDir(): Promise<string>;
  getAccount(): Promise<MinecraftAccount | null>;
  startSignIn(): Promise<DeviceCode>;
  pollSignIn(): Promise<SignInPoll>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  appVersion(): Promise<string>;
  checkUpdates(): Promise<UpdateStatus>;
  onProgress(cb: (event: ProgressEvent) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
};
