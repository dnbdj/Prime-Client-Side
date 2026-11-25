import type { ReactNode } from 'react';
import type { VersionSummary } from '../../shared/api';
import { shortDate } from '../format';

type Props = {
  versions: VersionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: ReactNode;
};

function swatchClass(type: string): string {
  if (type === 'release') return 'swatch release';
  if (type === 'snapshot') return 'swatch snapshot';
  return 'swatch other';
}

export function VersionTable({ versions, selectedId, onSelect, empty }: Props) {
  return (
    <div className="vlist">
      {versions.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        versions.map((version) => (
          <button
            type="button"
            key={version.id}
            className={version.id === selectedId ? 'vrow selected' : 'vrow'}
            onClick={() => onSelect(version.id)}
          >
            <span className={swatchClass(version.type)} aria-hidden="true" />
            <span className="v-id">{version.id}</span>
            <span className="v-type">{version.type}</span>
            <span className="v-date">{shortDate(version.releaseTime)}</span>
          </button>
        ))
      )}
    </div>
  );
}
