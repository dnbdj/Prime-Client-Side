import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InstanceEntry,
  JavaCandidate,
  MinecraftAccount,
  PrimeConfig,
  ProgressEvent,
  VersionSummary,
} from '../shared/api';
import { defaultInstance, INSTANCE_LOADERS } from '../shared/instances';
import { HomeIcon, MoreIcon, SearchIcon, SettingsIcon, VersionsIcon } from './components/Icon';
import { HomeView } from './views/HomeView';
import { InstanceView } from './views/InstanceView';
import { InstancesView, type InstanceCard } from './views/InstancesView';
import { SettingsView } from './views/SettingsView';

type View = 'home' | 'instances' | 'instance' | 'settings';

const NAV = [
  { id: 'home' as const, label: 'Home', Icon: HomeIcon },
  { id: 'instances' as const, label: 'Instances', Icon: VersionsIcon },
  { id: 'settings' as const, label: 'Settings', Icon: SettingsIcon },
];

const TITLES: Record<View, { title: string; subtitle: string }> = {
  home: { title: 'Home', subtitle: 'Pick a version and drop in' },
  instances: { title: 'Instances', subtitle: 'Your Minecraft builds, ready to play' },
  instance: { title: 'Instance', subtitle: 'Mods, flags and everything about this build' },
  settings: { title: 'Settings', subtitle: 'Stored locally on this machine' },
};

const MAX_LOG_LINES = 600;

function newInstanceId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return "Couldn't reach Mojang's servers. Check your connection, VPN or proxy, then reload.";
  }
  return message;
}

