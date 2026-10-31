import { occurrenceGroupKey, suppressesGeneric } from '@phosphorco/bb-turn-results';
import type { GalleryObservation } from './index.ts';
export type ProjectedResult = { kind: 'single'; key: string; row: GalleryObservation }
  | { kind: 'contested'; key: string; rows: GalleryObservation[] };
/** Equivalence is event/operation/kind scoped, never URL or artifact dedup.
 * Retain every owner-bound observation; suppression affects presentation only. */
export function projectResults(observations: readonly GalleryObservation[]): ProjectedResult[] {
  if (observations.length > 64) throw Error('Projection requires bounded continuation.');
  const rows = observations.filter(row => !row.retracted);
  const typed = rows.filter(row => row.identity.specificity === 'typed' && row.resolution && !row.sourceExpired);
  const visible = rows.filter(row => row.identity.specificity !== 'generic'
    || !typed.some(candidate => suppressesGeneric(candidate.identity, row.identity)));
  const groups = new Map<string, GalleryObservation[]>();
  for (const row of visible) {
    const key = occurrenceGroupKey(row.owner, row.identity), group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => new Set(group.map(row => row.owner)).size > 1
    ? { kind: 'contested' as const, key, rows: group }
    : { kind: 'single' as const, key, row: group[0]! });
}
