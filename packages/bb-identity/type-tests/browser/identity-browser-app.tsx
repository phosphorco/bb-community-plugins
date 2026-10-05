import { createRoot, type Root } from 'react-dom/client';
import * as React from 'react';
import type { PluginRpcClient, StandardSchemaV1 } from '@get-bb/plugin-sdk/app';
import type { IdentityClient } from '../../client.js';
import type { DraftKey, DraftStorage, StateAddress, StateDefinition, StateResource } from '../../state.js';
import type { IdentityKey, Json, Scheduler } from '../../model.js';
import { createIdentityConnection } from '../../client-connection-runtime.ts';
import { createIdentityClient } from '../../client-runtime.ts';
import { idCodec, ok } from '../../model-runtime.ts';
import { createIdentityReactRuntime, type NativeIdentityReactHooks } from '../../react-runtime.ts';
import { identityRpcMethods, identityRoutes } from '../../rpc-routes-runtime.ts';

declare global {
  interface Window {
    __bbIdentityBrowser?: {
      readonly readProbe: () => Promise<number | null>;
      readonly mounted: () => boolean;
      readonly rerenderSameRpc: () => void;
      readonly replaceRootARpc: () => void;
      readonly disposeRootA: () => void;
      readonly identityStats: () => BrowserStats;
      readonly stateBindingStats: () => StateBindingStats | null;
      readonly editStateBinding: () => boolean;
      readonly failStateBinding: () => boolean;
      readonly acknowledgeFailure: (generation: number) => boolean;
      readonly advanceStateRecord: () => void;
      readonly beginHeldClientReplacement: () => boolean;
      readonly waitForHeldWrite: () => Promise<void>;
      readonly releaseHeldWrite: () => void;
      readonly startHeldRecovery: () => boolean;
      readonly heldRecovery: () => HeldRecovery;
      readonly mountHeldProvider: () => Promise<void>;
      readonly beginMountedProviderSwitch: () => boolean;
      readonly waitForMountedProviderWrite: () => Promise<void>;
      readonly releaseMountedProviderWrite: () => void;
      readonly startMountedProviderRecovery: () => boolean;
      readonly mountedProviderRecovery: () => HeldRecovery;
      readonly mountedProviderStats: () => MountedProviderStats;
      readonly disposeMountedProvider: () => void;
      readonly resetDefaultView: () => Promise<boolean>;
      readonly stateDraftCount: () => Promise<number>;
      readonly stateDraftRecords: () => Promise<readonly { readonly recordId: string; readonly desired: readonly string[] }[]>;
    };
  }
}

type NativeMethod = (typeof identityRpcMethods)[keyof typeof identityRpcMethods];
type BrowserRpcContract = { readonly [Method in NativeMethod]: { readonly input: StandardSchemaV1<unknown, unknown>; readonly output: StandardSchemaV1<unknown, unknown> } };
type BrowserFixture = {
  readonly label: string;
  readonly version: number;
  readonly rpc: PluginRpcClient<BrowserRpcContract>;
  readonly realtime: Set<(payload: unknown) => void>;
  readonly counters: { bootstrap: number; subscriptions: number; unsubscriptions: number; active: number; stateSaves: number; client: IdentityClient | null };
};
export interface BrowserRootStats {
  readonly version: number;
  readonly bootstrap: number;
  readonly subscriptions: number;
  readonly unsubscriptions: number;
  readonly active: number;
  readonly live: boolean;
  readonly stateSaves: number;
}
export type BrowserStats = Readonly<Record<string, BrowserRootStats>>;
export interface StateBindingStats {
  readonly bindingId: number;
  readonly dirty: boolean;
  readonly owner: string | null;
  readonly view: string;
  readonly status: string;
  readonly client: string;
  readonly failures: readonly { readonly generation: number; readonly frozen: boolean }[];
  readonly failureCallbacks: number;
}
export type HeldRecovery =
  | { readonly status: 'idle' | 'pending' }
  | { readonly status: 'success'; readonly desired: readonly string[] }
  | { readonly status: 'failure'; readonly code: string };
