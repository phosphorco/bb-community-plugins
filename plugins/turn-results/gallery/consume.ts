import { buildEventWindow } from '@phosphorco/bb-turn-results/events';
import { canonicalByteLength, canonicalJson, claimKey, correlateResolveOutput, resolveOutcomeBudget } from '@phosphorco/bb-turn-results';
import { ResultsCallError, classifyResultsError, createResultsSupplierClient } from '@phosphorco/bb-turn-results/bb';
import type { ResultsSupplierClient } from '@phosphorco/bb-turn-results/bb';
import type { CapabilitiesV1, RecognizeInput } from '@phosphorco/bb-turn-results';
import type { NativeHistoryEvent } from '@phosphorco/bb-turn-results/events';
import type { GalleryAnchor } from './anchors.ts';
import type { GalleryBackend } from './rpc.ts';
import type { GalleryPage, StageRecord } from './index.ts';
import { KnownGalleryOutputSchema, PendingGallerySchema, PendingGalleryOutputSchema } from './rpc.ts';
import { untilAborted } from './lifetime.ts';

export interface ConsumerSource { pluginId: string; capabilities: CapabilitiesV1; client: ResultsSupplierClient }
export interface NativeReader {
  list(input: { threadId: string; afterSeq: string; beforeSeq: string; limit: string; order: 'asc'; types: ['item/completed']; signal: AbortSignal }): Promise<NativeHistoryEvent[]>;
}
const scopeMatches = (stage: StageRecord | null, anchor: GalleryAnchor) =>
  debtNumber(stage, 'fromSeq', -1) === anchor.turnSeqStart && debtNumber(stage, 'throughSeq', -1) === anchor.turnSeqEnd;
const debtNumber = (stage: StageRecord | null, name: string, fallback: number) => {
  const debt = stage?.value.debt;
  const value = debt && typeof debt === 'object' && !Array.isArray(debt) ? debt[name] : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};
// Match SQLite's UTF8 BINARY collation for exact canonical claim keys.
// Opaque identifiers can include supplementary Unicode; UTF16 string ordering
// differs. Keep this portable to the browser and never normalize identity text.
const pendingKeyEncoder = new TextEncoder();
function pendingKeyOrder(left: string, right: string): number {
  const a = pendingKeyEncoder.encode(left), b = pendingKeyEncoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}
/** One demanded source slice. Source/window cursor and admitted candidates commit
 * together; old identities stay in the index when native output is pruned.
 * No scan is scheduled for threads without a mounted/explicit consumer. */
