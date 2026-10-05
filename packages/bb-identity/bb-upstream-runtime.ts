/**
 * Internal upstream implementation for the eventual `/bb` binding.
 *
 * This deliberately has no public declaration/export: it converts only public
 * SDK calls into the conservative singleton branch of `UpstreamDriver`.
 */
import { z } from 'zod';
import type { BbIdentityApi, BbPromptInput } from './bb.js';
import type {
  AcceptanceOutcome, ActorSnapshot, Codec, ExecutionProvenance, IdentityProfile,
  InstanceId, Json, PluginId, ReadOptions, Result, Scheduler,
} from './model.js';
import { defaultIdentityKey, err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import type {
  ExternalAuthorInput, HostInvalidation, HostRequestHandle, ServerSession,
  UpstreamDriver,
} from './host.js';

export type UpstreamInvocationOrigin = 'interactive-user' | 'background' | 'external';
export type ExternalMessageRendering = 'host' | 'producer';

/** Opaque-by-registry invocation passed only by the future bind-once owner. */
export interface BbUpstreamInvocation {
  readonly origin: UpstreamInvocationOrigin;
  readonly signal: AbortSignal;
}

type UpstreamSdk = BbIdentityApi['sdk'];
type UpstreamBb = Pick<BbIdentityApi, 'pluginId' | 'onDispose' | 'sdk'>;
type PluginRpcInput = NonNullable<Parameters<UpstreamSdk['plugins']['callRpc']>[0]['input']>;

interface InvocationRecord {
  readonly origin: UpstreamInvocationOrigin;
  readonly controller: AbortController;
  readonly scopes: Set<ScopeRecord>;
}
interface ScopeRecord {
  readonly controller: AbortController;
  readonly parentAbort: () => void;
  released: boolean;
}

export interface BbUpstreamBinding {
  /** The binding owns this choice; it is deliberately not inferred from prompt text. */
  readonly externalMessageRendering: ExternalMessageRendering;
  readonly driver: UpstreamDriver<BbUpstreamInvocation, unknown, BbPromptInput>;
  /** The only way to create a context accepted by this driver's WeakMap. */
  issue(origin: UpstreamInvocationOrigin): BbUpstreamInvocation;
  /** Terminates the exact issued invocation and any scope it currently owns. */
  release(invocation: BbUpstreamInvocation): void;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJson(value: unknown): value is Json {
  return value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(isJson)
    || isRecord(value) && Object.values(value).every(isJson);
}
function cloneJson(value: Json): Json { return structuredClone(value); }
/** SDK JsonValue arrays are mutable; callers' readonly package JSON never crosses that boundary. */
function clonePluginRpcInput(value: Json): PluginRpcInput { return structuredClone(value) as PluginRpcInput; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
function escapeExternalEnvelopeValue(value: string): string {
  return value.replace(/[\[\]\r\n%<>]/g, (character) => encodeURIComponent(character));
}

/** Render the host-owned external sender envelope exactly once. */
export function renderExternalPrompt(
  pluginId: PluginId,
  author: ExternalAuthorInput,
  input: readonly BbPromptInput[],
): readonly BbPromptInput[] {
  const displayName = author.presentation.handle ?? author.presentation.displayName;
  const label = escapeExternalEnvelopeValue(`${pluginId}:${displayName.length ? displayName : 'External source'}`);
  return Object.freeze([
    { type: 'text', text: `[message received from external source]\n[sender=${label}]\n`, mentions: [], visibility: 'agent-only' },
    ...input,
    { type: 'text', text: `\n[/sender=${label}]`, mentions: [], visibility: 'agent-only' },
  ] as BbPromptInput[]);
}

function defaultScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback) {
      const timeout = setTimeout(callback, delayMs);
      return () => clearTimeout(timeout);
    },
  };
}

/**
 * A narrow, actual prompt-part normalizer: it accepts the installed SDK's four
 * discriminants and validates text fixtures before dispatch. The SDK remains
 * the final schema validator for nested mentions and optional fields.
 */
