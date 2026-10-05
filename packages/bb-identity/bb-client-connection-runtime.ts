/**
 * Internal native-app connection adapter. A React hook owns useRealtime's
 * declarative subscription and feeds this adapter; this module never calls a
 * hook or creates a second socket.
 */
import type { PluginRpcClient, PluginRpcContract, PluginRealtimeConnectionState, StandardSchemaV1 } from '@get-bb/plugin-sdk/app';
import type { ConnectionHealth, ConnectionLinkHealth, IdentityConnection } from './client.js';
import { createIdentityConnection } from './client-connection-runtime.js';
import { serverSessionCodec } from './host-runtime.js';
import type { IdentityError, Json, ReadOptions, Result, Unsubscribe } from './model.js';
import { err, ok } from './model-runtime.js';
import { identityRpcMethods, identityRoutes } from './rpc-routes-runtime.js';

type NativeMethod = (typeof identityRpcMethods)[keyof typeof identityRpcMethods];
type NativeContract = { readonly [Method in NativeMethod]: { readonly input: StandardSchemaV1<unknown, unknown>; readonly output: StandardSchemaV1<unknown, unknown> } };
type NativeRpc = Pick<PluginRpcClient<NativeContract>, 'call'>;

export const nativeIdentityRealtimeChannel = 'bb-identity/v1';

export interface NativeIdentityConnectionAdapter {
  readonly connection: IdentityConnection;
  /** Feed the payload received by `useRealtime(nativeIdentityRealtimeChannel, …)`. */
  acceptRealtime(payload: unknown): void;
  /** Feed the current value of `useRealtimeConnectionState()` once per render/effect. */
  setRealtimeState(state: PluginRealtimeConnectionState): void;
  dispose(): void;
}