export function App() {
  const [view, setView] = useState<View>('home');
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [config, setConfig] = useState<PrimeConfig | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [java, setJava] = useState<JavaCandidate[]>([]);
  const [account, setAccount] = useState<MinecraftAccount | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const [accountMenu, setAccountMenu] = useState(false);

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
      setRunningId(null);
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

  const handleLaunch = useCallback(
    async (versionId?: string, instanceId?: string) => {
      const target = versionId ?? config?.versionId;
      if (!target || busy || running) return;
      setBusy(true);
      setError(null);
      setLogs([]);
      setProgress({ phase: 'meta', current: 0, total: 1, label: 'Preparing launch' });

      const result = await window.prime.launch(target, instanceId);
      setBusy(false);

      if (!result.ok) {
        setProgress(null);
        setError(describeError(result.error ?? 'Launch failed.'));
        return;
      }
      setRunning(true);
      setRunningId(instanceId ?? null);
      // The main process records the launch for the Recently played list.
      await window.prime
        .getConfig()
        .then(setConfig)
        .catch(() => undefined);
    },
    [busy, config?.versionId, running],
  );

  const handleStop = useCallback(async () => {
    await window.prime.kill();
    setRunning(false);
    setRunningId(null);
    setProgress(null);
  }, []);

  const handleInstallLoader = useCallback(
    async (kind: 'fabric' | 'forge', gameVersion?: string) => {
      const target = gameVersion ?? config?.versionId;
      if (!target || busy) return;
      setBusy(true);
      setError(null);
      setProgress({ phase: 'loader', current: 0, total: 1, label: `Installing ${kind}` });
      const result = await window.prime.installLoader(kind, target);
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

  const instances = useMemo<InstanceCard[]>(() => {
    const played = new Map((config?.recent ?? []).map((entry) => [entry.versionId, entry.playedAt]));
    const entries: InstanceEntry[] = [];
    const seen = new Set<string>();
    const push = (entry: InstanceEntry) => {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      entries.push(entry);
    };

    const loaderOf = (versionId: string): Partial<InstanceEntry> => {
      const version = versions.find((candidate) => candidate.id === versionId);
      return version?.loader ? { loader: version.loader } : {};
    };

    for (const entry of config?.instances ?? []) push(entry);
    // Played versions and the last selection are instances even when the user
    // never went through setup for them. Versions that already have a record
    // are covered by it, including duplicates that share a version.
    const covered = new Set((config?.instances ?? []).map((entry) => entry.versionId));
    for (const entry of config?.recent ?? []) {
      if (covered.has(entry.versionId)) continue;
      push(defaultInstance(entry.versionId, loaderOf(entry.versionId)));
    }
    if (config?.versionId && !covered.has(config.versionId)) {
      push(defaultInstance(config.versionId, loaderOf(config.versionId)));
    }

    return entries
      .map((entry): InstanceCard | null => {
        const version = versions.find((candidate) => candidate.id === entry.versionId);
        return version ? { entry, version, playedAt: played.get(entry.versionId) ?? null } : null;
      })
      .filter((card): card is InstanceCard => card !== null);
  }, [config?.instances, config?.recent, config?.versionId, versions]);

  const addInstance = useCallback(
    async (entry: InstanceEntry) => {
      const current = config?.instances ?? [];
      const existing = current.find(
        (candidate) =>
          candidate.versionId === entry.versionId && candidate.name === entry.name,
      );
      // Each created instance gets its own id and therefore its own folder, even
      // when the Minecraft version matches another instance.
      const id = existing?.id ?? newInstanceId();
      const gameDir =
        existing?.gameDir ??
        (await window.prime.instanceDir(id, entry.versionId).catch(() => undefined));
      const record: InstanceEntry = { ...entry, id, ...(gameDir ? { gameDir } : {}) };
      const next = [
        record,
        ...current.filter(
          (candidate) =>
            candidate.versionId !== entry.versionId || candidate.name !== entry.name,
        ),
      ];
      await patchConfig({ instances: next, versionId: entry.versionId });
    },
    [config?.instances, patchConfig],
  );

  /** Edits that describe one instance and nothing else: name, colour. */
  const updateInstance = useCallback(
    async (id: string, patch: Partial<InstanceEntry>) => {
      const card = instances.find((candidate) => candidate.entry.id === id);
      if (!card) return;
      const nextEntry = { ...card.entry, ...patch };
      const current = config?.instances ?? [];
      const exists = current.some((entry) => entry.id === id);
      const next = exists
        ? current.map((entry) => (entry.id === id ? nextEntry : entry))
        : [nextEntry, ...current];
      await patchConfig({ instances: next });
    },
    [config?.instances, instances, patchConfig],
  );

  const removeInstance = useCallback(
    async (entry: InstanceEntry) => {
      if (runningId === entry.id) {
        setError('Stop the game before deleting this instance.');
        return;
      }
      const confirmed = window.confirm(
        `Delete "${entry.name}"?\n\nThis removes the instance and, when it has its own folder under instances, that folder and its mods. The shared Minecraft folder is never deleted.`,
      );
      if (!confirmed) return;
      try {
        const result = await window.prime.deleteInstance(entry.id, entry.versionId, true);
        setConfig(result.config);
        if (result.error) {
          setError(result.error);
          return;
        }
        appendLog(
          `[prime] Deleted ${entry.name}${result.folderDeleted ? ' and its game folder' : ''}.`,
        );
        if (instanceId === entry.id) {
          setInstanceId(null);
          setView('instances');
        }
      } catch (err) {
        setError(describeError(err));
      }
    },
    [appendLog, instanceId, runningId],
  );

  const activeInstance = useMemo(
    () => instances.find((card) => card.entry.id === instanceId) ?? null,
    [instanceId, instances],
  );

  const heading =
    view === 'instance' && activeInstance
      ? {
          title: activeInstance.entry.name,
          subtitle: `${activeInstance.version.id} · ${
            INSTANCE_LOADERS.find((loader) => loader.id === activeInstance.entry.loader)?.label ??
            'Vanilla'
          }`,
        }
      : TITLES[view];

  const recentInstances = useMemo(() => {
    return (config?.recent ?? [])
      .map((entry) => {
        const version = versions.find((candidate) => candidate.id === entry.versionId);
        return version ? { version, playedAt: entry.playedAt } : null;
      })
      .filter((entry): entry is { version: VersionSummary; playedAt: string } => entry !== null)
      .slice(0, 5);
  }, [config?.recent, versions]);

  useEffect(() => {
    if (!accountMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountMenu]);

  const chooseMicrosoft = useCallback(() => {
    setAccountMenu(false);
    if (!account) setView('settings');
  }, [account]);

  const chooseOffline = useCallback(async () => {
    setAccountMenu(false);
    if (!account) return;
    await window.prime.signOut().catch(() => undefined);
    setAccount(null);
  }, [account]);

  const openAccountSettings = useCallback(() => {
    setAccountMenu(false);
    setView('settings');
  }, []);

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
            <h1>{heading.title}</h1>
            <span>{heading.subtitle}</span>
          </div>

          <label className="search">
            <SearchIcon />
            <input
              value={filter}
              spellCheck={false}
              placeholder="Search versions"
              onChange={(event) => {
                setFilter(event.target.value);
                if (event.target.value.trim().length > 0) setView('instances');
              }}
            />
          </label>

          <div className="account" ref={accountMenuRef}>
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
            <span className="account-sep" aria-hidden="true" />
            <button
              type="button"
              className="account-more"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={accountMenu}
              onClick={() => setAccountMenu((open) => !open)}
            >
              <MoreIcon />
            </button>
            {accountMenu ? (
              <div className="account-menu" role="menu" aria-label="Account">
                <span className="account-menu-label">Account</span>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={Boolean(account)}
                  className="account-menu-item"
                  onClick={chooseMicrosoft}
                >
                  <span className="account-menu-title">Microsoft account</span>
                  <span className="account-menu-note">
                    {account ? account.name : 'Not signed in - open Settings to sign in'}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!account}
                  className="account-menu-item"
                  onClick={() => void chooseOffline()}
                >
                  <span className="account-menu-title">Offline</span>
                  <span className="account-menu-note">
                    {config?.username || 'Player'}
                    {account ? ' - signs out' : ''}
                  </span>
                </button>
                <span className="account-menu-break" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="account-menu-item account-menu-settings"
                  onClick={openAccountSettings}
                >
                  <span className="account-menu-title">Account settings</span>
                  <span className="account-menu-hint" aria-hidden="true">
                    &rarr;
                  </span>
                </button>
              </div>
            ) : null}
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
              onBrowseAll={() => setView('instances')}
              onLaunch={() => void handleLaunch()}
              onStop={() => void handleStop()}
            />
          ) : view === 'instance' && activeInstance ? (
            <InstanceView
              entry={activeInstance.entry}
              version={activeInstance.version}
              config={config}
              running={
                running &&
                (runningId
                  ? runningId === activeInstance.entry.id
                  : config?.versionId === activeInstance.version.id)
              }
              busy={busy}
              progress={progress}
              percent={percent}
              onBack={() => {
                setInstanceId(null);
                setView('instances');
              }}
              onPlay={() =>
                void handleLaunch(activeInstance.version.id, activeInstance.entry.id)
              }
              onStop={() => void handleStop()}
              onEdit={(patch) => void updateInstance(activeInstance.entry.id, patch)}
              onJvmArgs={(value) => setVersionJvmArgs(activeInstance.version.id, value)}
              onInstallLoader={(kind) =>
                void handleInstallLoader(kind, activeInstance.version.id)
              }
              onDelete={() => void removeInstance(activeInstance.entry)}
            />
          ) : view === 'instances' || (view === 'instance' && !activeInstance) ? (
            <InstancesView
              config={config}
              versions={versions}
              instances={instances}
              progress={progress}
              percent={percent}
              busy={busy}
              running={running}
              runningId={runningId}
              loadingVersions={loadingVersions}
              filter={filter}
              onAddInstance={(entry) => void addInstance(entry)}
              onOpenInstance={(entry) => {
                setInstanceId(entry.id);
                setView('instance');
              }}
              onPlay={(entry) => void handleLaunch(entry.versionId, entry.id)}
              onDelete={(entry) => void removeInstance(entry)}
              onStop={() => void handleStop()}
              onReloadVersions={loadVersions}
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
