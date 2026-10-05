/** Borrowed-client views and directory search; no React or state binding. */
import type { DirectorySearch, DirectorySearchSnapshot, IdentityClient, IdentityView, PendingEditPolicy, PreparedViewTransition, ViewSnapshot, ViewTransitionGuard } from './client.js';
import type { ActorReference, DirectoryQuery, PersonReference, Result, TargetSelection } from './model.js';
import { err, ok } from './model-runtime.js';

function ready(client: IdentityClient, selection: TargetSelection, subject: ActorReference | null, generation: number): Result<Extract<ViewSnapshot, { status: 'ready' }>> {
  const session = client.currentSession(); if (!session.ok) return session;
  if (session.value.status !== 'ready') return err(session.value.error.code, session.value.error.message, session.value.error.retry);
  if (selection.kind === 'person' && session.value.capabilities.requestIdentity === 'singleton') return err('unsupported', 'View-as is unavailable on the singleton host.');
  const resolved = selection.kind === 'self' ? session.value.actor.identity : subject;
  return resolved ? ok({ status: 'ready', session: session.value, subject: resolved, overriding: selection.kind === 'person', viewGeneration: generation }) : err('unavailable', 'Selected person is not resolved.', 'after-refresh');
}
export function createIdentityView(options: { readonly client: IdentityClient; readonly initialSelection?: TargetSelection; readonly pendingEdits?: PendingEditPolicy }): IdentityView {
  let disposed = false; let generation = 0; let serial = 0;
  let selection: TargetSelection = { kind: 'self' }; let selectedSubject: PersonReference | null = null;
  let snapshot: ViewSnapshot = { status: 'loading' }; let lastReady: Extract<ViewSnapshot, { status: 'ready' }> | null = null;
  let initial = options.initialSelection;
  const guards = new Set<ViewTransitionGuard>(); const listeners = new Set<() => void>();
  type Work = { controller: AbortController; prepared: PreparedViewTransition[]; cancelled: boolean };
  let active: Work | null = null;
  let finalizing = false;
  const safe = (callback: () => void) => { try { callback(); } catch {} };
  const publish = () => { for (const listener of [...listeners]) safe(listener); };
  const cancel = (work: Work) => {
    if (work.cancelled) return;
    work.cancelled = true; work.controller.abort();
    for (const item of work.prepared) safe(() => item.cancel());
    if (active === work) active = null;
  };
  const refresh = () => {
    const value = ready(options.client, selection, selectedSubject, generation);
    if (value.ok) { snapshot = value.value; lastReady = snapshot; }
    else snapshot = { status: 'blocked', session: options.client.getSnapshot(), requestedSubject: selection.kind === 'person' ? selection.key : null, lastReady, error: value.error };
    publish();
  };
  const invalidate = (reason: 'actor' | 'session' | 'disconnected' | 'disposed') => {
    if (active) cancel(active); generation++;
    for (const guard of [...guards]) safe(() => guard.invalidate(reason));
  };
  const select = async (input: TargetSelection, pending = options.pendingEdits ?? 'block'): Promise<Result<void>> => {
    if (disposed) return err('disposed', 'Identity view is disposed.');
    if (finalizing) return Promise.resolve().then(() => select(input, pending));
    if (active) cancel(active);
    const live = options.client.currentSession();
    if (!live.ok || live.value.status !== 'ready') return live.ok ? err('unavailable', 'Identity is unavailable.') : live;
    const next: TargetSelection = input.kind === 'self' || input.key === live.value.actor.identity.key ? { kind: 'self' } : { kind: 'person', key: input.key };
    if (next.kind === selection.kind && (next.kind === 'self' || selection.kind === 'person' && next.key === selection.key)) return ok(undefined);
    if (next.kind === 'person' && live.value.capabilities.requestIdentity === 'singleton') return err('unsupported', 'View-as is unavailable on the singleton host.');
    const expected = JSON.stringify([live.value.instanceId, live.value.actor.identity.key, live.value.stamp]);
    const from = snapshot;
    const work: Work = { controller: new AbortController(), prepared: [], cancelled: false }; active = work;
    const valid = () => {
      const current = options.client.currentSession();
      return !disposed && active === work && !work.controller.signal.aborted && current.ok && current.value.status === 'ready'
        && JSON.stringify([current.value.instanceId, current.value.actor.identity.key, current.value.stamp]) === expected;
    };
    const awaited = <T>(promise: Promise<Result<T>>): Promise<Result<T>> => new Promise(resolve => {
      const abort = () => { work.controller.signal.removeEventListener('abort', abort); resolve(err('stale-context', 'View transition was superseded.')); };
      if (work.controller.signal.aborted) { abort(); return; }
      work.controller.signal.addEventListener('abort', abort, { once: true });
      void promise.then(value => { work.controller.signal.removeEventListener('abort', abort); resolve(value); }, () => { work.controller.signal.removeEventListener('abort', abort); resolve(err('unavailable', 'View preparation failed.', 'after-refresh')); });
    });
    try {
      let resolved: PersonReference | null = null;
      if (next.kind === 'person') {
        const lookup = await awaited(options.client.directory.getMany({ keys: [next.key] }, { signal: work.controller.signal }));
        if (!valid()) return err('stale-context', 'View transition was superseded.');
        if (!lookup.ok) return lookup;
        const found = lookup.value[0];
        if (lookup.value.length !== 1 || !found || found.key !== next.key || found.status !== 'found' || found.profile.identity.kind !== 'person' || found.profile.identity.key !== next.key) return err(found?.status === 'missing' ? 'not-found' : 'incompatible', 'Selected identity is not a resolvable person.');
        resolved = Object.freeze({ ...found.profile.identity });
      }
      const transition = { id: String(++serial), from, selection: next, pending, signal: work.controller.signal };
      for (const guard of [...guards]) {
        if (!valid()) return err('stale-context', 'View transition was superseded.');
        const result = guard.inspect(transition); if (!result.ok) return result; work.prepared.push(result.value);
      }
      for (const item of work.prepared) {
        if (!valid()) return err('stale-context', 'View transition was superseded.');
        const value = await awaited(item.prepare());
        if (!valid()) return err('stale-context', 'View transition was superseded.');
        if (!value.ok) return value;
      }
      const candidate = ready(options.client, next, resolved, generation + 1);
      if (!candidate.ok) return candidate;
      finalizing = true;
      for (const item of work.prepared) {
        if (!valid()) return err('stale-context', 'View transition was superseded.');
        item.commit();
      }
      if (!valid()) return err('stale-context', 'View transition was superseded.');
      selection = next; selectedSubject = resolved; generation++; snapshot = candidate.value; lastReady = snapshot; active = null; publish(); return ok(undefined);
    } catch { return err('unavailable', 'View guard or identity lookup failed.', 'after-refresh'); }
    finally { finalizing = false; if (active === work || work.cancelled) cancel(work); }
  };
  let lastStamp: string | null = null; let lastActor: string | null = null;
  const observeClient = () => {
    if (disposed) return;
    const live = options.client.currentSession();
    if (!live.ok || live.value.status !== 'ready') { invalidate('disconnected'); lastStamp = null; lastActor = null; refresh(); return; }
    const actor = live.value.actor.identity.key;
    if (lastActor !== null && lastActor !== actor) invalidate('actor');
    else if (lastStamp !== null && lastStamp !== live.value.stamp) invalidate('session');
    lastStamp = live.value.stamp; lastActor = actor; refresh();
    if (initial) { const next = initial; initial = undefined; void select(next); }
  };
  const stop = options.client.subscribe(observeClient); observeClient();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    select(next, input) { return select(next, input?.pendingEdits); }, reset(input) { return select({ kind: 'self' }, input?.pendingEdits); },
    registerGuard(guard) { if (disposed) return () => {}; guards.add(guard); return () => { guards.delete(guard); if (active) cancel(active); }; },
    dispose() { if (disposed) return; disposed = true; invalidate('disposed'); stop(); guards.clear(); listeners.clear(); },
  };
}
export function createDirectorySearch(client: IdentityClient): DirectorySearch {
  let disposed = false; let epoch = 0; let controller: AbortController | null = null;
  let snapshot: DirectorySearchSnapshot = { status: 'loading' }; let query: DirectoryQuery | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const stop = client.directory.subscribe([], () => { epoch++; controller?.abort(); query = null; snapshot = { status: 'loading' }; publish(); });
  const load = async (input: DirectoryQuery, revision?: string): Promise<Result<void>> => {
    if (disposed) return err('disposed', 'Directory search is disposed.');
    const captured = structuredClone(input); const mine = ++epoch; controller?.abort();
    const current = new AbortController(); controller = current; snapshot = { status: 'loading' }; publish();
    const result = await new Promise<Awaited<ReturnType<IdentityClient['directory']['search']>>>(resolve => {
      const abort = () => resolve(err('stale-context', 'Directory query was superseded.'));
      current.signal.addEventListener('abort', abort, { once: true });
      void (async () => current.signal.aborted ? err('stale-context', 'Directory query was superseded.') : client.directory.search(captured, { signal: current.signal }))().then(value => {
        current.signal.removeEventListener('abort', abort); resolve(value);
      }, () => { current.signal.removeEventListener('abort', abort); resolve(err('unavailable', 'Directory query failed.', 'after-refresh')); });
    });
    if (disposed || mine !== epoch) return err('stale-context', 'Directory query was superseded.');
    if (!result.ok) { query = null; snapshot = { status: 'error', error: result.error }; publish(); return result; }
    if (revision !== undefined && result.value.revision !== revision) {
      const failure = err('stale-context', 'Directory snapshot changed during continuation.', 'after-refresh');
      if (!failure.ok) { query = null; snapshot = { status: 'error', error: failure.error }; publish(); } return failure;
    }
    query = captured; snapshot = { status: 'ready', page: result.value }; publish(); return ok(undefined);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    search: load,
    next() { return !query || snapshot.status !== 'ready' || !snapshot.page.nextCursor ? Promise.resolve(err('not-found', 'No next directory page.')) : load({ ...query, cursor: snapshot.page.nextCursor }, snapshot.page.revision); },
    dispose() { if (disposed) return; disposed = true; epoch++; controller?.abort(); stop(); listeners.clear(); },
  };
}
