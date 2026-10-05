/** Testing entry point: production-adapter inputs and separately labelled normalized consumer fixtures. */
import type { ActorReference, ActorSnapshot, Codec, Contribution, ContributionId, ExecutionProvenance,
  IdentityKey, OperationId, PersonReference, Result, Scheduler,
  SessionStamp, Unsubscribe } from './model.js';
import type { IdentityHost, UpstreamDriver } from './host.js';
import type { ConnectionHealth, IdentityClientTransport, IdentityConnection, IdentityConnectionEvent } from './client.js';
import type { AtomicStateStorage, StateAddress, StateEnvelope, StateRead, StateResource, StateVersion } from './state.js';
import type { TargetPolicy } from './server.js';
export interface ManualClock extends Scheduler {
  advance(milliseconds: number): Promise<void>;
  flush(): Promise<void>;
  readonly pendingTimers: number;
}
export interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void; }
export declare function createManualClock(initialMilliseconds?: number): ManualClock;
export declare function deferred<T>(): Deferred<T>;
/** Person fixture is for multi-person scenarios. Singleton comes only from the instance's reserved default. */
export declare function personFixture(input: { readonly subject: string; readonly name: string }): ActorSnapshot & { readonly identity: PersonReference };
export interface FakeRequest { readonly id: string; readonly origin: 'interactive-user' | 'agent' | 'background' | 'external' | 'unauthenticated'; }
export interface FakeToolCall { readonly id: string; }
export interface Pause { readonly reached: Promise<void>; release(): void; }
export interface AdapterHarness<Input> {
  readonly upstream: UpstreamDriver<FakeRequest, FakeToolCall, Input>;
  readonly clock: ManualClock;
  /** Production inspectForkExtension and createHostAdapter path, not a supplied normalized host. */
  connect(): IdentityHost<FakeRequest, FakeToolCall, Input>;
  setRawExtension(value: unknown): void;
  /** @throws This adapter fixture does not model operation lookup controls. */
  setLookup(status: 'supported' | 'unsupported' | 'pending' | 'absent-final' | 'expired' | 'unavailable'): void;
  request(origin?: FakeRequest['origin']): FakeRequest;
  /** Multi-user replacement advances the session stamp and invalidates every issued request; singleton rejects it. */
  setActor(actor: ActorSnapshot & { readonly identity: ActorReference }): Result<void>;
  setIdentityAvailability(status: 'ready' | 'unavailable' | 'unauthenticated'): void;
  settle(request: FakeRequest): void;
  /** @throws Streaming is not modeled by this adapter fixture. */
  constructStreamingResponse(request: FakeRequest): void;
  /** @throws Streaming is not modeled by this adapter fixture. */
  finishStream(request: FakeRequest): void;
  abort(request: FakeRequest): void;
  replaceProvider(result: 'succeed' | 'fail'): void;
  disconnect(): void;
  reconnect(): void;
  /** @throws Acceptance pause points are not modeled by this adapter fixture. */
  pauseAcceptance(point: 'before-dispatch' | 'before-commit' | 'after-commit-before-response'): Pause;
  /** @throws Response loss is not modeled by this adapter fixture. */
  loseNextAcceptanceResponse(): void;
  /** @throws Causal contribution/attempt controls are not modeled by this adapter fixture. */
  beginAttempt(groups: readonly (readonly ContributionId[])[]): string;
  editContribution(id: ContributionId, editor: ActorSnapshot): void;
  continueAttempt(attemptId: string, reason: string): string;
  toolCallForAttempt(attemptId: string): FakeToolCall;
  /** @throws Causal contribution/attempt controls are not modeled by this adapter fixture. */
  readonly accepted: readonly Contribution[];
  readonly observations: { readonly submissions: number; readonly rawExtensionReads: number;
    readonly profileReads: number; readonly participantReads: number; readonly subscriptions: number };
  dispose(): void;
}
export declare function createAdapterHarness<Input>(options: {
  readonly mode: 'single-user' | 'multi-user';
  /** Plain fixture IDs are validated and branded inside the test runtime. */
  readonly instanceId?: string; readonly pluginId?: string;
  readonly inputCodec: Codec<Input>; readonly clock?: ManualClock;
}): AdapterHarness<Input>;
/** Unit-only shortcut, intentionally not evidence of host causal attribution correctness. */
export declare function consumerProvenanceFixture(provenance: ExecutionProvenance): FakeToolCall;
/** Raw connection controls exercise production decoder/health paths, not a pre-normalized client.
 * `state` and `identity` health can change independently so a state-only outage is reproducible.
 */