export async function consumeTurnSource(backend: GalleryBackend, native: NativeReader, source: ConsumerSource,
  anchor: GalleryAnchor, signal: AbortSignal): Promise<{ continued: boolean; reason: string | null }> {
  const supplier = source.capabilities.supplier;
  if (!supplier) return { continued: false, reason: null };
  if (!backend.pending) throw Error('Pending gallery adapter is required.');
  signal.throwIfAborted();
  const resolveId = `resolve:${anchor.turnId}`;
  const resolveStage = await backend.stage(anchor.threadId, source.pluginId, resolveId, signal); signal.throwIfAborted();
  const invalidation = await backend.stage(anchor.threadId, source.pluginId, 'source-invalidation', signal); signal.throwIfAborted();
  const scope = { threadId: anchor.threadId, turnId: anchor.turnId, owner: source.pluginId,
    fromSeq: anchor.turnSeqStart, throughSeq: anchor.turnSeqEnd };
  const old = resolveStage?.value.debt;
  const debt = old && typeof old === 'object' && !Array.isArray(old) ? old : {};
  const sameScope = Object.entries(scope).every(([k,v]) => debt[k] === v);
  const sameSource = debt.sourceRevision === source.capabilities.revision && debt.invalidationVersion === (invalidation?.version ?? null);
  if (sameScope && sameSource && debt.quarantine === true)
    return { continued: false, reason: 'Supplier resolve is quarantined until its revision or invalidation changes.' };
  let feedContinued = false;
  if (supplier.enumerate) {
    const feedId = `feed:${anchor.turnId}`, feedStage = await backend.stage(anchor.threadId, source.pluginId, feedId, signal);
    signal.throwIfAborted();
    const output = await source.client.enumerate({ version: 1, threadId: anchor.threadId,
      range: { fromSeq: anchor.turnSeqStart, throughSeq: anchor.turnSeqEnd }, cursor: scopeMatches(feedStage, anchor) ? feedStage!.value.cursor : null, limit: 8 }, signal);
    signal.throwIfAborted();
    await backend.apply({ threadId: anchor.threadId, owner: source.pluginId,
      changes: output.state === 'page' ? output.rows : [],
      stage: { id: feedId, expectedVersion: feedStage?.version ?? null, value: { stage: 'feed',
        cursor: output.state === 'page' ? output.nextCursor : null, status: output.state === 'page' && output.settled ? 'complete' : 'ready',
        debt: { fromSeq: anchor.turnSeqStart, throughSeq: anchor.turnSeqEnd, epoch: output.epoch, throughRevision: output.state === 'page' ? output.throughRevision : 0 } } },
      supplier: { revision: source.capabilities.revision, connection: 'connected', freshUntil: Date.now() + 30000, epoch: output.epoch },
    }, signal);
    signal.throwIfAborted(); feedContinued = output.state === 'reset' || !output.settled;
  }
  const id = `native:${anchor.turnId}`;
  const stage = await backend.stage(anchor.threadId, source.pluginId, id, signal); signal.throwIfAborted();
  const scoped = scopeMatches(stage, anchor);
  const after = scoped ? debtNumber(stage, 'afterSeq', Math.max(0, anchor.turnSeqStart - 1)) : Math.max(0, anchor.turnSeqStart - 1);
  let continued = feedContinued;
  if (supplier.recognize && (!scoped || stage?.value.status !== 'complete')) {
    const raw = await untilAborted(native.list({ threadId: anchor.threadId, afterSeq: String(after), beforeSeq: String(anchor.turnSeqEnd + 1),
      limit: '32', order: 'asc', types: ['item/completed'], signal }), signal); signal.throwIfAborted();
    const window = await buildEventWindow(raw, { afterSeq: after, threadId: anchor.threadId, maxEvents: 32, maxBytes: 196608 });
    signal.throwIfAborted();
    const input: RecognizeInput = { version: 1, context: { consumer: { pluginId: 'turn-results', surface: 'inline-gallery' },
      threadId: anchor.threadId, range: { fromSeq: after + 1, throughSeq: Math.max(after + 1, window.afterSeq) } },
      events: window.events, page: { cursor: scoped ? stage!.value.cursor : null, limit: 8 } };
    canonicalByteLength(input, 262144);
    const recognized = window.events.length ? await source.client.recognize(input, signal)
      : { candidates: [], page: { state: 'complete' as const, nextCursor: null } };
    signal.throwIfAborted();
    const moreCandidates = recognized.page.nextCursor !== null;
    const incompleteWindow = window.nextInputIndex < raw.length;
    const complete = !moreCandidates && !incompleteWindow && raw.length < 32;
    // An unscoped/unreliable prefix cannot advance the source cursor. Park it
    // visibly rather than rescan the same native debt automatically forever.
    const blocked = raw.length > 0 && window.afterSeq === after && !moreCandidates;
    // Scope restarts may reselect a pruned event with a new selectedDigest.
    // Resolve the public claim key to its retained complete identity before
    // the unchanged immutable index applies this recognition page and cursor.
    const refs = recognized.candidates.map(candidate => candidate.identity.ref);
    const requested = new Set(refs.map(ref => claimKey(source.pluginId, ref)));
    const retained = refs.length ? KnownGalleryOutputSchema.parse(await untilAborted(
      backend.knownIdentities(anchor.threadId, source.pluginId, refs, signal), signal)) : [];
    signal.throwIfAborted();
    const known = new Map(retained.map(identity => [claimKey(source.pluginId, identity.ref), identity]));
    if (known.size !== retained.length || [...known.keys()].some(key => !requested.has(key))) throw Error('Invalid retained claim lookup.');
    const page: GalleryPage = { owner: source.pluginId, threadId: anchor.threadId,
      changes: recognized.candidates.map(candidate => ({ kind: 'candidate', identity: known.get(claimKey(source.pluginId, candidate.identity.ref)) ?? candidate.identity })),
      stage: { id, expectedVersion: stage?.version ?? null, value: { stage: 'recognize', cursor: recognized.page.nextCursor,
        status: blocked ? 'parked' : complete ? 'complete' : 'ready', debt: { fromSeq: anchor.turnSeqStart, afterSeq: moreCandidates ? after : window.afterSeq, throughSeq: anchor.turnSeqEnd } } },
      supplier: { revision: source.capabilities.revision, connection: 'connected', freshUntil: Date.now() + 30000 },
      coverage: window.diagnostics.length ? [{ fromSeq: Math.min(...window.diagnostics.map(gap => gap.seq ?? after + 1)),
        throughSeq: Math.max(...window.diagnostics.map(gap => gap.seq ?? after + 1)), state: 'unsupported', owner: source.pluginId,
        reason: 'Native selected window includes unsupported or oversized evidence.' }] : [] };
    await backend.apply(page, signal); signal.throwIfAborted();
    continued ||= !complete && !blocked;
    if (blocked) return { continued: false, reason: 'Native history has an unscoped or unsupported gap.' };
  }
  const resume = sameScope && sameSource && resolveStage?.value.status === 'ready';
  const batch = resume ? Math.max(1, Math.min(8, debtNumber(resolveStage, 'batch', 8))) : 8;
  const pendingAfter = resume ? debt.after ?? null : null;
  const input = { ...scope, after: pendingAfter, limit: batch };
  // Validate before passing a retained cursor across the private read boundary.
  const query = PendingGallerySchema.parse(input);
  const page = PendingGalleryOutputSchema.parse(await untilAborted(backend.pending(query, signal), signal));
  signal.throwIfAborted();
  let previous = query.after;
  for (const identity of page.rows) {
    const ref = identity.ref, seq = ref.source.seq, key = claimKey(source.pluginId, ref);
    if (!supplier.kinds.some(kind => kind.kind === ref.kind) || ref.source.threadId !== anchor.threadId || ref.source.turnId !== anchor.turnId
      || seq < scope.fromSeq || seq > scope.throughSeq || page.rows.length > batch
      || previous && (seq < previous.seq || seq === previous.seq && pendingKeyOrder(key, previous.key) <= 0)) throw Error('Invalid pending claim page.');
    previous = { seq, key };
  }
  if (page.next && (!page.rows.length || canonicalJson(page.next) !== canonicalJson(previous))) throw Error('Invalid pending continuation.');
  let parked = resume && debt.parked === true, quarantine = false, sourceAnswered = false;
  let reason: string | null = parked ? 'Earlier traversed claims remain unresolved.' : null;
  let next = page.next, nextBatch = 8, more = page.next !== null;
  let changes: GalleryPage['changes'] = [];
  if (page.rows.length) {
    const request = { version: 1 as const, threadId: anchor.threadId, items: page.rows, maxOutcomeBytes: resolveOutcomeBudget(page.rows.length) };
    let output;
    try {
      const raw = await untilAborted(source.client.resolve(request, signal), signal); signal.throwIfAborted();
      try { output = await correlateResolveOutput(request, raw); }
      catch (error) { throw new ResultsCallError('incompatible', undefined, error); }
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      const kind = classifyResultsError(error);
      if (kind === 'aborted' || kind === 'stale') throw error;
      quarantine = !['timeout', 'source-error', 'transport-error'].includes(kind);
      parked = true; reason = quarantine ? 'Supplier resolve contract or access is unavailable.' : 'Traversed source batch is temporarily unavailable.';
      if (quarantine) { more = false; next = query.after; }
    }
    if (output) {
      sourceAnswered = true;
      changes = output.resolutions.flatMap(row => row.state === 'resolved' ? [{ kind: 'upsert' as const, value: row.value }] : []);
      const deferred = output.resolutions.some(row => row.state === 'budget-deferred');
      if (deferred && batch > 1) {
        // Strictly shrink a deferred prefix without moving its watermark.
        // Resolved siblings disappear from the pending index atomically.
        next = query.after; nextBatch = Math.max(1, Math.ceil(batch / 2)); more = true;
      }
      if (output.resolutions.some(row => row.state !== 'resolved' && row.state !== 'budget-deferred') || deferred && batch === 1) {
        parked = true; reason = 'Traversed source claims remain unresolved.';
      }
    }
  }
  signal.throwIfAborted();
  // Outcome and traversal commit together under the existing stage CAS. A
  // failed apply propagates, leaving the previous traversal available to retry.
  await backend.apply({ owner: source.pluginId, threadId: anchor.threadId, changes,
    stage: { id: resolveId, expectedVersion: resolveStage?.version ?? null, value: { stage: 'resolve', cursor: null,
      status: more ? 'ready' : parked ? 'parked' : 'complete', debt: { ...scope, after: next, batch: nextBatch, parked, quarantine,
        sourceRevision: source.capabilities.revision, invalidationVersion: invalidation?.version ?? null, reason } } },
    ...(sourceAnswered ? { supplier: { revision: source.capabilities.revision, connection: 'connected' as const, freshUntil: Date.now() + 30000 } } : {}) }, signal);
  signal.throwIfAborted();
  return { continued: !quarantine && (continued || more), reason };
}

/** Listed owner argument is the only route; descriptors validate every result. */
export function consumerSource(sdk: Parameters<typeof createResultsSupplierClient>[0], pluginId: string, capabilities: CapabilitiesV1): ConsumerSource {
  return { pluginId, capabilities, client: createResultsSupplierClient(sdk, pluginId, { ...(capabilities.supplier ? { descriptors: capabilities.supplier.kinds } : {}) }) };
}
