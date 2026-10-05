/** Executable adapter fixtures. They deliberately exercise the public host adapter. */
import type {
  AcceptanceOutcome, ActorReference, ActorSnapshot, Codec, Contribution, ContributionId, ExecutionProvenance, IdentityKey,
  IdentityProfile, InstanceId, Json, OperationId, PersonReference, PluginId, Result,
  Scheduler, SendInput, Wire,
} from './model.js';
import { defaultIdentityKey, err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import { createHostAdapter, inspectForkExtension } from './host-runtime.js';
import { createIdentityConnection } from './client-connection-runtime.js';
import { createIdentityClientTransport } from './client-runtime.js';
import type {
  ExternalAuthorInput, ForkIdentityProtocolV1, ForkIdentityProvider, ForkInvocationScope, ForkProviderRegistration,
  HostInvalidation, HostRequestHandle, ProviderBoundaryConfigurationV1,
  ServerSession, UpstreamDriver,
} from './host.js';
import type { ConnectionHealth, IdentityConnectionEvent } from './client.js';
import type {
  AtomicStateStorage, StateAddress, StateEnvelope, StateMutation, StateOutcome,
  StateRead, StateSave, StateVersion,
} from './state.js';
import type { FakeRequest, FakeToolCall, ManualClock, Pause } from './testing.js';

const configuration: ProviderBoundaryConfigurationV1 = {
  version: 1,
  boundaryId: 'fixture-boundary',
  pluginId: 'fixture-plugin',
  ingressIds: ['local'],
  credentials: [],
  resolver: { timeoutMs: 1_000 },
};

function requiredId<Kind extends string>(value: string | undefined, kind: Kind, fallback: string) {
  const decoded = idCodec(kind).decode(value ?? fallback);
  if (!decoded.ok) throw new TypeError(decoded.error.message);
  return decoded.value;
}

function submitted<I>(input: SendInput<I>) {
  return {
    status: 'submitted' as const,
    receipt: {
      evidence: 'host-accepted' as const,
      operationId: input.operationId,
      acceptedAt: new Date(0).toISOString(),
      references: [],
      native: { deliveryId: null, queuedMessageId: null, turnId: null },
      provenance: 'structured' as const,
      deduplication: 'guaranteed' as const,
      retainedUntil: new Date(60_000).toISOString(),
    },
  };
}

function wireSubmitted<I>(input: Wire<SendInput<I>>): Wire<AcceptanceOutcome> {
  return {
    status: 'submitted',
    receipt: {
      evidence: 'host-accepted', operationId: input.operationId,
      acceptedAt: new Date(0).toISOString(), references: [],
      native: { deliveryId: null, queuedMessageId: null, turnId: null },
      provenance: 'structured', deduplication: 'guaranteed', retainedUntil: new Date(60_000).toISOString(),
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createManualClock(initialMilliseconds = 0): ManualClock {
  let now = initialMilliseconds;
  let nextId = 0;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  const runDue = async () => {
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };
  return {
    now: () => now,
    schedule(delayMs, callback) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return () => { timers.delete(id); };
    },
    async advance(milliseconds) { now += Math.max(0, milliseconds); await runDue(); },
    flush: runDue,
    get pendingTimers() { return timers.size; },
  };
}

export function personFixture(input: { readonly subject: string; readonly name: string }): ActorSnapshot & { readonly identity: PersonReference } {
  const key = identityKeyCodec.decode(`fixture:${input.subject}`);
  if (!key.ok) throw new TypeError(key.error.message);
  return {
    identity: { kind: 'person', key: key.value, issuer: 'fixture', subject: input.subject },
    presentation: { displayName: input.name, handle: null, avatarUrl: null },
    evidence: 'integration-asserted',
  };
}

function unavailableHistory() {
  return {
    contributions: async () => ok({ status: 'unavailable' as const, reason: 'unsupported' as const }),
    attempts: async () => ok({ status: 'unavailable' as const, reason: 'unsupported' as const }),
  };
}

function unsupportedControl(name: string): never {
  throw new Error(`AdapterHarness.${name} is unsupported by this fixture; use a core integration fixture for that behavior.`);
}

/**
 * Minimal enhanced-host fixture. Registration is intentionally the only provider operation it
 * drives: readiness has no evidence argument and resolve is never called while staging.
 */
export function createAdapterHarness<Input>(options: {
  readonly mode: 'single-user' | 'multi-user';
  readonly instanceId?: string; readonly pluginId?: string;
  readonly inputCodec: Codec<Input>; readonly clock?: ManualClock;
}) {
  const clock = options.clock ?? createManualClock();
  const instanceId = requiredId(options.instanceId, 'instance', 'fixture-instance');
  const pluginId = requiredId(options.pluginId, 'plugin', 'fixture-plugin');
  const defaultActor: ActorSnapshot & { readonly identity: ActorReference } = {
    identity: { kind: 'default-user', key: defaultIdentityKey(instanceId), instanceId },
    presentation: { displayName: 'Fixture user', handle: null, avatarUrl: null },
    evidence: 'local-user',
  };
  let actor = defaultActor;
  let sessionEpoch = 0;
  let identityStatus: 'ready' | 'unavailable' | 'unauthenticated' = 'ready';
  let rawExtension: unknown;
  let providerCounter = 0;
  let activeProvider: ForkProviderRegistration | null = null;
  let nextProviderResult: 'succeed' | 'fail' = 'succeed';
  const hostListeners = new Set<(event: HostInvalidation) => void>();
  const requestControllers = new Map<string, AbortController>();
  const scopeControllers = new Set<AbortController>();
  const observations = { submissions: 0, rawExtensionReads: 0, profileReads: 0, participantReads: 0, subscriptions: 0 };

  const invalidateRequests = () => {
    for (const controller of requestControllers.values()) controller.abort();
    for (const controller of scopeControllers) controller.abort();
    scopeControllers.clear();
  };

  const readySession = (): ServerSession => identityStatus === 'ready'
    ? { status: 'ready', instanceId, mode: options.mode, actor, stamp: requiredId(undefined, 'server-session', sessionEpoch === 0 ? 'fixture-session' : `fixture-session-${sessionEpoch}`), capabilities: {
      requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
      directory: { search: false, lookup: false }, participants: false, externalSend: 'structured',
      toolProvenance: 'causal', operationLookup: true,
    } }
    : { status: identityStatus, instanceId, error: {
      code: identityStatus === 'unauthenticated' ? 'unauthenticated' : 'unavailable',
      message: `Fixture identity is ${identityStatus}.`, retry: 'after-refresh',
    } };

  const profile = (): IdentityProfile => ({
    identity: actor.identity,
    presentation: actor.presentation,
    revision: requiredId(undefined, 'revision', 'fixture-profile'),
    status: 'current',
  });

  const newScope = (): ForkInvocationScope => {
    const controller = new AbortController();
    scopeControllers.add(controller);
    let released = false;
    return {
      signal: controller.signal,
      validate: () => released || controller.signal.aborted
        ? { ok: false as const, code: 'invalidated' as const }
        : { ok: true as const },
      release: () => { released = true; scopeControllers.delete(controller); controller.abort(); },
    };
  };

  const registerProvider = async (provider: ForkIdentityProvider): Promise<Result<ForkProviderRegistration>> => {
    if (nextProviderResult === 'fail') {
      nextProviderResult = 'succeed';
      return err('unavailable', 'Fixture provider replacement failed.', 'after-reconnect');
    }
    const generation = `fixture-generation-${++providerCounter}`;
    const controller = new AbortController();
    type RegistrationStatus = 'staged' | 'active' | 'retired';
    let status: RegistrationStatus = 'staged';
    const listeners = new Set<(status: RegistrationStatus) => void>();
    const publish = (next: RegistrationStatus) => { status = next; for (const listener of listeners) listener(status); };
    const raw: ForkProviderRegistration = {
      generation,
      configuration,
      getStatus: () => status,
      signal: controller.signal,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      invalidate: () => ok(undefined),
      person(issuer, subject) {
        const key = identityKeyCodec.decode(`fixture:${issuer}:${subject}`);
        return key.ok
          ? ok({ kind: 'person', key: key.value, issuer, subject })
          : key;
      },
      dispose() { if (status !== 'retired') { publish('retired'); controller.abort(); } },
    };
    if (provider.validateReadiness) {
      const readiness = await provider.validateReadiness({
        generation,
        configuration,
        deadlineAt: clock.now() + configuration.resolver.timeoutMs,
        signal: controller.signal,
      });
      if (!readiness.ok) { raw.dispose(); return readiness; }
    }
    const previous = activeProvider;
    activeProvider = raw;
    publish('active');
    previous?.dispose();
    return ok(raw);
  };

  const rawProtocol: ForkIdentityProtocolV1<FakeRequest, FakeToolCall, Input> = {
    version: 1,
    instanceId,
    bindInvocation({ handler }) {
      return { registration: { generation: 'fixture-invocation', status: 'active', dispose() {} }, handler: (...args) => handler({ request: { id: 'bound', origin: 'interactive-user' }, scope: newScope() }, ...args) };
    },
    async session() { return readySession(); },
    async selfProfile() { observations.profileReads++; return identityStatus === 'ready' ? ok(profile()) : err('unauthenticated', 'No fixture identity.'); },
    async openRequest(request) {
      const session = readySession();
      if (session.status !== 'ready') return err('unauthenticated', 'No fixture identity.');
      const controller = new AbortController();
      requestControllers.set(request.id, controller);
      const scope = newScope();
      return ok({
        signal: controller.signal, session,
        validate: (expected) => controller.signal.aborted
          ? err('expired', 'Fixture request expired.')
          : expected.actor === session.actor.identity.key && expected.session === session.stamp ? ok(undefined) : err('stale-context', 'Fixture request changed.'),
        release: () => controller.abort(), scope,
      });
    },
    async accept(input) {
      if (input.source.kind === 'scope' && !input.source.scope.validate().ok) {
        return { status: 'rejected' as const, error: { code: 'expired' as const, message: 'Fixture request context is no longer live.', retry: 'never' as const } };
      }
      observations.submissions++; return wireSubmitted(input.input);
    },
    async lookup() { return ok({ status: 'unknown' as const, reason: 'unsupported' as const }); },
    async provenance() { return ok({ status: 'unknown' as const, correlation: null, reason: 'fixture' }); },
    historyContributions: unavailableHistory().contributions,
    historyAttempts: unavailableHistory().attempts,
    directorySources: () => [],
    async participants() { observations.participantReads++; return err('unsupported', 'Fixture participants are disabled.'); },
    async forwardRpc(_scope, _destination, input) { return input; },
    registerProvider,
    subscribe(listener) { observations.subscriptions++; hostListeners.add(listener); return () => hostListeners.delete(listener); },
  };
  rawExtension = rawProtocol;

  const upstream: UpstreamDriver<FakeRequest, FakeToolCall, Input> = {
    instanceId, pluginId, inputCodec: options.inputCodec, scheduler: clock,
    async session() { return readySession(); },
    async selfProfile() { observations.profileReads++; return identityStatus === 'ready' ? ok(profile()) : err('unauthenticated', 'No fixture identity.'); },
    async openScope(request) {
      const session = readySession();
      if (session.status !== 'ready') return err('unauthenticated', 'No fixture identity.');
      const controller = new AbortController();
      requestControllers.set(request.id, controller);
      return ok({ signal: controller.signal, session,
        validate: (expected) => controller.signal.aborted
          ? err('expired', 'Fixture request expired.')
          : expected.actor === session.actor.identity.key && expected.session === session.stamp ? ok(undefined) : err('stale-context', 'Fixture request changed.'),
        release: () => controller.abort() });
    },
    async submit(input) { observations.submissions++; return submitted(input); },
    labelExternal: (_author, input) => input,
    toolCorrelation: () => ({ status: 'unknown', correlation: null, reason: 'fixture' }),
    async forward(_context, _plugin, _method, input) { return input; },
    subscribe(listener) { observations.subscriptions++; hostListeners.add(listener); return () => hostListeners.delete(listener); },
  };

  return {
    upstream, clock,
    connect() { observations.rawExtensionReads++; return createHostAdapter({ upstream, extension: inspectForkExtension<FakeRequest, FakeToolCall, Input>(rawExtension) }); },
    setRawExtension(value: unknown) { rawExtension = value; },
    setLookup() { unsupportedControl('setLookup'); },
    request(origin: FakeRequest['origin'] = 'interactive-user') { return { id: `request-${requestControllers.size + 1}`, origin }; },
    setActor(next: ActorSnapshot & { readonly identity: ActorReference }) {
      if (options.mode === 'single-user') return err('unsupported', 'Singleton adapter fixtures cannot replace the reserved default actor.');
      actor = next; sessionEpoch++; invalidateRequests();
      for (const listener of hostListeners) listener({ kind: 'session', reason: 'actor' });
      return ok(undefined);
    },
    setIdentityAvailability(status: typeof identityStatus) {
      if (identityStatus === status) return;
      identityStatus = status; invalidateRequests();
      for (const listener of hostListeners) listener({ kind: 'session', reason: 'provider' });
    },
    settle(request: FakeRequest) { requestControllers.get(request.id)?.abort(); },
    constructStreamingResponse() { unsupportedControl('constructStreamingResponse'); },
    finishStream() { unsupportedControl('finishStream'); },
    abort(request: FakeRequest) { requestControllers.get(request.id)?.abort(); },
    replaceProvider(result: 'succeed' | 'fail') { nextProviderResult = result; },
    disconnect() { for (const listener of hostListeners) listener({ kind: 'disconnected' }); },
    reconnect() { for (const listener of hostListeners) listener({ kind: 'reconnected' }); },
    pauseAcceptance() { return unsupportedControl('pauseAcceptance'); },
    loseNextAcceptanceResponse() { unsupportedControl('loseNextAcceptanceResponse'); },
    beginAttempt() { return unsupportedControl('beginAttempt'); },
    editContribution() { unsupportedControl('editContribution'); },
    continueAttempt() { return unsupportedControl('continueAttempt'); },
    toolCallForAttempt() { return unsupportedControl('toolCallForAttempt'); },
    get accepted(): readonly Contribution[] { return unsupportedControl('accepted'); },
    observations,
    dispose() { invalidateRequests(); for (const listener of hostListeners) listener({ kind: 'disposed' }); hostListeners.clear(); },
  };
}

interface FixturePause extends Pause {
  reach(): void;
  wait(): Promise<void>;
}

function createPause(): FixturePause {
  const reached = deferred<void>();
  const releaseGate = deferred<void>();
  let reachedOnce = false;
  let released = false;
  return {
    reached: reached.promise,
    reach() { if (!reachedOnce) { reachedOnce = true; reached.resolve(); } },
    wait: () => releaseGate.promise,
    release() { if (!released) { released = true; releaseGate.resolve(); } },
  };
}

function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}

function fixtureJson(value: unknown): string {
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Fixture storage accepts finite JSON numbers only.');
      return current;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (typeof current !== 'object') throw new TypeError('Fixture storage accepts JSON values only.');
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Fixture storage accepts plain JSON objects only.');
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(current).sort()) {
      const child = (current as Record<string, unknown>)[key];
      if (child === undefined) throw new TypeError('Fixture storage does not accept undefined values.');
      output[key] = visit(child);
    }
    return output;
  };
  return JSON.stringify(visit(value));
}

