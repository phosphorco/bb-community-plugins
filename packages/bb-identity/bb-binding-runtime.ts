/**
 * Portable server composition behind the public `/bb` entry.
 * Its declared surface covers native RPC, state and HTTP registration.
 */
import type { PluginRpcContract, PluginRpcHandlers, StandardSchemaV1, StandardSchemaV1InferInput, StandardSchemaV1InferOutput } from '@get-bb/plugin-sdk';
import type { BbIdentityApi, BbIdentityBinding, BbInvocation, BbInvocationServer, BbInvocationEndpoint, BbPromptInput, IdentityRpcHandlers } from './bb.js';
import { retainIdentityHttpResponse } from './http-lifetime-runtime.js';
import type { BbPortableIdentityHandlers, BbPortableInvocation, BbPortableRpcFoundation } from './bb-runtime.js';
import { createBbUpstreamDriver, renderExternalPrompt, type BbUpstreamBinding, type ExternalMessageRendering } from './bb-upstream-runtime.js';
import type { ForkIdentityExtensionSurface, ForkInvocationContext, ForkInvocationRegistration, IdentityHost } from './host.js';
import { createHostAdapter, inspectForkExtension } from './host-runtime.js';
import type { Codec, IdentityKey, Json, Result, Scheduler } from './model.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import type { PersonRequest } from './server.js';
import { createIdentityEndpoint, createIdentityServer } from './server-runtime.js';
import type { AtomicStateStorage, StateInvalidation, StateResource } from './state.js';
import { createIdentityStateRpcBridge, type IdentityStateRpcBridge } from './state-rpc-runtime.js';
import { identityRoutes, identityRpcMethods } from './rpc-routes-runtime.js';

type ServerBb = BbIdentityApi & ForkIdentityExtensionSurface;
type Origin = BbPortableInvocation['origin'];
type RawExtension = ReturnType<typeof inspectForkExtension<unknown, unknown, BbPromptInput>>;

export type { BbInvocationServer, BbInvocationEndpoint } from './bb.js';
export type BbIdentityServerBinding = BbIdentityBinding;

export type BbIdentityServerBindingOptions = {
  readonly bb: ServerBb;
  readonly stateNamespace?: string;
  readonly scheduler?: Scheduler;
  readonly externalMessageRendering?: ExternalMessageRendering;
};

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isJson(value: unknown): value is Json {
  return value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(isJson)
    || isRecord(value) && Object.values(value).every(isJson);
}
function jsonResult<T>(result: Result<T>, codec?: Pick<Codec<T>, 'encode'>): Json {
  return result.ok ? { ok: true, value: codec ? codec.encode(result.value) : result.value as unknown as Json }
    : { ok: false, error: { ...result.error } };
}
const jsonSchema: StandardSchemaV1<unknown, Json> = {
  '~standard': { version: 1, vendor: 'bb-identity', validate: value => isJson(value) ? { value } : { issues: [{ message: 'Expected JSON.' }] } },
};
const inputSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'bb-identity', validate: value => ({ value }) },
};
function invalid(message: string): Json { return { ok: false, error: { code: 'invalid-input', message, retry: 'never' } }; }

