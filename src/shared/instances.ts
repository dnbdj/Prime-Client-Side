import type { InstanceContent, InstanceEntry, InstanceLoader } from './api';

/** Card accents — dark enough to sit under the striped banner overlay. */
export const INSTANCE_COLORS: { hex: string; label: string }[] = [
  { hex: '#1f7a4d', label: 'Emerald' },
  { hex: '#2a6f97', label: 'Ocean' },
  { hex: '#6b4390', label: 'Grape' },
  { hex: '#a8542f', label: 'Ember' },
  { hex: '#4b5563', label: 'Slate' },
  { hex: '#9d4a63', label: 'Rose' },
  { hex: '#2f7f7a', label: 'Teal' },
  { hex: '#8a6d1f', label: 'Gold' },
];

export const DEFAULT_INSTANCE_COLOR = INSTANCE_COLORS[0].hex;

export const INSTANCE_LOADERS: { id: InstanceLoader; label: string }[] = [
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'modpack', label: 'Modpack' },
];

/** Vanilla is always part of an instance, so it is never false. */
export function defaultContent(content?: Partial<InstanceContent>): InstanceContent {
  return {
    vanilla: true,
    mods: content?.mods ?? false,
    primeMod: content?.primeMod ?? false,
  };
}

/**
 * Fills in everything an instance record needs. Used for instances the launcher
 * recorded itself (a launch or a loader install) as well as for old configs
 * that only stored version id strings.
 */
export function defaultInstance(versionId: string, extra: Partial<InstanceEntry> = {}): InstanceEntry {
  return {
    versionId,
    name: extra.name?.trim() || versionId,
    color: extra.color ?? DEFAULT_INSTANCE_COLOR,
    loader: extra.loader ?? 'vanilla',
    content: defaultContent(extra.content),
    createdAt: extra.createdAt ?? new Date().toISOString(),
    ...(extra.gameDir ? { gameDir: extra.gameDir } : {}),
  };
}

/** Reads instances from config, accepting both records and legacy version ids. */
export function normalizeInstances(value: unknown): InstanceEntry[] {
  if (!Array.isArray(value)) return [];
  const instances: InstanceEntry[] = [];
  for (const raw of value) {
    if (typeof raw === 'string') {
      if (raw.length > 0) instances.push(defaultInstance(raw));
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Partial<InstanceEntry>;
    if (typeof record.versionId !== 'string' || record.versionId.length === 0) continue;
    instances.push(defaultInstance(record.versionId, record));
  }
  return instances;
}