function sameVersion(left: StateVersion, right: StateVersion) {
  return left.epoch === right.epoch && left.sequence === right.sequence;
}

function cloneRead<T>(read: StateRead<T>): StateRead<T> {
  return cloneFixture(read);
}

/**
 * Raw transport fixture whose connection and client transport are the production
 * implementations. It only supplies a controllable network seam.
 */
export function createConnectionHarness() {
  let health: ConnectionHealth = {
    generation: 0,
    identity: { status: 'healthy' },
    state: { status: 'healthy' },
  };
  const replies = new Map<string, unknown[]>();
  const paused = new Map<string, FixturePause[]>();
  const events = new Set<(payload: unknown) => void>();
  const healthListeners = new Set<() => void>();
  const methods: string[] = [];
  let disposeCalls = 0;
  const connection = createIdentityConnection({
    async request(method) {
      methods.push(method);
      const gate = paused.get(method)?.shift();
      if (gate) { gate.reach(); await gate.wait(); }
      const queue = replies.get(method);
      if (!queue?.length) throw new Error(`No fixture reply queued for ${method}.`);
      return cloneFixture(queue.shift());
    },
    subscribe(listener) { events.add(listener); return () => events.delete(listener); },
    getHealth: () => cloneFixture(health),
    subscribeHealth(listener) { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    async revalidate() { return { ok: true as const, value: undefined }; },
    dispose() { disposeCalls++; },
  });
  return {
    connection,
    connect() { return createIdentityClientTransport(connection); },
    setHealth(next: ConnectionHealth) {
      health = cloneFixture(next);
      for (const listener of [...healthListeners]) listener();
    },
    replyNext(method: string, payload: unknown) {
      const queue = replies.get(method) ?? [];
      queue.push(cloneFixture(payload));
      replies.set(method, queue);
    },
    emit(event: IdentityConnectionEvent) {
      for (const listener of [...events]) listener(cloneFixture(event));
    },
    pauseNextRequest(method: string) {
      const gate = createPause();
      const queue = paused.get(method) ?? [];
      queue.push(gate); paused.set(method, queue);
      return gate;
    },
    observations: {
      methods,
      get disposeCalls() { return disposeCalls; },
    },
  };
}

/**
 * In-memory implementation of the public AtomicStateStorage contract. Receipt
 * lookup is address-scoped, duplicates replay their immutable result, and an
 * explicit lost response remains recoverable only through that receipt.
 */
export function createStateStorageHarness<T>(options: { readonly clock: ManualClock }) {
  const records = new Map<string, StateRead<T>>();
  const receipts = new Map<string, { readonly mutation: string; readonly outcome: StateOutcome<T>; readonly retainedUntil: number; expired: boolean }>();
  const commits: { actor: IdentityKey; address: StateAddress; version: StateVersion }[] = [];
  let readFailure: import('./model.js').IdentityError | null = null;
  let readPause: { readonly capture: 'before-pause' | 'after-release'; readonly gate: FixturePause } | null = null;
  let commitPause: FixturePause | null = null;
  let loseCommitResponse = false;
  const key = (address: StateAddress) => fixtureJson([address.instanceId, address.pluginId, address.collection, address.recordId, address.owner]);
  const receiptKey = (address: StateAddress, operationId: OperationId) => `${key(address)}\u0000${operationId}`;
  const empty = (address: StateAddress): StateRead<T> => ({ status: 'empty', address: cloneFixture(address), version: { epoch: 'fixture-empty-r1', sequence: 0 } });
  const current = (address: StateAddress) => cloneRead(records.get(key(address)) ?? empty(address));
  const storage: AtomicStateStorage<T> = {
    boundary: 'same-process-synchronous',
    receiptRetentionMs: 60_000,
    async read(address) {
      const paused = readPause; readPause = null;
      const before = paused?.capture === 'before-pause' ? current(address) : null;
      if (paused) { paused.gate.reach(); await paused.gate.wait(); }
      if (readFailure) return { ok: false, error: cloneFixture(readFailure) };
      return ok(before ?? current(address));
    },
    async commit(input) {
      const gate = commitPause; commitPause = null;
      if (gate) { gate.reach(); await gate.wait(); }
      let mutation: StateMutation<T>;
      let fingerprint: string;
      try { mutation = cloneFixture(input.mutation); fingerprint = fixtureJson(mutation); }
      catch (caught) { return err('invalid-input', caught instanceof Error ? caught.message : 'Invalid fixture state mutation.'); }
      const addressKey = key(mutation.address);
      const existingReceipt = receipts.get(receiptKey(mutation.address, mutation.operationId));
      if (existingReceipt) {
        if (existingReceipt.expired || existingReceipt.retainedUntil <= options.clock.now()) {
          existingReceipt.expired = true;
          return err('expired', 'Fixture operation receipt expired.');
        }
        return existingReceipt.mutation === fingerprint
          ? ok(cloneFixture(existingReceipt.outcome))
          : err('invalid-operation', 'Operation ID was reused with a different immutable mutation.');
      }
      const actor = input.validateAtCommit();
      if (!actor.ok) return actor;
      const present = current(mutation.address);
      const version = present.status === 'present' ? present.envelope.version : present.status === 'empty' ? present.version : null;
      const outcome: StateOutcome<T> = present.status === 'migration-required'
        ? { status: 'conflict', current: present, operationId: mutation.operationId }
        : mutation.kind === 'initialize' && present.status === 'present'
          ? { status: 'already-initialized', current: present, operationId: mutation.operationId }
          : version === null || !sameVersion(version, mutation.expectedVersion)
            ? { status: 'conflict', current: present, operationId: mutation.operationId }
            : present.status === 'present'
              && fixtureJson(present.envelope.value) === fixtureJson(mutation.value)
              && present.envelope.schemaVersion === mutation.schemaVersion
                ? { status: 'unchanged', envelope: present.envelope, operationId: mutation.operationId }
                : (() => {
                  const envelope: StateEnvelope<T> = {
                    address: cloneFixture(mutation.address),
                    version: { epoch: version.epoch, sequence: version.sequence + 1 },
                    schemaVersion: mutation.schemaVersion,
                    value: cloneFixture(mutation.value),
                    lastEditedBy: cloneFixture(actor.value),
                  };
                  records.set(addressKey, { status: 'present', envelope: cloneFixture(envelope) });
                  commits.push({ actor: actor.value.identity.key, address: cloneFixture(envelope.address), version: cloneFixture(envelope.version) });
                  return { status: 'saved', envelope, operationId: mutation.operationId };
                })();
      receipts.set(receiptKey(mutation.address, mutation.operationId), {
        mutation: fingerprint,
        outcome: cloneFixture(outcome),
        retainedUntil: options.clock.now() + storage.receiptRetentionMs,
        expired: false,
      });
      if (loseCommitResponse) { loseCommitResponse = false; return ok({ status: 'indeterminate', operationId: mutation.operationId }); }
      return ok(cloneFixture(outcome));
    },
    async reconcile({ address, operationId }) {
      const receipt = receipts.get(receiptKey(address, operationId));
      if (!receipt) return ok({ status: 'absent-final', retry: 'same-operation-only' });
      if (receipt.expired || receipt.retainedUntil <= options.clock.now()) {
        receipt.expired = true;
        return ok({ status: 'unknown', reason: 'expired' });
      }
      return ok({ status: 'final', outcome: cloneFixture(receipt.outcome) });
    },
  };
  return {
    storage,
    seed(envelope: StateEnvelope<T>) { records.set(key(envelope.address), { status: 'present', envelope: cloneFixture(envelope) }); },
    seedEmpty(address: StateAddress, version: StateVersion) { records.set(key(address), { status: 'empty', address: cloneFixture(address), version: cloneFixture(version) }); },
    seedReadFailure(error: import('./model.js').IdentityError) { readFailure = cloneFixture(error); },
    seedLegacy(address: StateAddress, schemaVersion: number) { records.set(key(address), { status: 'migration-required', address: cloneFixture(address), storedSchemaVersion: schemaVersion }); },
    readCommitted(address: StateAddress) {
      const read = records.get(key(address));
      return read?.status === 'present' ? cloneFixture(read.envelope) : null;
    },
    pauseNextRead(options: { readonly capture: 'before-pause' | 'after-release' }) {
      const gate = createPause(); readPause = { capture: options.capture, gate }; return gate;
    },
    pauseNextCommit() { const gate = createPause(); commitPause = gate; return gate; },
    loseNextCommitResponse() { loseCommitResponse = true; },
    expireReceipt(operationId: OperationId) {
      for (const [receiptKeyValue, receipt] of receipts) if (receiptKeyValue.endsWith(`\u0000${operationId}`)) receipt.expired = true;
    },
    commits,
  };
}
export function consumerProvenanceFixture(provenance: ExecutionProvenance): FakeToolCall {
  return { id: provenance.status === 'unknown' ? 'unknown-provenance' : provenance.correlation?.toolCallId ?? 'fixture-tool-call' };
}

export { createIdentityWireFake } from './testing-wire-runtime.js';
export { defineStateStorageConformance } from './testing-storage-runtime.js';
