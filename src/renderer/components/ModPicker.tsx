import { useEffect, useRef, useState } from 'react';
import type { InstanceEntry, ModProvider, ModSearchResult } from '../../shared/api';

type Props = {
  entry: InstanceEntry;
  onClose: () => void;
  onInstalled: () => void;
};

const PROVIDERS: { id: ModProvider; label: string; hint: string }[] = [
  { id: 'modrinth', label: 'Modrinth', hint: 'Open mod platform, no key needed' },
  { id: 'curseforge', label: 'CurseForge', hint: 'Needs an API key in Settings' },
];

function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ModPicker({ entry, onClose, onInstalled }: Props) {
  const [provider, setProvider] = useState<ModProvider>('modrinth');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ModSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const requestId = useRef(0);

  const search = async (nextProvider: ModProvider, nextQuery: string) => {
    const ticket = ++requestId.current;
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const response = await window.prime.searchMods(
        nextProvider,
        nextQuery,
        entry.versionId,
        entry.loader,
      );
      if (ticket !== requestId.current) return;
      setResults(response.results);
      if (!response.ok) setError(response.error ?? 'Search failed.');
    } catch (err) {
      if (ticket !== requestId.current) return;
      setError(describe(err));
    } finally {
      if (ticket === requestId.current) setLoading(false);
    }
  };

  // Open on a useful page of results instead of an empty box.
  useEffect(() => {
    void search('modrinth', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.versionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const chooseProvider = (next: ModProvider) => {
    setProvider(next);
    setInstalled(null);
    void search(next, query);
  };

  const install = async (result: ModSearchResult) => {
    setInstalling(result.id);
    setError(null);
    setInstalled(null);
    try {
      const response = await window.prime.installMod(
        result.provider,
        result.id,
        entry.id,
        entry.versionId,
      );
      if (!response.ok) {
        setError(response.error ?? 'Download failed.');
        return;
      }
      setInstalled(response.file?.name ?? 'Mod');
      onInstalled();
    } catch (err) {
      setError(describe(err));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal mod-picker"
        role="dialog"
        aria-modal="true"
        aria-label={`Add mods to ${entry.name}`}
      >
        <div className="modal-head">
          <div>
            <h2>Add mods</h2>
            <p className="note">
              {entry.name} · {entry.versionId}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="modal-tabs" role="tablist" aria-label="Mod source">
          {PROVIDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={provider === option.id}
              className={provider === option.id ? 'modal-tab on' : 'modal-tab'}
              title={option.hint}
              onClick={() => chooseProvider(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <form
          className="mod-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search(provider, query);
          }}
        >
          <input
            value={query}
            spellCheck={false}
            placeholder={`Search ${provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} mods…`}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" className="btn-primary small" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {installed ? (
          <p className="note success-text" role="status">
            Installed {installed} into this instance's mods folder.
          </p>
        ) : null}
        {error ? (
          <p className="note error-text" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mod-results">
          {loading ? (
            <p className="empty">Looking for mods…</p>
          ) : results.length === 0 && !error ? (
            <p className="empty">
              No mods matched. Try a different search, or check the instance's game version.
            </p>
          ) : (
            <ul>
              {results.map((result) => (
                <li className="mod-result" key={`${result.provider}-${result.id}`}>
                  <span className="mod-result-icon" aria-hidden="true">
                    {result.iconUrl ? <img src={result.iconUrl} alt="" /> : result.name.slice(0, 1)}
                  </span>
                  <div className="mod-result-text">
                    <strong>{result.name}</strong>
                    <span className="mod-result-summary">{result.summary}</span>
                    <span className="mod-result-meta">
                      {result.author || 'unknown'} · {formatDownloads(result.downloads)} downloads
                    </span>
                  </div>
                  <div className="mod-result-actions">
                    <button
                      type="button"
                      className="btn-primary small"
                      disabled={installing !== null}
                      onClick={() => void install(result)}
                    >
                      {installing === result.id ? 'Adding…' : 'Install'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => void window.prime.openExternal(result.url)}
                    >
                      Page
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="note">
          Downloads land directly in this instance's mods folder. Modrinth works out of the box;
          CurseForge needs its API key in Settings → Game.
        </p>
      </section>
    </div>
  );
}
