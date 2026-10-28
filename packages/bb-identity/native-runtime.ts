/** Public SDK snapshot adapter. No SDK runtime, lifecycle, history store or Contribution fabrication. */
import { decodeSourceActors, nativeMention } from './native-actors-runtime.js';
import type { NativeCoverage, NativeSourceActor, NativeSourceEvent as NativeEvent, NativeHistoryRead, NativeInputLink, NativeSourceAdapter, NativeSourceEvidence, NativeSourceReference, NativeSourceSnapshot, NativeTextEvidence, NativeTimeline } from './native.js';
import type { ProvenanceReader, Result } from './model.js';
import { err, idCodec, ok } from './model-runtime.js';

export const NATIVE_SOURCE_LIMITS = Object.freeze({ events: 2000, rows: 2000, bytes: 2097152, depth: 8, historyReads: 16, identifier: 256, dataDepth: 64 } as const);
const coverage = (reasons: string[], empty = false): NativeCoverage => ({ status: reasons.length ? (empty ? 'unknown' : 'partial') : 'known', reasons: [...new Set(reasons)] });
const unknownLineage = () => ({ status: 'unknown', reason: 'not-established-by-native-source' } as const);
const validId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= NATIVE_SOURCE_LIMITS.identifier;
const seq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const turn = (e: NativeEvent) => e.scope.kind === 'turn' ? e.scope.turnId : null;
/** Copy one data representation without invoking accessors or serialization hooks.
 * Count non-enumerable data too: it must not escape the bound if later consumed. */