export interface MountedProviderStats {
  readonly mounts: number;
  readonly disposals: number;
  readonly bindingId: number | null;
  readonly owner: string | null;
}

const HarnessFixtureContext = React.createContext<BrowserFixture | null>(null);
function useFixture(): BrowserFixture {
  const fixture = React.useContext(HarnessFixtureContext);
  if (!fixture) throw new Error('Missing browser identity fixture.');
  return fixture;
}
function readySession(label: string) {
  const identity = { kind: 'person' as const, key: `issuer:${label}`, issuer: 'issuer', subject: label };
  return {
    status: 'ready', instanceId: `browser-${label}`, mode: 'multi-user', stamp: `${label}-session`,
    actor: { identity, presentation: { displayName: label.toUpperCase(), handle: null, avatarUrl: null }, evidence: 'provider-verified' },
    capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
      directory: { search: false, lookup: false }, participants: false, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true },
  };
}

function requiredId<Kind extends string>(kind: Kind, value: string) {
  const result = idCodec(kind).decode(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function json(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]));
      throw new Error('Browser state value is not JSON.');
}

const browserStateDefinition: StateDefinition<string[]> = {
  collection: 'browser-state', schemaVersion: 1,
  codec: {
    decode(value) {
      return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? { ok: true, value: [...value] }
        : { ok: false, error: { code: 'invalid-input', message: 'Invalid browser state value.', retry: 'never' } };
    },
    encode(value) { return json(value); },
  },
  initialValue: () => [],
  equal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
};

const browserStateResource: StateResource<string[]> = {
  pluginId: requiredId('plugin', 'browser-state'), definition: browserStateDefinition,
};
let draftWriteFailures = 0;
type HeldWrite = { readonly entered: Promise<void>; readonly release: Promise<void>; enter(): void; resume(): void };
function createHeldWrite(): HeldWrite {
  let enter!: () => void; let resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  return { entered, release, enter, resume };
}
let heldWrite: HeldWrite | null = null;
let heldRecovery: HeldRecovery = { status: 'idle' };
const draftEntries = new Map<string, { readonly revision: number; readonly draft: import('../../state.js').PendingDraft<string[]> }>();
function draftEntryKey(key: DraftKey): string {
  return JSON.stringify([key.address.instanceId, key.address.pluginId, key.address.collection, key.address.recordId, key.address.owner, key.actor, key.ownerSession]);
}
const browserStateDrafts: DraftStorage<string[]> = {
  async find(address, actor, limit) {
    return ok([...draftEntries.values()]
      .filter(entry => entry.draft.key.actor === actor
        && entry.draft.key.address.instanceId === address.instanceId
        && entry.draft.key.address.pluginId === address.pluginId
        && entry.draft.key.address.collection === address.collection
        && entry.draft.key.address.recordId === address.recordId
        && entry.draft.key.address.owner === address.owner)
      .sort((left, right) => right.revision - left.revision)
      .slice(0, limit)
      .map(entry => structuredClone(entry)));
  },
  async write(draft, expectedRevision) {
    if (draftWriteFailures > 0) {
      draftWriteFailures--;
      return { ok: false as const, error: { code: 'unavailable' as const, message: 'Browser preservation failure.', retry: 'after-refresh' as const } };
    }
    const gate = heldWrite ?? mountedProviderWrite;
    if (gate !== null) { gate.enter(); await gate.release; }
    const key = draftEntryKey(draft.key);
    const current = draftEntries.get(key);
    if ((current?.revision ?? null) !== expectedRevision) {
      return { ok: false as const, error: { code: 'stale-context' as const, message: 'Draft revision changed.', retry: 'after-refresh' as const } };
    }
    const next = { revision: (current?.revision ?? 0) + 1, draft: structuredClone(draft) };
    draftEntries.set(key, next);
    return ok(structuredClone(next));
  },
  async remove(key, expectedRevision) {
    const current = draftEntries.get(draftEntryKey(key));
    if (current?.revision !== expectedRevision) {
      return { ok: false as const, error: { code: 'stale-context' as const, message: 'Draft revision changed.', retry: 'after-refresh' as const } };
    }
    draftEntries.delete(draftEntryKey(key));
    return ok(undefined);
  },
};
const browserStateScheduler: Scheduler = {
  now: () => 0,
  // State-binding tests explicitly choose when a dirty draft is preserved.
  schedule: () => () => {},
};
const browserStateValue = 'browser-state-value';
let nextBindingId = 0;
const bindingIds = new WeakMap<object, number>();
let stateProbe: {
  readonly stats: () => StateBindingStats;
  readonly edit: () => boolean;
  readonly fail: () => boolean;
  readonly acknowledge: (generation: number) => boolean;
  readonly beginHeldReplacement: () => boolean;
  readonly startHeldRecovery: () => boolean;
  readonly reset: () => Promise<boolean>;
  readonly draftCount: () => Promise<number>;
} | null = null;
let lastStateDraftScope: { readonly address: StateAddress; readonly actor: IdentityKey } | null = null;
let committedFailureCallbacks = 0;

