/** Decoded client transport, explicit fetch root, and bounded identity client cache. */
import type {
  ClientInvalidation, ConnectionHealth, IdentityClient, IdentityClientTransport,
  IdentityConnection, IdentityConnectionEvent, IdentityConnectionInputs, IdentitySession,
} from './client.js';
import { createIdentityConnection, freshConnectionHealth } from './client-connection-runtime.js';
import type { ServerSession } from './host.js';
import { serverSessionCodec } from './host-runtime.js';
import type {
  Directory, DirectoryQuery, IdentityError, IdentityKey, IdentityProfile, Json,
  Page, Participant, ParticipantPreviewQuery, ParticipantQuery, ParticipantReader,
  ProfileLookup, ProfileQuery, ReadOptions, Result, Revision, Scheduler, ThreadId, Unsubscribe,
} from './model.js';
import { err, idCodec, identityKeyCodec, ok, profileCodec } from './model-runtime.js';
import { identityRoutes as routes } from './rpc-routes-runtime.js';
const errorCodes = new Set<IdentityError['code']>([
  'unavailable', 'unauthenticated', 'unsupported', 'incompatible', 'invalid-input', 'not-found', 'ambiguous',
  'stale-owner', 'stale-context', 'conflict', 'cancelled', 'disposed', 'limit-exceeded', 'invalid-operation', 'expired',
]);
const retryKinds = new Set<IdentityError['retry']>(['never', 'after-refresh', 'after-reconnect', 'same-operation']);

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function decodeError(value: unknown): Result<IdentityError> {
  return isRecord(value) && typeof value.code === 'string' && errorCodes.has(value.code as IdentityError['code'])
    && typeof value.message === 'string' && typeof value.retry === 'string' && retryKinds.has(value.retry as IdentityError['retry'])
    ? ok({ code: value.code as IdentityError['code'], message: value.message, retry: value.retry as IdentityError['retry'] })
    : err('incompatible', 'Malformed identity route error.');
}
function decodeResult<T>(value: unknown, decode: (payload: unknown) => Result<T>): Result<T> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return err('incompatible', 'Malformed identity route Result.');
  if (!value.ok) { const failure = decodeError(value.error); return failure.ok ? { ok: false, error: failure.value } : failure; }
  return decode(value.value);
}
function unavailable(connection: IdentityConnection): Result<never> | null {
  const link = connection.getHealth().identity;
  if (link.status === 'unavailable') return err(link.error.code, link.error.message, link.error.retry);
  return link.status === 'healthy' ? null : err('unavailable', 'Identity transport is reconnecting.', 'after-reconnect');
}
function cancelled(options?: ReadOptions): Result<never> | null {
  return options?.signal?.aborted ? err('cancelled', 'Identity request was cancelled.') : null;
}
function decodePage(value: unknown): Result<Page<IdentityProfile>> {
  if (!isRecord(value) || !Array.isArray(value.items) || (value.nextCursor !== null && typeof value.nextCursor !== 'string') || typeof value.revision !== 'string') {
    return err('incompatible', 'Malformed directory page.');
  }
  const profiles = value.items.map((item) => profileCodec.decode(item));
  return profiles.every((profile) => profile.ok)
    ? ok({ items: profiles.map((profile) => (profile as { ok: true; value: IdentityProfile }).value), nextCursor: value.nextCursor as Page<IdentityProfile>['nextCursor'], revision: value.revision as Page<IdentityProfile>['revision'] })
    : err('incompatible', 'Malformed directory profile.');
}
function decodeLookups(value: unknown): Result<readonly ProfileLookup[]> {
  if (!Array.isArray(value)) return err('incompatible', 'Malformed profile lookup list.');
  const values: ProfileLookup[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return err('incompatible', 'Malformed profile lookup.');
    const key = identityKeyCodec.decode(entry.key); if (!key.ok) return err('incompatible', 'Malformed profile lookup key.');
    if (entry.status === 'missing') values.push({ key: key.value, status: 'missing' });
    else if (entry.status === 'found') { const profile = profileCodec.decode(entry.profile); if (!profile.ok || profile.value.identity.key !== key.value) return err('incompatible', 'Malformed profile lookup profile.'); values.push({ key: key.value, status: 'found', profile: profile.value }); }
    else return err('incompatible', 'Malformed profile lookup status.');
  }
  return ok(values);
}
function decodeParticipant(value: unknown): Result<Participant> {
  if (!isRecord(value) || !Array.isArray(value.roles) || !value.roles.every((role) => role === 'author' || role === 'editor' || role === 'mentioned' || role === 'interaction-resolver')) return err('incompatible', 'Malformed participant.');
  const profile = profileCodec.decode({ identity: value.identity, presentation: value.presentation, revision: 'participant', status: 'current' });
  return profile.ok ? ok({ identity: profile.value.identity, presentation: profile.value.presentation, roles: [...value.roles] as Participant['roles'] }) : err('incompatible', 'Malformed participant identity.');
}
function decodeParticipantPage(value: unknown): Result<Page<Participant> & { readonly coverage: 'complete-history' | 'partial-history' }> {
  if (!isRecord(value) || !Array.isArray(value.items) || (value.nextCursor !== null && typeof value.nextCursor !== 'string') || typeof value.revision !== 'string' || (value.coverage !== 'complete-history' && value.coverage !== 'partial-history')) return err('incompatible', 'Malformed participant page.');
  const items = value.items.map(decodeParticipant); return items.every((item) => item.ok)
    ? ok({ items: items.map((item) => (item as { ok: true; value: Participant }).value), nextCursor: value.nextCursor as Page<Participant>['nextCursor'], revision: value.revision as Page<Participant>['revision'], coverage: value.coverage })
    : err('incompatible', 'Malformed participant item.');
}
function decodePreviews(value: unknown): Result<readonly { readonly threadId: ThreadId; readonly participants: readonly Participant[]; readonly hasMore: boolean; readonly coverage: 'complete-history' | 'partial-history'; readonly revision: Revision }[]> {
  if (!Array.isArray(value)) return err('incompatible', 'Malformed participant previews.');
  const result: { threadId: ThreadId; participants: readonly Participant[]; hasMore: boolean; coverage: 'complete-history' | 'partial-history'; revision: Revision }[] = [];
  for (const preview of value) {
    if (!isRecord(preview) || !Array.isArray(preview.participants) || typeof preview.hasMore !== 'boolean' || typeof preview.revision !== 'string' || (preview.coverage !== 'complete-history' && preview.coverage !== 'partial-history')) return err('incompatible', 'Malformed participant preview.');
    const threadId = idCodec('thread').decode(preview.threadId); const revision = idCodec('revision').decode(preview.revision);
    if (!threadId.ok || !revision.ok) return err('incompatible', 'Malformed participant preview identifiers.');
    const participants = preview.participants.map(decodeParticipant); if (!participants.every((participant) => participant.ok)) return err('incompatible', 'Malformed participant preview item.');
    result.push({ threadId: threadId.value, participants: participants.map((participant) => (participant as { ok: true; value: Participant }).value), hasMore: preview.hasMore, coverage: preview.coverage, revision: revision.value });
  }
  return ok(result);
}

