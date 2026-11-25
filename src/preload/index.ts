import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DeviceCode,
  InstanceDeleteResult,
  JavaCandidate,
  JavaCheckResult,
  LaunchResult,
  LoaderInstallResult,
  MinecraftAccount,
  ModFile,
  ModInstallResult,
  ModSearchResponse,
  PrimeApi,
  PrimeConfig,
  ProgressEvent,
  SignInPoll,
  UpdateStatus,
  VersionSummary,
  WatcherStatus,
} from '../shared/api';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: PrimeApi = {
  getConfig: () => ipcRenderer.invoke('prime:config:get') as Promise<PrimeConfig>,
  setConfig: (patch) => ipcRenderer.invoke('prime:config:set', patch) as Promise<PrimeConfig>,
  listVersions: () => ipcRenderer.invoke('prime:versions') as Promise<VersionSummary[]>,
  btaVersions: () => ipcRenderer.invoke('prime:bta:versions') as Promise<VersionSummary[]>,
  listJava: () => ipcRenderer.invoke('prime:java:list') as Promise<JavaCandidate[]>,
  checkJava: (path) => ipcRenderer.invoke('prime:java:check', path) as Promise<JavaCheckResult>,
  launch: (versionId, instanceId) =>
    ipcRenderer.invoke('prime:launch', versionId, instanceId) as Promise<LaunchResult>,
  installLoader: (kind, gameVersion, agentJar) =>
    ipcRenderer.invoke(
      'prime:loader:install',
      kind,
      gameVersion,
      agentJar,
    ) as Promise<LoaderInstallResult>,
  pickAgent: () => ipcRenderer.invoke('prime:agent:pick') as Promise<string | null>,
  kill: () => ipcRenderer.invoke('prime:kill') as Promise<boolean>,
  instanceDir: (instanceId, versionId) =>
    ipcRenderer.invoke('prime:instance:dir', instanceId, versionId) as Promise<string>,
  listMods: (instanceId, versionId) =>
    ipcRenderer.invoke('prime:mods:list', instanceId, versionId) as Promise<ModFile[]>,
  addMods: (instanceId, versionId) =>
    ipcRenderer.invoke('prime:mods:add', instanceId, versionId) as Promise<ModFile[]>,
  addModsFrom: (instanceId, versionId, paths) =>
    ipcRenderer.invoke('prime:mods:addFrom', instanceId, versionId, paths) as Promise<ModFile[]>,
  searchMods: (provider, query, versionId, loader) =>
    ipcRenderer.invoke('prime:mods:search', provider, query, versionId, loader) as Promise<ModSearchResponse>,
  installMod: (provider, projectId, instanceId, versionId) =>
    ipcRenderer.invoke('prime:mods:install', provider, projectId, instanceId, versionId) as Promise<ModInstallResult>,
  deleteInstance: (instanceId, versionId, deleteFolder) =>
    ipcRenderer.invoke('prime:instance:delete', instanceId, versionId, deleteFolder) as Promise<InstanceDeleteResult>,
  removeMod: (instanceId, versionId, name) =>
    ipcRenderer.invoke('prime:mods:remove', instanceId, versionId, name) as Promise<ModFile[]>,
  modsDir: (instanceId, versionId) =>
    ipcRenderer.invoke('prime:mods:dir', instanceId, versionId) as Promise<string>,
  openMods: (instanceId, versionId) =>
    ipcRenderer.invoke('prime:mods:open', instanceId, versionId) as Promise<void>,
  openPath: (path) => ipcRenderer.invoke('prime:open', path) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('prime:external', url) as Promise<void>,
  defaultGameDir: () => ipcRenderer.invoke('prime:dir:default') as Promise<string>,
  getAccount: () => ipcRenderer.invoke('prime:auth:account') as Promise<MinecraftAccount | null>,
  startSignIn: () => ipcRenderer.invoke('prime:auth:start') as Promise<DeviceCode>,
  pollSignIn: () => ipcRenderer.invoke('prime:auth:poll') as Promise<SignInPoll>,
  cancelSignIn: () => ipcRenderer.invoke('prime:auth:cancel') as Promise<void>,
  signOut: () => ipcRenderer.invoke('prime:auth:signout') as Promise<void>,
  appVersion: () => ipcRenderer.invoke('prime:app:version') as Promise<string>,
  checkUpdates: () => ipcRenderer.invoke('prime:update:check') as Promise<UpdateStatus>,
  watcherStatus: () => ipcRenderer.invoke('prime:watcher:status') as Promise<WatcherStatus>,
  scheduleWatcher: () => ipcRenderer.invoke('prime:watcher:schedule') as Promise<WatcherStatus>,
  unscheduleWatcher: () => ipcRenderer.invoke('prime:watcher:unschedule') as Promise<WatcherStatus>,
  onProgress: (cb) => subscribe<ProgressEvent>('prime:progress', cb),
  onLog: (cb) => subscribe<string>('prime:log', cb),
  onExit: (cb) => subscribe<number | null>('prime:exit', cb),
};

contextBridge.exposeInMainWorld('prime', api);
