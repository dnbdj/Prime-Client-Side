import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { InstanceEntry, PrimeConfig, ProgressEvent, VersionSummary } from '../../shared/api';
import { MoreIcon } from '../components/Icon';
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
  onAddInstance: (entry: InstanceEntry, modPaths?: string[]) => void;
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
  onAddInstance,
  onOpenInstance,
  onPlay,
  onDelete,
  onStop,
  onReloadVersions,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ entry: InstanceEntry; x: number; y: number } | null>(null);

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>, entry: InstanceEntry) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 190;
    const height = 128;
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const y =
      rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6;
    setMenu({ entry, x, y });
  };

  const openFolder = async (entry: InstanceEntry) => {
    const dir = await window.prime.instanceDir(entry.id, entry.versionId).catch(() => null);
    if (dir) await window.prime.openPath(dir).catch(() => undefined);
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.vcard-menu') || target?.closest('.vcard-more')) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // With nothing installed yet, setup is the only useful thing to show.
  useEffect(() => {
    if (instances.length === 0) setCreating(true);
  }, [instances.length]);

  if (creating) {
    return (
      <InstanceWizard
        versions={versions}
        loadingVersions={loadingVersions}
        progress={progress}
        percent={percent}
        onReloadVersions={onReloadVersions}
        onCancel={() => setCreating(false)}
        onCreate={(entry, modPaths) => {
          onAddInstance(entry, modPaths);
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
            {instances.length === 0 ? (
              <p className="empty">
                No instances yet. Add one to start building your library.
              </p>
            ) : (
              instances.map(({ entry, version, playedAt }) => {
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
                      className="vcard-more"
                      aria-label={`Actions for ${entry.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.entry.id === entry.id}
                      onClick={(event) => openMenu(event, entry)}
                    >
                      <MoreIcon />
                    </button>
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

      {menu ? (
        <div
          className="vcard-menu"
          role="menu"
          aria-label={`Actions for ${menu.entry.name}`}
          style={{ top: menu.y, left: menu.x }}
        >
          <button
            type="button"
            role="menuitem"
            className="vcard-menu-item"
            onClick={() => {
              const entry = menu.entry;
              setMenu(null);
              onOpenInstance(entry);
            }}
          >
            Open details
          </button>
          <button
            type="button"
            role="menuitem"
            className="vcard-menu-item"
            onClick={() => {
              const entry = menu.entry;
              setMenu(null);
              void openFolder(entry);
            }}
          >
            Open game folder
          </button>
          <span className="vcard-menu-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="vcard-menu-item danger-text"
            onClick={() => {
              const entry = menu.entry;
              setMenu(null);
              onDelete(entry);
            }}
          >
            Delete instance
          </button>
        </div>
      ) : null}
    </div>
  );
}
