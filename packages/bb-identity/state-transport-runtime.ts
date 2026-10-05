/** Borrowed-connection state RPC adapter. It opens no feed and owns no identity. */
import type { Codec, IdentityError, Json, OperationId, OperationLookup, ReadOptions, Result, Unsubscribe } from './model.js';
import { err, ok } from './model-runtime.js';
import type { IdentityConnection } from './client.js';
import type {
  StateInvalidation, StateLookupRequest, StateMutation, StateOutcome, StateRead,
  StateReadRequest, StateResource, StateSave, StateTransport,
} from './state.js';
import { stateCodecs } from './state-service-runtime.js';
import { identityStateRoutes as routes } from './rpc-routes-runtime.js';

function writeUnavailable(connection: IdentityConnection): Result<never> | null {
  const health = connection.getHealth();
  if (health.identity.status === 'healthy' && health.state.status === 'healthy') return null;
  const failed = health.identity.status === 'unavailable' ? health.identity : health.state.status === 'unavailable' ? health.state : null;
  return failed ? err(failed.error.code, failed.error.message, failed.error.retry) : err('unavailable', 'Identity and state links must be healthy before writing.', 'after-reconnect');
}
function decodeError(value: unknown): Result<IdentityError> {
  const codes = new Set(['unavailable', 'unauthenticated', 'unsupported', 'incompatible', 'invalid-input', 'not-found', 'ambiguous', 'stale-owner', 'stale-context', 'conflict', 'cancelled', 'disposed', 'limit-exceeded', 'invalid-operation', 'expired']);
  const retries = new Set(['never', 'after-refresh', 'after-reconnect', 'same-operation']);
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
    && codes.has((value as { code: string }).code) && typeof (value as { message?: unknown }).message === 'string'
    && typeof (value as { retry?: unknown }).retry === 'string' && retries.has((value as { retry: string }).retry)
    ? ok(value as unknown as IdentityError) : err('incompatible', 'Malformed state route error.');
}
function decodeResult<T>(value: unknown, decode: (input: unknown) => Result<T>): Result<T> {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') return err('incompatible', 'Malformed state route Result.');
  if (!(value as { ok: boolean }).ok) { const failure = decodeError((value as { error?: unknown }).error); return failure.ok ? { ok: false, error: failure.value } : failure; }
  return decode((value as { value?: unknown }).value);
}

/** Uses only the documented relative routes; resource selection remains server-side by address. */
export function createStateTransport<T>(options: { readonly connection: IdentityConnection; readonly resource: StateResource<T> }): StateTransport<T> {
  const codecs = stateCodecs(options.resource.definition.codec);
  const request = async <V>(method: string, payload: Json, decode: (input: unknown) => Result<V>, readOptions?: ReadOptions): Promise<Result<V>> => {
    // Reads and receipt lookup are deliberate recovery attempts, even when the
    // previous state RPC failed. Saves retain the healthy-link gates below.
    if (readOptions?.signal?.aborted) return err('cancelled', 'State request was cancelled.');
    try { return decodeResult(await options.connection.request(method, payload, readOptions), decode); }
    catch { return err('unavailable', 'State route request failed.', 'after-reconnect'); }
  };
  return {
    load(input: StateReadRequest, readOptions) { return request(routes.load, { address: input.address, expected: input.expected } as unknown as Json, codecs.read.decode, readOptions); },
    async save(input: StateMutation<T>, readOptions) {
      const normalized = codecs.mutation.decode(structuredClone(codecs.mutation.encode(input)));
      if (!normalized.ok) return normalized;
      if (normalized.value.address.pluginId !== options.resource.pluginId || normalized.value.address.collection !== options.resource.definition.collection || normalized.value.schemaVersion !== options.resource.definition.schemaVersion) {
        return err('invalid-input', 'State mutation does not match this resource.');
      }
      const unavailable = writeUnavailable(options.connection); if (unavailable) return unavailable;
      const refreshed = await options.connection.revalidate(readOptions);
      if (!refreshed.ok) return refreshed;
      const after = writeUnavailable(options.connection); if (after) return after;
      const response = await request(routes.save, codecs.mutation.encode(normalized.value), codecs.save.decode, readOptions);
      if (!response.ok) return response;
      const outcome = response.value;
      if (outcome.operationId !== normalized.value.operationId) return err('incompatible', 'State route returned a different operation.');
      if (outcome.status === 'indeterminate') return response;
      const read = 'envelope' in outcome ? { status: 'present' as const, envelope: outcome.envelope } : outcome.current;
      const actual = read.status === 'present' ? read.envelope.address : read.address;
      if (actual.instanceId !== normalized.value.address.instanceId || actual.pluginId !== normalized.value.address.pluginId || actual.collection !== normalized.value.address.collection || actual.recordId !== normalized.value.address.recordId || actual.owner !== normalized.value.address.owner
        || read.status === 'present' && read.envelope.schemaVersion !== normalized.value.schemaVersion) return err('incompatible', 'State route returned a mismatched resource record.');
      return response;
    },
    reconcile(input: StateLookupRequest, readOptions) { return request(routes.reconcile, { address: input.address, expected: input.expected, operationId: input.operationId } as unknown as Json, codecs.lookup.decode, readOptions); },
    subscribe(address, listener): Unsubscribe {
      return options.connection.subscribe((event) => {
        if (event.kind !== 'state') return;
        const value = codecs.invalidation.decode(event.event);
        if (value.ok && value.value.address.instanceId === address.instanceId && value.value.address.pluginId === address.pluginId
          && value.value.address.collection === address.collection && value.value.address.recordId === address.recordId && value.value.address.owner === address.owner) listener(value.value);
      });
    },
  };
}