function boundedSnapshot(input: NativeSourceSnapshot): NativeSourceSnapshot {
  let bytes = 0;
  const active = new Set<object>();
  const encoder = new TextEncoder();
  function add(text: string): void {
    if (text.length > NATIVE_SOURCE_LIMITS.bytes - bytes) throw new Error('bytes');
    bytes += encoder.encode(text).byteLength;
    if (bytes > NATIVE_SOURCE_LIMITS.bytes) throw new Error('bytes');
  }
  function copy(value: unknown, depth: number): unknown {
    if (depth > NATIVE_SOURCE_LIMITS.dataDepth) throw new Error('data depth');
    if (value === null || value === undefined) { add('null'); return value; }
    if (typeof value === 'string') { add(value); add('""'); return value; }
    if (typeof value === 'boolean') { add(value ? 'true' : 'false'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(String(value)); return value; }
    if (typeof value !== 'object') throw new Error('non-data value');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('non-data prototype');
    if (active.has(value)) throw new Error('cycle');
    active.add(value);
    add(array ? '[]' : '{}');
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    if (array && (value.length > NATIVE_SOURCE_LIMITS.bytes || keys.length !== value.length + 1)) throw new Error('non-dense array');
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('symbol key');
      if (array && key === 'length') continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('non-data array property');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
      add(key); add(':,');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    active.delete(value);
    return result;
  }
  // Public input is typed; the bounded copy preserves those data fields. All used
  // fields still pass semantic validation below, before becoming evidence.
  const stable = copy(input, 0) as NativeSourceSnapshot;
  // Bound the serialized stable representation too, including JSON escape expansion.
  // The copied representation contains no callable hooks or accessors.
  if (encoder.encode(JSON.stringify(stable)).byteLength > NATIVE_SOURCE_LIMITS.bytes) throw new Error('serialized bytes');
  return stable;
}
interface AssistantItemIdentity {
  id: string;
  /** Recorded public parent link; null means absent, not recovered delegation. */
  parentToolCallId: string | null;
  phase: 'commentary' | 'final_answer' | null;
}
function assistantItem(e: NativeEvent): AssistantItemIdentity | null {
  if (e.type !== 'item/agentMessage/delta' && !(e.type === 'item/completed' && e.data.item.type === 'agentMessage')) return null;
  const completed = e.type === 'item/completed' && e.data.item.type === 'agentMessage' ? e.data.item : null;
  const id = completed ? completed.id : e.type === 'item/agentMessage/delta' ? e.data.itemId : null;
  const text = completed ? completed.text : e.type === 'item/agentMessage/delta' ? e.data.delta : null;
  const parent = completed ? completed.parentToolCallId : e.type === 'item/agentMessage/delta' ? e.data.parentToolCallId : undefined;
  const phase = completed?.phase;
  if (!validId(id) || typeof text !== 'string' || text.length === 0 || (parent !== undefined && !validId(parent)) || (phase !== undefined && phase !== null && phase !== 'commentary' && phase !== 'final_answer')) return null;
  return { id, parentToolCallId: parent ?? null, phase: phase ?? null };
}
const sameItem = (a: AssistantItemIdentity, b: AssistantItemIdentity) => a.id === b.id && a.parentToolCallId === b.parentToolCallId;
function validInputGroups(r: Extract<NativeEvent, { type: 'client/turn/requested' }>): boolean {
  const data = r.data;
  if (!validId(data.requestId) || !Array.isArray(data.input)) return false;
  const groups = data.inputGroups ?? [data.input];
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > 256) return false;
  return groups.every(group => Array.isArray(group) && group.every(part => {
    if (!part || typeof part !== 'object' || (part.visibility !== undefined && part.visibility !== 'agent-only')) return false;
    if (part.type === 'text') return typeof part.text === 'string';
    if (part.type === 'image') return typeof part.url === 'string';
    if (part.type === 'localImage' || part.type === 'localFile') return typeof part.path === 'string';
    return false;
  }));
}
function validateReference(s: NativeSourceReference): boolean {
  if (!s || !validId(s.threadId)) return false;
  const keys = Object.keys(s).sort().join(',');
  const expected = s.kind === 'event' ? 'eventId,kind,threadId' : s.kind === 'request-group' ? 'eventId,groupIndex,kind,requestId,threadId' : s.kind === 'assistant-item' ? 'itemId,kind,scope,terminalEventId,threadId' : 'kind,scope,terminalEventId,threadId';
  if (keys !== expected) return false;
  if ((s.kind === 'assistant-item' || s.kind === 'assistant-terminal') && (!s.scope || Object.keys(s.scope).join(',') !== 'turnId')) return false;
  if (s.kind === 'event') return validId(s.eventId);
  if (s.kind === 'request-group') return validId(s.eventId) && validId(s.requestId) && seq(s.groupIndex);
  return (s.kind === 'assistant-item' || s.kind === 'assistant-terminal') && validId(s.terminalEventId) && validId(s.scope?.turnId) && (s.kind !== 'assistant-item' || validId(s.itemId));
}
function normalize(snapshot: NativeSourceSnapshot): Result<NativeSourceEvidence> {
  try {
    const { source, events, timeline } = boundedSnapshot(snapshot);
    if (!validateReference(source) || !Array.isArray(events) || events.length > NATIVE_SOURCE_LIMITS.events) return err('invalid-input', 'Invalid or oversized native source snapshot.');
    const ids = new Set<string>(), sequences = new Set<number>();
    for (const e of events) {
      if (e.threadId !== source.threadId || !validId(e.id) || !seq(e.seq) || !e.scope || !['thread', 'turn'].includes(e.scope.kind) || (e.scope.kind === 'turn' && !validId(e.scope.turnId)) || ids.has(e.id) || sequences.has(e.seq)) return err('invalid-input', 'Native events must have unique ids/sequences in the requested thread.');
      ids.add(e.id); sequences.add(e.seq);
    }
    const byId = new Map(events.map(e => [e.id, e]));
    let sourceReasons: string[] = [], attributionReasons: string[] = [], executionReasons: string[] = [];
    let author: NativeSourceEvidence['author'] = null, latestEditor: NativeSourceEvidence['latestEditor'] = null;
    let mentionedTargets: NativeSourceEvidence['mentionedTargets'] = [], dispatch: NativeSourceEvidence['dispatch'] = null;
    let terminal: NativeSourceEvidence['terminal'] = null, origin: NativeSourceEvidence['origin'] = 'unknown';
    const text: NativeTextEvidence[] = [], inputs: NativeInputLink[] = [];
    let request: Extract<NativeEvent, { type: 'client/turn/requested' }> | undefined;
    let groupIndex: number | undefined;
    let boundarySeq = Number.MAX_SAFE_INTEGER, targetTurn: string | null = null;
    if (source.kind === 'event' || source.kind === 'request-group') {
      const event = byId.get(source.eventId);
      if (!event) sourceReasons.push('missing-source-event');
      else if (event.type === 'client/turn/requested') {
        request = event;
        if (source.kind === 'request-group') {
          if (event.data.requestId !== source.requestId) return err('invalid-input', 'Native request id does not match the source event.');
          groupIndex = source.groupIndex;
        } else groupIndex = (event.data.inputGroups?.length ?? 1) === 1 ? 0 : undefined;
      } else sourceReasons.push('unsupported-event-source');
    } else {
      const event = byId.get(source.terminalEventId);
      if (!event) sourceReasons.push('missing-terminal-event');
      else if (event.type !== 'turn/completed' || turn(event) !== source.scope.turnId) return err('invalid-input', 'Terminal event and scope.turnId must match exactly.');
      else {
        if (!['completed', 'failed', 'interrupted'].includes(event.data.status)) return err('invalid-input', 'Invalid terminal status.');
        boundarySeq = event.seq; targetTurn = source.scope.turnId; origin = 'assistant';
        terminal = { terminalEventId: event.id, scope: { turnId: targetTurn }, status: event.data.status };
        collectAssistant({ source, timeline, events, terminalSeq: event.seq, targetTurn, text, reasons: sourceReasons });
      }
      attributionReasons.push('assistant-has-no-native-person-author');
    }
    if (request) {
      const data = request.data;
      const groups = data.inputGroups ?? [data.input];
      if (!validInputGroups(request) || !['user', 'agent', 'system'].includes(data.initiator) || !['spawn', 'tell'].includes(data.source) || (data.senderThreadId !== null && !validId(data.senderThreadId)) || groups.length === 0 || groups.length > 256 || groups.some(g => !Array.isArray(g))) return err('invalid-input', 'Malformed native request data.');
      const authors = decodeSourceActors(data.p6rAuthors), editors = decodeSourceActors(data.p6rEditors);
      if (!authors.ok) return authors;
      if (!editors.ok) return editors;
      if (data.p6rMentionedTargets && (data.p6rMentionedTargets.length > 256 || data.p6rMentionedTargets.some(m => !nativeMention.safeParse(m).success))) return err('invalid-input', 'Malformed native mention target.');
      dispatch = { initiator: data.initiator, source: data.source, senderThreadId: data.senderThreadId };
      origin = data.initiator;
      mentionedTargets = data.p6rMentionedTargets ?? [];
      if (!data.p6rMentionedTargets) attributionReasons.push('mentions-not-recorded');
      if (groupIndex === undefined) sourceReasons.push('request-group-required');
      else if (!groups[groupIndex]) return err('invalid-input', 'Native input group is out of range.');
      else {
        // Group-parallel arrays are never flattened or borrowed from a different group.
        if (authors.value?.length === groups.length) author = authors.value[groupIndex] ?? null;
        else attributionReasons.push('authors-not-group-aligned');
        if (editors.value?.length === groups.length) latestEditor = editors.value[groupIndex] ?? null;
        else attributionReasons.push('editors-not-group-aligned');
        const group = groups[groupIndex]!;
        const visible = group.filter(p => p.type === 'text' && p.visibility !== 'agent-only');
        text.push({ text: visible.map(p => p.type === 'text' ? p.text : '').join('\n'), parentToolCallId: null, basis: 'request-input', eventIds: [request.id], sourceSeqStart: request.seq, sourceSeqEnd: request.seq, itemId: null, timelineRowId: null, phase: null });
        if (group.some(p => p.type !== 'text')) sourceReasons.push('non-text-input-not-expanded');
        if (group.some(p => p.visibility === 'agent-only')) sourceReasons.push('agent-only-input-excluded');
      }
      if (!author) attributionReasons.push('author-not-recorded');
    }
    // Exact request IDs establish causality, never authorship. Many accepted inputs can share a turn.
    if (!author && attributionReasons.length === 0) attributionReasons.push('author-not-established');
    const accepted = (request || terminal ? events : []).filter(e => e.type === 'turn/input/accepted' && e.seq <= boundarySeq && (targetTurn === null || turn(e) === targetTurn)).sort((a, b) => a.seq - b.seq);
    for (const e of accepted) {
      if (e.type !== 'turn/input/accepted') continue;
      if (request && e.data.clientRequestId !== request.data.requestId) continue;
      const candidates = events.filter((r): r is Extract<NativeEvent, { type: 'client/turn/requested' }> => r.type === 'client/turn/requested' && r.data.requestId === e.data.clientRequestId && r.seq < e.seq);
      const t = turn(e);
      if (candidates.length !== 1 || !t || (request && candidates[0]?.id !== request.id) || !validId(e.data.clientRequestId) || !validInputGroups(candidates[0]!)) { executionReasons.push('unresolved-accepted-request'); continue; }
      const r = candidates[0]!;
      inputs.push({ requestEventId: r.id, requestId: r.data.requestId, acceptedEventId: e.id, turnId: t, groupCount: r.data.inputGroups?.length ?? 1 });
    }
    if (!inputs.length) executionReasons.push('no-exact-accepted-input-link');
    // Supplied windows/projection pages do not establish complete retained causal history.
    executionReasons.push('bounded-snapshot-causal-coverage');
    return ok(structuredClone({ source, basis: 'public-sdk-native', origin, author, latestEditor, mentionedTargets, dispatch, terminal, text, inputs, initiatingPerson: unknownLineage(), carriedPerson: unknownLineage(), agentId: null, delegation: unknownLineage(), coverage: { source: coverage(sourceReasons, text.length === 0), attribution: coverage(attributionReasons, author === null), execution: coverage(executionReasons, inputs.length === 0), personalLineage: coverage(['not-established-by-native-source'], true) }, history: [] }));
  } catch {
    return err('invalid-input', 'Malformed native source snapshot.');
  }
}

