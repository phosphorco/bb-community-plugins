/** Sparse public timeline DTO selection; never derive or parse native row IDs. */
export interface ProbeRow {
  id: string;
  threadId: string;
  turnId: string | null;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  kind: string;
  role?: string;
  status?: string | null;
}
export interface Anchor {
  threadId: string;
  turnId: string;
  rowId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  historySnapshot: string;
}
export function chooseAnchor(rows: readonly ProbeRow[], threadId: string, turnId: string,
  eventSeq: number, historySnapshot: string): Anchor {
  if (!historySnapshot || rows.length > 1000) throw new Error('Timeline snapshot unavailable or over probe bound.');
  const ids = new Set<string>();
  let last: ProbeRow | undefined;
  let witnessedEventRange = false;
  let closedRange = false;
  for (const row of rows) {
    if (row.threadId !== threadId || !row.id || ids.has(row.id)
      || !Number.isSafeInteger(row.sourceSeqStart) || !Number.isSafeInteger(row.sourceSeqEnd)
      || row.sourceSeqStart < 0 || row.sourceSeqEnd < row.sourceSeqStart) {
      throw new Error('Timeline identity/range mismatch.');
    }
    ids.add(row.id);
    if (row.turnId === turnId) {
      if (closedRange) throw new Error('Turn is interleaved; probe needs a different anchor.');
      last = row;
      witnessedEventRange ||= row.sourceSeqStart <= eventSeq && row.sourceSeqEnd >= eventSeq;
    } else if (last) closedRange = true;
  }
  // Work rows can be transformed into private summary IDs by the native view.
  // Refuse that shape instead of constructing an ID or attaching to a nearby row.
  if (!last || !witnessedEventRange || last.sourceSeqEnd < eventSeq
    || !['turn', 'conversation', 'system'].includes(last.kind)
    || (last.kind === 'conversation' && last.role !== 'assistant')) {
    throw new Error('No exact public terminal anchor for this turn in the bounded snapshot.');
  }
  return { threadId, turnId, rowId: last.id, sourceSeqStart: last.sourceSeqStart,
    sourceSeqEnd: last.sourceSeqEnd, historySnapshot };
}
