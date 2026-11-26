import { useEffect, useMemo, useRef, useState } from 'react';
import type { InstanceEntry, ModSearchResult, PrimeConfig, VersionSummary } from '../../shared/api';
import type { InstanceCard } from '../views/InstancesView';

type PageId = 'home' | 'instances' | 'logs' | 'settings';

type Props = {
  query: string;
  versions: VersionSummary[];
  instances: InstanceCard[];
  config: PrimeConfig | null;
  onClose: () => void;
  onOpenInstance: (entry: InstanceEntry) => void;
  onPickVersion: (version: VersionSummary) => void;
  onNavigate: (view: PageId) => void;
};

const PAGES: { id: PageId; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: 'Pick a version and drop in' },
  { id: 'instances', label: 'Instances', hint: 'Your Minecraft builds' },
  { id: 'logs', label: 'Logs', hint: 'Sessions, filters and history' },
  { id: 'settings', label: 'Settings', hint: 'Accounts, Java, updates and mods' },
];

function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export function GlobalSearch({
  query,
  versions,
  instances,
  config,
  onClose,
  onOpenInstance,
  onPickVersion,
  onNavigate,
}: Props) {
  const needle = query.trim().toLowerCase();
  const [mods, setMods] = useState<ModSearchResult[]>([]);
  const [modsLoading, setModsLoading] = useState(false);
  const [modsError, setModsError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const ticket = useRef(0);

  // Mods install into the instance the app is pointed at, so results stay useful.
  const target = useMemo(
    () => instances.find((card) => card.version.id === config?.versionId) ?? instances[0] ?? null,
    [config?.versionId, instances],
  );

  const pages = useMemo(
    () => PAGES.filter((page) => `${page.label} ${page.hint}`.toLowerCase().includes(needle)),
    [needle],
  );

  const instanceHits = useMemo(
    () =>
      instances
        .filter((card) =>
          `${card.entry.name} ${card.entry.versionId} ${card.entry.loader}`
            .toLowerCase()
            .includes(needle),
        )
        .slice(0, 5),
    [instances, needle],
  );

  const versionHits = useMemo(
    () => versions.filter((version) => version.id.toLowerCase().includes(needle)).slice(0, 6),
    [needle, versions],
  );

  const targetId = target?.entry.id ?? null;
  const targetVersion = target?.version.id ?? null;
  const targetLoader = target?.entry.loader ?? null;

  useEffect(() => {
    if (!targetId || !targetVersion || !targetLoader || needle.length < 2) {
      setMods([]);
      setModsError(null);
      setModsLoading(false);
      return;
    }
    const ticketId = ++ticket.current;
    setModsLoading(true);
    setModsError(null);
    const timer = window.setTimeout(() => {
      window.prime
        .searchMods('modrinth', needle, targetVersion, targetLoader)
        .then((response) => {
          if (ticketId !== ticket.current) return;
          setMods(response.results.slice(0, 6));
          if (!response.ok) setModsError(response.error ?? 'Modrinth search failed.');
        })
        .catch((error: unknown) => {
          if (ticketId !== ticket.current) return;
          setMods([]);
          setModsError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (ticketId === ticket.current) setModsLoading(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [needle, targetId, targetLoader, targetVersion]);

  useEffect(() => {
    if (!installed) return;
    const timer = window.setTimeout(() => setInstalled(null), 4000);
    return () => window.clearTimeout(timer);
  }, [installed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Enter') return;
      const instance = instanceHits[0];
      if (instance) {
        onOpenInstance(instance.entry);
        return;
      }
      const version = versionHits[0];
      if (version) {
        onPickVersion(version);
        return;
      }
      const page = pages[0];
      if (page) onNavigate(page.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [instanceHits, onClose, onNavigate, onOpenInstance, onPickVersion, pages, versionHits]);

  const install = async (result: ModSearchResult) => {
    if (!target) return;
    setInstalling(result.id);
    setModsError(null);
    try {
      const response = await window.prime.installMod(
        result.provider,
        result.id,
        target.entry.id,
        target.entry.versionId,
      );
      if (!response.ok) {
        setModsError(response.error ?? 'Download failed.');
        return;
      }
      setInstalled(`Installed ${response.file?.name ?? result.name} into ${target.entry.name}`);
    } catch (error) {
      setModsError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(null);
    }
  };

  const empty =
    pages.length === 0 &&
    instanceHits.length === 0 &&
    versionHits.length === 0 &&
    mods.length === 0 &&
    !modsLoading;

  return (
    <div className="search-panel" role="dialog" aria-label="Search results">
      <div className="search-panel-body">
        {pages.length > 0 ? (
          <section className="search-group">
            <h4>Pages</h4>
            {pages.map((page) => (
              <button
                key={page.id}
                type="button"
                className="search-row"
                onClick={() => onNavigate(page.id)}
              >
                <span className="search-row-text">
                  <strong>{page.label}</strong>
                  <span className="search-row-sub">{page.hint}</span>
                </span>
                <span className="search-row-kind">Page</span>
              </button>
            ))}
          </section>
        ) : null}

        {instanceHits.length > 0 ? (
          <section className="search-group">
            <h4>Instances</h4>
            {instanceHits.map((card) => (
              <button
                key={card.entry.id}
                type="button"
                className="search-row"
                onClick={() => onOpenInstance(card.entry)}
              >
                <span className="search-row-text">
                  <strong>{card.entry.name}</strong>
                  <span className="search-row-sub">
                    {card.entry.versionId} · {card.entry.loader}
                  </span>
                </span>
                <span className="search-row-kind">Instance</span>
              </button>
            ))}
          </section>
        ) : null}

        {versionHits.length > 0 ? (
          <section className="search-group">
            <h4>Versions</h4>
            {versionHits.map((version) => (
              <button
                key={version.id}
                type="button"
                className="search-row"
                onClick={() => onPickVersion(version)}
              >
                <span className="search-row-text">
                  <strong>{version.id}</strong>
                  <span className="search-row-sub">{version.type}</span>
                </span>
                <span className="search-row-kind">Version</span>
              </button>
            ))}
          </section>
        ) : null}

        <section className="search-group">
          <h4>
            Mods on Modrinth
            {target ? <span className="search-group-note"> · {target.entry.name}</span> : null}
          </h4>
          {!target ? (
            <p className="search-note">Add an instance first to search and install mods.</p>
          ) : needle.length < 2 ? (
            <p className="search-note">Type two letters or more to search Modrinth.</p>
          ) : modsLoading ? (
            <p className="search-note">Searching Modrinth…</p>
          ) : modsError ? (
            <p className="search-note danger-text">{modsError}</p>
          ) : mods.length === 0 ? (
            <p className="search-note">
              No mods matched {target.version.id} on {target.entry.loader}.
            </p>
          ) : (
            mods.map((result) => (
              <div className="search-mod" key={result.id}>
                <button
                  type="button"
                  className="search-row"
                  onClick={() => void window.prime.openExternal(result.url)}
                >
                  <span className="search-mod-icon" aria-hidden="true">
                    {result.iconUrl ? (
                      <img src={result.iconUrl} alt="" />
                    ) : (
                      result.name.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="search-row-text">
                    <strong>{result.name}</strong>
                    <span className="search-row-sub">{result.summary}</span>
                    <span className="search-row-sub">
                      {result.author || 'unknown'} · {formatDownloads(result.downloads)} downloads
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="btn-ghost small"
                  disabled={installing !== null}
                  onClick={() => void install(result)}
                >
                  {installing === result.id ? 'Adding…' : 'Install'}
                </button>
              </div>
            ))
          )}
          {installed ? <p className="search-note success-text">{installed}</p> : null}
        </section>

        {empty ? (
          <p className="search-note">Nothing matched “{query.trim()}”.</p>
        ) : null}
      </div>

      <div className="search-foot">
        <span>
          {target
            ? `Mod installs land in ${target.entry.name}`
            : 'Search pages, instances and versions'}
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
      </div>
    </div>
  );
}