type TimelineRow = NativeTimeline['rows'][number];
function collectAssistant(args: { source: Extract<NativeSourceReference, { kind: 'assistant-item' | 'assistant-terminal' }>; timeline: NativeTimeline | undefined; events: readonly NativeEvent[]; terminalSeq: number; targetTurn: string; text: NativeTextEvidence[]; reasons: string[] }): void {
  const { source, timeline, events, terminalSeq, targetTurn, text, reasons } = args;
  if (!timeline) { reasons.push('public-timeline-required'); return; }
  // This is an opaque public snapshot token, not an entity identifier. The
  // producer can serialize a snapshot longer than the identifier limit. Keep
  // the original token; the existing whole-input byte bound still applies.
  const marker = timeline.timelinePage.historySnapshot;
  const validMarker = typeof marker === 'string' && marker.trim().length > 0 && marker.length <= NATIVE_SOURCE_LIMITS.bytes;
  if (!seq(timeline.maxSeq) || timeline.maxSeq < terminalSeq || !validMarker) { reasons.push('projection-does-not-cover-terminal'); return; }
  if (timeline.timelinePage.olderCursor) reasons.push('projection-page-incomplete');
  if (timeline.timelinePage.olderRowUpdates?.length) reasons.push('projection-row-updates-unapplied');
  if (timeline.delta) reasons.push('projection-delta-requires-materialized-rows');
  const flat: TimelineRow[] = [];
  function walk(rows: readonly TimelineRow[], depth: number): void {
    if (depth > NATIVE_SOURCE_LIMITS.depth) throw new Error('depth');
    for (const row of rows) {
      if (flat.length >= NATIVE_SOURCE_LIMITS.rows) throw new Error('rows');
      flat.push(row);
      if (row.kind === 'turn') {
        if (row.children === null && row.turnId === targetTurn) reasons.push('projection-children-unavailable');
        if (row.children) walk(row.children, depth + 1);
      }
    }
  }
  walk(timeline.rows, 0);
  const rowIds = new Set<string>();
  for (const row of flat) {
    if (row.kind !== 'conversation' || row.role !== 'assistant' || row.turnId !== targetTurn) continue;
    if (typeof row.text !== 'string') throw new Error('invalid projection text');
    if (!validId(row.id) || row.threadId !== source.threadId || !seq(row.sourceSeqStart) || !seq(row.sourceSeqEnd) || row.sourceSeqStart > row.sourceSeqEnd || rowIds.has(row.id)) { reasons.push('invalid-projection-row'); continue; }
    rowIds.add(row.id);
    if (row.sourceSeqStart > terminalSeq) continue;
    if (row.sourceSeqEnd > terminalSeq) { reasons.push('projection-row-crosses-terminal'); continue; }
    const start = events.find(e => e.seq === row.sourceSeqStart);
    const end = events.find(e => e.seq === row.sourceSeqEnd);
    const startItem = start && assistantItem(start), endItem = end && assistantItem(end);
    if (!start || !end || !startItem || !endItem || !sameItem(startItem, endItem) || turn(start) !== targetTurn || turn(end) !== targetTurn) { reasons.push('projection-source-join-unresolved'); continue; }
    if (source.kind === 'assistant-item') {
      if (startItem.id !== source.itemId) continue;
      const parents = new Set(events.filter(e => e.seq <= terminalSeq && turn(e) === targetTurn && assistantItem(e)?.id === source.itemId).map(e => assistantItem(e)!.parentToolCallId));
      if (parents.size > 1) { reasons.push('assistant-item-parent-ambiguous'); continue; }
    }
    const matching = events.filter(e => e.seq >= row.sourceSeqStart && e.seq <= row.sourceSeqEnd && turn(e) === targetTurn && (() => { const item = assistantItem(e); return item !== null && sameItem(item, startItem); })()).sort((a, b) => a.seq - b.seq);
    if (!row.text.trim()) { reasons.push('empty-or-deferred-assistant-row'); continue; }
    text.push({ text: row.text, parentToolCallId: startItem.parentToolCallId, basis: 'public-timeline', eventIds: matching.map(e => e.id), sourceSeqStart: row.sourceSeqStart, sourceSeqEnd: row.sourceSeqEnd, itemId: startItem.id, timelineRowId: row.id, phase: matching.map(assistantItem).find(i => i?.phase)?.phase ?? null });
  }
  // Never interpret a bounded empty page as proof that a turn had no retained output.
  if (text.length === 0) reasons.push('no-retained-assistant-text-in-snapshot');
}

