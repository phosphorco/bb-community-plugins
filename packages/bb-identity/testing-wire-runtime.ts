/**
 * Wire-level identity fake for client and app tests. It runs the production
 * server binding (`bindBbIdentity`, endpoint and state RPC bridge) on an SDK
 * fake plugin host, backed by `createStateStorageHarness`, so clients talk to
 * real bootstrap, directory and state handlers through host RPC semantics.
 *
 * Single-user mode uses the stable upstream singleton path of the binding.
 * Multi-user mode supplies a small in-memory enhanced-host protocol with a
 * switchable actor and a person directory. Neither is native host proof.
 */
import type { ActorReference, ActorSnapshot, IdentityKey, Json, Unsubscribe } from './model.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import { bindBbIdentity } from './bb-entry-runtime.js';
import type { BbIdentityApi } from './bb.js';
import type {
  ForkIdentityProtocolV1, ForkInvocationScope, HostInvalidation, ProviderDirectorySource, ServerSession,
} from './host.js';
import { identityRpcMethods } from './rpc-routes-runtime.js';
import type { AtomicStateStorage, StateAddress, StateEnvelope } from './state.js';
import type {
  IdentityWireFake, IdentityWireFakeOptions, ManualClock, Pause, WireFakeHost,
} from './testing.js';
import { createManualClock, createStateStorageHarness, personFixture } from './testing-runtime.js';

const CHANNEL = 'bb-identity/v1';
const ISSUER = 'fixture';

interface Gate extends Pause { wait(): Promise<void>; reach(): void }
function gate(): Gate {
  let reach!: () => void, open!: () => void;
  const reached = new Promise<void>(r => { reach = r; });
  const released = new Promise<void>(r => { open = r; });
  return { reached, reach: () => reach(), wait: () => released, release: () => open() };
}