export interface ConnectionHarness {
  readonly connection: IdentityConnection;
  /** Exercises production createIdentityClientTransport and createStateTransport paths. */
  connect(): IdentityClientTransport;
  setHealth(health: ConnectionHealth): void;
  replyNext(method: string, payload: unknown): void;
  emit(event: IdentityConnectionEvent): void;
  pauseNextRequest(method: string): Pause;
  readonly observations: { readonly methods: readonly string[]; readonly disposeCalls: number };
}
export declare function createConnectionHarness(): ConnectionHarness;
export interface StateStorageHarness<T> {
  readonly storage: AtomicStateStorage<T>;
  seed(envelope: StateEnvelope<T>): void;
  seedEmpty(address: StateAddress, version: StateVersion): void;
  seedReadFailure(error: import('./model.js').IdentityError): void;
  seedLegacy(address: StateAddress, schemaVersion: number): void;
  readCommitted(address: StateAddress): StateEnvelope<T> | null;
  /** Snapshot timing is explicit to reproduce stale successful loads. */
  pauseNextRead(options: { readonly capture: 'before-pause' | 'after-release' }): Pause;
  pauseNextCommit(): Pause;
  loseNextCommitResponse(): void;
  expireReceipt(operationId: OperationId): void;
  readonly commits: readonly { readonly actor: IdentityKey; readonly address: StateAddress; readonly version: StateVersion }[];
}
export declare function createStateStorageHarness<T>(options: { readonly clock: ManualClock }): StateStorageHarness<T>;

/** The parts of `createFakePluginHost()` (from `@get-bb/plugin-sdk/testing`) the wire fake uses. */
/** Structural, so `/testing` declarations compile without the optional SDK peer installed. */
export interface WireFakeHost {
  readonly bb: {
    readonly pluginId: string;
    onDispose(dispose: () => void | Promise<void>): void;
    readonly rpc: { register(contract: never, handlers: never): unknown };
    readonly realtime: { publish(channel: string, payload: never): unknown };
    readonly sdk: unknown;
  };
  readonly harness: {
    readonly behavior: { callRpc(method: string, input?: unknown): Promise<unknown> };
    readonly inspection: { readonly pluginId: string };
  };
}
export interface IdentityWireFakeOptions<T> {
  /** A fresh SDK fake host for the feature plugin; the production binding registers on it. */
  readonly host: WireFakeHost;
  /** `single-user` runs the upstream singleton path; `multi-user` adds a switchable actor and directory. */
  readonly mode: 'single-user' | 'multi-user';
  /** The feature's shared state resource; its pluginId must be the host's. */
  readonly resource: StateResource<T>;
  readonly policy?: TargetPolicy;
  readonly readPolicy?: TargetPolicy;
  readonly instanceId?: string;
  /** Initial multi-user actor; default subject `wire-fake-user`. */
  readonly actor?: { readonly subject: string; readonly name: string };
  readonly clock?: ManualClock;
}
/**
 * Wire-level identity server for client and app tests. Handlers run the production
 * `bindBbIdentity` binding, endpoint and state bridge on the SDK fake host, with
 * state in `createStateStorageHarness`. Source conformance only, not native host proof.
 */