async function countStateDrafts(): Promise<number> {
  if (lastStateDraftScope === null) return 0;
  const result = await browserStateDrafts.find(lastStateDraftScope.address, lastStateDraftScope.actor, 20);
  return result.ok ? result.value.length : 0;
}
async function stateDraftRecords(): Promise<readonly { readonly recordId: string; readonly desired: readonly string[] }[]> {
  if (lastStateDraftScope === null) return [];
  const result = await browserStateDrafts.find(lastStateDraftScope.address, lastStateDraftScope.actor, 20);
  return result.ok ? result.value.map(checkpoint => ({ recordId: checkpoint.draft.key.address.recordId, desired: checkpoint.draft.desired })) : [];
}
function createFixture(label: string, version: number): BrowserFixture {
  const counters = { bootstrap: 0, subscriptions: 0, unsubscriptions: 0, active: 0, stateSaves: 0, client: null };
  const rpc: PluginRpcClient<BrowserRpcContract> = {
    async call(method, input) {
      if (method === identityRpcMethods[identityRoutes.bootstrap]) {
        counters.bootstrap++;
        return { ok: true, value: readySession(label) };
      }
      if (method === identityRpcMethods['bb-identity/v1/state/load']) {
        if (typeof input !== 'object' || input === null || !('address' in input)) throw new Error('Malformed browser state load.');
        return { ok: true, value: { status: 'empty', address: input.address, version: { epoch: 'browser-state', sequence: 0 } } };
      }
      if (method === identityRpcMethods['bb-identity/v1/state/save']) {
        counters.stateSaves++;
        throw new Error('Browser state fixture must not re-author a recovered draft.');
      }
      throw new Error(`Unexpected browser identity RPC: ${method}`);
    },
  };
  return { label, version, rpc, realtime: new Set(), counters };
}

const browserHooks: NativeIdentityReactHooks = {
  useRpc() { return useFixture().rpc; },
  useRealtime(_channel, handler) {
    const fixture = useFixture();
    React.useEffect(() => {
      fixture.counters.subscriptions++; fixture.counters.active++; fixture.realtime.add(handler);
      return () => { fixture.counters.unsubscriptions++; fixture.counters.active--; fixture.realtime.delete(handler); };
    }, [fixture, handler]);
  },
  useRealtimeConnectionState() { useFixture(); return 'connected'; },
};
const BrowserIdentityReact = createIdentityReactRuntime(browserHooks);
const rootBFixture = createFixture('b', 0);
const discardedFixture = createFixture('discarded', 0);
const rootAHistory: BrowserFixture[] = [];
let rootAInstance: Root | null = null;
let heldProviderRoot: Root | null = null;
let mountedProvider: {
  readonly beginSwitch: () => boolean;
  readonly startRecovery: () => boolean;
  readonly stats: () => MountedProviderStats;
} | null = null;
let mountedProviderWrite: HeldWrite | null = null;
let mountedProviderRecovery: HeldRecovery = { status: 'idle' };
let mountedProviderMounts = 0;
let mountedProviderDisposals = 0;

