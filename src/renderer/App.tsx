import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  JavaCandidate,
  MinecraftAccount,
  PrimeConfig,
  ProgressEvent,
  VersionSummary,
} from '../shared/api';
import { HomeIcon, SearchIcon, SettingsIcon, VersionsIcon } from './components/Icon';
import { HomeView } from './views/HomeView';
import { SettingsView } from './views/SettingsView';
import { VersionsView } from './views/VersionsView';

type View = 'home' | 'versions' | 'settings';

const NAV = [
  { id: 'home' as const, label: 'Home', Icon: HomeIcon },
  { id: 'versions' as const, label: 'Versions', Icon: VersionsIcon },
  { id: 'settings' as const, label: 'Settings', Icon: SettingsIcon },
];

const TITLES: Record<View, { title: string; subtitle: string }> = {
  home: { title: 'Home', subtitle: 'Pick a version and drop in' },
  versions: { title: 'Versions', subtitle: 'Every Minecraft release Prime can install' },
  settings: { title: 'Settings', subtitle: 'Stored locally on this machine' },
};

const MAX_LOG_LINES = 600;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return "Couldn't reach Mojang's servers. Check your connection, VPN or proxy, then reload.";
  }
  return message;
}

export function App() {
  const [view, setView] = useState<View>('home');
  const [filter, setFilter] = useState('');
  const [channel, setChannel] = useState<'release' | 'all'>('release');
  const [config, setConfig] = useState<PrimeConfig | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [java, setJava] = useState<JavaCandidate[]>([]);
  const [account, setAccount] = useState<MinecraftAccount | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  const appendLog = useCallback((line: string) => {
    setLogs((current) => {
      const next = [...current, line];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  const patchConfig = useCallback(async (patch: Partial<PrimeConfig>) => {
    setConfig((current) => (current ? { ...current, ...patch } : current));
    const saved = await window.prime.setConfig(patch);
    setConfig(saved);
  }, []);

  const setVersionJvmArgs = useCallback(
    (versionId: string, value: string) => {
      setConfig((current) => {
        if (!current) return current;
        const overrides = { ...current.versionJvmArgs };
        if (value.trim().length === 0) delete overrides[versionId];
        else overrides[versionId] = value;
        void patchConfig({ versionJvmArgs: overrides });
        return { ...current, versionJvmArgs: overrides };
      });
    },
    [patchConfig],
  );

  const loadVersions = useCallback(async () => {
    setLoadingVersions(true);
    try {
      setVersions(await window.prime.listVersions());
      setError(null);
    } catch (err) {
      setVersions([]);
      setError(describeError(err));
    } finally {
      setLoadingVersions(false);
    }
  }, []);

  const loadJava = useCallback(async () => {
    const detected = await window.prime.listJava().catch(() => [] as JavaCandidate[]);
    setJava(detected);
  }, []);

  useEffect(() => {
    // Config loads on its own so saved settings stay usable when the version
    // manifest cannot be reached.
    void window.prime
      .getConfig()
      .then(setConfig)
      .catch((err: unknown) => setError(describeError(err)));

    void loadVersions();
    void loadJava();
    void window.prime
      .getAccount()
      .then(setAccount)
      .catch(() => setAccount(null));

    const offProgress = window.prime.onProgress(setProgress);
    const offLog = window.prime.onLog(appendLog);
    const offExit = window.prime.onExit((code) => {
      setRunning(false);
      setProgress(null);
      appendLog(
        code === 0 ? '[prime] Session closed.' : `[prime] Session ended (exit ${code ?? 'unknown'}).`,
      );
    });

    return () => {
      offProgress();
      offLog();
      offExit();
    };
  }, [appendLog, loadJava, loadVersions]);

  useEffect(() => {
    if (!config || config.versionId || versions.length === 0) return;
    const latest = versions.find((version) => version.type === 'release');
    if (latest) void patchConfig({ versionId: latest.id });
  }, [config, patchConfig, versions]);

  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs, view]);

  const handleLaunch = useCallback(async () => {
    if (!config?.versionId || busy || running) return;
    setBusy(true);
    setError(null);
    setLogs([]);
    setProgress({ phase: 'meta', current: 0, total: 1, label: 'Preparing launch' });

    const result = await window.prime.launch(config.versionId);
    setBusy(false);

    if (!result.ok) {
      setProgress(null);
      setError(describeError(result.error ?? 'Launch failed.'));
      return;
    }
    setRunning(true);
    // The main process records the launch for the Recently played list.
    await window.prime
      .getConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, [busy, config?.versionId, running]);

  const handleStop = useCallback(async () => {
    await window.prime.kill();
    setRunning(false);
    setProgress(null);
  }, []);

  const handleInstallLoader = useCallback(
    async (kind: 'fabric' | 'forge') => {
      if (!config?.versionId || busy) return;
      setBusy(true);
      setError(null);
      setProgress({ phase: 'loader', current: 0, total: 1, label: `Installing ${kind}` });
      const result = await window.prime.installLoader(kind, config.versionId);
      setBusy(false);
      if (!result.ok) {
        setProgress(null);
        setError(describeError(result.error ?? 'Loader install failed.'));
        return;
      }
      await loadVersions();
      if (result.versionId) await patchConfig({ versionId: result.versionId });
      setProgress(null);
    },
    [busy, config?.versionId, loadVersions, patchConfig],
  );

  const selected = useMemo(
    () => versions.find((version) => version.id === config?.versionId) ?? null,
    [config?.versionId, versions],
  );

  const recentInstances = useMemo(() => {
    return (config?.recent ?? [])
      .map((entry) => {
        const version = versions.find((candidate) => candidate.id === entry.versionId);
        return version ? { version, playedAt: entry.playedAt } : null;
      })
      .filter((entry): entry is { version: VersionSummary; playedAt: string } => entry !== null)
      .slice(0, 5);
  }, [config?.recent, versions]);

  const displayName = account?.name ?? (config?.username || 'No account');

  const percent = useMemo(() => {
    if (!progress || progress.total <= 0) return 0;
    return Math.min(100, Math.round((progress.current / progress.total) * 100));
  }, [progress]);

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-logo" title="Prime">
          P
        </div>
        <nav className="rail-nav">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-current={view === id ? 'page' : undefined}
              className={view === id ? 'rail-btn active' : 'rail-btn'}
              onClick={() => setView(id)}
            >
              <Icon />
            </button>
          ))}
        </nav>
        <div className="rail-foot" title={displayName}>
          {displayName.slice(0, 1).toUpperCase()}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="page-title">
            <h1>{TITLES[view].title}</h1>
            <span>{TITLES[view].subtitle}</span>
          </div>

          <label className="search">
            <SearchIcon />
            <input
              value={filter}
              spellCheck={false}
              placeholder="Search versions"
              onChange={(event) => {
                setFilter(event.target.value);
                if (event.target.value.trim().length > 0) setView('versions');
              }}
            />
          </label>

          <div className="account">
            <span className="avatar" aria-hidden="true">
              {account?.skinUrl ? (
                <img src={account.skinUrl} alt="" />
              ) : (
                displayName.slice(0, 1).toUpperCase()
              )}
            </span>
            <div className="account-text">
              <strong>{displayName}</strong>
              <span>{running ? 'In game' : account ? 'Microsoft account' : 'Offline mode'}</span>
            </div>
          </div>
        </header>

        {error ? (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        <main className="content">
          {view === 'home' ? (
            <HomeView
              config={config}
              recent={recentInstances}
              selected={selected}
              progress={progress}
              percent={percent}
              logs={logs}
              busy={busy}
              running={running}
              consoleRef={consoleRef}
              onSelectVersion={(id) => void patchConfig({ versionId: id })}
              onUsername={(username) => void patchConfig({ username })}
              onBrowseAll={() => setView('versions')}
              onLaunch={() => void handleLaunch()}
              onStop={() => void handleStop()}
            />
          ) : view === 'versions' ? (
            <VersionsView
              config={config}
              versions={versions}
              selected={selected}
              progress={progress}
              percent={percent}
              busy={busy}
              running={running}
              loadingVersions={loadingVersions}
              filter={filter}
              channel={channel}
              onFilter={setFilter}
              onChannel={setChannel}
              onSelectVersion={(id) => void patchConfig({ versionId: id })}
              onVersionJvmArgs={setVersionJvmArgs}
              onInstallLoader={(kind) => void handleInstallLoader(kind)}
              onReloadVersions={() => void loadVersions()}
              onLaunch={() => void handleLaunch()}
              onStop={() => void handleStop()}
            />
          ) : (
            <SettingsView
              config={config}
              java={java}
              account={account}
              onPatch={(patch) => void patchConfig(patch)}
              onRefreshJava={() => void loadJava()}
              onAccountChange={setAccount}
            />
          )}
        </main>
      </div>
    </div>
  );
}
