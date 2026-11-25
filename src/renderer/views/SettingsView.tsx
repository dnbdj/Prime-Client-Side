import { useEffect, useState } from 'react';
import type { DeviceCode, JavaCandidate, MinecraftAccount, PrimeConfig } from '../../shared/api';

type Props = {
  config: PrimeConfig | null;
  java: JavaCandidate[];
  account: MinecraftAccount | null;
  onPatch: (patch: Partial<PrimeConfig>) => void;
  onRefreshJava: () => void;
  onAccountChange: (account: MinecraftAccount | null) => void;
};

const MEMORY_PRESETS = [2048, 4096, 6144, 8192];

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
  const [defaultDir, setDefaultDir] = useState('');
  const [javaStatus, setJavaStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [flow, setFlow] = useState<DeviceCode | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.prime.defaultGameDir().then(setDefaultDir);
  }, []);

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
                Offline mode covers singleplayer and offline servers. Sign in to join online servers and
                keep your real skin and name.
              </p>
            </>
          )}
          {authMessage ? <p className="note">{authMessage}</p> : null}
        </div>
      </section>

      <section className="panel">
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
          <h2 className="panel-title">Launcher</h2>
        </div>
        <div className="panel-body">
          <button
            type="button"
            className={config?.closeOnLaunch ? 'chip toggle on' : 'chip toggle'}
            onClick={() => onPatch({ closeOnLaunch: !config?.closeOnLaunch })}
          >
            {config?.closeOnLaunch ? 'Closes when the game starts' : 'Stays open in game'}
          </button>
          <p className="note">The game keeps running either way.</p>
        </div>
      </section>

      <section className="panel wide">
        <div className="panel-head">
          <h2 className="panel-title">Game folder</h2>
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
          <p className="note">Leave empty to use the folder Prime manages.</p>
        </div>
      </section>
    </div>
  );
}
