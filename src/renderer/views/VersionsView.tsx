import { useMemo } from 'react';
import type { PrimeConfig, ProgressEvent, VersionSummary } from '../../shared/api';
import { VersionTable } from '../components/VersionTable';
import { shortDate } from '../format';

type Props = {
  config: PrimeConfig | null;
  versions: VersionSummary[];
  selected: VersionSummary | null;
  progress: ProgressEvent | null;
  percent: number;
  busy: boolean;
  running: boolean;
  loadingVersions: boolean;
  filter: string;
  channel: 'release' | 'all';
  onFilter: (value: string) => void;
  onChannel: (value: 'release' | 'all') => void;
  onSelectVersion: (id: string) => void;
  onReloadVersions: () => void;
  onLaunch: () => void;
  onStop: () => void;
};

export function VersionsView({
  config,
  versions,
  selected,
  progress,
  percent,
  busy,
  running,
  loadingVersions,
  filter,
  channel,
  onFilter,
  onChannel,
  onSelectVersion,
  onReloadVersions,
  onLaunch,
  onStop,
}: Props) {
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return versions.filter((version) => {
      if (channel === 'release' && version.type !== 'release') return false;
      return needle.length === 0 || version.id.toLowerCase().includes(needle);
    });
  }, [channel, filter, versions]);

  return (
    <div className="browse">
      <section className="panel list-panel">
        <div className="list-toolbar">
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
          <span className="muted">{visible.length} shown</span>
          <button type="button" className="btn-ghost" onClick={onReloadVersions}>
            Reload
          </button>
        </div>

        {filter ? (
          <div className="active-filter">
            <span>Filter: {filter}</span>
            <button type="button" onClick={() => onFilter('')}>
              Clear
            </button>
          </div>
        ) : null}

        <VersionTable
          versions={visible}
          selectedId={config?.versionId ?? null}
          onSelect={onSelectVersion}
          empty={
            loadingVersions
              ? 'Loading version manifest…'
              : versions.length === 0
                ? 'Version manifest unavailable. Check your connection and reload.'
                : 'No versions match that filter.'
          }
        />
      </section>

      <aside className="panel detail">
        <div className="panel-head">
          <h2 className="panel-title">{selected?.id ?? 'Nothing selected'}</h2>
          <span className="chip subtle">{selected?.type ?? '—'}</span>
        </div>
        <div className="panel-body">
          <dl className="meta-list">
            <div>
              <dt>Released</dt>
              <dd>{selected ? shortDate(selected.releaseTime) : '—'}</dd>
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
              {busy ? 'Launching…' : 'Play this version'}
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
