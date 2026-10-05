/** Source-only native RPC composition. The feature retains schema and storage ownership. */
import type { StandardSchemaV1 } from '@get-bb/plugin-sdk';
import type { BbPortableRpcFoundation } from './bb-runtime.js';
import type { Codec, Disposable, Json, PluginId, RequestExpectation, Result } from './model.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import type { IdentityServer, TargetPolicy } from './server.js';
import type { AtomicStateStorage, StateAddress, StateInvalidation, StateResource } from './state.js';
import { createStateService, stateCodecs } from './state-service-runtime.js';
import { identityStateRoutes, identityStateRpcMethods } from './rpc-routes-runtime.js';
export { identityStateRpcMethods } from './rpc-routes-runtime.js';
const methods = {
  load: identityStateRpcMethods[identityStateRoutes.load],
  save: identityStateRpcMethods[identityStateRoutes.save],
  reconcile: identityStateRpcMethods[identityStateRoutes.reconcile],
};
const inputSchema: StandardSchemaV1<unknown> = { '~standard': { version: 1, vendor: 'bb-identity', validate: value => ({ value }) } };
function isJson(value: unknown): value is Json {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(isJson)
    || isRecord(value) && Object.values(value).every(isJson);
}
const outputSchema: StandardSchemaV1<Json> = { '~standard': { version: 1, vendor: 'bb-identity', validate: value => isJson(value) ? { value } : { issues: [{ message: 'Expected an encoded identity state result.' }] } } };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function decodeRequest(input: unknown): Result<{ address: StateAddress; expected: RequestExpectation }> {
  if (!isRecord(input) || !isRecord(input.address) || !isRecord(input.expected)) return err('invalid-input', 'State request requires an address and expected session.');
  const address = input.address;
  const instance = idCodec('instance').decode(address.instanceId); const plugin = idCodec('plugin').decode(address.pluginId);
  const owner = identityKeyCodec.decode(address.owner); const actor = identityKeyCodec.decode(input.expected.actor);
  const session = idCodec('server-session').decode(input.expected.session);
  if (!instance.ok || !plugin.ok || !owner.ok || !actor.ok || !session.ok || typeof address.collection !== 'string' || !address.collection.length || typeof address.recordId !== 'string' || !address.recordId.length) return err('invalid-input', 'Invalid state request metadata.');
  return ok({ address: { instanceId: instance.value, pluginId: plugin.value, owner: owner.value, collection: address.collection, recordId: address.recordId }, expected: { actor: actor.value, session: session.value } });
}
function encoded<T>(result: Result<T>, codec: Pick<Codec<T>, 'encode'>): Json {
  return result.ok ? { ok: true, value: codec.encode(result.value) } : { ok: false, error: { ...result.error } };
}
function failed(code: Parameters<typeof err>[0], message: string): Json { return { ok: false, error: { code, message, retry: 'never' } }; }
type Action = 'load' | 'save' | 'reconcile';
type ResourceHandler = (action: Action, input: unknown, context: unknown) => Promise<Json>;
export interface IdentityStateRpcBridge extends Disposable {
  register<T>(options: { resource: StateResource<T>; storage: AtomicStateStorage<T>; policy: TargetPolicy; readPolicy?: TargetPolicy }): Result<Disposable>;
}
export function createIdentityStateRpcBridge<ToolContext, Input>(options: {
  readonly rpc: BbPortableRpcFoundation; readonly server: IdentityServer<unknown, ToolContext, Input>;
  readonly pluginId: PluginId; readonly publish: (event: StateInvalidation) => void;
}): Result<IdentityStateRpcBridge> {
  if (options.rpc.instanceId !== options.server.instanceId) return err('incompatible', 'RPC and state server instance namespaces disagree.');
  let disposed = false;
  const resources = new Map<string, ResourceHandler>(); const controllers = new Set<AbortController>();
  const dispatch = async (action: Action, input: unknown, context: unknown): Promise<Json> => {
    if (disposed) return failed('disposed', 'State RPC bridge is disposed.');
    const decoded = decodeRequest(input);
    if (!decoded.ok) return { ok: false, error: { ...decoded.error } };
    if (decoded.value.address.instanceId !== options.server.instanceId || decoded.value.address.pluginId !== options.pluginId) return failed('invalid-input', 'State address belongs to another instance or plugin.');
    const handler = resources.get(decoded.value.address.collection);
    return handler ? handler(action, input, context) : failed('not-found', 'State collection is not registered.');
  };
  const route = { input: inputSchema, output: outputSchema };
  const registered = options.rpc.register({
    [methods.load]: route, [methods.save]: route, [methods.reconcile]: route,
  }, {
    [methods.load]: { origin: 'interactive-user', handle: (input, context) => dispatch('load', input, context.request) },
    [methods.save]: { origin: 'interactive-user', handle: (input, context) => dispatch('save', input, context.request) },
    [methods.reconcile]: { origin: 'interactive-user', handle: (input, context) => dispatch('reconcile', input, context.request) },
  });
  if (!registered.ok) return registered;
  return ok({
    register<T>({ resource, storage, policy, readPolicy }: { resource: StateResource<T>; storage: AtomicStateStorage<T>; policy: TargetPolicy; readPolicy?: TargetPolicy }): Result<Disposable> {
      if (disposed) return err('disposed', 'State RPC bridge is disposed.');
      const definition = { ...resource.definition, codec: { ...resource.definition.codec } };
      const capturedPolicy = { ...policy };
      const capturedReadPolicy = { ...(readPolicy ?? policy) };
      const collection = definition.collection;
      if (resource.pluginId !== options.pluginId || !collection || !Number.isInteger(resource.definition.schemaVersion) || resource.definition.schemaVersion < 0 || storage.boundary !== 'same-process-synchronous' || (policy.kind !== 'self-only' && policy.kind !== 'collaborators') || (capturedReadPolicy.kind !== 'self-only' && capturedReadPolicy.kind !== 'collaborators')) return err('invalid-input', 'Invalid state resource registration.');
      if (resources.has(collection)) return err('conflict', 'State collection is already registered.');
      const controller = new AbortController(); controllers.add(controller);
      const codecs = stateCodecs(definition.codec);
      const service = createStateService({ instanceId: options.server.instanceId, pluginId: options.pluginId, definition, storage,
        commits: { boundary: 'same-process-synchronous', validate: (target, scope) => disposed || controller.signal.aborted ? err('expired', 'State resource registration expired.') : options.server.commits.validate(target, scope) },
        publish: event => { if (!disposed && !controller.signal.aborted) options.publish(event); },
      });
      const handler: ResourceHandler = async (action, input, context) => {
        if (disposed || controller.signal.aborted) return failed('disposed', 'State resource registration expired.');
        const decoded = decodeRequest(input); if (!decoded.ok) return { ok: false, error: { ...decoded.error } };
        const captured = decoded.value;
        const parsedMutation = action === 'save' ? codecs.mutation.decode(input) : null;
        const mutation = parsedMutation?.ok ? codecs.mutation.decode(structuredClone(codecs.mutation.encode(parsedMutation.value))) : parsedMutation;
        if (mutation && !mutation.ok) return { ok: false, error: { ...mutation.error } };
        const operation = action === 'reconcile' ? idCodec('operation').decode(isRecord(input) ? input.operationId : undefined) : null;
        if (operation && !operation.ok) return { ok: false, error: { ...operation.error } };
        const opened = await options.server.personRequest(context);
        if (!opened.ok) return { ok: false, error: { ...opened.error } };
        const person = opened.value;
        const signal = AbortSignal.any([person.signal, controller.signal]);
        const live = () => !disposed && !signal.aborted;
        try {
          if (!live()) return failed('expired', 'State request expired.');
          if (captured.expected.actor !== person.expected.actor || captured.expected.session !== person.expected.session) return failed('stale-context', 'State request expected another actor or session.');
          const selection = captured.address.owner === person.actor.identity.key ? { kind: 'self' as const } : { kind: 'person' as const, key: captured.address.owner };
          if (mutation?.ok) {
            const target = await person.target({ intent: 'write', selection, policy: capturedPolicy, expected: captured.expected, expectedSubject: captured.address.owner });
            if (!target.ok) return { ok: false, error: { ...target.error } };
            if (!live()) return failed('expired', 'State request expired.');
            return encoded(await service.save(target.value, mutation.value, { signal }), codecs.save);
          }
          const target = await person.target({ intent: 'read', selection, policy: capturedReadPolicy });
          if (!target.ok) return { ok: false, error: { ...target.error } };
          if (!live()) return failed('expired', 'State request expired.');
          if (target.value.snapshot().subject.key !== captured.address.owner) return failed('incompatible', 'Resolved state subject does not match the requested owner.');
          if (operation?.ok) {
            const result = await service.reconcile(target.value, captured.address.recordId, operation.value);
            return live() ? encoded(result, codecs.lookup) : failed('expired', 'State request expired.');
          }
          const result = await service.read(target.value, captured.address.recordId, { signal });
          return live() ? encoded(result, codecs.read) : failed('expired', 'State request expired.');
        } catch { return failed('unavailable', 'State resource operation failed.'); }
        finally { person.dispose(); }
      };
      resources.set(collection, handler);
      return ok({ dispose() { if (controller.signal.aborted) return; controller.abort(); controllers.delete(controller); if (resources.get(collection) === handler) resources.delete(collection); } });
    },
    dispose() { if (disposed) return; disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); resources.clear(); },
  });
}