function createExplicitReadyClient(label: string): IdentityClient {
  const connection = createIdentityConnection({
    async request(route, input) {
      if (route === identityRoutes.bootstrap) return { ok: true, value: readySession(label) };
      if (route === 'bb-identity/v1/state/load' && typeof input === 'object' && input !== null && 'address' in input) {
        return { ok: true, value: { status: 'empty', address: input.address, version: { epoch: 'held-provider-state', sequence: 0 } } };
      }
      throw new Error(`Unexpected explicit held-provider route: ${route}`);
    },
    subscribe: () => () => {},
    getHealth: () => ({ generation: 0, identity: { status: 'healthy' as const }, state: { status: 'healthy' as const } }),
    subscribeHealth: () => () => {},
    revalidate: async () => ok(undefined),
    dispose: () => {},
  });
  return createIdentityClient({ connection });
}

const databaseName = 'bb-identity-browser-harness';
const storeName = 'probe';
const key = 'mounted-react';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readProbe(): Promise<number | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
      request.onsuccess = () => resolve(typeof request.result === 'number' ? request.result : null);
    });
  } finally { database.close(); }
}

async function writeInitialProbe(): Promise<number> {
  const database = await openDatabase();
  try {
    const existing = await new Promise<number | null>((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
      request.onsuccess = () => resolve(typeof request.result === 'number' ? request.result : null);
    });
    if (existing !== null) return existing;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(1, key);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed.'));
      transaction.oncomplete = () => resolve();
    });
    return 1;
  } finally { database.close(); }
}

/** Root A also hosts the feature-storage bridge; B mounts through a separate React root. */
export function RootAHarness() {
  const [value, setValue] = React.useState<number | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [sameRenders, setSameRenders] = React.useState(0);
  const [rootAVersion, setRootAVersion] = React.useState(0);
  const [stateRecord, setStateRecord] = React.useState(0);
  const a = React.useMemo(() => createFixture('a', rootAVersion), [rootAVersion]);
  if (!rootAHistory.includes(a)) rootAHistory.push(a);
  React.useEffect(() => {
    let active = true;
    void writeInitialProbe().then(next => { if (active) setValue(next); }, error => { if (active) setFailure(error instanceof Error ? error.message : 'IndexedDB probe failed.'); });
    return () => { active = false; };
  }, []);
  window.__bbIdentityBrowser = {
    readProbe,
    mounted: () => valueIsReady(),
    rerenderSameRpc: () => setSameRenders(next => next + 1),
    replaceRootARpc: () => setRootAVersion(next => next + 1),
    disposeRootA: () => rootAInstance?.unmount(),
    identityStats: () => ({ discarded: report(discardedFixture), a: report(a), b: report(rootBFixture),
      ...Object.fromEntries(rootAHistory.map(item => [`a${item.version}`, report(item)])) }),
    stateBindingStats: () => stateProbe?.stats() ?? null,
    editStateBinding: () => stateProbe?.edit() ?? false,
    failStateBinding: () => stateProbe?.fail() ?? false,
    acknowledgeFailure: generation => stateProbe?.acknowledge(generation) ?? false,
    advanceStateRecord: () => setStateRecord(next => next + 1),
    beginHeldClientReplacement: () => stateProbe?.beginHeldReplacement() ?? false,
    waitForHeldWrite: async () => { await heldWrite?.entered; },
    releaseHeldWrite: () => heldWrite?.resume(),
    startHeldRecovery: () => stateProbe?.startHeldRecovery() ?? false,
    heldRecovery: () => heldRecovery,
    mountHeldProvider: async () => {
      const first = createExplicitReadyClient('held'); const second = createExplicitReadyClient('held');
      await Promise.all([first.start(), second.start()]);
      mountedProviderMounts = 0; mountedProviderDisposals = 0; mountedProviderRecovery = { status: 'idle' }; mountedProviderWrite = null;
      heldProviderRoot?.render(React.createElement(MountedProviderHarness, { first, second }));
    },
    beginMountedProviderSwitch: () => mountedProvider?.beginSwitch() ?? false,
    waitForMountedProviderWrite: async () => { await mountedProviderWrite?.entered; },
    releaseMountedProviderWrite: () => mountedProviderWrite?.resume(),
    startMountedProviderRecovery: () => mountedProvider?.startRecovery() ?? false,
    mountedProviderRecovery: () => mountedProviderRecovery,
    mountedProviderStats: () => mountedProvider?.stats() ?? { mounts: mountedProviderMounts, disposals: mountedProviderDisposals, bindingId: null, owner: null },
    disposeMountedProvider: () => heldProviderRoot?.unmount(),
    resetDefaultView: async () => stateProbe ? await stateProbe.reset() : false,
    stateDraftCount: countStateDrafts,
    stateDraftRecords,
  };
  return React.createElement('main', { id: 'identity-browser-root', 'data-state': failure ? 'error' : value === null ? 'loading' : 'ready', 'data-harness-renders': sameRenders },
    failure ?? value ?? 'loading', React.createElement(React.StrictMode, null,
      React.createElement(HarnessFixtureContext.Provider, { value: a }, React.createElement(NativeRoot, {
        root: 'a', stateRecord, advanceStateRecord: () => setStateRecord(next => next + 1),
        replaceClient: () => setRootAVersion(next => next + 1),
      }))));
}

