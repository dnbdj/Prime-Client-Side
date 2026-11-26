import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from '../components/Icon';
import { timeAgo } from '../format';

export type LogSession = {
  id: string;
  title: string;
  detail: string;
  startedAt: string;
  endedAt: string | null;
  lines: string[];
};

type Props = {
  live: LogSession;
  sessions: LogSession[];
  running: boolean;
  tabs: string[];
  activeId: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpen: (id: string) => void;
  onClear: () => void;
};

type Level = 'error' | 'warn' | 'prime' | 'dim' | 'plain';
type Order = 'oldest' | 'latest';
type RecentSort = 'recent' | 'oldest' | 'name';

const ERROR_RE = /\b(error|exception|fatal|failed|failure)\b/i;
const WARN_RE = /\bwarn(ing)?\b/i;

function levelOf(line: string): Level {
  if (ERROR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  const trimmed = line.trimStart();
  if (trimmed.startsWith('[prime]')) return 'prime';
  if (trimmed.startsWith('#')) return 'dim';
  return 'plain';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function countErrors(lines: string[]): number {
  let total = 0;
  for (const line of lines) if (levelOf(line) === 'error') total += 1;
  return total;
}

export function LogsView({
  live,
  sessions,
  running,
  tabs,
  activeId,
  onActivate,
  onCloseTab,
  onOpen,
  onClear,
}: Props) {
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState<Order>('oldest');
  const [recentSort, setRecentsSort] = useState<RecentSort>('recent');
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => [live, ...sessions], [live, sessions]);
  const active = all.find((session) => session.id === activeId) ?? live;

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = active.lines.map((line, index) => ({ line, index }));
    const matched = needle
      ? list.filter((row) => row.line.toLowerCase().includes(needle))
      : list;
    return order === 'latest' ? [...matched].reverse() : matched;
  }, [active.lines, filter, order]);

  const errors = useMemo(() => countErrors(active.lines), [active.lines]);

  const recents = useMemo(() => {
    const list = [...sessions];
    if (recentSort === 'name') list.sort((a, b) => a.title.localeCompare(b.title));
    else if (recentSort === 'oldest') list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    else list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return list;
  }, [sessions, recentSort]);

  const openTabs = useMemo(() => {
    const list: LogSession[] = [];
    for (const id of tabs) {
      const session = all.find((candidate) => candidate.id === id);
      if (session && !list.some((entry) => entry.id === session.id)) list.push(session);
    }
    if (!list.some((entry) => entry.id === 'live')) list.unshift(live);
    return list;
  }, [all, live, tabs]);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    // Follow the tail only when the newest line is at the bottom and nothing is filtered out.
    if (order !== 'oldest' || filter.trim()) return;
    node.scrollTop = node.scrollHeight;
  }, [active.lines, order, filter, activeId]);

  const copy = useCallback(() => {
    const text = rows.map((row) => row.line).join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }, [rows]);

  const label = rows.length === active.lines.length
    ? plural(active.lines.length, 'line')
    : `${rows.length} of ${plural(active.lines.length, 'line')}`;

  return (
    <section className="logs-page" aria-label="Logs">
      <div className="logs-browser">
        <div className="logs-tabs" role="tablist" aria-label="Open logs">
          {openTabs.map((session) => {
            const selected = session.id === active.id;
            const isLive = session.id === 'live';
            return (
              <div
                key={session.id}
                className={selected ? 'logs-tab on' : 'logs-tab'}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="logs-tab-label"
                  title={session.title}
                  onClick={() => onActivate(session.id)}
                >
                  <span
                    className={
                      isLive
                        ? running
                          ? 'logs-tab-dot live'
                          : 'logs-tab-dot'
                        : 'logs-tab-dot saved'
                    }
                    aria-hidden="true"
                  />
                  <span className="logs-tab-title">{session.title}</span>
                </button>
                {isLive ? null : (
                  <button
                    type="button"
                    className="logs-tab-close"
                    aria-label={`Close ${session.title}`}
                    onClick={() => onCloseTab(session.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="logs-bar">
          <label className="logs-field">
            <SearchIcon />
            <input
              value={filter}
              spellCheck={false}
              placeholder="Filter lines"
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter ? (
              <button
                type="button"
                className="logs-field-clear"
                aria-label="Clear filter"
                onClick={() => setFilter('')}
              >
                ×
              </button>
            ) : null}
          </label>
          <div className="logs-tools">
            <select
              value={order}
              aria-label="Line order"
              onChange={(event) => setOrder(event.target.value as Order)}
            >
              <option value="oldest">Oldest first</option>
              <option value="latest">Latest first</option>
            </select>
            <button
              type="button"
              className="btn-ghost"
              disabled={rows.length === 0}
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={active.id !== 'live' || active.lines.length === 0}
              onClick={onClear}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="logs-meta">
          <span className={active.id === 'live' && running ? 'chip green' : 'chip subtle'}>
            {active.id === 'live' ? (running ? 'Live' : 'Ready') : 'Saved'}
          </span>
          <strong className="logs-meta-title">{active.title}</strong>
          <span className="logs-meta-sep" aria-hidden="true">·</span>
          <span>{active.detail}</span>
          {active.endedAt ? (
            <span className="logs-meta-time">{timeAgo(active.endedAt)}</span>
          ) : null}
          <span className="logs-meta-right">
            {label}
            {errors > 0 ? ` · ${plural(errors, 'error')}` : ''}
          </span>
        </div>

        <div className="logs-split">
          <aside className="logs-recents" aria-label="Recently viewed">
            <div className="logs-recents-head">
              <h3>Recently viewed</h3>
              <select
                value={recentSort}
                aria-label="Sort recently viewed"
                onChange={(event) => setRecentsSort(event.target.value as RecentSort)}
              >
                <option value="recent">Recent first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
            <div className="logs-recents-list">
              {recents.length === 0 ? (
                <p className="logs-recents-empty">
                  Earlier runs land here once a new launch starts or you clear the live tab.
                </p>
              ) : (
                recents.map((session) => {
                  const bad = countErrors(session.lines) > 0;
                  return (
                    <button
                      type="button"
                      key={session.id}
                      className={session.id === active.id ? 'logs-recent on' : 'logs-recent'}
                      onClick={() => onOpen(session.id)}
                    >
                      <span
                        className={bad ? 'logs-recent-dot bad' : 'logs-recent-dot'}
                        aria-hidden="true"
                      />
                      <span className="logs-recent-text">
                        <span className="logs-recent-title">{session.title}</span>
                        <span className="logs-recent-sub">
                          {timeAgo(session.startedAt)} · {plural(session.lines.length, 'line')}
                          {bad ? ' · errors' : ''}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <div className="logs-log" ref={logRef}>
            {rows.length === 0 ? (
              <p className="logs-empty">
                {active.lines.length === 0
                  ? 'Nothing here yet. Launch the game and its output lands in this tab.'
                  : `No lines match “${filter.trim()}”.`}
              </p>
            ) : (
              rows.map((row) => (
                <div
                  className={`log-line ${levelOf(row.line)}`}
                  key={`${row.index}-${row.line.slice(0, 24)}`}
                >
                  <span className="log-index">{row.index + 1}</span>
                  <span className="log-text">{row.line}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
