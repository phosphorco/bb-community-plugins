import { MAX_ATTACHED_ANNOTATIONS } from "./attachment.ts";

/** Ignore responses from requests superseded by a newer refresh or unmount. */
export function createLatestRequestGate() {
  let latest = 0;
  return {
    issue: () => ++latest,
    isLatest: (request: number) => request === latest,
    invalidate: () => { latest += 1; },
  };
}

/** Preserve the displayed order, but attach only the exact selection reviewed. */
export function selectExactStagedIds(
  staged: readonly { id: string; seq: number }[],
  displayed: readonly { id: string; seq: number }[],
  selectedIds: ReadonlySet<string>,
  attachedIds: ReadonlySet<string>,
): string[] | null {
  if (selectedIds.size === 0 || selectedIds.size > MAX_ATTACHED_ANNOTATIONS) {
    return null;
  }
  const displayedSeq = new Map(displayed.map(({ id, seq }) => [id, seq]));
  const selected = staged
    .filter(({ id, seq }) =>
      selectedIds.has(id) &&
      !attachedIds.has(id) &&
      displayedSeq.get(id) === seq,
    )
    .map(({ id }) => id);
  return selected.length === selectedIds.size ? selected : null;
}

/** A confirmation owns its own immutable ID snapshot. */
export function snapshotSelection(selectedIds: ReadonlySet<string>): string[] {
  return [...selectedIds];
}