function NativeChild({ root }: { readonly root: 'a' | 'b' }) {
  const fixture = useFixture();
  const client = BrowserIdentityReact.useBorrowedIdentityClient();
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    fixture.counters.client = client;
    const stop = client.subscribe(() => setRevision(value => value + 1));
    return stop;
  }, [client, fixture]);
  const session = client.currentSession();
  const live = session.ok && client.connection.getHealth().identity.status === 'healthy';
  return React.createElement('output', { 'data-root': root, 'data-rpc-version': fixture.version, 'data-live': String(live), 'data-revision': revision }, live ? fixture.label : 'loading');
}

function NativeRoot({ root, stateRecord = 0, advanceStateRecord = () => {}, replaceClient = () => {} }: {
  readonly root: 'a' | 'b'; readonly stateRecord?: number; readonly advanceStateRecord?: () => void; readonly replaceClient?: () => void;
}) {
  const client = BrowserIdentityReact.useNativeIdentityClient();
  if (client === null) return React.createElement('output', { 'data-root': root, 'data-live': 'false' }, 'loading');
  return React.createElement(BrowserIdentityReact.Provider, { client },
    React.createElement(BrowserIdentityReact.Context, null,
      React.createElement(NativeChild, { root }), root === 'a'
        ? React.createElement(StateBindingProbe, { record: stateRecord, advanceRecord: advanceStateRecord, replaceClient }) : null));
}