/** Decodes every route envelope; malformed success never becomes empty/default identity data. */
export function createIdentityClientTransport(connection: IdentityConnection): IdentityClientTransport {
  const call = async <T>(method: string, input: Json, decode: (value: unknown) => Result<T>, options?: ReadOptions): Promise<Result<T>> => {
    const stopped = cancelled(options); if (stopped) return stopped;
    const failed = unavailable(connection); if (failed) return failed;
    try { return decodeResult(await connection.request(method, input, options), decode); }
    catch { return err('unavailable', 'Identity route request failed.', 'after-reconnect'); }
  };
  const directory: Directory = {
    search: (input, options) => call(routes.search, input as unknown as Json, decodePage, options),
    getMany: (input, options) => call(routes.profiles, input as unknown as Json, decodeLookups, options),
    subscribe(keys, listener) {
      return connection.subscribe((event) => {
        if (event.kind !== 'directory') return;
        if (!keys.length || !event.keys.length || event.keys.some((key) => keys.includes(key))) listener({ keys: event.keys, revision: event.revision });
      });
    },
  };
  const participants: ParticipantReader = {
    list: (input, options) => call(routes.participants, input as unknown as Json, decodeParticipantPage, options),
    previews: (input, options) => call(routes.participantPreviews, input as unknown as Json, decodePreviews, options),
  };
  return {
    bootstrap: (options) => call(routes.bootstrap, {}, serverSessionCodec.decode, options),
    selfProfile: (options) => call(routes.selfProfile, {}, profileCodec.decode, options),
    directory, participants,
    subscribe(listener) { return connection.subscribe((event) => { if (event.kind !== 'state') listener(event); }); },
  };
}

