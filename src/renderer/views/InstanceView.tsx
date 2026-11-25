import { useCallback, useEffect, useState } from 'react';
import type {
  InstanceEntry,
  ModFile,
  PrimeConfig,
  ProgressEvent,
  VersionSummary,
} from '../../shared/api';
import { INSTANCE_COLORS, INSTANCE_LOADERS } from '../../shared/instances';
import { shortDate } from '../format';

type Props = {
  entry: InstanceEntry;
  version: VersionSummary | null;
  config: PrimeConfig | null;
  running: boolean;
  busy: boolean;
  progress: ProgressEvent | null;
  percent: number;
  onBack: () => void;
  onPlay: () => void;
  onStop: () => void;
  onEdit: (patch: Partial<InstanceEntry>) => void;
  onJvmArgs: (value: string) => void;
  onInstallLoader: (kind: 'fabric' | 'forge') => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function InstanceView({
  entry,
  version,
  config,
  running,
  busy,
  progress,
  percent,
  onBack,
  onPlay,
  onStop,
  onEdit,
  onJvmArgs,
  onInstallLoader,
}: Props) {
  const [name, setName] = useState(entry.name);
  const [mods, setMods] = useState<ModFile[]>([]);
  const [modsDir, setModsDir] = useState('');
  const [modsBusy, setModsBusy] = useState(false);
  const [modsError, setModsError] = useState<string | null>(null);

  useEffect(() => setName(entry.name), [entry.name]);

  const refreshMods = useCallback(async () => {
    try {
      const [files, dir] = await Promise.all([window.prime.listMods(), window.prime.modsDir()]);
      setMods(files);
      setModsDir(dir);
    } catch (error) {
      setModsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshMods();
  }, [refreshMods]);

  const addMods = async () => {
    setModsBusy(true);
    setModsError(null);
    try {
      setMods(await window.prime.addMods());
    } catch (error) {
      setModsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModsBusy(false);
    }
  };

  const removeMod = async (file: string) => {
    setModsBusy(true);
    setModsError(null);
    try {
      setMods(await window.prime.removeMod(file));
    } catch (error) {
      setModsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModsBusy(false);
    }
  };

  const commitName = () => {
    const next = name.trim();
    if (next.length === 0 || next === entry.name) {
      setName(entry.name);
      return;
    }
    onEdit({ name: next });
  };

  const loaderLabel =
    INSTANCE_LOADERS.find((loader) => loader.id === entry.loader)?.label ?? 'Vanilla';
  const canInstallLoader = !version?.loader;

  return (
    <div className="instance-page">
      <button type="button" className="back-link" onClick={onBack}>
        &larr; All instances
      </button>

      <section className="instance-hero">
        <div className="instance-hero-left">
          <span
            className="instance-mark"
            style={{ backgroundColor: entry.color }}
            aria-hidden="true"
          />
          <div className="instance-hero-text">
            <h2>{entry.name}</h2>
            <p className="muted">
              {entry.versionId} · {loaderLabel} · added {shortDate(entry.createdAt)}
            </p>
          </div>
        </div>

        <div className="instance-hero-actions">
          {running ? (
            <button type="button" className="btn-primary danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !version}
              onClick={onPlay}
            >
              {busy ? 'Launching…' : 'Play'}
            </button>
          )}
          {progress ? (
            <div className="progress instance-progress">
              <div className="progress-meta">
                <span>{progress.label}</span>
                <span>{percent}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : (
            <span className="muted">{running ? 'In game' : 'Ready to play'}</span>
          )}
        </div>
      </section>

      <div className="instance-columns">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Details</h2>
            <span className="chip subtle">{loaderLabel}</span>
          </div>
          <div className="panel-body">
            <label className="field">
              <span>Instance name</span>
              <input
                value={name}
                maxLength={48}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    setName(entry.name);
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>

            <div className="field">
              <span>Card colour</span>
              <div className="swatches" role="group" aria-label="Instance colour">
                {INSTANCE_COLORS.map((option) => (
                  <button
                    key={option.hex}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={entry.color === option.hex}
                    className={entry.color === option.hex ? 'swatch-dot on' : 'swatch-dot'}
                    style={{ backgroundColor: option.hex }}
                    onClick={() => onEdit({ color: option.hex })}
                  />
                ))}
              </div>
            </div>

            <label className="field">
              <span>JVM flags for {entry.versionId}</span>
              <input
                value={config?.versionJvmArgs?.[entry.versionId] ?? ''}
                spellCheck={false}
                placeholder={config?.jvmArgs.trim() || 'Global flags from Settings'}
                onChange={(event) => onJvmArgs(event.target.value)}
              />
            </label>
            <p className="note">Leave empty to use the global flags from Settings.</p>

            <dl className="meta-list">
              <div>
                <dt>Version</dt>
                <dd>{entry.versionId}</dd>
              </div>
              <div>
                <dt>Released</dt>
                <dd>{version ? shortDate(version.releaseTime) : '—'}</dd>
              </div>
              <div>
                <dt>Memory</dt>
                <dd>{config ? `${config.ramMb} MB` : '—'}</dd>
              </div>
              <div>
                <dt>Player</dt>
                <dd>{config?.username || 'Player'}</dd>
              </div>
            </dl>

            {canInstallLoader ? (
              <div className="loader-install">
                <span className="loader-install-title">Modded loaders</span>
                <div className="chip-row">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => onInstallLoader('fabric')}
                  >
                    Install Fabric
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => onInstallLoader('forge')}
                  >
                    Install Forge
                  </button>
                </div>
                <p className="note">Adds a {entry.versionId} loader profile as its own instance.</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Mods</h2>
            <span className="panel-meta">{mods.length}</span>
          </div>
          <div className="panel-body">
            <div className="chip-row">
              <button
                type="button"
                className="btn-primary small"
                disabled={modsBusy}
                onClick={() => void addMods()}
              >
                {modsBusy ? 'Working…' : 'Add mods'}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={modsBusy}
                onClick={() => void window.prime.openMods()}
              >
                Open folder
              </button>
            </div>

            {modsError ? (
              <p className="note error-text" role="alert">
                {modsError}
              </p>
            ) : null}

            {mods.length === 0 ? (
              <p className="empty">No mods yet. Add .jar files to load them with this game.</p>
            ) : (
              <ul className="mod-list">
                {mods.map((mod) => (
                  <li className="mod-row" key={mod.name}>
                    <span className="mod-name" title={mod.name}>
                      {mod.name}
                    </span>
                    <span className="mod-size">{formatSize(mod.size)}</span>
                    <button
                      type="button"
                      className="mod-remove"
                      aria-label={`Remove ${mod.name}`}
                      title={`Remove ${mod.name}`}
                      disabled={modsBusy}
                      onClick={() => void removeMod(mod.name)}
                    >
                      &times;
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="note">
              {modsDir
                ? `Loaded from ${modsDir} - every instance using this game folder sees these files.`
                : 'Mods are read from the mods folder in the game directory.'}
            </p>
            <p className="note">
              Mods only do something with a loader that supports them: Fabric or Forge.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
