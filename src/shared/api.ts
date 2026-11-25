export type VersionSummary = {
  id: string;
  type: string;
  releaseTime: string;
};

export type PrimeConfig = {
  /** Offline-mode player name used for the ${auth_player_name} argument. */
  username: string;
  ramMb: number;
  /** Extra JVM flags, split on whitespace and placed before the classpath. */
  jvmArgs: string;
  /** Quit the launcher once the game process has started. */
  closeOnLaunch: boolean;
  /** Explicit Java executable, or null to auto-detect. */
  javaPath: string | null;
  /** Override for the working directory Minecraft runs in. */
  gameDir: string | null;
  /** Last selected version id. */
  versionId: string | null;
};

export type ProgressEvent = {
  phase: 'meta' | 'java' | 'files' | 'assets' | 'launch';
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

export type PrimeApi = {
  getConfig(): Promise<PrimeConfig>;
  setConfig(patch: Partial<PrimeConfig>): Promise<PrimeConfig>;
  listVersions(): Promise<VersionSummary[]>;
  listJava(): Promise<JavaCandidate[]>;
  checkJava(path: string): Promise<JavaCheckResult>;
  launch(versionId: string): Promise<LaunchResult>;
  kill(): Promise<boolean>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  defaultGameDir(): Promise<string>;
  getAccount(): Promise<MinecraftAccount | null>;
  startSignIn(): Promise<DeviceCode>;
  pollSignIn(): Promise<SignInPoll>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  onProgress(cb: (event: ProgressEvent) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
};