function decodeEmpty(value: unknown): Result<void> {
  return isRecord(value) && Object.keys(value).length === 0 ? ok(undefined) : err('invalid-input', 'Endpoint requires an empty input object.');
}
function decodeDirectory(value: unknown): Result<import('./model.js').DirectoryQuery> {
  if (!isRecord(value) || typeof value.query !== 'string' || !Array.isArray(value.kinds) || !value.kinds.every((kind) => kind === 'person' || kind === 'default-user' || kind === 'machine' || kind === 'external')
    || (value.history !== 'current' && value.history !== 'include-historical') || typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100
    || value.cursor !== undefined && !idCodec('cursor').decode(value.cursor).ok) return err('invalid-input', 'Invalid directory query.');
  const cursor = value.cursor === undefined ? undefined : idCodec('cursor').decode(value.cursor);
  const limit = value.limit as number;
  return cursor && !cursor.ok ? cursor : ok({ query: value.query, kinds: [...value.kinds], history: value.history, limit, ...(cursor ? { cursor: cursor.value } : {}) });
}
function decodeProfiles(value: unknown): Result<import('./model.js').ProfileQuery> {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length > 64) return err('invalid-input', 'Invalid profile query.');
  const keys = value.keys.map((key) => identityKeyCodec.decode(key));
  return keys.every((key) => key.ok) ? ok({ keys: keys.map((key) => (key as { ok: true; value: IdentityKey }).value) }) : err('invalid-input', 'Invalid profile key.');
}
function decodeParticipants(value: unknown): Result<import('./model.js').ParticipantQuery> {
  if (!isRecord(value) || typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100) return err('invalid-input', 'Invalid participant query.');
  const thread = idCodec('thread').decode(value.threadId); const cursor = value.cursor === undefined ? undefined : idCodec('cursor').decode(value.cursor);
  const limit = value.limit as number;
  return !thread.ok || cursor && !cursor.ok ? err('invalid-input', 'Invalid participant query identifiers.') : ok({ threadId: thread.value, limit, ...(cursor ? { cursor: cursor.value } : {}) });
}
function decodePreviews(value: unknown): Result<import('./model.js').ParticipantPreviewQuery> {
  if (!isRecord(value) || !Array.isArray(value.threadIds) || value.threadIds.length > 64 || typeof value.perThreadLimit !== 'number' || !Number.isInteger(value.perThreadLimit) || value.perThreadLimit < 1 || value.perThreadLimit > 100) return err('invalid-input', 'Invalid participant preview query.');
  const threads = value.threadIds.map((thread) => idCodec('thread').decode(thread));
  const perThreadLimit = value.perThreadLimit as number;
  return threads.every((thread) => thread.ok) ? ok({ threadIds: threads.map((thread) => (thread as { ok: true; value: import('./model.js').ThreadId }).value), perThreadLimit }) : err('invalid-input', 'Invalid participant preview thread ID.');
}

/** Creates exactly one normalizing registry; enhanced scopes are always core-issued. */
function createPortableFoundation(options: { readonly bb: ServerBb; readonly extension: RawExtension; readonly upstream: BbUpstreamBinding }): Result<BbPortableRpcFoundation> {
  if (options.extension.status === 'malformed') return { ok: false, error: options.extension.error };
  if (options.extension.status === 'unsupported-version') return err('incompatible', `Unsupported identity protocol version ${options.extension.version}.`);
  let disposed = false;
  const registrations = new Set<ForkInvocationRegistration>();
  const releaseRegistrations = () => { for (const registration of [...registrations]) { registrations.delete(registration); try { registration.dispose(); } catch {} } };
  const dispose = () => { if (disposed) return; disposed = true; releaseRegistrations(); };
  const invoke = async <C extends PluginRpcContract, M extends keyof C>(descriptor: BbPortableIdentityHandlers<C>[M], input: StandardSchemaV1InferOutput<C[M]['input']>, invocation: BbPortableInvocation): Promise<StandardSchemaV1InferInput<C[M]['output']>> => {
    if (disposed) throw new Error('Identity binding is disposed.');
    return descriptor.handle(input, invocation);
  };
  const foundation: BbPortableRpcFoundation = {
    instanceId: options.extension.status === 'supported' ? options.extension.protocol.instanceId : options.upstream.driver.instanceId,
    register<C extends PluginRpcContract>(contract: C, handlers: BbPortableIdentityHandlers<C>): Result<void> {
      if (disposed) return err('disposed', 'Identity binding is disposed.');
      const names = Object.keys(contract);
      if (!names.length || names.length !== Object.keys(handlers) .length || names.some((name) => {
        if (!Object.hasOwn(handlers, name)) return true;
        const descriptor = handlers[name];
        return !descriptor || typeof descriptor.handle !== 'function'
          || !['interactive-user', 'background', 'external'].includes(descriptor.origin);
      })) return err('invalid-input', 'RPC handlers must exactly match the contract and declare a valid origin.');
      if (options.extension.status === 'absent') {
        let admitted = true;
        const wrapped: Partial<PluginRpcHandlers<C>> = {};
        for (const name of names) {
          const method = name as keyof C; const descriptor = handlers[method];
          wrapped[method] = async (input: StandardSchemaV1InferOutput<C[typeof method]['input']>) => {
            if (disposed || !admitted) throw new Error('Identity RPC registration is retired.');
            const request = options.upstream.issue(descriptor.origin);
            try { return await invoke(descriptor, input, { request, signal: request.signal, origin: descriptor.origin }); }
            finally { options.upstream.release(request); }
          };
        }
        try {
          options.bb.rpc.register(contract, wrapped as PluginRpcHandlers<C>);
          if (disposed) { admitted = false; return err('disposed', 'Identity binding disposed during RPC registration.'); }
          return ok(undefined);
        } catch { admitted = false; return err('unavailable', 'Upstream RPC registration failed.', 'after-refresh'); }
      }
      if (options.extension.status !== 'supported') return err('incompatible', 'Identity protocol is unavailable.');
      const staged: ForkInvocationRegistration[] = []; const wrapped: Partial<PluginRpcHandlers<C>> = {}; let admitted = true;
      try {
        for (const name of names) {
          const method = name as keyof C; const descriptor = handlers[method];
          const bound = options.extension.protocol.bindInvocation({
            routeClass: descriptor.origin === 'interactive-user' ? 'interactive-session' : descriptor.origin === 'external' ? 'external-credential' : 'plugin-background',
            handler: async (raw: ForkInvocationContext<unknown>, input: StandardSchemaV1InferOutput<C[typeof method]['input']>) => {
              if (disposed || !admitted) throw new Error('Identity RPC registration is retired.');
              try { return await invoke(descriptor, input, { request: raw.request, signal: raw.scope.signal, origin: descriptor.origin }); }
              finally { raw.scope.release(); }
            },
          });
          staged.push(bound.registration); wrapped[method] = bound.handler;
        }
        options.bb.rpc.register(contract, wrapped as PluginRpcHandlers<C>);
        if (disposed) { for (const registration of staged) registration.dispose(); return err('disposed', 'Identity binding disposed during registration.'); }
        for (const registration of staged) registrations.add(registration);
        return ok(undefined);
      } catch {
        admitted = false;
        for (const registration of staged) { try { registration.dispose(); } catch {} }
        return err('unavailable', 'Enhanced RPC registration failed.', 'after-refresh');
      }
    },
    dispose,
  };
  try { options.bb.onDispose(dispose); } catch { dispose(); return err('unavailable', 'Could not register RPC cleanup.', 'after-refresh'); }
  return ok(foundation);
}