export interface IdentityWireFake<T> {
  /** `bb-identity.v1.*` handlers, shaped for SDK `testing/app` `renderSlot(…, { rpc })`. */
  readonly rpc: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
  /** The realtime channel identity clients subscribe to. */
  readonly channel: 'bb-identity/v1';
  /** Each server publication, JSON-normalized. Forward it to the rendered slot's `emitRealtime`. */
  onRealtime(listener: (channel: string, payload: unknown) => void): Unsubscribe;
  readonly host: WireFakeHost;
  /** Committed state, versions, pauses and operation outcomes. */
  readonly storage: StateStorageHarness<T>;
  /** Current multi-user actor; null in single-user mode. */
  readonly actor: (ActorSnapshot & { readonly identity: ActorReference }) | null;
  /** Multi-user only: replace the actor. The session stamp advances and older requests are fenced. */
  switchActor(subject: string): void;
  /** Multi-user only: add a person the directory can search and look up. */
  addPerson(person: { readonly subject: string; readonly name: string }): void;
  /** The identity key of a multi-user person, for state addresses. */
  personKey(subject: string): IdentityKey;
  /** Another writer commits a new version (same value unless given) and the change is published. */
  invalidateExternally(address: StateAddress, value?: T): StateEnvelope<T>;
  /** The next `count` state loads fail as `unavailable` with retry `after-reconnect`. */
  failNextLoads(count: number): void;
  /** The next state save commits, then the caller sees a transport failure. */
  loseNextSaveResponse(): void;
  /** Hold every state load until release. */
  holdLoads(): Pause;
  /** Hold every state commit until release. */
  holdSaves(): Pause;
  /** Every identity RPC method called, in order. */
  readonly calls: readonly string[];
  /** Every state save input, JSON-normalized. */
  readonly saveInputs: readonly unknown[];
  committed(address: StateAddress): StateEnvelope<T> | null;
  dispose(): void;
}
export declare function createIdentityWireFake<T>(options: IdentityWireFakeOptions<T>): IdentityWireFake<T>;

/** Test registrar shared by `node:test` and `bun:test`. */
export interface StateStorageConformanceTest {
  (name: string, fn: () => Promise<void>): unknown;
  skip?(name: string, fn: () => Promise<void>): unknown;
}
export interface OpenedStateStorage<T> {
  readonly storage: AtomicStateStorage<T>;
  /** Reopen the same persisted store, as after a process restart. */
  reopen?(): Promise<AtomicStateStorage<T>> | AtomicStateStorage<T>;
  /** True while a synchronous commit transaction is open, so the suite can prove validateAtCommit runs inside it. */
  insideCommit?(): boolean;
  close?(): Promise<void> | void;
}
export interface StateStorageConformanceOptions<T> {
  readonly test: StateStorageConformanceTest;
  /** Open the feature's real storage over a fresh, empty store. It must read time from `now`. */
  open(input: { readonly now: () => number }): Promise<OpenedStateStorage<T>> | OpenedStateStorage<T>;
  /** A state address for `recordId` in the feature's collection. */
  address(recordId: string): StateAddress;
  /** Two distinct feature values. */
  readonly values: readonly [T, T];
  readonly schemaVersion?: number;
  /** Editor snapshot returned by validateAtCommit. */
  readonly actor?: ActorSnapshot;
  /** Test-name prefix; default `state storage conformance: `. */
  readonly prefix?: string;
  /** Record a known gap with its reason instead of running the check. */
  readonly skip?: { readonly restart?: string };
}
/**
 * Registers the AtomicStateStorage contract checks: stable empty versions, one
 * initialize winner, unchanged and conflict outcomes, immutable address-scoped
 * operation ids with exact replay, expiry tombstones, commit-time rejection that
 * leaves no record or outcome, and restart durability.
 */
export declare function defineStateStorageConformance<T>(options: StateStorageConformanceOptions<T>): void;
