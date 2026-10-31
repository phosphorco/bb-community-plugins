import { occurrenceGroupKey, suppressesGeneric } from '@phosphorco/bb-turn-results';
import type { GalleryObservation } from './index.ts';
export type ProjectedResult = { kind: 'single'; key: string; row: GalleryObservation }
  | { kind: 'contested'; key: string; rows: GalleryObservation[] };
/** Selection changes presentation only. Routine native diagnostics stay indexed. */
function meaningful(row: GalleryObservation): boolean {
  const value = row.resolution, kind = row.identity.ref.kind;
  if (kind === 'workspace/command-completed' && (!value || value.route.kind === 'source' || value.route.kind === 'unavailable')) return false;
  const deliberate = Boolean(value && (value.fallback.kind === 'image' || value.route.kind === 'file' || value.presentation
    || value.knowledge === 'confirmed' && value.outcomeEvidence?.kind === 'external-success'));
  if (kind === 'workspace/address-observed' || kind === 'links/url-found' || row.identity.evidence.basis === 'text-link'
    || row.identity.specificity === 'generic' && !deliberate) {
    return Boolean(value && value.route.kind === 'url' && value.provenance.originHost.state === 'recorded'
      && value.availability.state === 'available' && row.currentAvailability?.state === 'available' && !row.sourceExpired);
  }
  return true;
}
/** Equivalence is event/operation/kind scoped, never URL or artifact dedup.
 * Retain every owner-bound observation; suppression affects presentation only. */
export function projectResults(observations: readonly GalleryObservation[]): ProjectedResult[] {
  if (observations.length > 64) throw Error('Projection requires bounded continuation.');
  const rows = observations.filter(row => !row.retracted && meaningful(row));
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