function StateBindingProbe({ record, advanceRecord, replaceClient }: {
  readonly record: number; readonly advanceRecord: () => void; readonly replaceClient: () => void;
}) {
  // Deliberately inline: ordinary parent rerenders must not recreate the
  // controller or lose a dirty edit merely because a callback identity changed.
  const binding = BrowserIdentityReact.useBoundIdentityState({
    resource: browserStateResource, recordId: `browser-state-${record}`, drafts: browserStateDrafts,
    target: 'actor', editPolicy: 'actor-only', initializeEmpty: false, scheduler: browserStateScheduler,
    onConflict: () => ({ kind: 'needs-review', reason: 'browser fixture' }),
    onUnpersistedDraft: () => { committedFailureCallbacks++; },
  });
  const snapshot = BrowserIdentityReact.useIdentityStateSnapshot(binding);
  const client = BrowserIdentityReact.useBorrowedIdentityClient();
  const actions = BrowserIdentityReact.useIdentityViewActions();
  const view = BrowserIdentityReact.useIdentityViewSnapshot();
  const failures = BrowserIdentityReact.usePreservationFailures();
  const acknowledge = BrowserIdentityReact.useAcknowledgePreservationFailure();
  const bindingId = React.useMemo(() => {
    if (binding === null) return 0;
    const known = bindingIds.get(binding);
    if (known !== undefined) return known;
    const next = ++nextBindingId; bindingIds.set(binding, next); return next;
  }, [binding]);
  React.useEffect(() => {
    if (binding === null) return;
    if (snapshot.status === 'ready') {
      lastStateDraftScope = { address: snapshot.address, actor: snapshot.address.owner };
    }
    const current = {
      stats: (): StateBindingStats => ({ bindingId, dirty: snapshot.status === 'ready' && snapshot.dirty,
        owner: binding.currentOwnerSession(), view: view.status, status: snapshot.status, client: client.getSnapshot().status,
        failures: failures.map(failure => ({ generation: failure.generation, frozen: Object.isFrozen(failure) })),
        failureCallbacks: committedFailureCallbacks }),
      edit: () => binding.edit([browserStateValue]).ok,
      fail: () => {
        const edited = binding.edit([browserStateValue]).ok;
        if (edited) { draftWriteFailures++; advanceRecord(); }
        return edited;
      },
      acknowledge: (generation: number) => acknowledge(generation),
      beginHeldReplacement: () => {
        const edited = binding.edit([browserStateValue]).ok;
        if (edited) { heldWrite = createHeldWrite(); heldRecovery = { status: 'idle' }; replaceClient(); }
        return edited;
      },
      startHeldRecovery: () => {
        const owner = binding.currentOwnerSession();
        if (owner === null || heldWrite === null) return false;
        heldRecovery = { status: 'pending' };
        void binding.recoveryCandidates(owner).then(result => {
          heldRecovery = result.ok
            ? { status: 'success', desired: result.value.map(candidate => candidate.draft.desired).flat() }
            : { status: 'failure', code: result.error.code };
        });
        return true;
      },
      reset: async () => (await actions.reset({ pendingEdits: 'discard' })).ok,
      draftCount: countStateDrafts,
    };
    stateProbe = current;
    return () => { if (stateProbe === current) stateProbe = null; };
  }, [acknowledge, actions, advanceRecord, binding, bindingId, client, failures, replaceClient, snapshot, view.status]);
  const dirty = snapshot.status === 'ready' && snapshot.dirty;
  const owner = binding?.currentOwnerSession() ?? null;
  return React.createElement('output', { 'data-state-binding': 'true', 'data-binding-id': bindingId,
    'data-state-dirty': String(dirty), 'data-state-owner': String(owner !== null), 'data-state-status': snapshot.status,
    'data-view-state': view.status }, binding === null ? 'waiting' : dirty ? 'dirty' : 'ready');
}

function MountedProviderLifetime({ children }: { readonly children?: React.ReactNode }) {
  React.useEffect(() => {
    mountedProviderMounts++;
    return () => { mountedProviderDisposals++; };
  }, []);
  return children;
}