function waitFor<T>(promise: Promise<Result<T>>, signal?: AbortSignal): Promise<Result<T>> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(err('cancelled', 'Identity read was cancelled.'));
  return new Promise((resolve) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(err('cancelled', 'Identity read was cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then((result) => { signal.removeEventListener('abort', abort); resolve(result); });
  });
}
function profileKey(query: DirectoryQuery): string { return JSON.stringify(query); }

/**
 * Owns bounded profile/search caches only. Requests share physical batches while
 * each observer retains its own cancellation result and never disposes the root.
 */
export function createIdentityClient(options: { readonly connection: IdentityConnection; readonly scheduler?: Scheduler; readonly profileCache?: { readonly maxEntries: number; readonly staleAfterMs: number } }): IdentityClient {
  const transport = createIdentityClientTransport(options.connection);
  const now = () => options.scheduler?.now() ?? Date.now();
  const cacheMax = options.profileCache?.maxEntries ?? 512;
  const staleAfter = options.profileCache?.staleAfterMs ?? 60_000;
  if (!Number.isSafeInteger(cacheMax) || cacheMax <= 0 || !Number.isFinite(staleAfter) || staleAfter < 0) {
    throw new RangeError('profileCache requires a positive finite maxEntries and non-negative finite staleAfterMs.');
  }
  let disposed = false;
  let started: Promise<Result<void>> | null = null;
  let snapshot: IdentitySession = { status: 'loading' };
  let generation = 0;
  let refreshOrder = 0;
  let cacheEpoch = 0;
  let requiresBootstrap = true;
  const listeners = new Set<() => void>();
  const profiles = new Map<IdentityKey, { value: ProfileLookup; at: number }>();
  const searches = new Map<string, { value: Page<IdentityProfile>; at: number }>();
  type ProfilePending = { promise: Promise<Result<ProfileLookup>>; resolve: (value: Result<ProfileLookup>) => void; waiters: number };
  type SearchPending = { promise: Promise<Result<Page<IdentityProfile>>>; resolve: (value: Result<Page<IdentityProfile>>) => void; controller: AbortController; epoch: number; input: DirectoryQuery; waiters: number; settled: boolean };
  const pending = new Map<IdentityKey, ProfilePending>();
  const batches: IdentityKey[][] = [];
  const batchControllers = new Set<AbortController>();
  const batchEntries = new Map<AbortController, ReadonlyMap<IdentityKey, ProfilePending>>();
  const pendingSearches = new Map<string, SearchPending>();
  const searchQueue: SearchPending[] = [];
  let activeSearches = 0;
  const scheduledProfileKeys = new Set<IdentityKey>();
  let batchScheduled = false; let activeBatches = 0;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const clearDirectory = (keys?: readonly IdentityKey[]) => {
    cacheEpoch++;
    for (const entry of pending.values()) entry.resolve(err('stale-context', 'Directory read was invalidated.'));
    pending.clear(); batches.length = 0; scheduledProfileKeys.clear();
    for (const controller of batchControllers) controller.abort();
    batchControllers.clear();
    for (const entry of pendingSearches.values()) { entry.settled = true; entry.controller.abort(); entry.resolve(err('stale-context', 'Directory search was invalidated.')); }
    pendingSearches.clear(); searchQueue.length = 0;
    if (!keys || !keys.length) { profiles.clear(); searches.clear(); return; }
    for (const key of keys) profiles.delete(key);
    searches.clear();
  };
  const queueProfiles = () => {
    if (batchScheduled) return;
    batchScheduled = true;
    queueMicrotask(() => {
      batchScheduled = false;
      if (disposed) return;
      const keys = [...pending.keys()].filter((key) => !scheduledProfileKeys.has(key));
      for (let index = 0; index < keys.length; index += 64) {
        const batch = keys.slice(index, index + 64); batch.forEach((key) => scheduledProfileKeys.add(key)); batches.push(batch);
      }
      runBatches();
    });
  };
  const runBatches = () => {
    while (activeBatches < 4 && batches.length) {
      const keys = batches.shift()!.filter((key) => (pending.get(key)?.waiters ?? 0) > 0); if (!keys.length) continue; activeBatches++;
      const entries = new Map(keys.map((key) => [key, pending.get(key)!]));
      const controller = new AbortController(); const epoch = cacheEpoch; batchControllers.add(controller);
      batchEntries.set(controller, entries);
      void transport.directory.getMany({ keys }, { signal: controller.signal }).then((result) => {
        if (disposed || epoch !== cacheEpoch) return;
        if (result.ok) {
          const seen = new Set<IdentityKey>();
          if (result.value.length !== keys.length || result.value.some((value) => !keys.includes(value.key) || seen.has(value.key) || (seen.add(value.key), false))) result = err('incompatible', 'Profile batch did not return exactly the requested keys.');
        }
        const byKey = new Map(result.ok ? result.value.map((value) => [value.key, value]) : []);
        for (const key of keys) {
          const observer = entries.get(key); if (!observer || pending.get(key) !== observer) continue;
          const value = result.ok ? byKey.get(key) ?? { key, status: 'missing' as const } : result;
          const normalized = 'ok' in value ? value : ok(value);
          if (normalized.ok) {
            profiles.set(key, { value: normalized.value, at: now() });
            while (profiles.size > cacheMax) profiles.delete(profiles.keys().next().value!);
          }
          pending.delete(key); observer.resolve(normalized);
        }
      }, () => {
        for (const key of keys) { const observer = entries.get(key); if (observer && pending.get(key) === observer) { pending.delete(key); observer.resolve(err('unavailable', 'Profile batch failed.', 'after-reconnect')); } }
      }).finally(() => { batchControllers.delete(controller); batchEntries.delete(controller); keys.forEach((key) => scheduledProfileKeys.delete(key)); activeBatches--; queueProfiles(); runBatches(); });
    }
  };
  const profileRead = (key: IdentityKey): Promise<Result<ProfileLookup>> => {
    if (disposed) return Promise.resolve(err('disposed', 'Identity client is disposed.'));
    const fresh = profiles.get(key); if (fresh && now() - fresh.at <= staleAfter) return Promise.resolve(ok(fresh.value));
    const existing = pending.get(key); if (existing) return existing.promise;
    let resolve!: (value: Result<ProfileLookup>) => void;
    const promise = new Promise<Result<ProfileLookup>>((done) => { resolve = done; });
    pending.set(key, { promise, resolve, waiters: 0 }); queueProfiles(); return promise;
  };
  const observeProfile = (key: IdentityKey, signal?: AbortSignal): Promise<Result<ProfileLookup>> => {
    if (signal?.aborted) return Promise.resolve(err('cancelled', 'Identity read was cancelled.'));
    const promise = profileRead(key); const entry = pending.get(key);
    if (!entry) return waitFor(promise, signal);
    entry.waiters++;
    return new Promise((resolve) => {
      let done = false;
      const release = (value: Result<ProfileLookup>) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort);
        const left = Math.max(0, entry.waiters - 1); entry.waiters = left;
        if (!left) {
          if (pending.get(key) === entry) { pending.delete(key); entry.resolve(err('cancelled', 'All profile readers cancelled.')); }
          for (const [controller, entries] of batchEntries) if ([...entries.values()].every((item) => item.waiters === 0)) controller.abort();
        }
        resolve(value);
      };
      const abort = () => release(err('cancelled', 'Identity read was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true }); void promise.then(release);
    });
  };
  const runSearches = () => {
    while (!disposed && activeSearches < 4 && searchQueue.length) {
      const entry = searchQueue.shift()!; if (entry.settled || entry.waiters === 0 || entry.epoch !== cacheEpoch) continue;
      activeSearches++;
      void transport.directory.search(entry.input, { signal: entry.controller.signal }).then((result) => {
        if (!entry.settled) {
          entry.settled = true; pendingSearches.delete(profileKey(entry.input));
          if (disposed) entry.resolve(err('disposed', 'Identity client is disposed.'));
          else if (entry.epoch !== cacheEpoch) entry.resolve(err('stale-context', 'Directory search was invalidated.'));
          else { if (result.ok) { searches.set(profileKey(entry.input), { value: result.value, at: now() }); while (searches.size > 64) searches.delete(searches.keys().next().value!); } entry.resolve(result); }
        }
      }).finally(() => { activeSearches--; runSearches(); });
    }
  };
  const observeSearch = (input: DirectoryQuery, signal?: AbortSignal): Promise<Result<Page<IdentityProfile>>> => {
    if (signal?.aborted) return Promise.resolve(err('cancelled', 'Identity read was cancelled.'));
    const key = profileKey(input); let entry = pendingSearches.get(key);
    if (!entry) { let resolve!: (value: Result<Page<IdentityProfile>>) => void; const promise = new Promise<Result<Page<IdentityProfile>>>((done) => { resolve = done; }); entry = { promise, resolve, controller: new AbortController(), epoch: cacheEpoch, input: structuredClone(input), waiters: 1, settled: false }; pendingSearches.set(key, entry); searchQueue.push(entry); runSearches(); }
    else entry.waiters++;
    return new Promise((resolve) => { let done = false; const release = (value: Result<Page<IdentityProfile>>) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); entry!.waiters--; if (entry!.waiters === 0 && !entry!.settled) { entry!.settled = true; pendingSearches.delete(key); entry!.controller.abort(); entry!.resolve(err('cancelled', 'All directory search readers cancelled.')); } resolve(value); }; const abort = () => release(err('cancelled', 'Identity read was cancelled.')); signal?.addEventListener('abort', abort, { once: true }); void entry.promise.then(release); });
  };
  const directory: Directory = {
    async search(input, readOptions) {
      if (disposed) return err('disposed', 'Identity client is disposed.');
      const key = profileKey(input); const cached = searches.get(key);
      if (cached && now() - cached.at <= staleAfter) return ok(cached.value);
      return observeSearch(input, readOptions?.signal);
    },
    async getMany(input, readOptions) {
      if (disposed) return err('disposed', 'Identity client is disposed.');
      const unique = [...new Set(input.keys)];
      const results = await Promise.all(unique.map((key) => observeProfile(key, readOptions?.signal)));
      const failed = results.find((result) => !result.ok); return failed && !failed.ok ? failed : ok(results.map((result) => (result as { ok: true; value: ProfileLookup }).value));
    },
    subscribe(keys, listener) { return transport.directory.subscribe(keys, listener); },
  };
  const subscription = transport.subscribe((event) => {
    if (disposed) return;
    if (event.kind === 'directory') clearDirectory(event.revision === null ? undefined : event.keys);
    if (event.kind === 'session') { clearDirectory(); void refreshInternal(undefined, event.reason !== 'provider'); }
    if (event.kind === 'reconnected') { void refresh(); }
    if (event.kind === 'disconnected') suspendAuthority();
  });
  const suspendAuthority = () => { if (disposed) return; generation++; requiresBootstrap = true; snapshot = { status: 'loading' }; notify(); };
  let previousIdentity = options.connection.getHealth().identity;
  let revalidating = false;
  const stopHealth = options.connection.subscribeHealth(() => {
    if (disposed) return;
    const next = options.connection.getHealth(); const identity = next.identity;
    const changed = identity.status !== previousIdentity.status || (identity.status === 'unavailable' && previousIdentity.status === 'unavailable'
      && (identity.error.code !== previousIdentity.error.code || identity.error.message !== previousIdentity.error.message || identity.error.retry !== previousIdentity.error.retry));
    const wasUnhealthy = previousIdentity.status !== 'healthy'; previousIdentity = identity;
    if (!changed || revalidating) return;
    suspendAuthority();
    if (identity.status === 'healthy' && wasUnhealthy) void refresh();
  });
  const refreshInternal = async (readOptions?: ReadOptions, suspend = true): Promise<Result<void>> => {
    if (disposed) return err('disposed', 'Identity client is disposed.');
    const requestOrder = ++refreshOrder;
    if (suspend) suspendAuthority(); const requestGeneration = generation;
    revalidating = true;
    const revalidated = await options.connection.revalidate(readOptions);
    revalidating = false;
    if (!revalidated.ok) { if (requestOrder === refreshOrder && requestGeneration === generation && suspend) { snapshot = { status: 'loading' }; notify(); } return revalidated; }
    const session = await transport.bootstrap(readOptions);
    if (requestOrder !== refreshOrder || requestGeneration !== generation || disposed) return session.ok ? err('stale-context', 'Superseded identity refresh.') : session;
    if (!session.ok) { if (requestOrder === refreshOrder && suspend) { snapshot = { status: 'loading' }; notify(); } return session; }
    snapshot = session.value; requiresBootstrap = false; notify(); return ok(undefined);
  };
  const refresh = (readOptions?: ReadOptions): Promise<Result<void>> => refreshInternal(readOptions, true);
  return {
    connection: options.connection,
    getSnapshot: () => snapshot,
    currentSession() {
      if (disposed) return err('disposed', 'Identity client is disposed.');
      const health = options.connection.getHealth().identity;
      if (health.status === 'unavailable') return err(health.error.code, health.error.message, health.error.retry);
      if (snapshot.status === 'ready' && health.status === 'healthy' && !requiresBootstrap) return ok(snapshot);
      if (snapshot.status === 'unauthenticated' || snapshot.status === 'unavailable' || snapshot.status === 'incompatible') return err(snapshot.error.code, snapshot.error.message, snapshot.error.retry);
      return err('unavailable', 'Identity session is not live.', 'after-reconnect');
    },
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    start() { if (disposed) return Promise.resolve(err('disposed', 'Identity client is disposed.')); return started ??= refresh(); },
    refresh,
    selfProfile: (readOptions) => transport.selfProfile(readOptions),
    directory,
    participants: transport.participants,
    dispose() { if (disposed) return; disposed = true; generation++; requiresBootstrap = true; subscription(); stopHealth(); listeners.clear(); profiles.clear(); searches.clear(); batches.length = 0; for (const controller of batchControllers) controller.abort(); batchControllers.clear(); for (const entry of pendingSearches.values()) { entry.settled = true; entry.controller.abort(); entry.resolve(err('disposed', 'Identity client is disposed.')); } pendingSearches.clear(); searchQueue.length = 0; for (const entry of pending.values()) entry.resolve(err('disposed', 'Identity client is disposed.')); pending.clear(); snapshot = { status: 'disposed' }; },
  };
}

