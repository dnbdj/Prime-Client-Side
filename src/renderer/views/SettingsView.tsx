import { useEffect, useState } from 'react';
import type {
  AfterLaunch,
  DeviceCode,
  JavaCandidate,
  MinecraftAccount,
  PrimeConfig,
  UpdateStatus,
} from '../../shared/api';

type Props = {
  config: PrimeConfig | null;
  java: JavaCandidate[];
  account: MinecraftAccount | null;
  onPatch: (patch: Partial<PrimeConfig>) => void;
  onRefreshJava: () => void;
  onAccountChange: (account: MinecraftAccount | null) => void;
};

const MEMORY_PRESETS = [2048, 4096, 6144, 8192];

const TABS = [
  { id: 'account', label: 'Account' },
  { id: 'game', label: 'Game' },
  { id: 'java', label: 'Java' },
  { id: 'launcher', label: 'Launcher' },
  { id: 'updates', label: 'Updates' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const AFTER_LAUNCH: { id: AfterLaunch; label: string; hint: string }[] = [
  {
    id: 'keep',
    label: 'Stay open',
    hint: 'The launcher window stays where it is while you play.',
  },
  {
    id: 'minimise',
    label: 'Minimise to the taskbar',
    hint: 'The window gets out of the way - click the taskbar to bring it back.',
  },
  {
    id: 'close',
    label: 'Close the launcher',
    hint: 'Prime quits as soon as the game starts. The game itself keeps running.',
  },
];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsView({
  config,
  java,
  account,
  onPatch,
  onRefreshJava,
  onAccountChange,
}: Props) {
  const [tab, setTab] = useState<TabId>('account');
  const [defaultDir, setDefaultDir] = useState('');
  const [javaStatus, setJavaStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [flow, setFlow] = useState<DeviceCode | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  useEffect(() => {
    void window.prime.defaultGameDir().then(setDefaultDir);
    void window.prime.appVersion().then(setAppVersion).catch(() => setAppVersion(''));
  }, []);

  const describeUpdate = (status: UpdateStatus): string => {
    switch (status.status) {
      case 'unconfigured':
        return 'No updates configured — add a feed URL to check for a new build.';
      case 'current':
        return `Up to date. Feed offers ${status.version}.`;
      case 'available':
        return `Version ${status.version} is available.${status.notes ? ` ${status.notes}` : ''}`;
      default:
        return status.error;
    }
  };

  const checkUpdates = async () => {
    setUpdateBusy(true);
    try {
      setUpdateStatus(await window.prime.checkUpdates());
    } catch (error) {
      setUpdateStatus({ status: 'error', error: describe(error) });
    } finally {
      setUpdateBusy(false);
    }
  };

  // Poll Microsoft while a device code is on screen; stops as soon as it is spent.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    const timer = setInterval(
      async () => {
        try {
          const result = await window.prime.pollSignIn();
          if (cancelled) return;
          if (result.status === 'done' && result.account) {
            setFlow(null);
            setAuthMessage(`Signed in as ${result.account.name}.`);
            onAccountChange(result.account);
          } else if (result.status === 'error') {
            setFlow(null);
            setAuthMessage(result.error ?? 'Sign-in failed.');
          }
        } catch (error) {
          if (!cancelled) setAuthMessage(describe(error));
        }
      },
      Math.max(3, flow.interval) * 1000,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [flow, onAccountChange]);

  const gameDir = config?.gameDir ?? defaultDir;
  const ram = config?.ramMb ?? 4096;
  const afterLaunch = config?.afterLaunch ?? 'keep';

  const verify = async () => {
    if (!config?.javaPath) {
      setJavaStatus('Select a runtime first, or leave it on auto-detect.');
      return;
    }
    setChecking(true);
    const result = await window.prime.checkJava(config.javaPath);
    setChecking(false);
    setJavaStatus(
      result.ok ? `Java ${result.major} — ready to launch.` : (result.error ?? 'Check failed.'),
    );
  };

  const beginSignIn = async () => {
    setAuthBusy(true);
    setAuthMessage(null);
    try {
      setFlow(await window.prime.startSignIn());
    } catch (error) {
      setAuthMessage(describe(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const cancelSignIn = async () => {
    await window.prime.cancelSignIn();
    setFlow(null);
  };

  const signOut = async () => {
    await window.prime.signOut();
    onAccountChange(null);
    setAuthMessage('Signed out.');
  };

  return (
    <div className="settings">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`settings-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`settings-panel-${entry.id}`}
            className={tab === entry.id ? 'settings-tab on' : 'settings-tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        className="settings-panels"
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === 'account' ? (
          <section className="panel wide">
            <div className="panel-head">
              <h2 className="panel-title">Account</h2>
              <span className={account ? 'chip green' : 'chip subtle'}>
                {account ? 'Microsoft' : 'Offline'}
              </span>
            </div>
            <div className="panel-body">
              {account ? (
                <div className="account-row">
                  <span className="avatar large">
                    {account.skinUrl ? (
                      <img src={account.skinUrl} alt="" />
                    ) : (
                      account.name.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <div className="account-identity">
                    <strong>{account.name}</strong>
                    <span className="mono">{account.uuid}</span>
                  </div>
                  <button type="button" className="btn-ghost" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              ) : flow ? (
                <div className="session">
                  <p className="note">{flow.message}</p>
                  <span className="session-code">{flow.userCode}</span>
                  <div className="chip-row">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void window.prime.openExternal(flow.verificationUri)}
                    >
                      Open sign-in page
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => void cancelSignIn()}>
                      Cancel
                    </button>
                  </div>
                  <p className="note">Waiting for you to approve the code — this updates by itself.</p>
                </div>
              ) : (
                <>
                  <label className="field">
                    <span>Offline player name</span>
                    <input
                      value={config?.username ?? ''}
                      maxLength={16}
                      spellCheck={false}
                      placeholder="Steve"
                      onChange={(event) => onPatch({ username: event.target.value })}
                    />
                  </label>
                  <div className="chip-row">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void beginSignIn()}
                      disabled={authBusy}
                    >
                      {authBusy ? 'Opening…' : 'Sign in with Microsoft'}
                    </button>
                  </div>
                  <p className="note">
                    Offline mode covers singleplayer and offline servers. Sign in to join online
                    servers and keep your real skin and name.
                  </p>
                </>
              )}
              {authMessage ? <p className="note">{authMessage}</p> : null}
            </div>
          </section>
        ) : null}

        {tab === 'game' ? (
          <>
            <section className="panel wide">
              <div className="panel-head">
                <h2 className="panel-title">Memory</h2>
                <span className="panel-meta">{ram} MB</span>
              </div>
              <div className="panel-body">
                <input
                  type="range"
                  min={1024}
                  max={16384}
                  step={512}
                  value={Math.min(16384, ram)}
                  onChange={(event) => onPatch({ ramMb: Number(event.target.value) })}
                />
                <div className="chip-row">
                  {MEMORY_PRESETS.map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={ram === value ? 'chip toggle on' : 'chip toggle'}
                      onClick={() => onPatch({ ramMb: value })}
                    >
                      {value / 1024} GB
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="panel wide">
              <div className="panel-head">
                <h2 className="panel-title">Mod picker</h2>
                <span className={config?.curseForgeApiKey ? 'chip green' : 'chip subtle'}>
                  {config?.curseForgeApiKey ? 'CurseForge ready' : 'Modrinth only'}
                </span>
              </div>
              <div className="panel-body">
                <label className="field">
                  <span>CurseForge API key</span>
                  <input
                    type="password"
                    value={config?.curseForgeApiKey ?? ''}
                    spellCheck={false}
                    placeholder="Paste a key from console.curseforge.com"
                    onChange={(event) =>
                      onPatch({ curseForgeApiKey: event.target.value || null })
                    }
                  />
                </label>
                <p className="note">
                  Stored locally in Prime's config. Modrinth needs no key; without one, the
                  CurseForge tab in the mod picker explains what to add.
                </p>
              </div>
            </section>

            <section className="panel wide">
              <div className="panel-head">
                <h2 className="panel-title">Game folders</h2>
                <div className="chip-row">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void window.prime.openPath(`${gameDir}/logs`)}
                  >
                    Logs
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void window.prime.openPath(`${gameDir}/crash-reports`)}
                  >
                    Crash reports
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void window.prime.openPath(gameDir)}
                  >
                    Open folder
                  </button>
                </div>
              </div>
              <div className="panel-body">
                <input
                  value={config?.gameDir ?? ''}
                  placeholder={defaultDir}
                  spellCheck={false}
                  onChange={(event) => onPatch({ gameDir: event.target.value || null })}
                />
                <p className="note">
                  Base folder for Prime. Each instance keeps its own game folder under{' '}
                  <code>instances/</code>, so mods and worlds stay separate. Leave empty to use the
                  folder Prime manages.
                </p>
              </div>
            </section>
          </>
        ) : null}

        {tab === 'java' ? (
          <>
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Java runtime</h2>
                <span className="panel-meta">{java.length ? `${java.length} found` : 'none'}</span>
              </div>
              <div className="panel-body">
                <select
                  value={config?.javaPath ?? ''}
                  onChange={(event) => {
                    setJavaStatus(null);
                    onPatch({ javaPath: event.target.value || null });
                  }}
                >
                  <option value="">Auto-detect (recommended)</option>
                  {java.map((candidate) => (
                    <option key={candidate.path} value={candidate.path}>
                      Java {candidate.major} — {candidate.path}
                    </option>
                  ))}
                </select>
                <div className="chip-row">
                  <button type="button" className="btn-ghost" onClick={onRefreshJava}>
                    Rescan
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void verify()}
                    disabled={checking}
                  >
                    Verify
                  </button>
                </div>
                {javaStatus ? <p className="note">{javaStatus}</p> : null}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">JVM flags</h2>
              </div>
              <div className="panel-body">
                <input
                  value={config?.jvmArgs ?? ''}
                  spellCheck={false}
                  placeholder="-XX:+UseG1GC"
                  onChange={(event) => onPatch({ jvmArgs: event.target.value })}
                />
                <p className="note">
                  Extra flags for every launch, space separated. Memory above is added automatically.
                </p>
              </div>
            </section>
          </>
        ) : null}

        {tab === 'launcher' ? (
          <section className="panel wide">
            <div className="panel-head">
              <h2 className="panel-title">When the game starts</h2>
              <span className="panel-meta">
                {AFTER_LAUNCH.find((option) => option.id === afterLaunch)?.label}
              </span>
            </div>
            <div className="panel-body">
              <div
                className="pick-list"
                role="radiogroup"
                aria-label="What the launcher does when the game starts"
              >
                {AFTER_LAUNCH.map((option) => {
                  const on = option.id === afterLaunch;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={on ? 'pick-item on' : 'pick-item'}
                      onClick={() => onPatch({ afterLaunch: option.id })}
                    >
                      <span className="pick-dot" aria-hidden="true" />
                      <span className="pick-text">
                        <strong>{option.label}</strong>
                        <span>{option.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="note">
                One choice at a time. The game keeps running whichever you pick.
              </p>
            </div>
          </section>
        ) : null}

        {tab === 'updates' ? (
          <section className="panel wide">
            <div className="panel-head">
              <h2 className="panel-title">Updates</h2>
              <span className="panel-meta">{appVersion ? `Prime ${appVersion}` : 'Prime'}</span>
            </div>
            <div className="panel-body">
              <label className="field">
                <span>Update feed URL</span>
                <input
                  value={config?.updateFeed ?? ''}
                  spellCheck={false}
                  placeholder="https://example.com/prime/latest.json"
                  onChange={(event) => {
                    setUpdateStatus(null);
                    onPatch({ updateFeed: event.target.value.trim() || null });
                  }}
                />
              </label>
              <div className="chip-row">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => void checkUpdates()}
                  disabled={updateBusy}
                >
                  {updateBusy ? 'Checking…' : 'Check for updates'}
                </button>
                {updateStatus?.status === 'available' && updateStatus.url ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void window.prime.openExternal(updateStatus.url ?? '')}
                  >
                    Open release page
                  </button>
                ) : null}
              </div>
              <p className="note">
                {updateStatus
                  ? describeUpdate(updateStatus)
                  : 'The feed is a small JSON file with a version, a download URL and optional notes.'}
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
