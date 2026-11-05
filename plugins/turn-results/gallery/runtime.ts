import { Store } from '@tanstack/store';
import { z } from 'zod';
import { canonicalByteLength, canonicalJson, InputSchemas, PluginIdSchema } from '@phosphorco/bb-turn-results';
import { createResultsDiscoveryOwner, discoverResultsParticipants, createResultsSupplierClient, classifyResultsError } from '@phosphorco/bb-turn-results/bb';
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

type Sdk = { plugins: Parameters<typeof discoverResultsParticipants>[0]['sdk']['plugins'] & {
  experimental_discoverRpc?(input?: { method?: string; signal?: AbortSignal }): Promise<readonly { pluginId: string; method: string }[]>;
}; threads: { events: Parameters<typeof consumeTurnSource>[1] } };
export interface TurnSnapshot { loaded?: boolean; next?: { seq: number; key: string } | null;
  bindings?: Record<string, { after: { seq: number; key: string } | null }>; limited?: boolean;
  rows: GalleryObservation[]; busy: boolean; continued: boolean; error: string | null; coverage: string }
export interface GalleryPresentationRoot {
  readonly id: number;
  site(key: string, priority: CanvasPriority, current: () => boolean, displayCurrent?: () => boolean): PresentationLifetime | null;
  beginDisposal(): () => void;
  whenDrained(): Promise<void>;
}
interface TurnEntry {
  key: string; threadId: string; anchor: GalleryAnchor; after: { seq: number; key: string } | undefined; store: Store<TurnSnapshot>; refs: number; visible: number;
  dirty: boolean; phase: 'read' | 'source'; controller: AbortController | null; afterOwner: string | null;
  debts: Set<string>; enumerateRetries: Set<string>; debtBudget: number; bytes: number; cursorCharge: number;
  collection: TurnCollection | null; collectionBytes: number;
}
interface TurnCollection {
  anchor: GalleryAnchor; after: { seq: number; key: string } | undefined;
  rows: GalleryObservation[]; bindings: NonNullable<TurnSnapshot['bindings']>;
  seen: Set<string>; cursors: Set<string>; pages: number; charged: number;
  coverage: string; limited: boolean; done: boolean; retired: boolean; deadline: number;
}
interface HistoryRead { threadId: string; priority: boolean; live(): boolean; start(): void; cancel(): void }
type Work = TurnEntry | HistoryRead;
export const GALLERY_RUNTIME_LIMITS = Object.freeze({ leases: 128, cached: 64, lanes: 2,
  historyQueue: 128, cursorBytes: 4096, cursorHistory: 64, collectionRows: 64, collectionPages: 8,
  snapshotBytes: 262144, totalSnapshotBytes: 16777216, sliceMs: 6000, automaticDebtUnits: 4 });
const stageSchema = z.object({ version: z.number().int().nonnegative(), value: z.object({
  stage: z.enum(['discover', 'native', 'recognize', 'resolve', 'feed', 'maintenance']), cursor: z.string().nullable(),
  status: z.enum(['ready', 'parked', 'complete']), debt: z.json(),
}) }).nullable();
const observationSchema = z.object({ key: z.string().max(1024), owner: z.string().max(128), identity: InputSchemas.identity,
  resolution: InputSchemas.resolution.nullable(), unresolved: z.boolean(), firstObservedOrder: z.number().int().nonnegative(),
  corrections: z.array(z.object({ kind: z.enum(['observation', 'external-success', 'definite-failure']), id: z.string(), digest: z.string(), recordedAt: z.number().int().nonnegative() })), sourceExpired: InputSchemas.revision.nullable(),
  retracted: z.object({ revision: InputSchemas.revision, supersedesEvidenceDigest: z.string(), reason: z.string() }).nullable(),
  freshness: z.enum(['fresh', 'stale', 'disconnected', 'unsupported', 'unverified']), currentAvailability: z.object({ state: z.enum(['available', 'unavailable', 'unknown']), asOf: z.number(), expiresAt: z.number().nullable(), reason: z.string().optional() }).nullable() });
const readSchema = z.object({ page: z.object({ rows: z.array(observationSchema).max(8), next: z.object({ seq: z.number().int().nonnegative(), key: z.string().max(1024) }).nullable() }),
  coverage: z.object({ state: z.enum(['unindexed', 'partial', 'deleted']), intervals: z.array(z.unknown()).max(128) }) });

/** Window-generation owner. Only demanded turns run. All values/notifications
 * live in keyed TanStack stores; queues and controllers own resources only. */