export function createNativeSourceAdapter(options: { readonly history?: ProvenanceReader } = {}): NativeSourceAdapter {
  return {
    resolve: normalize,
    async enrich(evidence, readOptions) {
      if (!options.history) return ok(evidence);
      const thread = idCodec('thread').decode(evidence.source.threadId);
      if (!thread.ok) return thread;
      const history: NativeHistoryRead[] = [];
      const attempted = new Set<string>();
      const eventIds = evidence.origin === 'assistant' ? evidence.inputs.map(i => i.requestEventId) : evidence.text.flatMap(t => t.eventIds);
      for (const eventId of [...new Set(eventIds)].slice(0, NATIVE_SOURCE_LIMITS.historyReads)) {
        if (readOptions?.signal?.aborted) return err('cancelled', 'Native evidence enrichment cancelled.');
        const result = await options.history.contributions({ kind: 'native-event', threadId: thread.value, eventId, limit: 100 }, readOptions);
        history.push({ kind: 'contributions', eventId, result });
        if (!result.ok || (result.value.status !== 'known' && result.value.status !== 'partial')) continue;
        for (const contribution of result.value.items) {
          if (history.length >= NATIVE_SOURCE_LIMITS.historyReads) break;
          if (contribution.reference.threadId !== thread.value) continue;
          const key = JSON.stringify([contribution.reference.threadId, contribution.reference.contributionId]);
          if (attempted.has(key)) continue;
          attempted.add(key);
          if (readOptions?.signal?.aborted) return err('cancelled', 'Native evidence enrichment cancelled.');
          const attempts = await options.history.attempts({ kind: 'contribution', reference: contribution.reference, limit: 50 }, readOptions);
          // Keep the reader outcome unmodified. Consumers match correlation to native inputs/terminal.
          history.push({ kind: 'attempts', contribution: contribution.reference, result: attempts });
        }
        if (history.length >= NATIVE_SOURCE_LIMITS.historyReads) break;
      }
      return ok({ ...evidence, history });
    },
  };
}
