/** Internal framework-neutral controller/view owner for the portable client binding. */
import type { IdentityStateBinding, IdentityStateBindingOptions, StateBindingSource, ViewTransitionGuard } from './client.js';
import type { ServerSession } from './host.js';
import type { ActorReference, IdentityError, OwnerSessionId, Result } from './model.js';
import type { IdentityState, PendingDraft, SyncSnapshot } from './state.js';
import { err, idCodec, newOperationId, ok } from './model-runtime.js';
import { createIdentityState } from './state-controller-runtime.js';
import { createStateTransport } from './state-transport-runtime.js';
import type { DraftRetirementOwner, DraftRetirementScope } from './draft-retirement-runtime.js';

type Ready = Extract<ServerSession, { status: 'ready' }>;
const waiting = Object.freeze({ status: 'waiting-for-identity' as const });

export function bindIdentityState<T>(options: IdentityStateBindingOptions<T> & StateBindingSource<T>, retirementOwner?: DraftRetirementOwner): IdentityStateBinding<T> {
  type Entry = { key: string; recoveryKey: string; owner: OwnerSessionId; controller: IdentityState<T>; stop: () => void; writable: boolean;
    reconnect: Promise<Result<void>> | null;
    preservation: { storage: object; scope: DraftRetirementScope } | null };
  let disposed = false;
  let viewDisposed = false;
  let current: Entry | null = null;
  let pause: object | null = null;
  let snapshot: ReturnType<IdentityStateBinding<T>['getSnapshot']> = waiting;
  let stateHealthy = options.client.connection.getHealth().state.status === 'healthy';
  const listeners = new Set<() => void>();
  const retirements = new Map<string, Set<Promise<Result<void>>>>();
  const publish = () => { for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const hasPending = (state: SyncSnapshot<T>) => state.status === 'ready'
    ? state.dirty || state.saving : (state.status === 'blocked' || state.status === 'detached') && state.draft !== null;
  const live = (): { session: Ready; subject: ActorReference; key: string; writable: boolean } | null => {
    if (disposed || viewDisposed) return null;
    const result = options.client.currentSession();
    if (!result.ok || result.value.status !== 'ready') return null;
    const session = result.value;
    const view = options.view.getSnapshot();
    if (options.target === 'viewed-subject' && (view.status !== 'ready'
      || view.session.instanceId !== session.instanceId || view.session.stamp !== session.stamp
      || view.session.actor.identity.key !== session.actor.identity.key)) return null;
    const subject = options.target === 'viewed-subject' && view.status === 'ready' ? view.subject : session.actor.identity;
    return { session, subject, key: JSON.stringify([session.instanceId, session.actor.identity.key, session.stamp, subject.key]),
      writable: options.editPolicy === 'collaborators' || subject.key === session.actor.identity.key };
  };
  const valid = (entry: Entry) => !disposed && current === entry && live()?.key === entry.key;
  const failedPreservation = (draft: PendingDraft<T> | null, error: IdentityError) => {
    if (draft) { try { options.onUnpersistedDraft?.(draft, error); } catch {} }
  };
  const retire = (reason: 'identity-invalidated' | 'view-change' | 'unmount', pending: 'preserve' | 'discard' = 'preserve') => {
    const entry = current;
    if (!entry) return;
    current = null; pause = null; entry.stop();
    const preserve = hasPending(entry.controller.getSnapshot());
    const draft = entry.controller.detach(reason);
    snapshot = entry.controller.getSnapshot();
    if (!preserve && pending !== 'discard') { entry.controller.dispose(); publish(); return; }
    const group = retirements.get(entry.recoveryKey) ?? new Set<Promise<Result<void>>>(); retirements.set(entry.recoveryKey, group);
    const task = Promise.resolve().then(() => entry.controller.close({ pending })).then(result => {
      if (!result.ok) failedPreservation(draft, result.error);
      return result;
    }, () => {
      const failure = err('unavailable', 'Draft preservation failed.', 'after-refresh');
      if (!failure.ok) failedPreservation(draft, failure.error);
      return failure;
    }).finally(() => { entry.controller.dispose(); group.delete(task); if (!group.size) retirements.delete(entry.recoveryKey); if (!disposed) publish(); });
    group.add(task);
    if (entry.preservation) retirementOwner?.begin(entry.preservation.storage, entry.preservation.scope, task);
    publish();
  };
  let observing = false;
  let observeAgain = false;
  const observe = () => {
    if (disposed || viewDisposed) return;
    if (observing) { observeAgain = true; return; }
    observing = true;
    try { do {
    observeAgain = false;
    const next = live();
    if (!next) { retire('identity-invalidated'); return; }
    if (current?.key === next.key) return;
    retire('identity-invalidated');
    if (live()?.key !== next.key) { observeAgain = true; continue; }
    const owner = idCodec('owner-session').decode(`owner-${newOperationId()}`);
    if (!owner.ok) throw new Error(owner.error.message);
    const controller = options.create
      ? options.create({ session: next.session, subject: next.subject, ownerSession: owner.value })
      : createIdentityState({
        address: { instanceId: next.session.instanceId, pluginId: options.resource.pluginId,
          collection: options.resource.definition.collection, recordId: options.recordId, owner: next.subject.key },
        expected: { actor: next.session.actor.identity.key, session: next.session.stamp }, ownerSession: owner.value,
        definition: options.resource.definition, transport: createStateTransport({ connection: options.client.connection, resource: options.resource }),
        ...(options.drafts ? { drafts: options.drafts } : {}), onConflict: options.onConflict, initializeEmpty: next.writable && options.initializeEmpty,
        ...(options.scheduler ? { scheduler: options.scheduler } : {}), currentSession: () => options.client.currentSession(),
      });
    if (live()?.key !== next.key) { controller.dispose(); observeAgain = true; continue; }
    const preservation = options.resource && options.drafts ? { storage: options.drafts, scope: { address: controller.getSnapshot().address,
      actor: next.session.actor.identity.key, schemaVersion: options.resource.definition.schemaVersion } } : null;
    const entry: Entry = { key: next.key, recoveryKey: JSON.stringify([next.session.instanceId, next.session.actor.identity.key, next.subject.key]), owner: owner.value, controller, stop: () => {}, writable: next.writable, reconnect: null, preservation };
    current = entry;
    const update = () => { if (valid(entry)) { snapshot = controller.getSnapshot(); publish(); } };
    entry.stop = controller.subscribe(update); update();
    void controller.start().then(update, update);
    } while (observeAgain && !disposed && !viewDisposed);
    } finally { observing = false; }
  };
  const command = async <V>(owner: OwnerSessionId, run: (controller: IdentityState<T>) => Promise<Result<V>>, write = false): Promise<Result<V>> => {
    const entry = current;
    if (!entry || owner !== entry.owner || !valid(entry)) return err('stale-context', 'State controller ownership changed.');
    if (write && (!entry.writable || pause)) return err('unsupported', 'The selected state is not editable during this view or transition.');
    let result: Result<V>;
    try { result = await run(entry.controller); }
    catch { result = err('unavailable', 'State operation failed.', 'after-refresh'); }
    return valid(entry) ? result : err('stale-context', 'State controller ownership changed.');
  };
  const reconnect = (owner: OwnerSessionId): Promise<Result<void>> => {
    const entry = current;
    if (entry === null) {
      return Promise.resolve(err('stale-context', 'State controller ownership changed or is not writable.'));
    }
    const eligible = () => current === entry && entry.owner === owner
      && valid(entry) && entry.writable && pause === null;
    if (!eligible()) {
      return Promise.resolve(err('stale-context', 'State controller ownership changed or is not writable.'));
    }
    if (entry.reconnect) {
      return entry.reconnect.then(result => eligible()
        ? result
        : err('stale-context', 'State controller ownership changed.'));
    }
    const work = (async (): Promise<Result<void>> => {
      if (!eligible()) return err('stale-context', 'State controller ownership changed or is not writable.');
      let verified: Result<void>;
      try { verified = await options.client.connection.revalidate(); }
      catch { verified = err('unavailable', 'State connection revalidation failed.', 'after-refresh'); }
      if (!eligible()) return err('stale-context', 'State controller ownership changed.');
      if (!verified.ok) return verified;
      let recovered: Result<void>;
      try { recovered = await entry.controller.reconnect(); }
      catch { recovered = err('unavailable', 'State reconciliation failed.', 'after-refresh'); }
      return eligible() ? recovered : err('stale-context', 'State controller ownership changed.');
    })();
    entry.reconnect = work;
    void work.finally(() => { if (entry.reconnect === work) entry.reconnect = null; });
    return work;
  };
  const guard: ViewTransitionGuard = {
    invalidate(reason) { if (reason === 'disposed') viewDisposed = true; retire('identity-invalidated'); },
    inspect(transition) {
      const entry = current;
      const unaffected = options.target === 'actor' || !entry;
      if (!unaffected && transition.pending === 'block' && hasPending(entry.controller.getSnapshot())) return err('conflict', 'Resolve or preserve pending edits before changing view.');
      const token = {}; let committed = false; let resume: (() => void) | null = null;
      return ok({
        async prepare() {
          if (unaffected) return ok(undefined);
          if (!valid(entry) || transition.signal.aborted) return err('stale-context', 'View transition expired.');
          pause = token;
          resume = entry.controller.suspendAutomaticDispatch();
          if (transition.pending === 'block' && hasPending(entry.controller.getSnapshot())) return err('conflict', 'New edits arrived before the view transition.');
          const result = transition.pending === 'flush' ? await entry.controller.flush()
            : transition.pending === 'preserve' ? await entry.controller.checkpoint() : ok(undefined);
          if (!result.ok) return result;
          return valid(entry) && !transition.signal.aborted ? ok(undefined) : err('stale-context', 'View transition expired.');
        },
        commit() {
          committed = true;
          if (!unaffected && current === entry) retire('view-change', transition.pending === 'discard' ? 'discard' : 'preserve');
          resume?.(); resume = null;
          if (pause === token) pause = null;
        },
        cancel() { if (!committed && pause === token) pause = null; resume?.(); resume = null; },
      });
    },
  };
  const stopGuard = options.view.registerGuard(guard);
  const stopView = options.view.subscribe(observe);
  const stopClient = options.client.subscribe(observe);
  const stopHealth = options.client.connection.subscribeHealth(() => {
    const healthy = options.client.connection.getHealth().state.status === 'healthy';
    const reconnect = healthy && !stateHealthy; stateHealthy = healthy;
    const entry = current;
    if (reconnect && entry && valid(entry)) void entry.controller.reconnect({ reuseInFlight: true });
  });
  observe();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    currentOwnerSession: () => current?.owner ?? null,
    edit(value) {
      const entry = current;
      if (!entry || !valid(entry)) return err('stale-context', 'State identity is not ready.');
      return entry.writable && !pause ? entry.controller.edit(value) : err('unsupported', 'The selected state is read-only or changing view.');
    },
    flush() { return current ? command(current.owner, controller => controller.flush(), true) : Promise.resolve(err('stale-context', 'State identity is not ready.')); },
    reconnect(owner) { return reconnect(owner); },
    recoveryCandidates(owner, readOptions) {
      const entry = current;
      return command(owner, async controller => {
        if (!entry) return err('stale-context', 'State controller ownership changed.');
        if (entry.preservation && retirementOwner) {
          const settled = await retirementOwner.wait(entry.preservation.storage, entry.preservation.scope, readOptions?.signal);
          if (!settled.ok) return settled;
        }
        while (retirements.get(entry.recoveryKey)?.size) {
          if (!valid(entry)) return err('stale-context', 'State controller ownership changed.');
          if (readOptions?.signal?.aborted) return err('cancelled', 'Recovery lookup was cancelled.');
          const pending = Promise.all([...retirements.get(entry.recoveryKey)!]);
          if (readOptions?.signal) {
            const signal = readOptions.signal;
            await new Promise<void>(resolve => {
              const done = () => { signal.removeEventListener('abort', done); resolve(); };
              signal.addEventListener('abort', done, { once: true }); void pending.then(done);
              if (signal.aborted) done();
            });
          } else await pending;
        }
        if (!valid(entry)) return err('stale-context', 'State controller ownership changed.');
        return controller.recoveryCandidates(readOptions);
      });
    },
    checkpoint(owner) { return command(owner, controller => controller.checkpoint()); },
    recover(owner, checkpoint) { return command(owner, controller => controller.recover(checkpoint), true); },
    discardRecovery(owner, checkpoint) { return command(owner, controller => controller.discardRecovery(checkpoint), true); },
    resolveConflict(owner, token, decision) { return command(owner, controller => controller.resolveConflict(token, decision), true); },
    dispose() {
      if (disposed) return;
      disposed = true; stopGuard(); stopView(); stopClient(); stopHealth(); retire('unmount'); listeners.clear();
    },
  };
}
