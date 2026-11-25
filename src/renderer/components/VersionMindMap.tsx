import { useEffect, useMemo, useRef, useState } from 'react';
import type { VersionSummary } from '../../shared/api';

type MapNode = {
  id: string;
  /** Exact version ids that live at this prefix. */
  versions: string[];
  children: MapNode[];
  /** Newest release time below this node, used for sorting. */
  newest: string;
  /** Versions at this node and below. */
  count: number;
};

const PLAIN = /^\d+(\.\d+)*$/;

/** BTA ids carry a bta- prefix so they cannot collide with Minecraft versions. */
const displayLabel = (id: string): string => (id.startsWith('bta-') ? `BTA ${id.slice(4)}` : id);

/** 26.3 -> 26, 1.21.4 -> 1.21, snapshots -> Snapshots. */
function familyOf(id: string): string {
  if (id.startsWith('bta-')) return 'BTA';
  if (!PLAIN.test(id)) return 'Snapshots';
  const parts = id.split('.');
  return parts[0] === '1' && parts.length > 1 ? `1.${parts[1]}` : parts[0];
}

function makeNode(id: string, newest: string): MapNode {
  return { id, versions: [], children: [], newest, count: 0 };
}

function ensure(parent: MapNode, id: string, releaseTime: string): MapNode {
  let node = parent.children.find((child) => child.id === id);
  if (!node) {
    node = makeNode(id, releaseTime);
    parent.children.push(node);
  }
  if (releaseTime > node.newest) node.newest = releaseTime;
  return node;
}

/** Groups the flat manifest into the family tree the map draws. */
export function buildMindMap(versions: VersionSummary[]): MapNode[] {
  const root = makeNode('', '');

  for (const version of versions) {
    const family = familyOf(version.id);
    let node = ensure(root, family, version.releaseTime);

    if (version.id !== family) {
      if (!PLAIN.test(version.id)) {
        node = ensure(node, version.id, version.releaseTime);
      } else {
        const parts = version.id.split('.');
        for (let depth = family.split('.').length + 1; depth < parts.length; depth += 1) {
          node = ensure(node, parts.slice(0, depth).join('.'), version.releaseTime);
        }
        node = ensure(node, version.id, version.releaseTime);
      }
    }

    node.versions.push(version.id);
  }

  const sort = (nodes: MapNode[]): void => {
    nodes.sort((a, b) => b.newest.localeCompare(a.newest));
    for (const node of nodes) {
      sort(node.children);
      node.count = node.versions.length + node.children.reduce((sum, child) => sum + child.count, 0);
    }
  };
  sort(root.children);
  return root.children;
}

function deepestVersion(node: MapNode): string | null {
  if (node.versions[0]) return node.versions[0];
  return node.children[0] ? deepestVersion(node.children[0]) : null;
}

type Props = {
  versions: VersionSummary[];
  /** Open branch labels, family first: ['26', '26.1']. */
  path: string[];
  onPath: (path: string[]) => void;
  pending: string | null;
  activeId: string | null;
  onPick: (id: string | null) => void;
  empty: string;
};

