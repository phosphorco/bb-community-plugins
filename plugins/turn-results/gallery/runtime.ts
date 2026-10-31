import { Store } from '@tanstack/store';
import { z } from 'zod';
import { canonicalByteLength, canonicalJson, InputSchemas } from '@phosphorco/bb-turn-results';
import { createResultsDiscoveryOwner, discoverResultsParticipants, classifyResultsError } from '@phosphorco/bb-turn-results/bb';
import type { ResultsDiscoveryCursor } from '@phosphorco/bb-turn-results/bb';
import type { GalleryAnchor } from './anchors.ts';
import type { GalleryObservation, GalleryPage, StageRecord } from './index.ts';
import { GALLERY_METHODS, GalleryRawSchema, KnownGalleryOutputSchema, PendingGalleryOutputSchema } from './rpc.ts';
import type { GalleryBackend, GalleryRead } from './rpc.ts';
import { consumeTurnSource, consumerSource } from './consume.ts';
import type { ConsumerSource } from './consume.ts';
import { createGalleryMedia } from './media.ts';
import { createWindowCanvasOwner } from './canvas-owner.ts';
import type { CanvasPriority } from './canvas-owner.ts';
import { createPresentationLifetime } from './presentation-lifetime.ts';
import type { PresentationLifetime } from './presentation-lifetime.ts';
import type { GalleryDialogInput, GalleryDialogController } from './dialog.tsx';
import { untilAborted } from './lifetime.ts';

type Sdk = { plugins: Parameters<typeof discoverResultsParticipants>[0]['sdk']['plugins']; threads: { events: Parameters<typeof consumeTurnSource>[1] } };
export interface TurnSnapshot { rows: GalleryObservation[]; busy: boolean; continued: boolean; error: string | null; coverage: string }
export interface GalleryPresentationRoot {
  readonly id: number;
  site(key: string, priority: CanvasPriority, current: () => boolean): PresentationLifetime | null;
  beginDisposal(): () => void;
  whenDrained(): Promise<void>;
}
interface TurnEntry {
  key: string; threadId: string; anchor: GalleryAnchor; store: Store<TurnSnapshot>; refs: number; visible: number;
  dirty: boolean; controller: AbortController | null; afterOwner: string | null;
  debts: Set<string>; debtBudget: number; bytes: number;
}
interface HistoryRead { threadId: string; live(): boolean; start(): void; cancel(): void }
type Work = TurnEntry | HistoryRead;
export const GALLERY_RUNTIME_LIMITS = Object.freeze({ leases: 128, cached: 64, lanes: 2,
  historyQueue: 128, snapshotBytes: 262144, totalSnapshotBytes: 16777216, sliceMs: 6000, automaticDebtUnits: 4 });
const stageSchema = z.object({ version: z.number().int().nonnegative(), value: z.object({
  stage: z.enum(['discover', 'native', 'recognize', 'resolve', 'feed', 'maintenance']), cursor: z.string().nullable(),
  status: z.enum(['ready', 'parked', 'complete']), debt: z.json(),
}) }).nullable();
const observationSchema = z.object({ key: z.string().max(1024), owner: z.string().max(128), identity: InputSchemas.identity,
  resolution: InputSchemas.resolution.nullable(), unresolved: z.boolean(), firstObservedOrder: z.number().int().nonnegative(),
  corrections: z.array(z.object({ kind: z.enum(['observation', 'external-success', 'definite-failure']), id: z.string(), digest: z.string(), recordedAt: z.number().int().nonnegative() })), sourceExpired: InputSchemas.revision.nullable(),
  retracted: z.object({ revision: InputSchemas.revision, supersedesEvidenceDigest: z.string(), reason: z.string() }).nullable(),
  freshness: z.enum(['fresh', 'stale', 'disconnected', 'unsupported', 'unverified']), currentAvailability: z.object({ state: z.enum(['available', 'unavailable', 'unknown']), asOf: z.number(), expiresAt: z.number().nullable(), reason: z.string().optional() }).nullable() });
