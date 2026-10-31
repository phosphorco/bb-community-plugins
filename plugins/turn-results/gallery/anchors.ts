import { canonicalByteLength } from '@phosphorco/bb-turn-results';
import type { Anchor, ProbeRow } from '../probe/anchor.ts';

/** Exact terminal placement plus a separately witnessed full-turn discovery scope. */
export interface GalleryAnchor extends Anchor { turnSeqStart: number; turnSeqEnd: number }

/** Contiguous public-row segments only. A page beginning inside a turn defers
 * that turn. Overlapping foreign ranges/interleaved turns cannot widen discovery. */
export function galleryAnchors(rows: readonly ProbeRow[], threadId: string, snapshot: string, historyStart: boolean): GalleryAnchor[] {
  if (rows.length > 1000 || !snapshot || rows.some(row => row.threadId !== threadId)) throw Error('Invalid timeline snapshot.');
  const ids = new Set<string>();
  const segments: { turnId: string | null; first: number; start: number; end: number; ordered: boolean }[] = [];
  const counts = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    if (!row.id || ids.has(row.id) || !Number.isSafeInteger(row.sourceSeqStart) || !Number.isSafeInteger(row.sourceSeqEnd)
      || row.sourceSeqStart < 0 || row.sourceSeqEnd < row.sourceSeqStart || row.sourceSeqEnd >= Number.MAX_SAFE_INTEGER) throw Error('Invalid timeline range.');
    ids.add(row.id);
    const prior = segments.at(-1);
    if (prior && prior.turnId === row.turnId) {
      prior.ordered &&= row.sourceSeqStart >= rows[index - 1]!.sourceSeqStart;
      prior.start = Math.min(prior.start, row.sourceSeqStart); prior.end = Math.max(prior.end, row.sourceSeqEnd);
    } else {
      segments.push({ turnId: row.turnId, first: index, start: row.sourceSeqStart, end: row.sourceSeqEnd, ordered: true });
      if (row.turnId) counts.set(row.turnId, (counts.get(row.turnId) ?? 0) + 1);
    }
  }
  const suffixStart = new Array<number>(segments.length + 1).fill(Infinity);
  for (let i = segments.length - 1; i >= 0; i--) suffixStart[i] = Math.min(segments[i]!.start, suffixStart[i + 1]!);
  const anchors: GalleryAnchor[] = [];
  let previousEnd = -1;
  for (const [index, segment] of segments.entries()) {
    const { turnId, first, start, end, ordered } = segment;
    if (turnId && counts.get(turnId) === 1 && ordered && (first > 0 || historyStart)
      && start > previousEnd && end < suffixStart[index + 1]!) {
      const last = rows[(segments[index + 1]?.first ?? rows.length) - 1]!;
      if (['turn', 'conversation', 'system'].includes(last.kind) && last.status !== 'pending'
        && (last.kind !== 'conversation' || last.role === 'assistant')) {
        anchors.push({ threadId, turnId, rowId: last.id, sourceSeqStart: last.sourceSeqStart,
          sourceSeqEnd: last.sourceSeqEnd, historySnapshot: snapshot, turnSeqStart: start, turnSeqEnd: end });
      }
    }
    previousEnd = Math.max(previousEnd, end);
  }
  return anchors;
}

export class GalleryBoundaryError extends Error {}

export const GALLERY_HISTORY_LIMITS = Object.freeze({ targets: 20, pages: 4, chainPages: 8, segments: 100, rows: 1000, bytes: 1048576 });
export interface GalleryTimelinePage {
  rows: readonly ProbeRow[];
  completedTurnDisplay?: string;
  timelinePage: { historySnapshot: string; olderCursor: { anchorId: string; anchorSeq: number } | null };
}
export interface GalleryTimelinePort {
  timeline(input: { threadId: string; includeNestedRows: 'false'; segmentLimit: string;
    beforeAnchorId?: string; beforeAnchorSeq?: string; deferContent: 'true'; signal: AbortSignal }): Promise<GalleryTimelinePage | { state: 'capacity' }>;
}
/** Only live pane demand advances this public backward cursor, in two finite slices. No native ID
 * parsing, outline/transcript scan, latest-page restart loop, or detached work.
 * A bounded boundary window witnesses complete turns; a very large turn stays
 * unplaced, with continuation, rather than inventing its missing start. */