const promptInputCodec: Codec<BbPromptInput> = {
  decode(value) {
    if (!isRecord(value) || !isJson(value) || typeof value.type !== 'string') return err('invalid-input', 'Prompt input must be a JSON SDK prompt part.');
    const valid = value.type === 'text'
      ? typeof value.text === 'string' && (value.mentions === undefined || Array.isArray(value.mentions))
      : value.type === 'image' ? typeof value.url === 'string'
        : value.type === 'localImage' ? typeof value.path === 'string'
          : value.type === 'localFile' ? typeof value.path === 'string'
            : false;
    return valid ? ok(freeze(structuredClone(value) as BbPromptInput))
      : err('invalid-input', 'Invalid installed-SDK prompt input shape.');
  },
  encode(value) {
    const encoded = value as unknown as Json;
    if (!isJson(encoded)) throw new TypeError('Prompt input codec received non-JSON data.');
    return cloneJson(encoded);
  },
};

function unavailableSession(instanceId: InstanceId, code: 'unauthenticated' | 'unsupported' | 'incompatible', message: string): ServerSession {
  return { status: 'unauthenticated', instanceId, error: { code, message, retry: 'never' } };
}
function nativeIds(value: unknown): Result<{ readonly deliveryId: string | null; readonly queuedMessageId: string | null; readonly turnId: string | null }> {
  // Installed SDK 0.4.15 has legacy `{ ok: true }`; newer proof targets add this union.
  if (!isRecord(value) || value.ok !== true) return err('incompatible', 'Malformed upstream dispatch response.');
  if (!Object.hasOwn(value, 'delivery')) return ok({ deliveryId: null, queuedMessageId: null, turnId: null });
  if (value.delivery === 'sent') return ok({ deliveryId: null, queuedMessageId: null, turnId: null });
  if (value.delivery === 'queued' && isRecord(value.queuedMessage) && typeof value.queuedMessage.id === 'string' && value.queuedMessage.id.length) {
    return ok({ deliveryId: null, queuedMessageId: value.queuedMessage.id, turnId: null });
  }
  return err('incompatible', 'Malformed upstream dispatch response.');
}