export function VersionMindMap({
  versions,
  path,
  onPath,
  pending,
  activeId,
  onPick,
  empty,
}: Props) {
  const nodes = useMemo(() => buildMindMap(versions), [versions]);
  const family = nodes.find((node) => node.id === path[0]) ?? null;
  const minor = family?.children.find((node) => node.id === path[1]) ?? null;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [links, setLinks] = useState<{ d: string; hot: boolean }[]>([]);

  // Curves are measured after layout so they follow the real node rows.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let frame = 0;

    const draw = () => {
      const box = wrap.getBoundingClientRect();
      const drawn: { d: string; hot: boolean }[] = [];
      wrap.querySelectorAll<HTMLElement>('[data-mm-parent]').forEach((child) => {
        const parent = wrap.querySelector<HTMLElement>(
          `[data-mm-key="${child.dataset.mmParent ?? ''}"]`,
        );
        if (!parent) return;
        const from = parent.getBoundingClientRect();
        const to = child.getBoundingClientRect();
        const x1 = from.right - box.left + wrap.scrollLeft;
        const y1 = from.top - box.top + from.height / 2 + wrap.scrollTop;
        const x2 = to.left - box.left + wrap.scrollLeft;
        const y2 = to.top - box.top + to.height / 2 + wrap.scrollTop;
        const bend = Math.max(18, (x2 - x1) / 2);
        drawn.push({
          d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          hot: child.dataset.mmHot === '1',
        });
      });
      setLinks(drawn);
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(wrap);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [nodes, path, pending, versions]);

  const leafClass = (id: string | null): string =>
    [
      'mm-node',
      'leaf',
      id === activeId ? 'active' : '',
      id === pending ? 'pending' : '',
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div className="mindmap" ref={wrapRef}>
      <svg className="mindmap-links" aria-hidden="true">
        {links.map((link, index) => (
          <path key={index} d={link.d} className={link.hot ? 'hot' : undefined} />
        ))}
      </svg>

      <div className="mm-col mm-col-root">
        <span className="mm-root" data-mm-key="minecraft">
          Minecraft
        </span>
      </div>

      <div className="mm-col">
        <span className="mm-col-title">Release</span>
        {nodes.length === 0 ? <p className="empty">{empty}</p> : null}
        {nodes.map((node) => {
          const open = node.id === family?.id;
          const isLeaf = node.children.length === 0;
          return (
            <button
              key={node.id}
              type="button"
              data-mm-key={`fam:${node.id}`}
              data-mm-parent="minecraft"
              data-mm-hot={open ? '1' : undefined}
              className={[
                'mm-node',
                isLeaf ? 'leaf' : '',
                open ? 'open' : '',
                node.versions[0] === activeId ? 'active' : '',
                node.versions[0] === pending ? 'pending' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                if (isLeaf) {
                  onPick(node.versions[0] ?? null);
                  return;
                }
                onPath([node.id]);
                onPick(null);
              }}
            >
              <span className="mm-label">{displayLabel(node.id)}</span>
              {isLeaf ? null : <span className="mm-count">{node.count}</span>}
              {isLeaf ? null : (
                <span className="mm-caret" aria-hidden="true">
                  &rsaquo;
                </span>
              )}
            </button>
          );
        })}
      </div>

      {family && family.children.length > 0 ? (
        <div className="mm-col">
          <span className="mm-col-title">{family.id} builds</span>
          {/* A family can be a version itself (1.13), and expanding it would
              otherwise leave that version impossible to pick. */}
          {family.versions.map((id) => (
            <button
              key={`base:${id}`}
              type="button"
              data-mm-key={`pat:${id}`}
              data-mm-parent={`fam:${family.id}`}
              className={leafClass(id)}
              onClick={() => onPick(id)}
            >
              <span className="mm-label">{displayLabel(id)}</span>
              <span className="mm-tag">base</span>
            </button>
          ))}
          {family.children.map((node) => {
            const open = node.id === minor?.id;
            const isLeaf = node.children.length === 0;
            const target = deepestVersion(node);
            return (
              <button
                key={node.id}
                type="button"
                data-mm-key={`min:${node.id}`}
                data-mm-parent={`fam:${family.id}`}
                data-mm-hot={open ? '1' : undefined}
                className={
                  isLeaf
                    ? leafClass(target)
                    : ['mm-node', open ? 'open' : ''].filter(Boolean).join(' ')
                }
                onClick={() => {
                  if (isLeaf) {
                    onPick(target);
                    return;
                  }
                  onPath([family.id, node.id]);
                  onPick(null);
                }}
              >
                <span className="mm-label">{displayLabel(node.id)}</span>
                {isLeaf ? null : <span className="mm-count">{node.count}</span>}
                {isLeaf ? null : (
                  <span className="mm-caret" aria-hidden="true">
                    &rsaquo;
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {minor && minor.children.length > 0 ? (
        <div className="mm-col">
          <span className="mm-col-title">{minor.id} patches</span>
          {minor.versions.map((id) => (
            <button
              key={`base:${id}`}
              type="button"
              data-mm-key={`pat:${id}`}
              data-mm-parent={`min:${minor.id}`}
              className={leafClass(id)}
              onClick={() => onPick(id)}
            >
              <span className="mm-label">{displayLabel(id)}</span>
              <span className="mm-tag">base</span>
            </button>
          ))}
          {minor.children.map((node) => {
            const target = deepestVersion(node);
            return (
              <button
                key={node.id}
                type="button"
                data-mm-key={`pat:${node.id}`}
                data-mm-parent={`min:${minor.id}`}
                className={leafClass(target)}
                onClick={() => onPick(target)}
              >
                <span className="mm-label">{displayLabel(node.id)}</span>
                {node.children.length > 0 ? (
                  <span className="mm-tag">{node.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