function MountedProviderProbe({ replaceClient }: { readonly replaceClient: () => void }) {
  const binding = BrowserIdentityReact.useBoundIdentityState({
    resource: browserStateResource, recordId: 'held-provider-state', drafts: browserStateDrafts,
    target: 'actor', editPolicy: 'actor-only', initializeEmpty: false, scheduler: browserStateScheduler,
    onConflict: () => ({ kind: 'needs-review', reason: 'held provider fixture' }), onUnpersistedDraft: () => {},
  });
  const snapshot = BrowserIdentityReact.useIdentityStateSnapshot(binding);
  const bindingId = React.useMemo(() => {
    if (binding === null) return null;
    const known = bindingIds.get(binding);
    if (known !== undefined) return known;
    const next = ++nextBindingId; bindingIds.set(binding, next); return next;
  }, [binding]);
  React.useEffect(() => {
    if (binding === null) return;
    if (snapshot.status === 'ready') lastStateDraftScope = { address: snapshot.address, actor: snapshot.address.owner };
    const current = {
      beginSwitch: () => {
        const edited = binding.edit([browserStateValue]).ok;
        if (edited) { mountedProviderWrite = createHeldWrite(); mountedProviderRecovery = { status: 'idle' }; replaceClient(); }
        return edited;
      },
      startRecovery: () => {
        const owner = binding.currentOwnerSession();
        if (owner === null || mountedProviderWrite === null) return false;
        mountedProviderRecovery = { status: 'pending' };
        void binding.recoveryCandidates(owner).then(result => {
          mountedProviderRecovery = result.ok
            ? { status: 'success', desired: result.value.map(candidate => candidate.draft.desired).flat() }
            : { status: 'failure', code: result.error.code };
        });
        return true;
      },
      stats: (): MountedProviderStats => ({ mounts: mountedProviderMounts, disposals: mountedProviderDisposals,
        bindingId, owner: binding.currentOwnerSession() }),
    };
    mountedProvider = current;
    return () => { if (mountedProvider === current) mountedProvider = null; };
  }, [binding, bindingId, replaceClient, snapshot]);
  return React.createElement('output', { 'data-held-provider-binding': String(bindingId !== null), 'data-held-provider-owner': String(binding?.currentOwnerSession() !== null) }, 'held-provider');
}

function MountedProviderHarness({ first, second }: { readonly first: IdentityClient; readonly second: IdentityClient }) {
  const [client, setClient] = React.useState(first);
  return React.createElement(BrowserIdentityReact.Provider, { client },
    React.createElement(MountedProviderLifetime, null,
      React.createElement(BrowserIdentityReact.Context, null,
        React.createElement(MountedProviderProbe, { replaceClient: () => setClient(second) }))));
}

function report(fixture: BrowserFixture): BrowserRootStats {
  const client = fixture.counters.client;
  const live = client !== null && client.currentSession().ok && client.connection.getHealth().identity.status === 'healthy';
  return { version: fixture.version, bootstrap: fixture.counters.bootstrap, subscriptions: fixture.counters.subscriptions,
    unsubscriptions: fixture.counters.unsubscriptions, active: fixture.counters.active, stateSaves: fixture.counters.stateSaves, live };
}

function RootBHarness() {
  return React.createElement(React.StrictMode, null,
    React.createElement(HarnessFixtureContext.Provider, { value: rootBFixture }, React.createElement(NativeRoot, { root: 'b' })));
}

function valueIsReady(): boolean {
  return document.querySelectorAll('output[data-live="true"]').length === 2;
}

const rootAElement = document.getElementById('root-a');
const rootBElement = document.getElementById('root-b');
const heldProviderElement = document.getElementById('root-held-provider');
if (!rootAElement || !rootBElement || !heldProviderElement) throw new Error('Missing browser test roots.');
rootAInstance = createRoot(rootAElement);
const rootBInstance = createRoot(rootBElement);
heldProviderRoot = createRoot(heldProviderElement);
// This render is replaced before commit: constructor-free ownership must not
// leave a bootstrap or realtime subscription behind on the discarded fixture.
rootAInstance.render(React.createElement(HarnessFixtureContext.Provider, { value: discardedFixture }, React.createElement(NativeRoot, { root: 'a' })));
rootAInstance.render(React.createElement(RootAHarness));
rootBInstance.render(React.createElement(RootBHarness));