export function createGalleryAnchorReader(port: GalleryTimelinePort, threadId: string) {
  let window: ProbeRow[] = [], snapshot: string | null = null, display: string | undefined;
  let cursor: { anchorId: string; anchorSeq: number } | null = null, started = false, exhausted = false;
  let lastTargets = new Set<string>();
  const matched = new Map<string, GalleryAnchor>(), ineligible = new Set<string>();
  let generation = 0, chainPages = 0;
  const unresolved = (id: string) => !matched.has(id) && !ineligible.has(id);
  function reset() {
    generation++; window = []; snapshot = null; display = undefined; cursor = null; started = false; exhausted = false;
    matched.clear(); ineligible.clear(); chainPages = 0;
  }
  function invalidate() {
    // An issued older cursor pins its original snapshot/status. Only a latest
    // request can establish a fresh chain after a genuine invalidation. Older
    // targets get only the same bounded two-slice chain, never an automatic sweep.
    reset();
  }
  return { invalidate,
    async read(targets: readonly string[], signal: AbortSignal, restart = false, pageBudget: number = GALLERY_HISTORY_LIMITS.pages) {
      if (!Number.isSafeInteger(pageBudget) || pageBudget < 1 || pageBudget > GALLERY_HISTORY_LIMITS.pages
        || targets.length > GALLERY_HISTORY_LIMITS.targets || targets.some(id => !id || id.length > 1024)
        || new Set(targets).size !== targets.length) throw Error('Invalid gallery history demand.');
      if (restart || targets.some(id => !lastTargets.has(id))) reset();
      lastTargets = new Set(targets);
      for (const id of matched.keys()) if (!lastTargets.has(id)) matched.delete(id);
      for (const id of ineligible) if (!lastTargets.has(id)) ineligible.delete(id);
      const readGeneration = generation;
      let pages = 0, limited = false;
      while (targets.length && !exhausted && targets.some(unresolved) && pages < pageBudget && chainPages < GALLERY_HISTORY_LIMITS.chainPages) {
        signal.throwIfAborted();
        const before = started ? cursor : null;
        const page = await port.timeline({ threadId, includeNestedRows: 'false', segmentLimit: String(GALLERY_HISTORY_LIMITS.segments), deferContent: 'true',
          ...(before ? { beforeAnchorId: before.anchorId, beforeAnchorSeq: String(before.anchorSeq) } : {}), signal });
        signal.throwIfAborted();
        if (readGeneration !== generation) throw Error('Timeline read retired.');
        if ('state' in page) return { anchors: targets.flatMap(id => matched.has(id) ? [matched.get(id)!] : []), continued: true, unplaced: targets.filter(unresolved), checked: targets.filter(id => !unresolved(id) || exhausted), capacity: true, pages, exhausted, automatic: false };
        pages++; chainPages++;
        if (!page.timelinePage.historySnapshot || (snapshot !== null && (page.timelinePage.historySnapshot !== snapshot || page.completedTurnDisplay !== display))) {
          reset(); throw new GalleryBoundaryError('Timeline changed while reading its boundary.');
        }
        if (page.rows.length > GALLERY_HISTORY_LIMITS.rows || page.rows.some(row => row.threadId !== threadId) || new Set(page.rows.map(row => row.id)).size !== page.rows.length) { reset(); throw new GalleryBoundaryError('Timeline page exceeds gallery capacity or scope.'); }
        const next = page.timelinePage.olderCursor;
        if (next && (!next.anchorId || !Number.isSafeInteger(next.anchorSeq) || next.anchorSeq < 0
          || (before && (next.anchorSeq > before.anchorSeq || (next.anchorSeq === before.anchorSeq && next.anchorId === before.anchorId))))) { reset(); throw Error('Timeline cursor did not progress.'); }
        // Store sparse fields only; no Markdown, tool output or nested rows.
        const sparse = page.rows.map(row => ({ id: row.id, threadId: row.threadId, turnId: row.turnId,
          sourceSeqStart: row.sourceSeqStart, sourceSeqEnd: row.sourceSeqEnd, kind: row.kind,
          ...(row.role ? { role: row.role } : {}), ...(row.status ? { status: row.status } : {}) }));
        if (sparse.some(row => row.id.length > 1024 || row.threadId.length > 1024 || (row.turnId?.length ?? 0) > 1024
          || row.kind.length > 128 || (row.role?.length ?? 0) > 32 || (row.status?.length ?? 0) > 32)) {
          return { anchors: targets.flatMap(id => matched.has(id) ? [matched.get(id)!] : []), continued: true,
            unplaced: targets.filter(unresolved), checked: targets.filter(id => !unresolved(id) || exhausted), capacity: true, pages, exhausted, automatic: false };
        }
        try { canonicalByteLength(sparse, GALLERY_HISTORY_LIMITS.bytes); }
        catch { return { anchors: targets.flatMap(id => matched.has(id) ? [matched.get(id)!] : []), continued: true,
          unplaced: targets.filter(unresolved), checked: targets.filter(id => !unresolved(id) || exhausted), capacity: true, pages, exhausted, automatic: false }; }
        snapshot = page.timelinePage.historySnapshot; display = page.completedTurnDisplay;
        const byId = new Map(window.map(row => [row.id, row]));
        for (const row of sparse) byId.set(row.id, row);
        const combined = [...byId.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart || a.sourceSeqEnd - b.sourceSeqEnd);
        limited ||= combined.length > GALLERY_HISTORY_LIMITS.rows;
        let prefix = 0, charge = 2;
        for (const row of combined.slice(0, GALLERY_HISTORY_LIMITS.rows)) {
          const bytes = canonicalByteLength(row, GALLERY_HISTORY_LIMITS.bytes) + 1;
          if (charge + bytes > GALLERY_HISTORY_LIMITS.bytes) break;
          charge += bytes; prefix++;
        }
        limited ||= prefix < combined.length;
        window = combined.slice(0, prefix);
        if (combined.length > window.length) {
          const cut = window.at(-1)?.turnId;
          if (cut && combined[window.length]?.turnId === cut) window = window.filter(row => row.turnId !== cut);
        }
        started = true; cursor = next ? { ...next } : null; exhausted = next === null;
        const anchors = galleryAnchors(window, threadId, snapshot, exhausted);
        for (const anchor of anchors) if (lastTargets.has(anchor.rowId)) matched.set(anchor.rowId, anchor);
        const completeTurns = new Set(anchors.map(anchor => anchor.turnId));
        for (const row of window) if (lastTargets.has(row.id) && !matched.has(row.id)
          && (row.role === 'user' || row.turnId === null || row.status === 'pending' || (row.turnId && completeTurns.has(row.turnId)))) ineligible.add(row.id);
      }
      return { anchors: targets.flatMap(id => matched.has(id) ? [matched.get(id)!] : []),
        continued: targets.some(unresolved) && !exhausted,
        unplaced: targets.filter(unresolved), checked: targets.filter(id => !unresolved(id) || exhausted), capacity: limited || chainPages >= GALLERY_HISTORY_LIMITS.chainPages && targets.some(unresolved) && !exhausted,
        pages, exhausted, automatic: !limited && chainPages === GALLERY_HISTORY_LIMITS.pages && pages === GALLERY_HISTORY_LIMITS.pages
          && targets.some(unresolved) && !exhausted };
    },
  };
}