/** Independent-root HTTP connection: no retained feed and no inferred endpoint/plugin identity. */
export function createIdentityFetchConnection(options: { readonly endpoint: URL; readonly fetch: typeof globalThis.fetch; readonly signal: AbortSignal; readonly scheduler?: Scheduler }): IdentityConnection {
  let health: ConnectionHealth = freshConnectionHealth();
  const eventListeners = new Set<(payload: unknown) => void>();
  const healthListeners = new Set<() => void>();
  let disposed = false;
  const activeFetches = new Set<AbortController>();
  let verifiedStamp: string | null = null;
  let revalidateEpoch = 0;
  let revalidateFlight: Promise<Result<void>> | null = null;
  const publishHealth = () => { for (const listener of [...healthListeners]) listener(); };
  const setFailed = (state: 'identity' | 'state', message: string) => {
    health = { ...health, generation: health.generation + 1, [state]: { status: 'unavailable', error: { code: 'unavailable', message, retry: 'after-reconnect' } } };
    if (state === 'identity') for (const listener of [...eventListeners]) listener({ kind: 'disconnected' }); publishHealth();
  };
  const inputs: IdentityConnectionInputs = {
    async request(method, input, readOptions) {
      if (disposed || options.signal.aborted || readOptions?.signal?.aborted) throw new Error('Identity fetch request was cancelled.');
      const controller = new AbortController();
      activeFetches.add(controller);
      const abort = () => controller.abort(); options.signal.addEventListener('abort', abort, { once: true }); readOptions?.signal?.addEventListener('abort', abort, { once: true });
      const target = method.startsWith('bb-identity/v1/state/') ? 'state' : 'identity';
      try {
        const response = await options.fetch(new URL(method, options.endpoint), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(input), signal: controller.signal });
        if (!response.ok) throw new Error(`Identity route returned ${response.status}.`);
        return await response.json();
      } catch (cause) { if (!controller.signal.aborted) setFailed(target, cause instanceof Error ? cause.message : 'Identity fetch request failed.'); throw cause; }
      finally { activeFetches.delete(controller); options.signal.removeEventListener('abort', abort); readOptions?.signal?.removeEventListener('abort', abort); }
    },
    subscribe(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    getHealth: () => health,
    subscribeHealth(listener) { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    async revalidate(readOptions) {
      if (disposed || options.signal.aborted || readOptions?.signal?.aborted) return err('cancelled', 'Identity fetch connection was cancelled.');
      if (revalidateFlight) return revalidateFlight;
      const epoch = ++revalidateEpoch;
      const controller = new AbortController(); activeFetches.add(controller);
      const abort = () => controller.abort(); options.signal.addEventListener('abort', abort, { once: true }); readOptions?.signal?.addEventListener('abort', abort, { once: true });
      const flight = (async (): Promise<Result<void>> => { try {
        const response = await options.fetch(new URL(routes.bootstrap, options.endpoint), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, credentials: 'same-origin', body: '{}', signal: controller.signal });
        if (!response.ok) throw new Error(`Identity bootstrap returned ${response.status}.`);
        const checked = decodeResult(await response.json(), serverSessionCodec.decode);
        if (disposed || epoch !== revalidateEpoch) return err('disposed', 'Identity connection is disposed.');
        if (!checked.ok) { setFailed('identity', checked.error.message); return checked; }
        if (checked.value.status !== 'ready') {
          const failure = checked.value.error;
          setFailed('identity', failure.message); return err(failure.code, failure.message, failure.retry);
        }
        const changed = verifiedStamp !== null && verifiedStamp !== checked.value.stamp;
        verifiedStamp = checked.value.stamp;
        health = { ...health, generation: health.generation + 1, identity: { status: 'healthy' } }; publishHealth();
        if (changed) for (const listener of [...eventListeners]) listener({ kind: 'session' });
        return ok(undefined);
      } catch (cause) {
        if (controller.signal.aborted) return err('cancelled', 'Identity bootstrap was cancelled.');
        setFailed('identity', cause instanceof Error ? cause.message : 'Identity bootstrap failed.');
        return err('unavailable', 'Identity bootstrap failed.', 'after-reconnect');
      } finally { activeFetches.delete(controller); options.signal.removeEventListener('abort', abort); readOptions?.signal?.removeEventListener('abort', abort); } })();
      revalidateFlight = flight;
      void flight.finally(() => { if (revalidateFlight === flight) revalidateFlight = null; });
      return flight;
    },
    dispose() { disposed = true; revalidateEpoch++; for (const controller of activeFetches) controller.abort(); activeFetches.clear(); eventListeners.clear(); healthListeners.clear(); },
  };
  return createIdentityConnection(inputs);
}
