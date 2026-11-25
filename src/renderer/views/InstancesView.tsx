import { useEffect, useMemo, useState } from 'react';
import type {
  InstanceEntry,
  PrimeConfig,
  ProgressEvent,
  VersionSummary,
} from '../../shared/api';
import { InstanceWizard } from '../components/InstanceWizard';
import { shortDate, timeAgo } from '../format';

export type InstanceCard = {
  entry: InstanceEntry;
  version: VersionSummary;
  playedAt: string | null;
};

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
  onSelectInstance: (id: string) => void;
  onAddInstance: (entry: InstanceEntry) => void;
  onVersionJvmArgs: (versionId: string, value: string) => void;
  onInstallLoader: (kind: 'fabric' | 'forge') => void;
  onReloadVersions: () => void;
  onLaunch: () => void;
  onStop: () => void;
};

const LOADER_LABEL: Record<InstanceEntry['loader'], string> = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  modpack: 'Modpack',
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
  onSelectInstance,
  onAddInstance,
  onVersionJvmArgs,
  onInstallLoader,
  onReloadVersions,
  onLaunch,
  onStop,
}: Props) {
  const [creating, setCreating] = useState(false);

  // With nothing installed yet, setup is the only useful thing to show.
  useEffect(() => {
    if (instances.length === 0) setCreating(true);
  }, [instances.length]);

  const needle = filter.trim().toLowerCase();

  const cards = useMemo(
    () =>
      needle
        ? instances.filter((card) => {
            const haystack = `${card.entry.name} ${card.entry.versionId}`.toLowerCase();
            return haystack.includes(needle);
          })
        : instances,
    [instances, needle],
  );

  const active = instances.find((card) => card.version.id === config?.versionId) ?? null;
  const detail = selected;

  if (creating) {
    return (
      <InstanceWizard
        versions={versions}
        filter={filter}
        loadingVersions={loadingVersions}
        onCancel={() => setCreating(false)}
        onCreate={(entry) => {
          onAddInstance(entry);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <div className="browse">
      <section className="panel list-panel">
        <div className="list-toolbar">
          <span className="chip subtle">
            {instances.length} instance{instances.length === 1 ? '' : 's'}
          </span>
          <span className="muted">{running ? 'In game' : 'Ready to play'}</span>
          <button type="button" className="btn-ghost" onClick={onReloadVersions}>
            Reload
          </button>
          <button type="button" className="btn-primary small" onClick={() => setCreating(true)}>
            + Add instance
          </button>
        </div>

        <div className="instance-grid">
          <div className="card-grid">
            {cards.length === 0 ? (
              <p className="empty">
                {instances.length === 0
                  ? 'No instances yet. Add one to start building your library.'
                  : 'No instances match that filter.'}
              </p>
            ) : (
              cards.map(({ entry, version, playedAt }) => (
                <button
                  type="button"
                  key={`${entry.name}-${entry.versionId}`}
                  className={version.id === config?.versionId ? 'vcard selected' : 'vcard'}
                  onClick={() => onSelectInstance(version.id)}
                >
                  <span
                    className={`vcard-banner ${version.loader ?? version.type}`}
                    style={{ backgroundColor: entry.color }}
                    aria-hidden="true"
                  />
                  <span className="vcard-body">
                    <span className="chip subtle">{LOADER_LABEL[entry.loader]}</span>
                    <strong className="vcard-id">{entry.name}</strong>
                    <span className="vcard-date">
                      {entry.name === entry.versionId ? '' : `${entry.versionId} · `}
                      {playedAt ? `played ${timeAgo(playedAt)}` : 'added to your instances'}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      <aside className="panel detail">
        <div className="panel-head">
          <h2 className="panel-title">
            {active?.entry.name ?? detail?.id ?? 'No instance selected'}
          </h2>
          <span className="chip subtle">
            {active ? LOADER_LABEL[active.entry.loader] : (detail?.loader ?? detail?.type ?? '—')}
          </span>
        </div>
        <div className="panel-body">
          <dl className="meta-list">
            <div>
              <dt>Version</dt>
              <dd>{detail?.id ?? '—'}</dd>
            </div>
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

          {detail && !detail.loader ? (
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

          {running ? (
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