export function createBbUpstreamDriver(options: {
  readonly bb: UpstreamBb;
  /** Reserved, storage-scoped namespace. It is never a plugin, browser, or request ID. */
  readonly stateNamespace?: string;
  readonly scheduler?: Scheduler;
  readonly externalMessageRendering?: ExternalMessageRendering;
}): Result<BbUpstreamBinding> {
  const externalMessageRendering = options.externalMessageRendering ?? 'host';
  if (externalMessageRendering !== 'host' && externalMessageRendering !== 'producer') {
    return err('invalid-input', 'Invalid external message rendering mode.');
  }
  const instance = idCodec('instance').decode(options.stateNamespace ?? 'local');
  const plugin = idCodec('plugin').decode(options.bb.pluginId);
  if (!instance.ok || !plugin.ok) return err('invalid-input', 'The upstream binding requires valid plugin and state namespace IDs.');
  const instanceId = instance.value;
  const pluginId = plugin.value;
  const singletonKey = defaultIdentityKey(instanceId);
  const machineKey = identityKeyCodec.decode('p6r-machine:v1:' + encodeURIComponent(instanceId) + ':server');
  const stamp = idCodec('server-session').decode('singleton:' + instanceId);
  const revision = idCodec('revision').decode('singleton:' + instanceId);
  if (!machineKey.ok || !stamp.ok || !revision.ok) return err('incompatible', 'Unable to construct stable upstream identity identifiers.');
  const machineIdentity = { kind: 'machine' as const, key: machineKey.value, instanceId, hostId: null };
  const capabilities = {
    requestIdentity: 'singleton' as const, acceptance: 'pre-dispatch-check' as const, forwarding: 'singleton-convention' as const,
    directory: { search: false, lookup: false }, participants: false, externalSend: 'source-labelled' as const,
    toolProvenance: 'unknown' as const, operationLookup: false,
  };
  /** Every public DTO is a new frozen projection; validation reads only these primitives. */
  const readySession = (): Extract<ServerSession, { status: 'ready' }> => freeze({
    status: 'ready' as const, instanceId, mode: 'single-user' as const,
    actor: {
      identity: { kind: 'default-user' as const, key: singletonKey, instanceId },
      presentation: { displayName: 'Local user', handle: null, avatarUrl: null }, evidence: 'upstream-default' as const,
    },
    stamp: stamp.value, capabilities,
  });
  const machineSession = (): Extract<ServerSession, { status: 'ready' }> => freeze({
    status: 'ready' as const, instanceId, mode: 'single-user' as const,
    actor: {
      identity: machineIdentity,
      presentation: { displayName: 'BB machine', handle: null, avatarUrl: null }, evidence: 'machine' as const,
    },
    stamp: stamp.value, capabilities,
  });
  const selfProfile = (): IdentityProfile => freeze({
    identity: { kind: 'default-user' as const, key: singletonKey, instanceId },
    presentation: { displayName: 'Local user', handle: null, avatarUrl: null }, revision: revision.value, status: 'current' as const,
  });
  const machineProfile = (): IdentityProfile => freeze({
    identity: machineIdentity,
    presentation: { displayName: 'BB machine', handle: null, avatarUrl: null }, revision: revision.value, status: 'current' as const,
  });
  let disposed = false;
  const records = new WeakMap<BbUpstreamInvocation, InvocationRecord>();
  const active = new Set<InvocationRecord>();
  const listeners = new Set<(event: HostInvalidation) => void>();
  const labelledExternal = new WeakSet<object>();

  const terminateScope = (record: InvocationRecord, scope: ScopeRecord | null) => {
    if (!scope || scope.released) return;
    scope.released = true;
    record.controller.signal.removeEventListener('abort', scope.parentAbort);
    scope.controller.abort();
    record.scopes.delete(scope);
  };
  const terminate = (record: InvocationRecord) => {
    for (const scope of [...record.scopes]) terminateScope(record, scope);
    record.controller.abort();
    active.delete(record);
  };
  const known = (context: BbUpstreamInvocation): Result<InvocationRecord> => {
    const record = records.get(context);
    return !record ? err('invalid-input', 'Invocation context was not issued by this binding.')
      : disposed ? err('disposed', 'Upstream binding is disposed.')
      : record.controller.signal.aborted ? err('expired', 'Invocation context has expired.')
      : ok(record);
  };
  const admission = (context: BbUpstreamInvocation): Result<InvocationRecord> => {
    const record = known(context);
    if (!record.ok) return record;
    if (record.value.origin === 'external') return err('unauthenticated', 'External upstream work uses an explicit external source.');
    return record;
  };
  const session = (context: BbUpstreamInvocation): ServerSession => {
    const record = known(context);
    if (!record.ok) return unavailableSession(instanceId, record.error.code === 'invalid-input' ? 'incompatible' : 'unauthenticated', record.error.message);
    if (record.value.origin === 'interactive-user') return readySession();
    return record.value.origin === 'background'
      ? machineSession()
      : unavailableSession(instanceId, 'unauthenticated', 'External upstream work uses an explicit external source.');
  };

  const driver: UpstreamDriver<BbUpstreamInvocation, unknown, BbPromptInput> = {
    instanceId,
    pluginId,
    inputCodec: promptInputCodec,
    scheduler: options.scheduler ?? defaultScheduler(),
    async session(context) { return session(context); },
    async selfProfile(context) {
      const allowed = admission(context);
      return allowed.ok ? ok(allowed.value.origin === 'background' ? machineProfile() : selfProfile()) : allowed;
    },
    async openScope(context) {
      const allowed = admission(context);
      if (!allowed.ok) return allowed;
      const record = allowed.value;
      let scope: ScopeRecord;
      const parentAbort = () => terminateScope(record, scope);
      scope = { controller: new AbortController(), parentAbort, released: false };
      record.scopes.add(scope);
      const expire = () => terminateScope(record, scope);
      record.controller.signal.addEventListener('abort', parentAbort, { once: true });
      const exposedSession = record.origin === 'background' ? machineSession() : readySession();
      const expectedKey = record.origin === 'background' ? machineKey.value : singletonKey;
      return ok({
        signal: scope.controller.signal,
        session: exposedSession,
        validate(expected) {
          if (scope.released || scope.controller.signal.aborted || record.controller.signal.aborted || disposed) {
            return err('expired', 'Upstream request context is no longer live.');
          }
          return expected.actor === expectedKey && expected.session === stamp.value
            ? ok(undefined) : err('stale-context', 'Request expectation does not match the singleton session.');
        },
        release: expire,
      } as HostRequestHandle);
    },
    async submit(input, readOptions) {
      if (disposed) return { status: 'rejected', error: { code: 'disposed', message: 'Upstream binding is disposed.', retry: 'never' } };
      if (readOptions?.signal?.aborted) return { status: 'rejected', error: { code: 'cancelled', message: 'Submission was cancelled before dispatch.', retry: 'never' } };
      const operation = idCodec('operation').decode(input.operationId);
      const thread = idCodec('thread').decode(input.threadId);
      if (!operation.ok || !thread.ok || !['auto', 'start', 'steer-if-active', 'queue-if-active'].includes(input.mode)) {
        return { status: 'rejected', error: { code: 'invalid-input', message: 'Invalid upstream submission metadata.', retry: 'never' } };
      }
      const labelled = labelledExternal.has(input.input as unknown as object);
      const prompts: BbPromptInput[] = [];
      for (const item of input.input) {
        const decoded = promptInputCodec.decode(item);
        if (!decoded.ok) return { status: 'rejected', error: decoded.error };
        prompts.push(decoded.value);
      }
      // The SDK has no AbortSignal on threads.send. Once called, a thrown result is ambiguous.
      try {
        const response = await options.bb.sdk.threads.send({ threadId: thread.value, mode: input.mode, input: prompts });
        const native = nativeIds(response);
        if (!native.ok) return { status: 'indeterminate', operationId: operation.value, message: 'Upstream dispatch returned an unrecognized response after submission.' };
        return {
          status: 'submitted',
          receipt: {
            evidence: 'upstream-response', operationId: operation.value, acceptedAt: null, references: null,
            native: native.value, provenance: labelled ? 'source-labelled' : 'upstream-default', deduplication: 'not-guaranteed',
          },
        };
      } catch {
        return { status: 'indeterminate', operationId: operation.value, message: 'Upstream submission may have been accepted before its response failed.' };
      }
    },
    labelExternal(_author, input) {
      // The public binding renders the host envelope before reaching this
      // adapter. Keep this lower-level hook for defensive SDK normalization
      // and external provenance bookkeeping; never add a second text frame.
      const copied = Object.freeze(input.map((item) => {
        const decoded = promptInputCodec.decode(item);
        return decoded.ok ? decoded.value : item;
      }));
      labelledExternal.add(copied as unknown as object);
      return copied;
    },
    toolCorrelation(_context): ExecutionProvenance {
      return { status: 'unknown', correlation: null, reason: 'upstream-unattributed' };
    },
    async forward(context, destinationPlugin, method, input, readOptions) {
      const allowed = known(context);
      if (!allowed.ok) throw allowed.error;
      if (readOptions?.signal?.aborted) throw { code: 'cancelled', message: 'Plugin forwarding was cancelled before dispatch.', retry: 'never' };
      const destination = idCodec('plugin').decode(destinationPlugin);
      if (!destination.ok || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(method) || !isJson(input)) {
        throw { code: 'invalid-input', message: 'Invalid upstream plugin RPC destination.', retry: 'never' };
      }
      // callRpc requires a Zod output schema; `forward` intentionally exposes only decoded JSON.
      return options.bb.sdk.plugins.callRpc({ pluginId: destination.value, method, input: clonePluginRpcInput(input), outputSchema: z.unknown() });
    },
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => listeners.delete(listener); },
  };

  const binding: BbUpstreamBinding = {
    externalMessageRendering,
    driver,
    issue(origin) {
      if (disposed) throw new Error('Upstream binding is disposed.');
      const controller = new AbortController();
      const invocation = Object.freeze({ origin, signal: controller.signal });
      const record: InvocationRecord = { origin, controller, scopes: new Set() };
      records.set(invocation, record); active.add(record);
      return invocation;
    },
    release(invocation) { const record = records.get(invocation); if (record) terminate(record); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of [...active]) terminate(record);
      for (const listener of [...listeners]) { try { listener({ kind: 'disposed' }); } catch {} }
      listeners.clear();
    },
  };
  try { options.bb.onDispose(() => binding.dispose()); } catch { binding.dispose(); return err('unavailable', 'Unable to register upstream binding cleanup.', 'after-refresh'); }
  return ok(binding);
}