export function createGalleryRuntime(sdk: Sdk) {
  const turns = new Map<string, TurnEntry>(), discoveryOwner = createResultsDiscoveryOwner();
  let sources: ConsumerSource[] | null = null, discovering: Promise<ConsumerSource[]> | null = null;
  let discoveryCursor: ResultsDiscoveryCursor | null = null;
  let active = true, visible = !document.hidden, running = 0, scheduled = false, leases = 0, bytes = 0;
  // Open checks precede queued optional work; otherwise FIFO threads/turns.
  // A busy thread never occupies both lanes.
  const queue = new Map<string, Set<Work>>(), runningThreads = new Map<string, () => boolean>();
  // A yielded retained read still owns its lane until the actual public call
  // settles. An abort-aware wrapper alone is not a cancellation receipt.
  const retainedCalls = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
  let workDrain: Promise<void> | null = null, finishWorkDrain: (() => void) | null = null;
  const drainedWork = () => { if (!running && finishWorkDrain) { const done = finishWorkDrain; finishWorkDrain = null; workDrain = null; done(); } };
  const historyReads = new Set<HistoryRead>();
  let discoveryController: AbortController | null = null, discoveryGeneration = 0;
  let discoveryCapacity = false;
  // Named, window-shared debt: a failed descriptor gets one yielded retry.
  // A persistent failure parks until a later genuine demand, never an idle tick.
  const descriptorDebt = new Map<string, 'queued' | 'parked'>();
  const transientDescriptor = (state: string) => ['source-error', 'transport-error', 'timeout'].includes(state);
  const queuedDescriptors = () => [...descriptorDebt.values()].some(state => state === 'queued');
  function demandDescriptors() {
    for (const [id, state] of descriptorDebt) if (state === 'parked') descriptorDebt.set(id, 'queued');
  }
  let discoveryDemands = 0, visibleDiscoveryDemands = 0;
  const lifetime = new AbortController();
  const media = createGalleryMedia({ fetch: (url, signal) => fetch(url, { signal }),
    createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url) });
  const canvases = createWindowCanvasOwner();
  const readyOwners = new Store<ReadonlySet<string>>(new Set<string>());
  // Display labels have no readiness authority. Already-admitted descriptors
  // are bounded by discovery; cards select only their primitive caption.
  const captionLabels = new Store<ReadonlyMap<string, { neutral: string; confirmed: string }>>(new Map());
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
    sources = null; discoveryCursor = null; discoveryCapacity = false; descriptorDebt.clear(); publishReady(new Set());
  }
  function presentationRoot(signal: AbortSignal, current: () => boolean, displayCurrent = current): GalleryPresentationRoot {
    const id = ++rootId;
    const sites = new Map<PresentationLifetime, () => void>();
    let closing = false, finishRoot: (() => void) | null = null;
    let resolve: (() => void) | null = null, drain: Promise<void> | null = null;
    const check = () => { if (!sites.size && resolve) { const done = resolve; resolve = null; done(); } };
    return { id,
      site(key, priority, siteCurrent, siteDisplayCurrent = siteCurrent) {
        if (!active || closing || signal.aborted) return null;
        const request = canvases.request(canonicalJson([id, key]), { ...priority, visible: false, focused: false, dialog: false });
        const scope = createPresentationLifetime(request, { signal,
          current: () => active && !closing && current() && siteCurrent(),
          displayCurrent: () => active && visible && !closing && displayCurrent() && siteDisplayCurrent() });
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
    const call = Promise.resolve(sdk.plugins.callRpc({ pluginId: 'turn-results', method,
      input: JSON.parse(canonicalJson(input)), outputSchema: GalleryRawSchema, signal }));
    const pending = retainedCalls.get(signal) ?? new Set<Promise<unknown>>();
    pending.add(call); retainedCalls.set(signal, pending);
    void call.finally(() => { pending.delete(call); }).catch(() => {});
    const raw = await untilAborted(call, signal);
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
  async function discoveryExclusions(signal: AbortSignal, deadline: number): Promise<string[]> {
    const exclude = ['turn-results'];
    if (!sdk.plugins.experimental_discoverRpc) return exclude;
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // Optional metadata shares the existing discovery deadline and Describe
    // call bound. It narrows candidates, never admits a supplier or readiness.
    const timer = setTimeout(() => controller.abort('deadline'), Math.max(0, Math.min(500, deadline - performance.now())));
    const calls: Promise<unknown>[] = [];
    try {
      const methodCall = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return sdk.plugins.experimental_discoverRpc!({ method: 'turnResultsDescribe', signal: controller.signal }); });
      calls.push(methodCall);
      const methods = await untilAborted(methodCall, controller.signal);
      signal.throwIfAborted();
      canonicalByteLength(methods, 262144);
      if (!Array.isArray(methods) || methods.length > 256) return exclude;
      const advertised = new Set<string>(), seen = new Set<string>();
      for (const row of methods) {
        if (!row || !PluginIdSchema.safeParse(row.pluginId).success || row.method !== 'turnResultsDescribe' || advertised.has(row.pluginId)) return exclude;
        advertised.add(row.pluginId);
      }
      // Older SDK hosts may expose this optional method but reject its call.
      // Do not add a second list on that fallback path.
      const listCall = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return sdk.plugins.list({ signal: controller.signal }); });
      calls.push(listCall);
      const listed = await untilAborted(listCall, controller.signal);
      signal.throwIfAborted();
      if (!listed || !Array.isArray(listed.plugins) || listed.plugins.length > 256) return exclude;
      for (const row of listed.plugins) {
        if (!row || !PluginIdSchema.safeParse(row.id).success || typeof row.enabled !== 'boolean' || typeof row.status !== 'string'
          || row.status.length > 64 || seen.has(row.id)) return ['turn-results'];
        seen.add(row.id);
        if (!advertised.has(row.id)) exclude.push(row.id);
      }
      return exclude;
    } catch {
      signal.throwIfAborted();
      return exclude; // Unsupported/failing/malformed metadata uses public Describe discovery.
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      // Ignored cancellation retains the initiating lane until actual settlement.
      await Promise.allSettled(calls);
    }
  }
  async function discover(signal: AbortSignal, spendRetry?: () => boolean) {
    const retry = sources !== null && !discoveryCursor && queuedDescriptors();
    if (sources && !discoveryCursor && (!retry || !discovering && !spendRetry?.())) return sources;
    if (!discovering) {
      const controller = new AbortController(), generation = discoveryGeneration;
      discoveryController = controller;
      const operation = (async () => {
        const deadline = performance.now() + 3000;
        // Listing-only discovery retains the public list admission/capacity
        // rules. Only failed named owners are described again; healthy owners
        // keep their valid descriptor and canvas authority.
        const candidates = retry ? [...descriptorDebt].filter(([, state]) => state === 'queued').slice(0, 32).map(([id]) => id) : [];
        for (const id of candidates) descriptorDebt.set(id, 'parked');
        const exclude = await discoveryExclusions(controller.signal, deadline);
        controller.signal.throwIfAborted();
        const result = await discoverResultsParticipants({ sdk, owner: discoveryOwner, cursor: retry ? null : discoveryCursor,
          exclude, budgets: { concurrency: 1, ...(retry ? { processingSlots: 0 } : {}) },
          overallDeadline: deadline, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (generation !== discoveryGeneration) throw Error('Result discovery retired.');
        if (result.state === 'failed') {
          if (retry) return sources ?? []; // Optional retry failure cannot erase healthy owners.
          throw Error('Result sources are temporarily unavailable.');
        }
        if (retry) {
          // A list admission alone never restores a failed owner's readiness.
          for (const row of result.rows) if (row.state === 'queued') row.state = 'prior-slice';
          for (const id of candidates) {
            const row = result.rows.find(row => row.pluginId === id);
            if (!row || row.state !== 'prior-slice') { descriptorDebt.delete(id); continue; }
            if (performance.now() >= deadline) { descriptorDebt.set(id, 'queued'); continue; }
            // Rotate only actual attempts. Deadline-deferred suffix owners stay
            // queued ahead of the attempted prefix for the next yielded unit.
            descriptorDebt.delete(id); descriptorDebt.set(id, 'parked');
            try {
              const negotiated = await createResultsSupplierClient(sdk, id, { signal: controller.signal,
                current: () => active && visible && generation === discoveryGeneration,
                overallDeadline: deadline }).describe();
              controller.signal.throwIfAborted();
              if (generation !== discoveryGeneration) throw Error('Result discovery retired.');
              if (negotiated.state === 'ready') { row.state = 'ready'; row.capabilities = negotiated.capabilities; }
              else row.state = 'incompatible';
            } catch (error) {
              controller.signal.throwIfAborted();
              if (generation !== discoveryGeneration) throw error;
              row.state = classifyResultsError(error);
            }
          }
        }
        const listedOwners = new Set(result.rows.map(row => row.pluginId));
        for (const id of descriptorDebt.keys()) if (!listedOwners.has(id)) descriptorDebt.delete(id);
        for (const row of result.rows) {
          if (transientDescriptor(row.state)) {
            if (!retry && !descriptorDebt.has(row.pluginId)) descriptorDebt.set(row.pluginId, 'queued');
          } else if (row.state !== 'queued' && row.state !== 'prior-slice') descriptorDebt.delete(row.pluginId);
        }
        const previousReady = readyOwners.state;
        const found = result.rows.flatMap(row => row.state === 'ready' && row.capabilities?.supplier
          ? [consumerSource(sdk, row.pluginId, row.capabilities)] : []);
        const merged = new Map((sources ?? []).filter(source => result.rows.some(row => row.pluginId === source.pluginId
          && !['disabled', 'not-running', 'incompatible', 'unknown-plugin', 'unknown-method', 'unauthorized'].includes(row.state)))
          .map(source => [source.pluginId, source]));
        for (const source of found) if (merged.has(source.pluginId) || merged.size < 256) merged.set(source.pluginId, source);
        if (!retry) discoveryCursor = result.cursor;
        discoveryCapacity = !result.capacity.complete;
        if (retry) for (const source of found) for (const entry of turns.values())
          if (entry.refs && entry.afterOwner !== null && source.pluginId <= entry.afterOwner) entry.debts.add(source.pluginId);
        sources = [...merged.values()].sort((a, b) => a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
        // A finite rediscovery slice can omit a still-listed owner that has
        // already supplied a valid label. Keep that display metadata without
        // granting readiness; fresh descriptors replace their own kind set.
        const listed = new Set(result.rows.filter(row => !['disabled', 'not-running', 'incompatible'].includes(row.state)).map(row => row.pluginId));
        const refreshed = new Set(found.map(source => source.pluginId));
        const labels = new Map([...captionLabels.state].filter(([key]) => {
          const [owner] = JSON.parse(key) as [string, string];
          return listed.has(owner) && !refreshed.has(owner);
        }));
        for (const source of sources) if (listed.has(source.pluginId)) for (const kind of source.capabilities.supplier?.kinds ?? [])
          labels.set(canonicalJson([source.pluginId, kind.kind]), { neutral: kind.neutralLabel, confirmed: kind.confirmedLabel });
        if (labels.size !== captionLabels.state.size || [...labels].some(([key, value]) => {
          const previous = captionLabels.state.get(key); return previous?.neutral !== value.neutral || previous.confirmed !== value.confirmed;
        })) captionLabels.setState(() => labels);
        publishReady(new Set(result.rows.filter(row => row.state === 'ready' && row.capabilities?.supplier
          || row.state === 'prior-slice' && previousReady.has(row.pluginId)).map(row => row.pluginId)));
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
      dropCollection(entry); turns.delete(entry.key); bytes -= entry.bytes;
    }
  }
  function publishPrefix(entry: TurnEntry, rows: GalleryObservation[], bindings: NonNullable<TurnSnapshot['bindings']>, coverage: string, limited: boolean) {
    if (entry.store.state.loaded) return; // A complete last-good snapshot is never replaced by a prefix.
    const retained = new Map(entry.store.state.rows.map(row => [row.key, row]));
    const bound = { ...entry.store.state.bindings };
    const charge = (row: GalleryObservation) => canonicalByteLength(row, 1048576)
      + canonicalByteLength({ [row.key]: bound[row.key] ?? { after: null } }, 16384) - 1;
    let bytes = canonicalByteLength({ rows: [], bindings: {} }) + [...retained.values()].reduce((sum, row) => sum + charge(row), 0);
    for (const row of rows) {
      const previous = retained.get(row.key), oldBinding = bound[row.key], oldCharge = previous ? charge(previous) : 0;
      // An explicitly returned changed/unresolved/retracted row can revoke its
      // own old positive. Omitted rows say nothing about absent membership.
      if (!row.resolution || row.unresolved || row.retracted) {
        retained.delete(row.key); delete bound[row.key]; bytes -= oldCharge; continue;
      }
      bound[row.key] = bindings[row.key]!;
      const added = charge(row);
      if ((!previous && retained.size >= GALLERY_RUNTIME_LIMITS.collectionRows) || bytes - oldCharge + added > GALLERY_RUNTIME_LIMITS.snapshotBytes - 2048) {
        if (previous && canonicalJson(previous) === canonicalJson(row)) bound[row.key] = oldBinding!;
        else { retained.delete(row.key); delete bound[row.key]; bytes -= oldCharge; }
        limited = true; continue;
      }
      retained.set(row.key, row); bytes += added - oldCharge;
    }
    publish(entry, { ...entry.store.state, rows: [...retained.values()], bindings: bound, loaded: false,
      limited, coverage, continued: true }, false);
  }
  function newCollection(anchor: GalleryAnchor, after?: { seq: number; key: string }, deadline = Infinity): TurnCollection {
    return { anchor: { ...anchor }, after, rows: [], bindings: Object.create(null), seen: new Set(), cursors: new Set(), pages: 0,
      charged: canonicalByteLength({ rows: [], bindings: {} }), coverage: 'unindexed', limited: false, done: false, retired: false, deadline };
  }
  function collectionCharge(pass: TurnCollection) {
    return canonicalByteLength({ anchor: pass.anchor, after: pass.after ?? null, rows: pass.rows, bindings: pass.bindings,
      seen: [...pass.seen], cursors: [...pass.cursors], pages: pass.pages }, 1048576) + 256;
  }
  function chargeCollection(entry: TurnEntry, pass: TurnCollection) {
    const next = collectionCharge(pass);
    if (next > GALLERY_RUNTIME_LIMITS.snapshotBytes || bytes - entry.collectionBytes + next
      > GALLERY_RUNTIME_LIMITS.totalSnapshotBytes - GALLERY_RUNTIME_LIMITS.leases * 16384) throw Error('Results collection capacity reached.');
    bytes += next - entry.collectionBytes; entry.collectionBytes = next;
  }
  function dropCollection(entry: TurnEntry) {
    if (active) bytes -= entry.collectionBytes;
    entry.collectionBytes = 0; entry.collection = null;
  }
  function retireCollection(entry: TurnEntry) {
    if (!entry.collection) return;
    entry.collection.retired = true;
    // In-flight ignored calls still retain their pass memory/credit until drain.
    if (!entry.controller) dropCollection(entry);
  }
  async function readCollectionPage(pass: TurnCollection, signal: AbortSignal) {
    signal.throwIfAborted();
    const { anchor, after, rows, bindings, seen, cursors } = pass;
    const result = await backend.read(anchor.threadId, anchor.turnId, signal, after); signal.throwIfAborted();
    if (pass.retired) throw Error('Turn result collection retired.');
    pass.coverage = result.coverage.state; pass.pages++;
    for (const row of result.page.rows) {
      if (row.identity.ref.source.threadId !== anchor.threadId || row.identity.ref.source.turnId !== anchor.turnId || seen.has(row.key))
        throw Error('Turn result collection changed.');
      const binding = { after: after ?? null };
      const charge = canonicalByteLength(row, 1048576) + canonicalByteLength({ [row.key]: binding }, 16384) - 2 + (rows.length ? 2 : 0);
      if (rows.length >= GALLERY_RUNTIME_LIMITS.collectionRows || pass.charged + charge > GALLERY_RUNTIME_LIMITS.snapshotBytes - 2048) { pass.limited = true; break; }
      pass.charged += charge;
      rows.push(row); seen.add(row.key); bindings[row.key] = binding;
    }
    pass.limited ||= Boolean(result.page.next && (pass.pages === GALLERY_RUNTIME_LIMITS.collectionPages || rows.length >= GALLERY_RUNTIME_LIMITS.collectionRows));
    pass.done = pass.limited || !result.page.next;
    if (!pass.done) {
      const key = canonicalJson(result.page.next);
      if (cursors.has(key)) throw Error('Turn result cursor did not advance.');
      cursors.add(key); pass.after = result.page.next!; // Only an actually issued cursor.
    }
    // Persisted pass metadata shares the original per-collection byte bound.
    // A trimmed candidate is provisional capacity, never completed absence.
    while (rows.length && collectionCharge(pass) > GALLERY_RUNTIME_LIMITS.snapshotBytes) {
      const removed = rows.pop()!; seen.delete(removed.key); delete bindings[removed.key]; pass.limited = pass.done = true;
    }
  }
  async function readTurn(anchor: GalleryAnchor, signal: AbortSignal) {
    const pass = newCollection(anchor);
    while (!pass.done) await readCollectionPage(pass, signal);
    return pass;
  }
  function publish(entry: TurnEntry, next: TurnSnapshot, authoritative = false) {
    const encoded = canonicalJson(next, GALLERY_RUNTIME_LIMITS.snapshotBytes);
    if (canonicalJson(entry.store.state, GALLERY_RUNTIME_LIMITS.snapshotBytes) === encoded) { if (authoritative) dialog?.observe(next.rows); return; }
    const charge = new TextEncoder().encode(encoded).length + entry.cursorCharge;
    if (bytes - entry.bytes + charge > GALLERY_RUNTIME_LIMITS.totalSnapshotBytes - GALLERY_RUNTIME_LIMITS.leases * 16384) {
      // Do not evict mounted content or acknowledge an empty successful view.
      authoritative = false;
      next = { ...entry.store.state, busy: false, continued: true, limited: true, error: 'Results display capacity reached.' };
    }
    const nextBytes = canonicalByteLength(next, GALLERY_RUNTIME_LIMITS.snapshotBytes) + entry.cursorCharge;
    bytes += nextBytes - entry.bytes; entry.bytes = nextBytes;
    entry.store.setState(() => next);
    if (authoritative) dialog?.observe(next.rows);
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
    const threads = [...queue];
    const urgent = ([, entries]: typeof threads[number]) => [...entries].some(entry => 'start' in entry && entry.priority && entry.live());
    // Open is first; retained pages/history/Media then share FIFO ahead of
    // optional source work. A short turn's enrichment cannot consume the
    // original deadline of a sibling's still-incomplete retained collection.
    const useful = (entry: Work) => 'start' in entry || entry.phase === 'read';
    const usefulThread = ([, entries]: typeof threads[number]) => [...entries].some(entry => useful(entry)
      && ('start' in entry ? entry.live() : entry.refs && entry.visible && entry.dirty && !entry.controller));
    for (const [threadId, entries] of [...threads.filter(urgent), ...threads.filter(entry => !urgent(entry) && usefulThread(entry)),
      ...threads.filter(entry => !urgent(entry) && !usefulThread(entry))]) {
      if (runningThreads.has(threadId)) continue;
      queue.delete(threadId);
      let next: Work | null = null;
      const priority = [...entries].find(entry => 'start' in entry && entry.priority && entry.live());
      for (const entry of priority ? [priority, ...[...entries].filter(entry => entry !== priority)]
        : [...[...entries].filter(useful), ...[...entries].filter(entry => !useful(entry))]) {
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
      if ('start' in entry) { running++; runningThreads.set(entry.threadId, () => false); entry.start(); continue; }
      entry.dirty = false;
      const controller = new AbortController(); entry.controller = controller; running++;
      const collecting = entry.phase === 'read'; let yielded = false;
      const collection = collecting ? entry.collection ??= newCollection(entry.anchor, entry.after, performance.now() + GALLERY_RUNTIME_LIMITS.sliceMs) : null;
      runningThreads.set(entry.anchor.threadId, () => {
        // Source operations may have their own nested transport lifetimes.
        // Yield only the tracked retained-read phase; other work finishes its
        // existing bounded unit before priority selection, never overlaps it.
        if (!collecting || controller.signal.aborted) return false;
        yielded = true; controller.abort('open-priority'); return true;
      });
      const anchor = entry.anchor;
      const signal = controller.signal;
      const remaining = collection ? Math.max(0, collection.deadline - performance.now()) : GALLERY_RUNTIME_LIMITS.sliceMs;
      const timer = setTimeout(() => controller.abort('deadline'), remaining);
      publish(entry, { ...entry.store.state, busy: true });
      void (async () => {
        if (collecting) {
          const pass = collection!;
          if (remaining <= 0) controller.abort('deadline');
          signal.throwIfAborted(); chargeCollection(entry, pass);
          await readCollectionPage(pass, signal); signal.throwIfAborted();
          if (pass.retired || entry.collection !== pass) throw Error('Turn result collection retired.');
          chargeCollection(entry, pass);
          if (!pass.done) {
            publishPrefix(entry, pass.rows, pass.bindings, pass.coverage, pass.limited);
            entry.dirty = true; return; // Same deadline/issued pass, FIFO after one settled page.
          }
          const cached = { rows: pass.rows, bindings: pass.bindings, limited: pass.limited, coverage: pass.coverage };
          dropCollection(entry); // Transfer into the sole store before charging its completed snapshot.
          if (cached.limited) {
            publishPrefix(entry, cached.rows, cached.bindings, cached.coverage, true);
            publish(entry, { ...entry.store.state, continued: true, limited: true, error: null });
          } else publish(entry, { ...entry.store.state, ...cached, loaded: true, next: null, continued: false, error: null }, true);
          // Release this lane before optional discovery/source work. Other
          // proved turns get their own retained read instead of waiting behind
          // a sibling's enrichment. The same entry/cursors/debt resume FIFO.
          entry.phase = 'source'; entry.dirty = true; return;
        }
        const cached = entry.store.state;
        const available = await discover(signal, () => { if (!entry.debtBudget) return false; entry.debtBudget--; return true; }); signal.throwIfAborted();
        // Finish a finite first visit to every listed owner before revisiting
        // productive owner debt. Failures park only that owner, never this pass.
        let source = available.find(source => entry.afterOwner === null || source.pluginId > entry.afterOwner);
        let revisiting = false, retryEnumerate = false;
        if (!source && !discoveryCursor && entry.debtBudget > 0) {
          const owner = entry.debts.values().next().value;
          source = available.find(source => source.pluginId === owner);
          if (source) {
            revisiting = true; entry.debtBudget--; entry.debts.delete(source.pluginId);
            retryEnumerate = entry.enumerateRetries.delete(source.pluginId);
          }
        }
        let failure: string | null = null;
        if (source) {
          // Advance the resource cursor even when this source fails. All factual
          // stage/claim progress still belongs to the existing atomic backend.
          if (!revisiting) entry.afterOwner = source.pluginId;
          try {
            let admitted = true;
            if (retryEnumerate) {
              // Recheck bounded public membership without re-describing healthy
              // owners or restoring any readiness. This stays in the charged
              // retry lane; its owner never supersedes shared discovery.
              const owner = createResultsDiscoveryOwner();
              try {
                const listed = await discoverResultsParticipants({ sdk, owner, exclude: ['turn-results'],
                  budgets: { processingSlots: 0 }, signal });
                signal.throwIfAborted();
                admitted = listed.state !== 'failed' && listed.rows.some(row => row.pluginId === source!.pluginId && row.state === 'queued')
                  && (sources?.includes(source) ?? false);
              } finally { owner.dispose(); }
            }
            const result: Awaited<ReturnType<typeof consumeTurnSource>> = admitted ? await consumeTurnSource(backend, sdk.threads.events, source, anchor, signal)
              : { continued: false, reason: `${source.pluginId}: retry source is not currently admitted` };
            signal.throwIfAborted();
            if (result.transientEnumerate) {
              // One failed first visit gets one revisit after healthy owners.
              // A failed revisit parks until genuine demand resets the pass.
              if (!revisiting) { entry.debts.add(source.pluginId); entry.enumerateRetries.add(source.pluginId); }
              else entry.debts.delete(source.pluginId);
              await backend.apply({ owner: source.pluginId, threadId: anchor.threadId, changes: [],
                supplier: { revision: source.capabilities.revision, connection: 'disconnected', freshUntil: null } }, signal);
            } else if (result.continued) entry.debts.add(source.pluginId); else entry.debts.delete(source.pluginId);
            failure = result.reason;
          } catch (error) {
            if (signal.aborted) throw error;
            entry.debts.delete(source.pluginId);
            entry.enumerateRetries.delete(source.pluginId);
            const reason = classifyResultsError(error);
            await backend.apply({ owner: source.pluginId, threadId: anchor.threadId, changes: [],
              supplier: { revision: source.capabilities.revision, connection: reason === 'incompatible' ? 'unsupported' : 'disconnected', freshUntil: null } }, signal);
            failure = `${source.pluginId}: ${reason}`;
          }
        }
        const unvisited = available.some(source => entry.afterOwner === null || source.pluginId > entry.afterOwner);
        const productive = unvisited || discoveryCursor !== null || ((entry.debts.size > 0 || queuedDescriptors()) && entry.debtBudget > 0);
        publish(entry, { ...entry.store.state, busy: false,
          continued: productive || entry.debts.size > 0 || descriptorDebt.size > 0 || cached.limited || discoveryCapacity,
          error: failure, coverage: discoveryCapacity ? 'source-capacity' : cached.coverage }, Boolean(entry.store.state.loaded));
        // Yield after the existing owner slice. One queued collection observes
        // its committed facts; there is no second page walk inside this unit.
        if (productive || source) { entry.phase = 'read'; entry.dirty = true; }
      })().catch(error => {
        if (collection?.retired) return; // Reset owns the new pass; old completion cannot publish into it.
        if (yielded) { if (active && visible && entry.refs && entry.visible) entry.dirty = true; return; }
        if (collection) retireCollection(entry);
        if (!collection && signal.aborted && signal.reason === 'deadline' && entry.afterOwner !== null
          && (sources?.some(source => source.pluginId > entry.afterOwner!) || discoveryCursor !== null)) entry.dirty = true;
        if (active && entry.controller === controller) publish(entry, { ...entry.store.state, busy: false, continued: true,
          error: signal.aborted ? signal.reason === 'deadline' ? 'Results read reached its deadline. Continue results.' : entry.store.state.error
            : error instanceof Error ? error.message.slice(0, 160) : 'Results are temporarily unavailable.' });
      }).finally(async () => {
        await Promise.allSettled([...(retainedCalls.get(signal) ?? [])]);
        if (collection?.retired && entry.collection === collection) dropCollection(entry);
        clearTimeout(timer); if (entry.controller === controller) entry.controller = null;
        running--; runningThreads.delete(anchor.threadId);
        drainedWork();
        if (active && entry.store.state.busy) publish(entry, { ...entry.store.state, busy: false });
        collect(); if (entry.dirty) enqueue(entry); schedule();
      });
    }
  }
  function readScope<T>(threadId: string, signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>, priority = false): Promise<{ state: 'ready'; value: T } | { state: 'capacity' }> {
    signal.throwIfAborted();
    if (!active || !visible) return Promise.reject(Error('Gallery read retired.'));
    if (historyReads.size >= GALLERY_RUNTIME_LIMITS.historyQueue) return Promise.resolve({ state: 'capacity' });
    return new Promise((resolve, reject) => {
      const controller = new AbortController(); let started = false;
      const cleanup = () => { signal.removeEventListener('abort', callerAbort); controller.signal.removeEventListener('abort', cancelled); };
      const callerAbort = () => controller.abort(signal.reason);
      const work: HistoryRead = { threadId, priority, live: () => !controller.signal.aborted,
        cancel: () => controller.abort(), start() {
          started = true;
          const call = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); });
          void untilAborted(call, controller.signal)
            .then(value => resolve({ state: 'ready', value }), reject).finally(async () => {
              await call.catch(() => {});
              // backend.read may reject its abort-aware wrapper before the
              // underlying SDK promise acknowledges cancellation.
              await Promise.allSettled([...(retainedCalls.get(controller.signal) ?? [])]);
              cleanup(); historyReads.delete(work); running--; runningThreads.delete(threadId); drainedWork(); schedule();
            });
        } };
      const cancelled = () => {
        if (!started) { unqueue(work); historyReads.delete(work); cleanup(); reject(controller.signal.reason); }
      };
      signal.addEventListener('abort', callerAbort, { once: true }); controller.signal.addEventListener('abort', cancelled, { once: true });
      historyReads.add(work);
      const pending = queue.get(threadId) ?? new Set<Work>(); pending.add(work); queue.set(threadId, pending); schedule();
      if (priority) {
        const sameThread = runningThreads.get(threadId);
        if (sameThread) sameThread();
        else if (running >= GALLERY_RUNTIME_LIMITS.lanes) {
          for (const yieldRead of runningThreads.values()) if (yieldRead()) break;
        }
      }
    });
  }
  function reset(entry: TurnEntry) {
    if (entry.collection) { retireCollection(entry); entry.controller?.abort('collection-reset'); }
    entry.dirty = true; entry.phase = 'read'; entry.afterOwner = null; entry.debts.clear(); entry.enumerateRetries.clear(); entry.debtBudget = GALLERY_RUNTIME_LIMITS.automaticDebtUnits;
  }
  function stopUnusedDiscovery() {
    if (!visibleDiscoveryDemands && ![...turns.values()].some(entry => entry.refs && entry.visible)) discoveryController?.abort();
  }
  function visibility() {
    visible = !document.hidden; media.visible(visible); canvases.setHidden(!visible);
    if (!visible) { pendingDialog = null; dialogSites.setState(previous => ({ ...previous, pending: null })); invalidateReadiness(); for (const read of historyReads) read.cancel(); for (const entry of turns.values()) { retireCollection(entry); entry.controller?.abort(); } }
    else { demandDescriptors(); for (const entry of turns.values()) if (entry.refs && entry.visible) { reset(entry); enqueue(entry); } }
  }
  document.addEventListener('visibilitychange', visibility);
  const api = { media, canvases, backend, readScope, readyOwners, captionLabels, presentationStatus, dialogSites, presentationRoot, invalidateReadiness,
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
        const page = await readTurn({ threadId: source.threadId, turnId: source.turnId } as GalleryAnchor, bounded);
        await discover(bounded); bounded.throwIfAborted();
        return page.rows.find(next => next.key === row.key && next.owner === row.owner && canonicalJson(next.identity) === canonicalJson(row.identity));
      });
      if (result.state === 'capacity' || !result.value) throw Error('This saved result needs another history page before it can be refreshed.');
      return result.value;
    },
    caption(row: GalleryObservation) {
      const kind = captionLabels.state.get(canonicalJson([row.owner, row.identity.ref.kind]));
      return kind ? row.resolution?.knowledge === 'confirmed' ? kind.confirmed : kind.neutral
          : row.resolution?.knowledge === 'failed' ? 'Result failed' : row.resolution?.knowledge === 'confirmed' ? 'Result recorded'
            : row.resolution?.knowledge === 'pending' ? 'Pending result' : 'Result status unknown';
    },
    invalidate(threadId?: string, rediscover = false, turnIds?: ReadonlySet<string>) {
      if (rediscover) invalidateReadiness();
      else demandDescriptors();
      for (const entry of turns.values()) if (entry.refs && (!threadId || entry.anchor.threadId === threadId)
        && (!turnIds || turnIds.has(entry.anchor.turnId))) { reset(entry); enqueue(entry); }
    },
    retain(anchor: GalleryAnchor, initiallyVisible = true, after?: { seq: number; key: string }) {
      if (after) canonicalByteLength(after, 4096);
      if (!active) throw Error('Gallery generation retired.');
      if (leases >= GALLERY_RUNTIME_LIMITS.leases) return {
        after, capacity: true, store: new Store<TurnSnapshot>({ rows: [], busy: false, continued: true, error: null, coverage: 'view-capacity' }),
        visible(_next: boolean) {}, more() {}, dispose() {},
      };
      const key = canonicalJson([anchor.threadId, anchor.turnId, anchor.turnSeqStart, anchor.turnSeqEnd, ...(after ? [after] : [])]);
      let entry = turns.get(key);
      if (!entry) {
        const initial: TurnSnapshot = { rows: [], busy: false, continued: false, error: null, coverage: 'unindexed' };
        // Charge both the page cursor and its cache-key copy. The fixed
        // reserve separately covers bounded per-view back-history metadata.
        const cursorCharge = after ? canonicalByteLength(after, 4096) * 2 + 16 : 0;
        const initialBytes = canonicalByteLength(initial) + cursorCharge;
        if (bytes + initialBytes > GALLERY_RUNTIME_LIMITS.totalSnapshotBytes - GALLERY_RUNTIME_LIMITS.leases * (GALLERY_RUNTIME_LIMITS.cursorBytes + 1024)) return {
          after, capacity: true, store: new Store<TurnSnapshot>({ rows: [], busy: false, continued: true, error: null, coverage: 'view-capacity' }),
          visible(_next: boolean) {}, more() {}, dispose() {},
        };
        entry = { key, threadId: anchor.threadId, anchor: { ...anchor }, after, store: new Store(initial), refs: 0, visible: 0, dirty: true, phase: 'read',
          controller: null, afterOwner: null, debts: new Set(), enumerateRetries: new Set(), debtBudget: GALLERY_RUNTIME_LIMITS.automaticDebtUnits, bytes: initialBytes, cursorCharge, collection: null, collectionBytes: 0 };
        turns.set(key, entry); bytes += entry.bytes;
      }
      const owned = entry;
      if (!owned.refs) { demandDescriptors(); reset(owned); }
      if (owned.anchor.turnSeqStart !== anchor.turnSeqStart || owned.anchor.turnSeqEnd !== anchor.turnSeqEnd) {
        owned.controller?.abort(); reset(owned);
      }
      owned.anchor = { ...anchor }; owned.refs++; leases++; if (initiallyVisible) owned.visible++;
      let live = true, shown = initiallyVisible;
      enqueue(owned);
      return { after, capacity: false, store: owned.store,
        visible(next: boolean) { if (!live || shown === next) return; shown = next; owned.visible += next ? 1 : -1;
          if (!owned.visible) { retireCollection(owned); owned.controller?.abort(); unqueue(owned); stopUnusedDiscovery(); }
          else { demandDescriptors(); reset(owned); enqueue(owned); } },
        more() { if (!live) return; demandDescriptors(); reset(owned); enqueue(owned); },
        dispose() {
          if (!live) return; live = false; if (!active) return; owned.refs--; leases--; if (shown) owned.visible--;
          if (!owned.refs || !owned.visible) { retireCollection(owned); owned.controller?.abort(); unqueue(owned); stopUnusedDiscovery(); }
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
    async whenDrained() {
      await dialogDrain; await canvases.whenDrained();
      // Replacement generations cannot buy new lanes while an old ignored
      // transport still occupies this owner's lane after disposal.
      if (running) await (workDrain ??= new Promise<void>(resolve => { finishWorkDrain = resolve; }));
    },
  };
  return api;
}
export type GalleryRuntime = ReturnType<typeof createGalleryRuntime>;