/**
 * Portable server subset: RPC, state, endpoint, provider and tool operations.
 * HTTP retains its invocation through response body completion.
 */
export function createBbIdentityServerBinding(options: BbIdentityServerBindingOptions): Result<BbIdentityServerBinding> {
  const upstream = createBbUpstreamDriver({ bb: options.bb, ...(options.stateNamespace !== undefined ? { stateNamespace: options.stateNamespace } : {}), ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}), ...(options.externalMessageRendering !== undefined ? { externalMessageRendering: options.externalMessageRendering } : {}) });
  if (!upstream.ok) return upstream;
  const extension = inspectForkExtension<unknown, unknown, BbPromptInput>(options.bb.experimental_p6rIdentity);
  if (extension.status !== 'absent' && extension.status !== 'supported') { upstream.value.dispose(); return extension.status === 'malformed' ? { ok: false, error: extension.error } : err('incompatible', `Unsupported identity protocol version ${extension.version}.`); }
  if (upstream.value.externalMessageRendering === 'producer' && extension.status === 'supported') {
    const enableProducerRendering = extension.protocol.experimental_useProducerMessageRendering;
    if (typeof enableProducerRendering !== 'function') {
      upstream.value.dispose();
      return err('incompatible', 'Enhanced identity host does not support producer-owned external message rendering.');
    }
    try {
      const hookResult = enableProducerRendering.call(extension.protocol);
      if (hookResult !== undefined) throw Error('Producer rendering hook must be synchronous.');
    } catch {
      upstream.value.dispose();
      return err('incompatible', 'Enhanced identity host could not enable producer-owned external message rendering.');
    }
  }
  const host: IdentityHost<unknown, unknown, BbPromptInput> = createHostAdapter({ upstream: upstream.value.driver, extension });
  const server = createIdentityServer({ host });
  let disposed = false;
  const publish = (event: unknown) => { if (!disposed) try { options.bb.realtime.publish('bb-identity/v1', event); } catch {} };
  const endpoint = createIdentityEndpoint({ server, publish });
  const foundation = createPortableFoundation({ bb: options.bb, extension, upstream: upstream.value });
  if (!foundation.ok) { endpoint.dispose(); server.dispose(); host.dispose(); upstream.value.dispose(); return foundation; }
  const state = createIdentityStateRpcBridge({ rpc: foundation.value, server, pluginId: host.pluginId, publish: (event: StateInvalidation) => publish({ kind: 'state', event }) });
  if (!state.ok) { foundation.value.dispose(); endpoint.dispose(); server.dispose(); host.dispose(); upstream.value.dispose(); return state; }
  interface BoundInvocationRecord {
    readonly request: unknown;
    readonly signal: AbortSignal;
    readonly people: Set<PersonRequest<BbPromptInput>>;
    settled: boolean;
  }
  const invocations = new WeakMap<BbInvocation, BoundInvocationRecord>();
  const expired = <T>(): Result<T> => err('expired', 'Invocation has already settled.');
  const recordFor = (invocation: BbInvocation): Result<BoundInvocationRecord> => {
    const record = invocations.get(invocation);
    return disposed || !record || record.settled || record.signal.aborted ? expired() : ok(record);
  };
  const unavailableSession = (): import('./host.js').ServerSession => ({
    status: 'unavailable', instanceId: server.instanceId,
    error: { code: 'expired', message: 'Invocation has already settled.', retry: 'after-refresh' },
  });
  const openPerson = async (invocation: BbInvocation): Promise<Result<PersonRequest<BbPromptInput>>> => {
    const record = recordFor(invocation); if (!record.ok) return record;
    const opened = await server.personRequest(record.value.request);
    if (record.value.settled || record.value.signal.aborted) {
      if (opened.ok) opened.value.dispose();
      return expired();
    }
    if (opened.ok) record.value.people.add(opened.value);
    return opened;
  };
  const guardEndpoint = async <T>(invocation: BbInvocation, operation: (request: unknown) => Promise<Result<T>>): Promise<Result<T>> => {
    const record = recordFor(invocation); if (!record.ok) return record;
    const result = await operation(record.value.request);
    return record.value.settled || record.value.signal.aborted ? expired() : result;
  };
  let disposeBinding = () => {};
  const guardedHistory: BbInvocationServer['history'] = {
    async contributions(query, readOptions) {
      if (disposed) return err('disposed', 'Identity binding is disposed.');
      const result = await server.history.contributions(query, readOptions);
      return disposed ? err('disposed', 'Identity binding is disposed.') : result;
    },
    async attempts(query, readOptions) {
      if (disposed) return err('disposed', 'Identity binding is disposed.');
      const result = await server.history.attempts(query, readOptions);
      return disposed ? err('disposed', 'Identity binding is disposed.') : result;
    },
  };
  const publicServer: BbInvocationServer = {
    instanceId: server.instanceId,
    commits: server.commits,
    async session(invocation) {
      const record = recordFor(invocation); if (!record.ok) return unavailableSession();
      const session = await server.session(record.value.request);
      return record.value.settled || record.value.signal.aborted ? unavailableSession() : session;
    },
    selfProfile: invocation => guardEndpoint(invocation, request => server.selfProfile(request)),
    personRequest: openPerson,
    async sendExternal(author, input, readOptions) {
      if (disposed) return { status: 'rejected', error: { code: 'disposed', message: 'Identity binding is disposed.', retry: 'never' } };
      const renderedInput = upstream.value.externalMessageRendering === 'host'
        ? renderExternalPrompt(upstream.value.driver.pluginId, author, input.input)
        : input.input;
      return server.sendExternal(author, { ...input, input: renderedInput }, readOptions);
    },
    lookupOperation: (operationId, readOptions) => disposed
      ? Promise.resolve(err('disposed', 'Identity binding is disposed.')) : server.lookupOperation(operationId, readOptions),
    history: guardedHistory,
  };
  const publicEndpoint: BbInvocationEndpoint = {
    bootstrap: invocation => guardEndpoint(invocation, request => endpoint.bootstrap(request)),
    selfProfile: invocation => guardEndpoint(invocation, request => endpoint.selfProfile(request)),
    search: (invocation, input) => guardEndpoint(invocation, request => endpoint.search(request, input)),
    profiles: (invocation, input) => guardEndpoint(invocation, request => endpoint.profiles(request, input)),
    participants: (invocation, input) => guardEndpoint(invocation, request => endpoint.participants(request, input)),
    participantPreviews: (invocation, input) => guardEndpoint(invocation, request => endpoint.participantPreviews(request, input)),
    dispose: () => disposeBinding(),
  };
  const endpointContract = {
    [identityRpcMethods[identityRoutes.bootstrap]]: { input: inputSchema, output: jsonSchema },
    [identityRpcMethods[identityRoutes.selfProfile]]: { input: inputSchema, output: jsonSchema },
    [identityRpcMethods[identityRoutes.search]]: { input: inputSchema, output: jsonSchema },
    [identityRpcMethods[identityRoutes.profiles]]: { input: inputSchema, output: jsonSchema },
    [identityRpcMethods[identityRoutes.participants]]: { input: inputSchema, output: jsonSchema },
    [identityRpcMethods[identityRoutes.participantPreviews]]: { input: inputSchema, output: jsonSchema },
  } as const satisfies PluginRpcContract;
  const endpointRegistered = foundation.value.register(endpointContract, {
    [identityRpcMethods[identityRoutes.bootstrap]]: { origin: 'interactive-user', handle: async (input, context) => { const decoded = decodeEmpty(input); return decoded.ok ? jsonResult(await endpoint.bootstrap(context.request)) : invalid(decoded.error.message); } },
    [identityRpcMethods[identityRoutes.selfProfile]]: { origin: 'interactive-user', handle: async (input, context) => { const decoded = decodeEmpty(input); return decoded.ok ? jsonResult(await endpoint.selfProfile(context.request)) : invalid(decoded.error.message); } },
    [identityRpcMethods[identityRoutes.search]]: { origin: 'interactive-user', handle: async (input, context) => { const decoded = decodeDirectory(input); return decoded.ok ? jsonResult(await endpoint.search(context.request, decoded.value)) : invalid(decoded.error.message); } },
    [identityRpcMethods[identityRoutes.profiles]]: { origin: 'interactive-user', handle: async (input, context) => { const decoded = decodeProfiles(input); return decoded.ok ? jsonResult(await endpoint.profiles(context.request, decoded.value)) : invalid(decoded.error.message); } },
    [identityRpcMethods[identityRoutes.participants]]: { origin: 'interactive-user', handle: async (input, context) => { const decoded = decodeParticipants(input); return decoded.ok ? jsonResult(await endpoint.participants(context.request, decoded.value)) : invalid(decoded.error.message); } },
    [identityRpcMethods[identityRoutes.participantPreviews]]: { origin: 'interactive-user', handle: async (input, context) => { const decoded = decodePreviews(input); return decoded.ok ? jsonResult(await endpoint.participantPreviews(context.request, decoded.value)) : invalid(decoded.error.message); } },
  });
  if (!endpointRegistered.ok) { state.value.dispose(); foundation.value.dispose(); endpoint.dispose(); server.dispose(); host.dispose(); upstream.value.dispose(); return endpointRegistered; }
  const createInvocation = (context: BbPortableInvocation) => {
    const record: BoundInvocationRecord = { request: context.request, signal: context.signal, people: new Set(), settled: false };
    const invocation: BbInvocation = {
      origin: context.origin,
      signal: context.signal,
      person: () => context.origin === 'external'
        ? Promise.resolve(err('unauthenticated', 'External invocation uses an explicit external source.'))
        : openPerson(invocation),
    };
    invocations.set(invocation, record);
    const finish = () => {
      record.settled = true;
      for (const request of record.people) request.dispose();
      record.people.clear();
    };
    return { invocation, finish };
  };
  const httpRegistrations = new Set<ForkInvocationRegistration>();
  const httpReleases = new Set<() => void>();
  const binding: BbIdentityServerBinding = {
    server: publicServer, endpoint: publicEndpoint,
    rpc: { register<C extends PluginRpcContract>(contract: C, handlers: IdentityRpcHandlers<C>): Result<void> {
      const names = Object.keys(contract);
      if (!names.length || names.length !== Object.keys(handlers).length || names.some(name => {
        if (!Object.hasOwn(handlers, name)) return true;
        const descriptor = handlers[name];
        return !descriptor || typeof descriptor.handle !== 'function'
          || !['interactive-user', 'background', 'external'].includes(descriptor.origin);
      })) return err('invalid-input', 'RPC handlers must exactly match the contract and declare a valid origin.');
      const normalized: { -readonly [M in keyof BbPortableIdentityHandlers<C>]?: BbPortableIdentityHandlers<C>[M] } = {};
      for (const name of names as (keyof C)[]) {
        const descriptor = handlers[name];
        if (!descriptor) return err('invalid-input', 'RPC handlers must exactly match the contract.');
        normalized[name] = { origin: descriptor.origin, handle: async (input, context) => {
          const issued = createInvocation(context);
          try { return await descriptor.handle(input, issued.invocation); }
          finally { issued.finish(); }
        } };
      }
      return foundation.value.register(contract, normalized as BbPortableIdentityHandlers<C>);
    } },
    http: { route(method, path, descriptor, routeOptions) {
      if (disposed) return err('disposed', 'Identity binding is disposed.');
      if (!options.bb.http) return err('unsupported', 'This SDK has no HTTP registration.');
      if (!descriptor || typeof descriptor.handle !== 'function'
        || !['interactive-user', 'external'].includes(descriptor.origin)
        || descriptor.origin === 'interactive-user' && (routeOptions?.auth ?? 'local') !== 'local') {
        return err('invalid-input', 'Interactive HTTP identity requires local authentication.');
      }
      type HttpContext = Parameters<typeof descriptor.handle>[0];
      const run = async (context: HttpContext, raw: BbPortableInvocation, release: () => void, coreOwnsBody = false) => {
        if (disposed) { release(); throw new Error('Identity HTTP registration is retired.'); }
        const issued = createInvocation(raw);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          context.req.raw.signal.removeEventListener('abort', finish);
          raw.signal.removeEventListener('abort', finish);
          httpReleases.delete(finish); issued.finish(); release();
        };
        httpReleases.add(finish);
        context.req.raw.signal.addEventListener('abort', finish, { once: true });
        raw.signal.addEventListener('abort', finish, { once: true });
        if (context.req.raw.signal.aborted) { finish(); throw new Error('HTTP request is aborted.'); }
        try {
          const response = await descriptor.handle(context, issued.invocation);
          if (coreOwnsBody) return response;
          return retainIdentityHttpResponse(response, raw.signal, context.req.raw.signal, finish);
        } catch (cause) { finish(); throw cause; }
      };
      let registration: ForkInvocationRegistration | undefined;
      try {
        if (extension.status === 'supported') {
          const bound = extension.protocol.bindInvocation({
            routeClass: descriptor.origin === 'interactive-user' ? 'interactive-session' : 'external-credential',
            handler: (raw: ForkInvocationContext<unknown>, context: HttpContext) => run(context,
              { request: raw.request, signal: raw.scope.signal, origin: descriptor.origin }, () => raw.scope.release(), true),
          });
          registration = bound.registration;
          options.bb.http.route(method, path, bound.handler, routeOptions);
          if (disposed) registration.dispose();
          else httpRegistrations.add(registration);
        } else {
          options.bb.http.route(method, path, (context: HttpContext) => {
            const request = upstream.value.issue(descriptor.origin);
            return run(context, { request, signal: request.signal, origin: descriptor.origin }, () => upstream.value.release(request));
          }, routeOptions);
        }
        return disposed ? err('disposed', 'Identity binding is disposed.') : ok(undefined);
      } catch { registration?.dispose(); return err('unavailable', 'HTTP registration failed.'); }
    } },
    state: { register: (options) => disposed ? err('disposed', 'Identity binding is disposed.') : state.value.register(options) },
    async registerProvider(provider) {
      if (disposed) return err('disposed', 'Identity binding is disposed.');
      const registration = await host.registerProvider(provider);
      return disposed && registration.ok ? (registration.value.dispose(), err('disposed', 'Identity binding is disposed.')) : registration;
    },
    toolProvenance: (context) => disposed ? Promise.resolve(err('disposed', 'Identity binding is disposed.')) : server.toolProvenance(context),
    async background(run) {
      if (disposed) throw new Error('Identity binding is disposed.');
      const request = upstream.value.issue('background');
      const issued = createInvocation({ request, origin: 'background', signal: request.signal });
      try { return await run(issued.invocation); }
      finally { issued.finish(); upstream.value.release(request); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of [...httpReleases]) release();
      for (const registration of httpRegistrations) registration.dispose();
      httpRegistrations.clear();
      state.value.dispose(); foundation.value.dispose(); endpoint.dispose(); server.dispose(); host.dispose(); upstream.value.dispose();
    },
  };
  disposeBinding = () => binding.dispose();
  try { options.bb.onDispose(() => binding.dispose()); } catch { binding.dispose(); return err('unavailable', 'Could not register binding cleanup.', 'after-refresh'); }
  return ok(binding);
}
