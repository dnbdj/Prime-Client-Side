import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DeviceCode,
  JavaCandidate,
  JavaCheckResult,
  LaunchResult,
  LoaderInstallResult,
  MinecraftAccount,
  PrimeApi,
  PrimeConfig,
  ProgressEvent,
  SignInPoll,
  UpdateStatus,
  VersionSummary,
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
  listJava: () => ipcRenderer.invoke('prime:java:list') as Promise<JavaCandidate[]>,
  checkJava: (path) => ipcRenderer.invoke('prime:java:check', path) as Promise<JavaCheckResult>,
  launch: (versionId) => ipcRenderer.invoke('prime:launch', versionId) as Promise<LaunchResult>,
  installLoader: (kind, gameVersion) =>
    ipcRenderer.invoke('prime:loader:install', kind, gameVersion) as Promise<LoaderInstallResult>,
  kill: () => ipcRenderer.invoke('prime:kill') as Promise<boolean>,
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
  onProgress: (cb) => subscribe<ProgressEvent>('prime:progress', cb),
  onLog: (cb) => subscribe<string>('prime:log', cb),
  onExit: (cb) => subscribe<number | null>('prime:exit', cb),
};

contextBridge.exposeInMainWorld('prime', api);
