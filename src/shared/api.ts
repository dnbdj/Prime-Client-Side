export type VersionSummary = {
  id: string;
  type: string;
  releaseTime: string;
  /** Loader profile Prime installed, when this entry is one. */
  loader?: LoaderKind;
};

export type LoaderKind =
  | 'fabric'
  | 'forge'
  | 'quilt'
  | 'legacyfabric'
  | 'neoforge'
  | 'liteloader'
  | 'babric'
  | 'ornithe'
  | 'nilloader'
  | 'bta'
  | 'modloader'
  | 'rift'
  | 'java-agent';

/** How an instance was started: the plain game, a mod loader, or a modpack. */
export type InstanceLoader = 'vanilla' | LoaderKind | 'modpack';

export type InstanceContent = {
  /** The game itself; always true. */
  vanilla: boolean;
  mods: boolean;
  primeMod: boolean;
};

/** A named instance on the Instances page. */
export type InstanceEntry = {
  /** Stable instance identity; two instances may share a Minecraft version. */
  id: string;
  versionId: string;
  name: string;
  /** Card accent colour, hex. */
  color: string;
  loader: InstanceLoader;
  content: InstanceContent;
  createdAt: string;
  /**
   * This instance's own game directory. Instances that predate per-instance
   * folders keep pointing at the old shared directory so their saves and
   * options stay where they were.
   */
  gameDir?: string;
};

export type LoaderInstallResult = {
  ok: boolean;
  error?: string;
  versionId?: string;
};

export type ModProvider = 'modrinth' | 'curseforge';

/** One project returned by the in-app mod picker. */
export type ModSearchResult = {
  provider: ModProvider;
  id: string;
  name: string;
  summary: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  url: string;
};

export type ModSearchResponse = {
  ok: boolean;
  results: ModSearchResult[];
  error?: string;
};

export type ModInstallResult = {
  ok: boolean;
  error?: string;
  file?: ModFile;
};

export type InstanceDeleteResult = {
  config: PrimeConfig;
  folderDeleted: boolean;
  error?: string;
};

/** A jar sitting in the game folder's mods directory. */
export type ModFile = {
  name: string;
  size: number;
};

/** What the launcher window does once a game process is running. */
export type AfterLaunch = 'keep' | 'minimise' | 'close';