function unavailable(message: string): ConnectionLinkHealth {
  return { status: 'unavailable', error: { code: 'unavailable', message, retry: 'after-reconnect' } };
}
function link(state: PluginRealtimeConnectionState): ConnectionLinkHealth {
  return state === 'connected' ? { status: 'healthy' } : { status: state };
}
function sameLink(left: ConnectionLinkHealth, right: ConnectionLinkHealth): boolean {
  return left.status === right.status && (left.status !== 'unavailable' || right.status === 'unavailable'
    && left.error.code === right.error.code && left.error.message === right.error.message && left.error.retry === right.error.retry);
}
function cloneLink(value: ConnectionLinkHealth): ConnectionLinkHealth {
  return value.status === 'unavailable' ? { status: 'unavailable', error: { ...value.error } } : { status: value.status };
}
function decodeError(value: unknown): Result<IdentityError> {
  if (!value || typeof value !== 'object') return err('incompatible', 'Malformed native identity error.');
  const error = value as { code?: unknown; message?: unknown; retry?: unknown };
  const codes = new Set<IdentityError['code']>(['unavailable', 'unauthenticated', 'unsupported', 'incompatible', 'invalid-input', 'not-found', 'ambiguous', 'stale-owner', 'stale-context', 'conflict', 'cancelled', 'disposed', 'limit-exceeded', 'invalid-operation', 'expired']);
  const retries = new Set<IdentityError['retry']>(['never', 'after-refresh', 'after-reconnect', 'same-operation']);
  return typeof error.code === 'string' && codes.has(error.code as IdentityError['code']) && typeof error.message === 'string'
    && typeof error.retry === 'string' && retries.has(error.retry as IdentityError['retry'])
    ? ok({ code: error.code as IdentityError['code'], message: error.message, retry: error.retry as IdentityError['retry'] })
    : err('incompatible', 'Malformed native identity error.');
}
function decodeBootstrap(value: unknown): Result<import('./host.js').ServerSession> {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') return err('incompatible', 'Malformed bootstrap Result.');
  if (!(value as { ok: boolean }).ok) {
    const failure = decodeError((value as { error?: unknown }).error);
    return failure.ok ? { ok: false, error: failure.value } : failure;
  }
  return serverSessionCodec.decode((value as { value?: unknown }).value);
}
function isStateRoute(route: string): boolean {
  return route.includes('/state/');
}
function isSessionInvalidation(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'session';
}
function waitFor<T>(flight: Promise<Result<T>>, signal?: AbortSignal): Promise<Result<T>> {
  if (!signal) return flight;
  if (signal.aborted) return Promise.resolve(err('cancelled', 'Native identity revalidation was cancelled.'));
  return new Promise(resolve => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(err('cancelled', 'Native identity revalidation was cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    void flight.then(result => { signal.removeEventListener('abort', abort); resolve(result); });
  });
}

/**
 * The hook root supplies exactly one RPC client and scoped realtime callbacks.
 * A successful bootstrap is the sole identity-authority recovery check; it
 * never calls IdentityClient.refresh and never replaces a resource reload.
 */
export function createNativeIdentityConnection(options: { readonly rpc: NativeRpc; readonly realtimeState: PluginRealtimeConnectionState }): NativeIdentityConnectionAdapter {
  let disposed = false;
  let nativeState = options.realtimeState;
  let health: ConnectionHealth = { generation: 0, identity: link(nativeState), state: link(nativeState) };
  let verified: { readonly instanceId: string; readonly actor: string; readonly stamp: string } | null = null;
  /** Changes only when authority can change; ordinary bootstrap attempts do not retire requests. */
  let authorityEpoch = 0;
  let bootstrapAttempt = 0;
  let revalidateFlight: Promise<Result<void>> | null = null;
  const events = new Set<(payload: unknown) => void>();
  const healthListeners = new Set<() => void>();
  const emitHealth = () => { for (const listener of [...healthListeners]) try { listener(); } catch {} };
  const emit = (payload: unknown) => { for (const listener of [...events]) try { listener(payload); } catch {} };
  const changeHealth = (next: Pick<ConnectionHealth, 'identity' | 'state'>) => {
    if (sameLink(health.identity, next.identity) && sameLink(health.state, next.state)) return;
    health = { generation: health.generation + 1, identity: cloneLink(next.identity), state: cloneLink(next.state) };
    emitHealth();
  };
  const fail = (target: 'identity' | 'state', message: string) => {
    const next = { identity: health.identity, state: health.state };
    next[target] = unavailable(message);
    const lostAuthority = target === 'identity' && health.identity.status === 'healthy';
    changeHealth(next);
    if (lostAuthority) emit({ kind: 'disconnected' });
  };
  const inputs = {
    async request(route: string, input: Json, readOptions?: ReadOptions): Promise<unknown> {
      if (disposed || readOptions?.signal?.aborted) throw new Error('Native identity request was cancelled.');
      const method = Object.hasOwn(identityRpcMethods, route) ? identityRpcMethods[route as keyof typeof identityRpcMethods] : undefined;
      if (!method) throw new Error(`Unsupported identity route ${route}.`);
      const current = authorityEpoch;
      try {
        const value = await options.rpc.call(method, input);
        if (disposed || current !== authorityEpoch || readOptions?.signal?.aborted) throw new Error('Native identity request became stale.');
        if (route === identityRoutes.bootstrap) {
          const checked = decodeBootstrap(value);
          if (checked.ok && checked.value.status === 'ready') {
            const next = { instanceId: checked.value.instanceId, actor: checked.value.actor.identity.key, stamp: checked.value.stamp };
            const changed = verified !== null && (verified.instanceId !== next.instanceId || verified.actor !== next.actor || verified.stamp !== next.stamp);
            if (changed) {
              // This bootstrap is the caller's authoritative reload. Fence old work before
              // returning B, but do not notify health observers: the caller is already
              // committing this exact B response and a notification would recurse refresh.
              verified = next; authorityEpoch++;
              if (disposed || nativeState !== 'connected') throw new Error('Native bootstrap became stale.');
            } else verified = next;
          }
        }
        if (isStateRoute(route) && health.state.status !== 'healthy') changeHealth({ identity: health.identity, state: { status: 'healthy' } });
        return value;
      } catch (cause) {
        if (disposed || current !== authorityEpoch || readOptions?.signal?.aborted) throw cause;
        fail(isStateRoute(route) ? 'state' : 'identity', cause instanceof Error ? cause.message : 'Native identity request failed.');
        throw cause;
      }
    },
    subscribe(listener: (payload: unknown) => void): Unsubscribe { events.add(listener); return () => events.delete(listener); },
    getHealth: () => health,
    subscribeHealth(listener: () => void): Unsubscribe { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    async revalidate(readOptions?: ReadOptions): Promise<Result<void>> {
      if (disposed) return err('disposed', 'Native identity connection is disposed.');
      if (readOptions?.signal?.aborted) return err('cancelled', 'Native identity revalidation was cancelled.');
      if (nativeState !== 'connected') return err('unavailable', 'Native realtime is not connected.', 'after-reconnect');
      if (revalidateFlight) return waitFor(revalidateFlight, readOptions?.signal);
      const currentAuthority = authorityEpoch;
      const currentAttempt = ++bootstrapAttempt;
      const flight = (async () => {
        try {
          const response = await options.rpc.call(identityRpcMethods[identityRoutes.bootstrap], {});
          const checked = decodeBootstrap(response);
          if (disposed) return err('disposed', 'Native identity connection is disposed.');
          if (currentAuthority !== authorityEpoch || currentAttempt !== bootstrapAttempt || nativeState !== 'connected') return err('stale-context', 'Native identity authority changed during bootstrap.');
          if (!checked.ok) { fail('identity', checked.error.message); return checked; }
          if (checked.value.status !== 'ready') { fail('identity', checked.value.error.message); return err(checked.value.error.code, checked.value.error.message, checked.value.error.retry); }
          const next = { instanceId: checked.value.instanceId, actor: checked.value.actor.identity.key, stamp: checked.value.stamp };
          const changed = verified !== null && (verified.instanceId !== next.instanceId || verified.actor !== next.actor || verified.stamp !== next.stamp);
          if (changed) {
            // Publish authority facts and suspend writes before re-entrant observers run.
            verified = next; const publishedEpoch = ++authorityEpoch;
            changeHealth({ identity: { status: 'connecting' }, state: health.state });
            emit({ kind: 'session' });
            if (disposed || publishedEpoch !== authorityEpoch || nativeState !== 'connected') return err('stale-context', 'Native identity authority changed during session notification.');
          } else verified = next;
          changeHealth({ identity: { status: 'healthy' }, state: health.state });
          return ok(undefined);
        } catch (cause) {
          if (disposed) return err('disposed', 'Native identity connection is disposed.');
          if (currentAuthority !== authorityEpoch || currentAttempt !== bootstrapAttempt || nativeState !== 'connected') return err('stale-context', 'Native identity authority changed during bootstrap.');
          fail('identity', cause instanceof Error ? cause.message : 'Native bootstrap failed.');
          return err('unavailable', 'Native bootstrap failed.', 'after-reconnect');
        }
      })();
      revalidateFlight = flight;
      void flight.finally(() => { if (revalidateFlight === flight) revalidateFlight = null; });
      return waitFor(flight, readOptions?.signal);
    },
    dispose() { disposed = true; authorityEpoch++; bootstrapAttempt++; revalidateFlight = null; events.clear(); healthListeners.clear(); },
  };
  const connection = createIdentityConnection(inputs);
  return {
    connection,
    acceptRealtime(payload) {
      if (disposed) return;
      if (isSessionInvalidation(payload)) {
        authorityEpoch++; bootstrapAttempt++; revalidateFlight = null; verified = null;
        changeHealth({ identity: { status: 'connecting' }, state: health.state });
      }
      emit(payload);
    },
    setRealtimeState(state) {
      if (disposed || state === nativeState) return;
      const wasConnected = nativeState === 'connected'; nativeState = state; authorityEpoch++; bootstrapAttempt++; revalidateFlight = null;
      if (state === 'connected') {
        // State health recovers only after an actual state route succeeds; controllers reload/reconcile first.
        changeHealth({ identity: { status: 'connecting' }, state: health.state.status === 'healthy' ? health.state : { status: 'reconnecting' } });
        if (!wasConnected) emit({ kind: 'reconnected' });
      } else {
        const next = link(state); const lostAuthority = health.identity.status === 'healthy';
        changeHealth({ identity: next, state: next });
        if (lostAuthority) emit({ kind: 'disconnected' });
      }
    },
    dispose() { connection.dispose(); },
  };
}
