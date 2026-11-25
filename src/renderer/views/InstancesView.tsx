import { Fragment, useEffect, useMemo, useState } from 'react';
import type { PrimeConfig, ProgressEvent, VersionSummary } from '../../shared/api';
import { VersionMindMap } from '../components/VersionMindMap';
import { shortDate, timeAgo } from '../format';

export type InstanceCard = { version: VersionSummary; playedAt: string | null };

type Props = {
  config: PrimeConfig | null;
  versions: VersionSummary[];
  instances: InstanceCard[];
  selected: VersionSummary | null;
  progress: ProgressEvent | null;
  percent: number;
  busy: boolean;
  running: boolean;
  loadingVersions: boolean;
  filter: string;
  channel: 'release' | 'all';
  onChannel: (value: 'release' | 'all') => void;
  onSelectInstance: (id: string) => void;
  onAddInstance: (id: string) => void;
  onVersionJvmArgs: (versionId: string, value: string) => void;
  onInstallLoader: (kind: 'fabric' | 'forge') => void;
  onReloadVersions: () => void;
  onLaunch: () => void;
  onStop: () => void;
};

export function InstancesView({
  config,
  versions,
  instances,
  selected,
  progress,
  percent,
  busy,
  running,
  loadingVersions,
  filter,
  channel,
  onChannel,
  onSelectInstance,
  onAddInstance,
  onVersionJvmArgs,
  onInstallLoader,
  onReloadVersions,
  onLaunch,
  onStop,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  // With nothing installed yet, the picker is the only useful thing to show.
  useEffect(() => {
    if (instances.length === 0) setAdding(true);
  }, [instances.length]);

  const needle = filter.trim().toLowerCase();

  const cards = useMemo(
    () =>
      needle
        ? instances.filter((card) => card.version.id.toLowerCase().includes(needle))
        : instances,
    [instances, needle],
  );

  const pickerVersions = useMemo(
    () =>
      versions.filter((version) => {
        if (version.loader) return false;
        if (channel === 'release' && version.type !== 'release') return false;
        return needle.length === 0 || version.id.toLowerCase().includes(needle);
      }),
    [channel, needle, versions],
  );

  const pendingVersion = useMemo(
    () => versions.find((version) => version.id === pending) ?? null,
    [pending, versions],
  );

  const detail = adding ? pendingVersion : selected;

  const startAdd = () => {
    setAdding(true);
    setPath([]);
    setPending(null);
  };

  const closePicker = () => {
    setAdding(false);
    setPath([]);
    setPending(null);
  };

  const confirmAdd = () => {
    if (!pending) return;
    onAddInstance(pending);
    setAdding(false);
    setPath([]);
    setPending(null);
  };

  return (
    <div className="browse">
      <section className="panel list-panel">
        <div className="list-toolbar">
          <span className="chip subtle">
            {instances.length} instance{instances.length === 1 ? '' : 's'}
          </span>
          <span className="muted">{adding ? 'Add instance' : 'Ready to play'}</span>
          <button type="button" className="btn-ghost" onClick={onReloadVersions}>
            Reload
          </button>
          <button
            type="button"
            className="btn-primary small"
            onClick={adding ? closePicker : startAdd}
          >
            {adding ? 'Close picker' : '+ Add instance'}
          </button>
        </div>

        {adding ? (
          <>
            <div className="picker-bar">
              <div className="chip-row" role="group" aria-label="Channel">
                <button
                  type="button"
                  className={channel === 'release' ? 'chip toggle on' : 'chip toggle'}
                  onClick={() => onChannel('release')}
                >
                  Releases
                </button>
                <button
                  type="button"
                  className={channel === 'all' ? 'chip toggle on' : 'chip toggle'}
                  onClick={() => onChannel('all')}
                >
                  All versions
                </button>
              </div>
              <span className="muted">{pickerVersions.length} versions</span>
            </div>

            <div className="picker-crumbs">
              <button
                type="button"
                className={path.length === 0 ? 'on' : undefined}
                onClick={() => {
                  setPath([]);
                  setPending(null);
                }}
              >
                All versions
              </button>
              {path.map((id, index) => (
                <Fragment key={id}>
                  <span className="sep" aria-hidden="true">
                    /
                  </span>
                  <button
                    type="button"
                    className={index === path.length - 1 ? 'on' : undefined}
                    onClick={() => {
                      setPath(path.slice(0, index + 1));
                      setPending(null);
                    }}
                  >
                    {id}
                  </button>
                </Fragment>
              ))}
              <span className="picker-hint">
                {pending ? `${pending} picked` : 'Open a branch, then pick a version'}
              </span>
            </div>

            <VersionMindMap
              versions={pickerVersions}
              path={path}
              onPath={setPath}
              pending={pending}
              activeId={config?.versionId ?? null}
              onPick={setPending}
              empty={
                loadingVersions
                  ? 'Loading version manifest…'
                  : versions.length === 0
                    ? 'Version manifest unavailable. Check your connection and reload.'
                    : 'No versions match that filter.'
              }
            />
          </>
        ) : (
          <div className="instance-grid">
            <div className="card-grid">
              {cards.length === 0 ? (
                <p className="empty">
                  {instances.length === 0
                    ? 'No instances yet. Add one to start building your library.'
                    : 'No instances match that filter.'}
                </p>
              ) : (
                cards.map(({ version, playedAt }) => (
                  <button
                    type="button"
                    key={version.id}
                    className={version.id === config?.versionId ? 'vcard selected' : 'vcard'}
                    onClick={() => onSelectInstance(version.id)}
                  >
                    <span
                      className={`vcard-banner ${version.loader ?? version.type}`}
                      aria-hidden="true"
                    />
                    <span className="vcard-body">
                      <span className="chip subtle">{version.loader ?? version.type}</span>
                      <strong className="vcard-id">{version.id}</strong>
                      <span className="vcard-date">
                        {playedAt ? `played ${timeAgo(playedAt)}` : 'added to your instances'}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      <aside className="panel detail">
        <div className="panel-head">
          <h2 className="panel-title">
            {detail?.id ?? (adding ? 'Pick a version' : 'No instance selected')}
          </h2>
          <span className="chip subtle">{detail?.loader ?? detail?.type ?? '—'}</span>
        </div>
        <div className="panel-body">
          <dl className="meta-list">
            <div>
              <dt>Released</dt>
              <dd>{detail ? shortDate(detail.releaseTime) : '—'}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>{config ? `${config.ramMb} MB` : '—'}</dd>
            </div>
            <div>
              <dt>Java</dt>
              <dd>{config?.javaPath ? 'Custom' : 'Auto-detect'}</dd>
            </div>
            <div>
              <dt>Player</dt>
              <dd>{config?.username || 'Player'}</dd>
            </div>
          </dl>

          {detail ? (
            <>
              <label className="field">
                <span>JVM flags for {detail.id}</span>
                <input
                  value={config?.versionJvmArgs?.[detail.id] ?? ''}
                  spellCheck={false}
                  placeholder={config?.jvmArgs.trim() || 'Global flags from Settings'}
                  onChange={(event) => onVersionJvmArgs(detail.id, event.target.value)}
                />
              </label>
              <p className="note">Leave empty to use the global flags from Settings.</p>
            </>
          ) : null}

          {!adding && detail && !detail.loader ? (
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
              <p className="note">Adds a {detail.id} loader profile as its own instance.</p>
            </div>
          ) : null}

          {adding ? (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={!pending}
                onClick={confirmAdd}
              >
                {pending ? `Add ${pending}` : 'Add instance'}
              </button>
              <p className="note">
                {pending
                  ? 'Adding makes this version your active instance.'
                  : 'Pick a version in the map to add it as an instance.'}
              </p>
            </>
          ) : running ? (
            <button type="button" className="btn-primary danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !config?.versionId}
              onClick={onLaunch}
            >
              {busy ? 'Launching…' : 'Play this instance'}
            </button>
          )}

          <div className="progress">
            <div className="progress-meta">
              <span>{progress?.label ?? 'Ready'}</span>
              <span>{progress ? `${percent}%` : ''}</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress ? percent : 0}%` }} />
            </div>
          </div>

          <p className="note">The first launch downloads this version's game files.</p>
        </div>
      </aside>
    </div>
  );
}