const readSchema = z.object({ page: z.object({ rows: z.array(observationSchema).max(8), next: z.object({ seq: z.number().int(), key: z.string() }).nullable() }),
  coverage: z.object({ state: z.enum(['unindexed', 'partial', 'deleted']), intervals: z.array(z.unknown()).max(128) }) });

/** Window-generation owner. Only demanded turns run. All values/notifications
 * live in keyed TanStack stores; queues and controllers own resources only. */
export function createGalleryRuntime(sdk: Sdk) {
  const turns = new Map<string, TurnEntry>(), discoveryOwner = createResultsDiscoveryOwner();
  let sources: ConsumerSource[] | null = null, discovering: Promise<ConsumerSource[]> | null = null;
  let discoveryCursor: ResultsDiscoveryCursor | null = null;
  let active = true, visible = !document.hidden, running = 0, scheduled = false, leases = 0, bytes = 0;
  // FIFO threads, then FIFO turns. A busy thread never occupies both lanes.
  const queue = new Map<string, Set<Work>>(), runningThreads = new Set<string>();
  const historyReads = new Set<HistoryRead>();
  let discoveryController: AbortController | null = null, discoveryGeneration = 0;
  let discoveryCapacity = false;
  let discoveryDemands = 0, visibleDiscoveryDemands = 0;
  const lifetime = new AbortController();
  const media = createGalleryMedia({ fetch: (url, signal) => fetch(url, { signal }),
    createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url) });
  const canvases = createWindowCanvasOwner();
  const readyOwners = new Store<ReadonlySet<string>>(new Set<string>());
  const presentationStatus = new Store({ stalled: 0 });
  const dialogSites = new Store<{ active: string | null; pending: string | null }>({ active: null, pending: null });
  let rootId = 0, activation = 0;
  let dialog: GalleryDialogController | null = null, dialogLoading = false, pendingDialog: GalleryDialogInput | null = null;
  let dialogDrain: Promise<void> = Promise.resolve();
  function publishReady(next: ReadonlySet<string>) {
    const previous = readyOwners.state;
    if (previous.size === next.size && [...previous].every(id => next.has(id))) return;
    readyOwners.setState(() => next);
  }
  function invalidateReadiness() {
    discoveryGeneration++; discoveryController?.abort(); discovering = null;
    sources = null; discoveryCursor = null; discoveryCapacity = false; publishReady(new Set());
  }
  function presentationRoot(signal: AbortSignal, current: () => boolean): GalleryPresentationRoot {
    const id = ++rootId;
    const sites = new Map<PresentationLifetime, () => void>();
    let closing = false, finishRoot: (() => void) | null = null;
    let resolve: (() => void) | null = null, drain: Promise<void> | null = null;
    const check = () => { if (!sites.size && resolve) { const done = resolve; resolve = null; done(); } };
    return { id,
      site(key, priority, siteCurrent) {
        if (!active || closing || signal.aborted) return null;
        const request = canvases.request(canonicalJson([id, key]), { ...priority, visible: false, focused: false, dialog: false });
        const scope = createPresentationLifetime(request, { signal,
          current: () => active && !closing && current() && siteCurrent() });
        request.setAvailable(false); // Only a committed public host can admit it.
        // A denied request owns no reservation; never retain it in a root map.
        if (request.getSnapshot().state === 'capacity' || request.getSnapshot().state === 'released') {
          scope.dispose(); return scope; // Denied sites must not retain an abort listener either.
        }
        {
          const released = () => {
            const stalled = canvases.counts().stalled;
            if (presentationStatus.state.stalled !== stalled) presentationStatus.setState(() => ({ stalled }));
            const state = request.getSnapshot();
            if (state.lease || state.state !== 'released') return;
            sites.get(scope)?.(); sites.delete(scope); check();
          };
          sites.set(scope, request.subscribe(released)); released();
        }
        request.update(priority); return scope;
      },
      beginDisposal() {
        if (finishRoot) return finishRoot;
        closing = true;
        const finishes = [...sites.keys()].map(scope => scope.beginRootDisposal());
        let pending = true;
        finishRoot = () => { if (!pending) return; pending = false; for (const finish of finishes) finish(); check(); };
        return finishRoot;
      },
      whenDrained() {
        if (!sites.size) return Promise.resolve();
        if (!drain) drain = new Promise<void>(done => { resolve = done; });
        return drain;
      },
    };
  }
  function selectDialog(input: GalleryDialogInput) {
    if (!active || !visible) return;
    pendingDialog = input;
    dialogSites.setState(previous => ({ ...previous, pending: input.siteKey }));
    input.retireDock();
    if (dialog) { pendingDialog = null; dialog.open(input); return; }
    if (dialogLoading) return;
    dialogLoading = true;
    void import('./dialog.tsx').then(module => {
      dialogLoading = false;
      if (!active || !visible || !pendingDialog?.openerCurrent()) {
        pendingDialog = null; dialogSites.setState(previous => ({ ...previous, pending: null })); return;
      }
      dialog = module.createGalleryDialog(api);
      const next = pendingDialog; pendingDialog = null;
      if (next) dialog.open(next);
    }, () => {
      dialogLoading = false; pendingDialog = null;
      dialogSites.setState(() => ({ active: null, pending: null }));
    });
  }
  media.visible(visible); canvases.setHidden(!visible);
  async function rpc(method: string, input: unknown, signal: AbortSignal) {
    canonicalByteLength(input, 262144);
    const raw = await untilAborted(sdk.plugins.callRpc({ pluginId: 'turn-results', method,
      input: JSON.parse(canonicalJson(input)), outputSchema: GalleryRawSchema, signal }), signal);
    signal.throwIfAborted(); return raw;
  }
  const backend: GalleryBackend = {
    async pending(input, signal) { return PendingGalleryOutputSchema.parse(await rpc(GALLERY_METHODS.pending, input, signal)); },
    async knownIdentities(threadId, owner, refs, signal) {
      return KnownGalleryOutputSchema.parse(await rpc(GALLERY_METHODS.known, { threadId, owner, refs }, signal));
    },
    async read(threadId, turnId, signal, after) { return readSchema.parse(await rpc(GALLERY_METHODS.read, { threadId, ...(turnId ? { turnId } : {}), ...(after ? { after } : {}) }, signal)) as GalleryRead; },
    async stage(threadId, owner, id, signal) { return stageSchema.parse(await rpc(GALLERY_METHODS.stage, { threadId, owner, id }, signal)) as StageRecord | null; },
    async apply(page: GalleryPage, signal) {
      const result = z.object({ state: z.enum(['committed', 'unchanged', 'capacity', 'conflict', 'revalidate']), reason: z.string().optional() }).parse(await rpc(GALLERY_METHODS.apply, page, signal));
      if (result.state !== 'committed' && result.state !== 'unchanged') throw Error(`History ${result.state}: ${result.reason ?? 'continuation was not committed'}`);
    },
  };
  async function discover(signal: AbortSignal) {
    if (sources && !discoveryCursor) return sources;
    if (!discovering) {
      const controller = new AbortController(), generation = discoveryGeneration;
      discoveryController = controller;
      const operation = (async () => {
        const result = await discoverResultsParticipants({ sdk, owner: discoveryOwner, cursor: discoveryCursor, exclude: ['turn-results'], budgets: { concurrency: 1 }, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (generation !== discoveryGeneration) throw Error('Result discovery retired.');
        if (result.state === 'failed') { publishReady(new Set()); throw Error('Result sources are temporarily unavailable.'); }
        const previousReady = readyOwners.state;
        publishReady(new Set(result.rows.filter(row => row.state === 'ready' && row.capabilities?.supplier
          || row.state === 'prior-slice' && previousReady.has(row.pluginId)).map(row => row.pluginId)));
        const found = result.rows.flatMap(row => row.state === 'ready' && row.capabilities?.supplier
          ? [consumerSource(sdk, row.pluginId, row.capabilities)] : []);
        const merged = new Map((sources ?? []).map(source => [source.pluginId, source]));
        for (const source of found) if (merged.has(source.pluginId) || merged.size < 256) merged.set(source.pluginId, source);
        discoveryCursor = result.cursor; discoveryCapacity = !result.capacity.complete;
        sources = [...merged.values()].sort((a, b) => a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
        return sources;
      })();
      discovering = operation;
      void operation.finally(() => { if (discovering === operation) { discovering = null; discoveryController = null; } }).catch(() => {});
    }
    // A proof-suspended turn may stop consuming, while its actual mounted pane
    // still demands this finite pass. Keep the initiating lane until that pass
    // settles; detaching on caller abort would orphan discovery outside 2/1.
    const found = await discovering; signal.throwIfAborted(); return found;
  }
  function collect() {
    const cached = [...turns.values()].filter(entry => !entry.refs && !entry.controller);
    for (const entry of cached.slice(0, Math.max(0, cached.length - GALLERY_RUNTIME_LIMITS.cached))) {
      turns.delete(entry.key); bytes -= entry.bytes;
    }
  }
  function publish(entry: TurnEntry, next: TurnSnapshot) {
    const encoded = canonicalJson(next, GALLERY_RUNTIME_LIMITS.snapshotBytes);
    if (canonicalJson(entry.store.state, GALLERY_RUNTIME_LIMITS.snapshotBytes) === encoded) return;
    const charge = new TextEncoder().encode(encoded).length;
    if (bytes - entry.bytes + charge > GALLERY_RUNTIME_LIMITS.totalSnapshotBytes - GALLERY_RUNTIME_LIMITS.leases * 1024) {
      // Do not evict mounted content or acknowledge an empty successful view.
      next = { ...entry.store.state, busy: false, continued: true, error: 'Results display capacity reached. Retry results after closing another view.' };
    }
    const nextBytes = canonicalByteLength(next, GALLERY_RUNTIME_LIMITS.snapshotBytes);
    bytes += nextBytes - entry.bytes; entry.bytes = nextBytes;
    entry.store.setState(() => next);
    dialog?.observe(next.rows);
  }
  function enqueue(entry: TurnEntry) {
    if (!entry.refs || !entry.visible || !entry.dirty || !active || !visible) return;
    const thread = queue.get(entry.anchor.threadId) ?? new Set<Work>();
    thread.add(entry); queue.set(entry.anchor.threadId, thread); schedule();
  }
  function unqueue(entry: Work) {
    const pending = queue.get(entry.threadId); pending?.delete(entry);
    if (!pending?.size) queue.delete(entry.threadId);
  }
  function dequeue(): Work | null {
    for (const [threadId, entries] of queue) {
      if (runningThreads.has(threadId)) continue;
      queue.delete(threadId);
      let next: Work | null = null;
      for (const entry of entries) {
        entries.delete(entry);
        if ('start' in entry ? entry.live() : entry.refs && entry.visible && entry.dirty && !entry.controller) { next = entry; break; }
      }
      if (entries.size) queue.set(threadId, entries);
      if (next) return next;
    }
    return null;
  }
  function schedule() {
    if (!active || !visible || scheduled) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump() {
    if (!active || !visible) return;
    while (running < GALLERY_RUNTIME_LIMITS.lanes) {
      const entry = dequeue(); if (!entry) break;
      if ('start' in entry) { running++; runningThreads.add(entry.threadId); entry.start(); continue; }
      entry.dirty = false;
      const controller = new AbortController(); entry.controller = controller; running++; runningThreads.add(entry.anchor.threadId);
      const anchor = entry.anchor;
      const signal = controller.signal, timer = setTimeout(() => controller.abort('deadline'), GALLERY_RUNTIME_LIMITS.sliceMs);
      publish(entry, { ...entry.store.state, busy: true });
      void (async () => {
        const cached = await backend.read(anchor.threadId, anchor.turnId, signal); signal.throwIfAborted();
        publish(entry, { ...entry.store.state, rows: cached.page.rows, coverage: cached.coverage.state,
          continued: cached.page.next !== null, error: null });
        const available = await discover(signal); signal.throwIfAborted();
        // Finish a finite first visit to every listed owner before revisiting
        // productive owner debt. Failures park only that owner, never this pass.
        let source = available.find(source => entry.afterOwner === null || source.pluginId > entry.afterOwner);
        let revisiting = false;
        if (!source && !discoveryCursor && entry.debtBudget > 0) {
          const owner = entry.debts.values().next().value;
          source = available.find(source => source.pluginId === owner);
          if (source) { revisiting = true; entry.debtBudget--; entry.debts.delete(source.pluginId); }
        }
        let failure: string | null = null;
        if (source) {
          // Advance the resource cursor even when this source fails. All factual
          // stage/claim progress still belongs to the existing atomic backend.
          if (!revisiting) entry.afterOwner = source.pluginId;
          try {
            const result = await consumeTurnSource(backend, sdk.threads.events, source, anchor, signal);
            signal.throwIfAborted();
            if (result.continued) entry.debts.add(source.pluginId); else entry.debts.delete(source.pluginId);
            failure = result.reason;
          } catch (error) {
            if (signal.aborted) throw error;
            entry.debts.delete(source.pluginId);
            const reason = classifyResultsError(error);
            await backend.apply({ owner: source.pluginId, threadId: anchor.threadId, changes: [],
              supplier: { revision: source.capabilities.revision, connection: reason === 'incompatible' ? 'unsupported' : 'disconnected', freshUntil: null } }, signal);
            failure = `${source.pluginId}: ${reason}`;
          }
        }
        const unvisited = available.some(source => entry.afterOwner === null || source.pluginId > entry.afterOwner);
        const productive = unvisited || discoveryCursor !== null || (entry.debts.size > 0 && entry.debtBudget > 0);
        const next = await backend.read(anchor.threadId, anchor.turnId, signal); signal.throwIfAborted();
        publish(entry, { rows: next.page.rows, busy: false,
          continued: productive || entry.debts.size > 0 || next.page.next !== null || discoveryCapacity,
          error: failure, coverage: discoveryCapacity ? 'source-capacity' : next.coverage.state });
        if (productive) entry.dirty = true;
      })().catch(error => {
        if (signal.aborted && signal.reason === 'deadline' && entry.afterOwner !== null
          && (sources?.some(source => source.pluginId > entry.afterOwner!) || discoveryCursor !== null)) entry.dirty = true;
        if (active && entry.controller === controller) publish(entry, { ...entry.store.state, busy: false, continued: true,
          error: signal.aborted ? signal.reason === 'deadline' ? 'Results read reached its deadline. Continue results.' : entry.store.state.error
            : error instanceof Error ? error.message : 'Results are temporarily unavailable.' });
      }).finally(() => {
        clearTimeout(timer); if (entry.controller === controller) entry.controller = null;
        running--; runningThreads.delete(anchor.threadId);
        if (active && entry.store.state.busy) publish(entry, { ...entry.store.state, busy: false });
        collect(); if (entry.dirty) enqueue(entry); schedule();
      });
    }
  }
  function readScope<T>(threadId: string, signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<{ state: 'ready'; value: T } | { state: 'capacity' }> {
    signal.throwIfAborted();
    if (!active || !visible) return Promise.reject(Error('Gallery read retired.'));
    if (historyReads.size >= GALLERY_RUNTIME_LIMITS.historyQueue) return Promise.resolve({ state: 'capacity' });
    return new Promise((resolve, reject) => {
      const controller = new AbortController(); let started = false;
      const cleanup = () => { signal.removeEventListener('abort', callerAbort); controller.signal.removeEventListener('abort', cancelled); };
      const callerAbort = () => controller.abort(signal.reason);
      const work: HistoryRead = { threadId, live: () => !controller.signal.aborted,
        cancel: () => controller.abort(), start() {
          started = true;
          void untilAborted(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); }), controller.signal)
            .then(value => resolve({ state: 'ready', value }), reject).finally(() => {
              cleanup(); historyReads.delete(work); running--; runningThreads.delete(threadId); schedule();
            });
        } };
      const cancelled = () => {
        if (!started) { unqueue(work); historyReads.delete(work); cleanup(); reject(controller.signal.reason); }
      };
      signal.addEventListener('abort', callerAbort, { once: true }); controller.signal.addEventListener('abort', cancelled, { once: true });
      historyReads.add(work);
      const pending = queue.get(threadId) ?? new Set<Work>(); pending.add(work); queue.set(threadId, pending); schedule();
    });
  }
  function reset(entry: TurnEntry) { entry.dirty = true; entry.afterOwner = null; entry.debts.clear(); entry.debtBudget = GALLERY_RUNTIME_LIMITS.automaticDebtUnits; }
  function stopUnusedDiscovery() {
    if (!visibleDiscoveryDemands && ![...turns.values()].some(entry => entry.refs && entry.visible)) discoveryController?.abort();
  }
  function visibility() {
    visible = !document.hidden; media.visible(visible); canvases.setHidden(!visible);
    if (!visible) { pendingDialog = null; dialogSites.setState(previous => ({ ...previous, pending: null })); invalidateReadiness(); for (const read of historyReads) read.cancel(); for (const entry of turns.values()) entry.controller?.abort(); }
    else { for (const entry of turns.values()) if (entry.refs && entry.visible) { reset(entry); enqueue(entry); } }
  }
  document.addEventListener('visibilitychange', visibility);
  const api = { media, canvases, backend, readScope, readyOwners, presentationStatus, dialogSites, presentationRoot, invalidateReadiness,
    retainDiscoveryDemand() {
      if (!active || discoveryDemands >= GALLERY_RUNTIME_LIMITS.leases) return null;
      discoveryDemands++;
      let live = true, shown = false;
      return {
        visible(next: boolean) {
          if (!live || !active || shown === next) return;
          shown = next; visibleDiscoveryDemands += next ? 1 : -1;
          if (!next) stopUnusedDiscovery();
        },
        dispose() {
          if (!live) return; live = false;
          if (!active) return;
          discoveryDemands--; if (shown) visibleDiscoveryDemands--;
          stopUnusedDiscovery();
        },
      };
    },
    observeRows(rows: readonly GalleryObservation[]) { if (active) dialog?.observe(rows); },
    async discoverReady(signal: AbortSignal) { await discover(signal); return { continued: discoveryCursor !== null, capacity: discoveryCapacity }; },
    isActive: () => active,
    isReadyOwner: (id: string) => active && readyOwners.state.has(id),
    nextActivation: () => ++activation,
    openDialog: selectDialog,
    dialogMounted(siteKey: string) { dialogSites.setState(previous => ({ active: siteKey, pending: previous.pending === siteKey ? null : previous.pending })); },
    dialogRetired(siteKey: string) { dialogSites.setState(previous => ({ ...previous, active: previous.active === siteKey ? null : previous.active })); },
    dialogCancelled() { dialogSites.setState(previous => ({ ...previous, pending: null })); },
    async refreshDialogRow(row: GalleryObservation, signal: AbortSignal) {
      invalidateReadiness();
      const source = row.identity.ref.source;
      const result = await readScope(source.threadId, signal, async bounded => {
        const page = await backend.read(source.threadId, source.turnId, bounded);
        await discover(bounded); bounded.throwIfAborted();
        return page.page.rows.find(next => next.key === row.key && next.owner === row.owner && canonicalJson(next.identity) === canonicalJson(row.identity));
      });
      if (result.state === 'capacity' || !result.value) throw Error('This saved result needs another history page before it can be refreshed.');
      return result.value;
    },
    caption(row: GalleryObservation) {
      const kind = sources?.find(source => source.pluginId === row.owner)?.capabilities.supplier?.kinds.find(kind => kind.kind === row.identity.ref.kind);
      return kind ? row.resolution?.knowledge === 'confirmed' ? kind.confirmedLabel : kind.neutralLabel : 'Result';
    },
    invalidate(threadId?: string, rediscover = false, turnIds?: ReadonlySet<string>) {
      if (rediscover) invalidateReadiness();
      for (const entry of turns.values()) if (entry.refs && (!threadId || entry.anchor.threadId === threadId)
        && (!turnIds || turnIds.has(entry.anchor.turnId))) { reset(entry); enqueue(entry); }
    },
    retain(anchor: GalleryAnchor, initiallyVisible = true) {
      if (!active) throw Error('Gallery generation retired.');
      if (leases >= GALLERY_RUNTIME_LIMITS.leases) return {
        capacity: true, store: new Store<TurnSnapshot>({ rows: [], busy: false, continued: true, error: null, coverage: 'view-capacity' }),
        visible(_next: boolean) {}, more() {}, dispose() {},
      };
      const key = canonicalJson([anchor.threadId, anchor.turnId, anchor.turnSeqStart, anchor.turnSeqEnd]);
      let entry = turns.get(key);
      if (!entry) {
        const initial: TurnSnapshot = { rows: [], busy: false, continued: false, error: null, coverage: 'unindexed' };
        entry = { key, threadId: anchor.threadId, anchor: { ...anchor }, store: new Store(initial), refs: 0, visible: 0, dirty: true,
          controller: null, afterOwner: null, debts: new Set(), debtBudget: GALLERY_RUNTIME_LIMITS.automaticDebtUnits, bytes: canonicalByteLength(initial) };
        turns.set(key, entry); bytes += entry.bytes;
      }
      const owned = entry;
      if (!owned.refs) reset(owned);
      if (owned.anchor.turnSeqStart !== anchor.turnSeqStart || owned.anchor.turnSeqEnd !== anchor.turnSeqEnd) {
        owned.controller?.abort(); reset(owned);
      }
      owned.anchor = { ...anchor }; owned.refs++; leases++; if (initiallyVisible) owned.visible++;
      let live = true, shown = initiallyVisible;
      enqueue(owned);
      return { capacity: false, store: owned.store,
        visible(next: boolean) { if (!live || shown === next) return; shown = next; owned.visible += next ? 1 : -1;
          if (!owned.visible) { owned.controller?.abort(); unqueue(owned); stopUnusedDiscovery(); }
          else { reset(owned); enqueue(owned); } },
        more() { if (!live) return; reset(owned); enqueue(owned); },
        dispose() {
          if (!live) return; live = false; if (!active) return; owned.refs--; leases--; if (shown) owned.visible--;
          if (!owned.refs || !owned.visible) { owned.controller?.abort(); unqueue(owned); stopUnusedDiscovery(); }
          // Refresh LRU position only on lease retirement, never on idle ticks.
          turns.delete(key); turns.set(key, owned); collect();
        } };
    },
    stats: () => ({ leases, entries: turns.size, cached: [...turns.values()].filter(entry => !entry.refs).length,
      historyReads: historyReads.size, discoveryDemands, visibleDiscoveryDemands,
      queued: [...queue.values()].reduce((sum, entries) => sum + entries.size, 0), running, bytes }),
    dispose() {
      if (!active) return; active = false; lifetime.abort(); discoveryController?.abort(); document.removeEventListener('visibilitychange', visibility);
      pendingDialog = null; publishReady(new Set()); dialogDrain = dialog?.dispose() ?? Promise.resolve();
      for (const read of historyReads) read.cancel(); for (const entry of turns.values()) entry.controller?.abort(); turns.clear(); queue.clear(); bytes = 0; leases = 0; discoveryDemands = 0; visibleDiscoveryDemands = 0; discoveryOwner.dispose(); media.dispose(); canvases.dispose();
    },
    async whenDrained() { await dialogDrain; await canvases.whenDrained(); },
  };
  return api;
}
export type GalleryRuntime = ReturnType<typeof createGalleryRuntime>;
