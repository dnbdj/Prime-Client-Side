import type { RefObject } from 'react';
import type { PrimeConfig, ProgressEvent, VersionSummary } from '../../shared/api';
import { shortDate, timeAgo } from '../format';

type RecentCard = { version: VersionSummary; playedAt: string };

type Props = {
  config: PrimeConfig | null;
  recent: RecentCard[];
  selected: VersionSummary | null;
  progress: ProgressEvent | null;
  percent: number;
  logs: string[];
  busy: boolean;
  running: boolean;
  consoleRef: RefObject<HTMLDivElement | null>;
  onSelectVersion: (id: string) => void;
  onUsername: (name: string) => void;
  onBrowseAll: () => void;
  onLaunch: () => void;
  onStop: () => void;
};

export function HomeView({
  config,
  recent,
  selected,
  progress,
  percent,
  logs,
  busy,
  running,
  consoleRef,
  onSelectVersion,
  onUsername,
  onBrowseAll,
  onLaunch,
  onStop,
}: Props) {

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-art" aria-hidden="true">
          <div className="hero-skyline" />
        </div>

        <div className="hero-body">
          <div className="hero-copy">
            <div className="hero-chips">
              <span className="chip green">{selected?.type ?? 'no version'}</span>
              <span className="chip">{config?.ramMb ?? 0} MB heap</span>
            </div>
            <h2 className="hero-title">{selected?.id ?? 'Pick a version'}</h2>
            <p className="hero-sub">
              {selected
                ? `Minecraft ${selected.id} · released ${shortDate(selected.releaseTime)}`
                : 'Choose a Minecraft version to get started.'}
            </p>
          </div>

          <div className="hero-actions">
            {running ? (
              <button type="button" className="btn-primary big danger" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary big"
                disabled={busy || !config?.versionId}
                onClick={onLaunch}
              >
                {busy ? 'Launching…' : 'Play'}
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
          </div>
        </div>

        <div className="hero-meta">
          <label className="hero-cell">
            <span>Player</span>
            <input
              value={config?.username ?? ''}
              maxLength={16}
              spellCheck={false}
              placeholder="Steve"
              onChange={(event) => onUsername(event.target.value)}
            />
          </label>
          <div className="hero-cell">
            <span>Memory</span>
            <strong>{config ? `${config.ramMb} MB` : '—'}</strong>
          </div>
          <div className="hero-cell">
            <span>Java</span>
            <strong>{config?.javaPath ? 'Custom' : 'Auto-detect'}</strong>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Recently played</h2>
          <button type="button" className="link" onClick={onBrowseAll}>
            All instances
          </button>
        </div>
        <div className="card-grid">
          {recent.length === 0 ? (
            <p className="empty">
              No instances played yet. Pick a version in Versions and press Play - it shows up here.
            </p>
          ) : (
            recent.map(({ version, playedAt }) => (
              <button
                type="button"
                key={version.id}
                className={version.id === config?.versionId ? 'vcard selected' : 'vcard'}
                onClick={() => onSelectVersion(version.id)}
              >
                <span
                  className={`vcard-banner ${version.loader ?? version.type}`}
                  aria-hidden="true"
                />
                <span className="vcard-body">
                  <span className="chip subtle">{version.loader ?? version.type}</span>
                  <strong className="vcard-id">{version.id}</strong>
                  <span className="vcard-date">played {timeAgo(playedAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="panel console-panel">
        <div className="panel-head">
          <h2 className="panel-title">Console</h2>
          <span className="panel-meta">{logs.length ? `${logs.length} lines` : 'empty'}</span>
        </div>
        <div className="console" ref={consoleRef}>
          {logs.length === 0 ? (
            <p className="console-empty">Game and installer output appears here.</p>
          ) : (
            logs.map((line, index) => (
              <div className="console-line" key={`${index}-${line.slice(0, 20)}`}>
                {line}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