export type PrimeConfig = {
  /** Offline-mode player name used for the ${auth_player_name} argument. */
  username: string;
  /** Every account the launcher can switch to; always at least one offline. */
  accounts: AccountEntry[];
  /** Id of the account launches use. */
  activeAccountId: string | null;
  ramMb: number;
  /** Global JVM flags, used when a version has no override of its own. */
  jvmArgs: string;
  /** Per-version JVM flag overrides, keyed by Minecraft version id. */
  versionJvmArgs: Record<string, string>;
  /** What the launcher window does once the game has started. */
  afterLaunch: AfterLaunch;
  /** JSON update feed URL, or null to check this project's GitHub releases. */
  updateFeed: string | null;
  /** Release the user chose to skip, so it is not offered again. */
  skippedUpdateVersion: string | null;
  /** Explicit Java executable, or null to auto-detect. */
  javaPath: string | null;
  /** Override for the working directory Minecraft runs in. */
  gameDir: string | null;
  /** Last selected version id. */
  versionId: string | null;
  /** Instance records, newest first. */
  instances: InstanceEntry[];
  /** Instances that were actually played, newest first. */
  recent: RecentInstance[];
  /** Optional CurseForge API key for the in-app mod picker. */
  curseForgeApiKey: string | null;
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

/** One entry of the error-code catalog stored in the repository. */
export type ErrorEntry = {
  code: string;
  area: string;
  title: string;
  message: string;
  fix: string;
};

/** One selectable account: an offline name or a signed-in Microsoft account. */
export type AccountEntry = {
  /** Stable id: offline:<slug> or ms:<uuid>. */
  id: string;
  kind: 'offline' | 'microsoft';
  name: string;
  /** Microsoft accounts only; offline accounts derive theirs from the name. */
  uuid: string | null;
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
  /** Account id the finished sign-in was stored under. */
  accountId?: string;
};

/** State of the Windows scheduled task that runs the Wi-Fi watcher. */
export type WatcherStatus = {
  /** Scheduled tasks only exist on Windows. */
  supported: boolean;
  installed: boolean;
  taskName: string;
  /** Minutes between checks while the task is registered. */
  intervalMinutes: number;
  scriptPath: string;
  nodePath: string | null;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  logPath: string;
  lastLogLine: string | null;
  error?: string;
};

export type UpdateStatus =
  | { status: 'unconfigured' }
  | { status: 'current'; version: string }
  | {
      status: 'available';
      version: string;
      url: string | null;
      notes: string | null;
      /** Direct download of the newest release asset, when it has one. */
      assetUrl?: string | null;
      assetName?: string | null;
    }
  | { status: 'error'; error: string };

export type PrimeApi = {
  getConfig(): Promise<PrimeConfig>;
  setConfig(patch: Partial<PrimeConfig>): Promise<PrimeConfig>;
  listVersions(): Promise<VersionSummary[]>;
  /** BTA's own build list; these ids are never in the Minecraft manifest. */
  btaVersions(): Promise<VersionSummary[]>;
  listJava(): Promise<JavaCandidate[]>;
  checkJava(path: string): Promise<JavaCheckResult>;
  launch(versionId: string, instanceId?: string): Promise<LaunchResult>;
  /** Java Agent installs take a local agent jar; the other loaders ignore it. */
  installLoader(
    kind: LoaderKind,
    gameVersion: string,
    agentJar?: string,
  ): Promise<LoaderInstallResult>;
  /** File picker for a JVM agent jar. */
  pickAgent(): Promise<string | null>;
  /** File picker for mod jars chosen while an instance is being set up. */
  pickMods(): Promise<string[]>;
  kill(): Promise<boolean>;
  instanceDir(instanceId: string, versionId: string): Promise<string>;
  listMods(instanceId: string, versionId: string): Promise<ModFile[]>;
  addMods(instanceId: string, versionId: string): Promise<ModFile[]>;
  /** Copies jars from explicit paths; the UI dialog and tests both land here. */
  addModsFrom(instanceId: string, versionId: string, paths: string[]): Promise<ModFile[]>;
  /** Searches Modrinth or CurseForge for mods matching this instance. */
  searchMods(
    provider: ModProvider,
    query: string,
    gameVersion: string,
    loader: InstanceLoader,
  ): Promise<ModSearchResponse>;
  /** Downloads the newest compatible file straight into the instance's mods folder. */
  installMod(
    provider: ModProvider,
    projectId: string,
    instanceId: string,
    versionId: string,
  ): Promise<ModInstallResult>;
  /** Removes the record (and optionally its own game folder). */
  deleteInstance(instanceId: string, versionId: string, deleteFolder: boolean): Promise<InstanceDeleteResult>;
  removeMod(instanceId: string, versionId: string, name: string): Promise<ModFile[]>;
  modsDir(instanceId: string, versionId: string): Promise<string>;
  openMods(instanceId: string, versionId: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  defaultGameDir(): Promise<string>;
  getAccount(): Promise<MinecraftAccount | null>;
  startSignIn(): Promise<DeviceCode>;
  pollSignIn(): Promise<SignInPoll>;
  cancelSignIn(): Promise<void>;
  /** Drops the stored tokens for one account (or the active one). */
  signOut(accountId?: string): Promise<void>;
  /** Error-code catalog published in the repository. */
  errorCatalog(): Promise<ErrorEntry[]>;
  lookupError(code: string): Promise<ErrorEntry | null>;
  appVersion(): Promise<string>;
  checkUpdates(): Promise<UpdateStatus>;
  /** Downloads the release asset, replaces the app folder and relaunches. */
  installUpdate(assetUrl: string, version: string): Promise<{ ok: boolean; error?: string }>;
  onUpdateProgress(cb: (percent: number) => void): () => void;
  watcherStatus(): Promise<WatcherStatus>;
  /** Registers the watcher with the Windows Task Scheduler. */
  scheduleWatcher(): Promise<WatcherStatus>;
  unscheduleWatcher(): Promise<WatcherStatus>;
  onProgress(cb: (event: ProgressEvent) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
};
