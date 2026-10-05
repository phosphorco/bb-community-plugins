/** Root-owned connection primitives and strict invalidation decoding. */
import type {
  ConnectionHealth, ConnectionLinkHealth, IdentityConnection,
  IdentityConnectionEvent, IdentityConnectionInputs, ClientInvalidation,
} from './client.js';
import type { Codec, IdentityError, Json, ReadOptions, Result, Unsubscribe } from './model.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import { stateCodecs } from './state-service-runtime.js';

const errorCodes = new Set<IdentityError['code']>([
  'unavailable', 'unauthenticated', 'unsupported', 'incompatible', 'invalid-input', 'not-found', 'ambiguous',
  'stale-owner', 'stale-context', 'conflict', 'cancelled', 'disposed', 'limit-exceeded', 'invalid-operation', 'expired',
]);
const retryKinds = new Set<IdentityError['retry']>(['never', 'after-refresh', 'after-reconnect', 'same-operation']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeError(value: unknown): Result<IdentityError> {
  if (!isRecord(value) || typeof value.code !== 'string' || !errorCodes.has(value.code as IdentityError['code'])
    || typeof value.message !== 'string' || typeof value.retry !== 'string' || !retryKinds.has(value.retry as IdentityError['retry'])) {
    return err('incompatible', 'Malformed identity transport error.');
  }
  return ok({ code: value.code as IdentityError['code'], message: value.message, retry: value.retry as IdentityError['retry'] });
}
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
const jsonCodec: Codec<Json> = {
  decode(value: unknown) { return isJson(value) ? ok(value) : err('invalid-input', 'Expected JSON payload.'); },
  encode(value: Json) { return value; },
};
const stateInvalidationCodec = stateCodecs(jsonCodec).invalidation;

/** Invalid wire events are discarded; malformed is never reinterpreted as a singleton signal. */
export const clientInvalidationCodec: Codec<ClientInvalidation> = {
  decode(value: unknown) {
    if (!isRecord(value) || typeof value.kind !== 'string') return err('invalid-input', 'Invalid identity invalidation.');
    if (value.kind === 'session') {
      const reason = value.reason;
      return reason === undefined ? ok({ kind: 'session' })
        : reason === 'actor' || reason === 'provider' || reason === 'capabilities' ? ok({ kind: 'session', reason })
          : err('invalid-input', 'Invalid session invalidation reason.');
    }
    if (value.kind === 'disconnected' || value.kind === 'reconnected') return ok({ kind: value.kind });
    if (value.kind === 'directory' && Array.isArray(value.keys)) {
      const keys = value.keys.map((key) => identityKeyCodec.decode(key));
      const revision = value.revision === null ? ok(null) : idCodec('revision').decode(value.revision);
      return keys.every((key) => key.ok) && revision.ok ? ok({ kind: 'directory', keys: keys.map((key) => (key as { ok: true; value: typeof key.value }).value), revision: revision.value })
        : err('invalid-input', 'Invalid directory invalidation keys.');
    }
    if (value.kind === 'participants' && Array.isArray(value.threadIds)) {
      const threadIds = value.threadIds.map((id) => idCodec('thread').decode(id));
      return threadIds.every((id) => id.ok) ? ok({ kind: 'participants', threadIds: threadIds.map((id) => (id as { ok: true; value: typeof id.value }).value) })
        : err('invalid-input', 'Invalid participant invalidation thread IDs.');
    }
    return err('invalid-input', 'Unknown identity invalidation.');
  },
  encode(value: ClientInvalidation) { return value as unknown as Json; },
};

function decodeEvent(value: unknown): IdentityConnectionEvent | null {
  const client = clientInvalidationCodec.decode(value);
  if (client.ok) return client.value;
  if (isRecord(value) && value.kind === 'state') {
    const state = stateInvalidationCodec.decode(value.event);
    if (state.ok) return { kind: 'state', event: state.value };
  }
  return null;
}
function available(): ConnectionLinkHealth { return { status: 'healthy' }; }
function cloneHealth(value: ConnectionHealth): ConnectionHealth {
  const clone = (link: ConnectionLinkHealth): ConnectionLinkHealth => link.status === 'unavailable'
    ? { status: 'unavailable', error: { ...link.error } } : { status: link.status };
  return { generation: value.generation, identity: clone(value.identity), state: clone(value.state) };
}
function cancelled(options?: ReadOptions): Result<never> | null {
  return options?.signal?.aborted ? err('cancelled', 'Identity request was cancelled.') : null;
}

/**
 * Adapts a single physical/root connection. Event and health subscriptions are
 * reference counted so borrowed transports cannot dispose the root.
 */
export function createIdentityConnection(inputs: IdentityConnectionInputs): IdentityConnection {
  let disposed = false;
  const channel = <T>(subscribeSource: (listener: (value: T) => void) => Unsubscribe) => {
    const listeners = new Set<{ observer: (value: T) => void }>();
    let source: { closed: boolean; stop: Unsubscribe | null } | null = null;
    const close = () => {
      const previous = source; source = null;
      if (previous) { previous.closed = true; try { previous.stop?.(); } catch {} previous.stop = null; }
    };
    return {
      subscribe(listener: (value: T) => void): Unsubscribe {
        if (disposed) return () => {};
        const entry = { observer: listener }; listeners.add(entry);
        if (!source) {
          const current = { closed: false, stop: null as Unsubscribe | null }; source = current;
          try {
            const stop = subscribeSource(value => {
              if (disposed || current.closed) return;
              for (const entry of [...listeners]) {
                if (disposed || current.closed) break;
                if (listeners.has(entry)) { try { entry.observer(value); } catch {} }
              }
            });
            if (current.closed) { try { stop(); } catch {} } else current.stop = stop;
          } catch (error) {
            if (source === current) source = null;
            current.closed = true; listeners.delete(entry); throw error;
          }
        }
        let removed = false;
        return () => { if (removed) return; removed = true; listeners.delete(entry); if (!listeners.size) close(); };
      },
      dispose() { close(); listeners.clear(); },
    };
  };
  const events = channel<IdentityConnectionEvent>(listener => inputs.subscribe(payload => {
    const event = decodeEvent(payload); if (event) listener(event);
  }));
  const healthEvents = channel<void>(listener => inputs.subscribeHealth(() => listener()));
  return {
    getHealth() { return disposed ? { generation: -1, identity: { status: 'unavailable', error: { code: 'disposed', message: 'Identity connection is disposed.', retry: 'never' } }, state: { status: 'unavailable', error: { code: 'disposed', message: 'Identity connection is disposed.', retry: 'never' } } } : cloneHealth(inputs.getHealth()); },
    subscribeHealth(listener) {
      return healthEvents.subscribe(listener);
    },
    async request(method, input, options) {
      const aborted = cancelled(options); if (aborted && !aborted.ok) throw new Error(aborted.error.message);
      if (disposed) throw new Error('Identity connection is disposed.');
      return inputs.request(method, input, options);
    },
    subscribe(listener) {
      return events.subscribe(listener);
    },
    async revalidate(options) {
      const aborted = cancelled(options); if (aborted) return aborted;
      if (disposed) return err('disposed', 'Identity connection is disposed.');
      try {
        const result = await inputs.revalidate(options);
        if (disposed) return err('disposed', 'Identity connection is disposed.');
        const aborted = cancelled(options); if (aborted) return aborted;
        if (!isRecord(result) || typeof result.ok !== 'boolean') return err('incompatible', 'Malformed connection revalidation result.');
        if (result.ok) return ok(undefined);
        const failure = decodeError(result.error); return failure.ok ? { ok: false, error: failure.value } : failure;
      } catch {
        if (disposed) return err('disposed', 'Identity connection is disposed.');
        const aborted = cancelled(options); if (aborted) return aborted;
        return err('unavailable', 'Identity connection revalidation failed.', 'after-reconnect');
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; events.dispose(); healthEvents.dispose(); inputs.dispose?.();
    },
  };
}

/** Utility used by the explicit fetch root; exported only within the runtime source. */
export function freshConnectionHealth(): ConnectionHealth {
  return { generation: 0, identity: available(), state: available() };
}
