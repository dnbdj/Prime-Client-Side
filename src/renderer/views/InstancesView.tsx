import { useEffect, useMemo, useState } from 'react';
import type { InstanceEntry, PrimeConfig, ProgressEvent, VersionSummary } from '../../shared/api';
import { InstanceWizard } from '../components/InstanceWizard';
import { timeAgo } from '../format';

export type InstanceCard = {
  entry: InstanceEntry;
  version: VersionSummary;
  playedAt: string | null;
};

type Props = {
  config: PrimeConfig | null;
  versions: VersionSummary[];
  instances: InstanceCard[];
  progress: ProgressEvent | null;
  percent: number;
  busy: boolean;
  running: boolean;
  runningId: string | null;
  loadingVersions: boolean;
  filter: string;
  onAddInstance: (entry: InstanceEntry) => void;
  onOpenInstance: (entry: InstanceEntry) => void;
  onPlay: (entry: InstanceEntry) => void;
  onDelete: (entry: InstanceEntry) => void;
  onStop: () => void;
  onReloadVersions: () => Promise<void> | void;
};

const LOADER_LABEL: Record<InstanceEntry['loader'], string> = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  legacyfabric: 'Legacy Fabric',
  liteloader: 'LiteLoader',
  babric: 'Babric',
  bta: 'BTA',
  ornithe: 'Ornithe',
  nilloader: 'NilLoader',
  modloader: 'ModLoader',
  rift: 'Rift',
  'java-agent': 'Java Agent',
  modpack: 'Modpack',
};

export function InstancesView({
  config,
  versions,
  instances,
  progress,
  percent,
  busy,
  running,
  runningId,
  loadingVersions,
  filter,
  onAddInstance,
  onOpenInstance,
  onPlay,
  onDelete,
  onStop,
  onReloadVersions,
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

  if (creating) {
    return (
      <InstanceWizard
        versions={versions}
        filter={filter}
        loadingVersions={loadingVersions}
        progress={progress}
        percent={percent}
        onReloadVersions={onReloadVersions}
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
          <span className="muted">
            {progress
              ? `${progress.label} · ${percent}%`
              : running
                ? 'In game'
                : 'Ready to play'}
          </span>
          <button type="button" className="btn-ghost" onClick={() => void onReloadVersions()}>
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
              cards.map(({ entry, version, playedAt }) => {
                const active = version.id === config?.versionId;
                const inGame = running && (runningId ? entry.id === runningId : active);
                return (
                  <div
                    key={entry.id}
                    className={[
                      'vcard',
                      active ? 'selected' : '',
                      inGame ? 'running' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <button
                      type="button"
                      className="vcard-open"
                      onClick={() => onOpenInstance(entry)}
                      aria-label={`Open ${entry.name}`}
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

                    <div className="vcard-foot">
                      {inGame ? (
                        <button type="button" className="vcard-play danger" onClick={onStop}>
                          Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="vcard-play"
                          disabled={busy || running}
                          onClick={() => onPlay(entry)}
                        >
                          Play
                        </button>
                      )}
                      <span className="vcard-state">{inGame ? 'In game' : 'Open'}</span>
                      <button
                        type="button"
                        className="vcard-delete"
                        aria-label={`Delete ${entry.name}`}
                        title={`Delete ${entry.name}`}
                        onClick={() => onDelete(entry)}
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