function brand(kind: string, value: string): string {
  const decoded = idCodec(kind).decode(value);
  if (!decoded.ok) throw new TypeError(decoded.error.message);
  return decoded.value;
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Enhanced-host stand-in: one actor at a time, request scopes fenced by session epoch. */
function createMultiUserProtocol(instanceId: string, initial: ActorSnapshot & { readonly identity: ActorReference }) {
  let actor = initial;
  let epoch = 0;
  let requests = 0;
  const people = new Map<string, { readonly name: string }>();
  const scopes = new Set<AbortController>();
  const listeners = new Set<(event: HostInvalidation) => void>();
  const session = (): Extract<ServerSession, { status: 'ready' }> => ({
    status: 'ready', instanceId: instanceId as never, mode: 'multi-user', actor,
    stamp: brand('server-session', `wire-fake-session-${epoch}`) as never,
    capabilities: {
      requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
      directory: { search: true, lookup: true }, participants: false, externalSend: 'structured',
      toolProvenance: 'causal', operationLookup: true,
    },
  });
  const scope = (): ForkInvocationScope => {
    const controller = new AbortController(); scopes.add(controller);
    return {
      signal: controller.signal,
      validate: () => controller.signal.aborted ? { ok: false as const, code: 'invalidated' as const } : { ok: true as const },
      release: () => { scopes.delete(controller); controller.abort(); },
    };
  };
  const record = (subject: string) => {
    const person = people.get(subject);
    return person ? { issuer: ISSUER, subject, presentation: { displayName: person.name, handle: null, avatarUrl: null }, status: 'current' as const } : null;
  };
  const revision = () => `wire-fake-directory-${people.size}`;
  const directory: ProviderDirectorySource = {
    issuers: [ISSUER], generation: brand('provider-generation', 'wire-fake-provider') as never,
    async directory(input) {
      const query = input.query.toLowerCase();
      const records = [...people.keys()].map(record).filter(r => r !== null && (r.subject.includes(query) || r.presentation.displayName.toLowerCase().includes(query))).slice(0, input.limit);
      return ok({ records: records as NonNullable<ReturnType<typeof record>>[], nextCursor: null, revision: revision() as never });
    },
    async lookup(subjects) {
      return ok({ revision: revision() as never, records: subjects.map(s => ({ issuer: s.issuer, subject: s.subject, record: s.issuer === ISSUER ? record(s.subject) : null })) });
    },
    person(issuer, subject) {
      const key = identityKeyCodec.decode(`${issuer}:${subject}`);
      return key.ok ? ok({ kind: 'person' as const, key: key.value, issuer, subject }) : key;
    },
  };
  const unsupported = async () => err('unsupported', 'Not modeled by the identity wire fake.');
  const protocol: ForkIdentityProtocolV1<{ readonly id: string }, unknown, unknown> = {
    version: 1, instanceId,
    bindInvocation({ handler }) {
      return {
        registration: { generation: 'wire-fake-invocation', status: 'active', dispose() {} },
        handler: (...args) => handler({ request: { id: `wire-fake-request-${++requests}` }, scope: scope() }, ...args),
      };
    },
    async session() { return session(); },
    async selfProfile() { return ok({ identity: actor.identity, presentation: actor.presentation, revision: brand('revision', `wire-fake-profile-${epoch}`) as never, status: 'current' as const }); },
    async openRequest() {
      const current = session(); const controller = new AbortController(); const opened = scope();
      scopes.add(controller);
      return ok({
        signal: controller.signal, session: current, scope: opened,
        validate: expected => controller.signal.aborted ? err('expired', 'Wire fake request expired.')
          : expected.actor === current.actor.identity.key && expected.session === current.stamp ? ok(undefined) : err('stale-context', 'Wire fake session changed.'),
        release: () => { scopes.delete(controller); controller.abort(); },
      });
    },
    async accept() { return { status: 'rejected' as const, error: { code: 'unsupported' as const, message: 'Not modeled by the identity wire fake.', retry: 'never' as const } }; },
    async lookup() { return ok({ status: 'unknown' as const, reason: 'unsupported' as const }); },
    async provenance() { return ok({ status: 'unknown' as const, correlation: null, reason: 'wire-fake' }); },
    async historyContributions() { return ok({ status: 'unavailable' as const, reason: 'unsupported' as const }); },
    async historyAttempts() { return ok({ status: 'unavailable' as const, reason: 'unsupported' as const }); },
    directorySources: () => [directory],
    participants: unsupported,
    async forwardRpc(_scope, _destination, input) { return input; },
    registerProvider: unsupported,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {
    protocol,
    get actor() { return actor; },
    addPerson(subject: string, name: string) { people.set(subject, { name }); },
    switchActor(next: ActorSnapshot & { readonly identity: ActorReference }) {
      actor = next; epoch++;
      for (const controller of [...scopes]) controller.abort();
      scopes.clear();
      for (const listener of [...listeners]) listener({ kind: 'session', reason: 'actor' });
    },
  };
}

export function createIdentityWireFake<T>(options: IdentityWireFakeOptions<T>): IdentityWireFake<T> {
  const clock: ManualClock = options.clock ?? createManualClock();
  const harness = createStateStorageHarness<T>({ clock });
  const host: WireFakeHost = options.host;
  const pluginId = host.harness.inspection.pluginId;
  if (options.resource.pluginId !== pluginId) throw new TypeError('The state resource must belong to the fake host plugin.');
  const multi = options.mode === 'multi-user'
    ? createMultiUserProtocol(brand('instance', options.instanceId ?? 'wire-fake-instance'), personFixture(options.actor ?? { subject: 'wire-fake-user', name: 'Wire fake user' }))
    : null;

  // Controls on the storage seam the production state service commits through.
  let failLoads = 0;
  let loadHold: Gate | null = null, saveHold: Gate | null = null, loseSave = false;
  const storage: AtomicStateStorage<T> = {
    boundary: harness.storage.boundary,
    get receiptRetentionMs() { return harness.storage.receiptRetentionMs; },
    async read(address, readOptions) {
      if (loadHold) { const held = loadHold; held.reach(); await held.wait(); }
      if (failLoads > 0) { failLoads--; return err('unavailable', 'Controlled state read failure.', 'after-reconnect'); }
      return harness.storage.read(address, readOptions);
    },
    async commit(input) {
      if (saveHold) { const held = saveHold; held.reach(); await held.wait(); }
      return harness.storage.commit(input);
    },
    reconcile: input => harness.storage.reconcile(input),
  };

  const realtime = new Set<(channel: string, payload: unknown) => void>();
  const publish = (channel: string, payload: unknown) => {
    host.bb.realtime.publish(channel, payload as never);
    const wire = json(payload ?? null);
    for (const listener of [...realtime]) listener(channel, wire);
  };
  const bb = {
    pluginId,
    onDispose: (fn: () => void | Promise<void>) => host.bb.onDispose(fn),
    rpc: { register: (contract: never, handlers: never) => host.bb.rpc.register(contract, handlers) },
    realtime: { publish },
    sdk: host.bb.sdk,
    ...(multi ? { experimental_p6rIdentity: multi.protocol } : {}),
  } as unknown as BbIdentityApi;
  const bound = bindBbIdentity(bb, options.instanceId && !multi ? { stateNamespace: options.instanceId } : undefined);
  if (!bound.ok) throw new Error(`bindBbIdentity failed: ${bound.error.message}`);
  const binding = bound.value;
  const registered = binding.state.register({ resource: options.resource, storage, policy: options.policy ?? { kind: 'self-only' }, ...(options.readPolicy ? { readPolicy: options.readPolicy } : {}) });
  if (!registered.ok) throw new Error(`State registration failed: ${registered.error.message}`);

  const calls: string[] = [];
  const saveInputs: unknown[] = [];
  const stateSave = identityRpcMethods['bb-identity/v1/state/save'];
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const method of Object.values(identityRpcMethods)) {
    rpc[method] = async input => {
      calls.push(method);
      if (method === stateSave) saveInputs.push(json(input ?? null));
      const result = await host.harness.behavior.callRpc(method, input ?? {});
      if (method === stateSave && loseSave) { loseSave = false; throw new Error('Controlled post-commit response loss.'); }
      return result;
    };
  }

  const nextVersion = (address: StateAddress) => {
    const current = harness.readCommitted(address);
    if (!current) throw new Error('No committed state at that address to invalidate.');
    return current;
  };
  return {
    rpc,
    channel: CHANNEL,
    host,
    storage: harness,
    get actor() { return multi ? multi.actor : null; },
    onRealtime(listener): Unsubscribe { realtime.add(listener); return () => { realtime.delete(listener); }; },
    switchActor(subject: string) {
      if (!multi) throw new Error('switchActor needs mode: multi-user; the singleton actor cannot change.');
      multi.switchActor(personFixture({ subject, name: subject }));
    },
    addPerson(person) {
      if (!multi) throw new Error('addPerson needs mode: multi-user; the singleton directory is empty.');
      multi.addPerson(person.subject, person.name);
    },
    personKey(subject: string): IdentityKey {
      const key = identityKeyCodec.decode(`${ISSUER}:${subject}`);
      if (!key.ok) throw new TypeError(key.error.message);
      return key.value;
    },
    invalidateExternally(address, value) {
      const current = nextVersion(address);
      const envelope: StateEnvelope<T> = { ...current, version: { epoch: current.version.epoch, sequence: current.version.sequence + 1 }, ...(value === undefined ? {} : { value }) };
      harness.seed(envelope);
      publish(CHANNEL, { kind: 'state', event: { address, version: envelope.version, operationId: null } } as unknown as Json);
      return envelope;
    },
    failNextLoads(count: number) { failLoads = count; },
    loseNextSaveResponse() { loseSave = true; },
    holdLoads() { const held = gate(); loadHold = held; const release = held.release; return { reached: held.reached, release() { if (loadHold === held) loadHold = null; release(); } }; },
    holdSaves() { const held = gate(); saveHold = held; const release = held.release; return { reached: held.reached, release() { if (saveHold === held) saveHold = null; release(); } }; },
    calls,
    saveInputs,
    committed: (address: StateAddress) => harness.readCommitted(address),
    dispose() { registered.value.dispose(); binding.dispose(); },
  } satisfies IdentityWireFake<T> as IdentityWireFake<T>;
}

