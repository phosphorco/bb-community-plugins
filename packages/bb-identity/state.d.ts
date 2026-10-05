/** Framework-neutral synchronization; feature-owned schemas and transactional storage. */
import type { ActorSnapshot, Codec, ConflictToken, Disposable, IdentityKey, InstanceId, OperationId,
  OperationLookup, OwnerSessionId, PluginId, ReadOptions, RequestExpectation, Result, Scheduler, Unsubscribe } from './model.js';
import type { CommitValidator, ResolvedTarget } from './server.js';
export interface StateAddress {
  readonly instanceId: InstanceId; readonly pluginId: PluginId;
  readonly collection: string; readonly recordId: string; readonly owner: IdentityKey;
}
/** Ordered only within an epoch. Reset/recreation produces a fresh epoch; empty records have stable versions. */
export interface StateVersion { readonly epoch: string; readonly sequence: number; }
export interface StateDefinition<T> {
  readonly collection: string; readonly schemaVersion: number; readonly codec: Codec<T>;
  initialValue(): T;
  equal(left: T, right: T): boolean;
}
/** Share this feature-owned descriptor between client and server; address construction is package-owned. */
export interface StateResource<T> {
  readonly pluginId: PluginId; readonly definition: StateDefinition<T>;
}
/** Borrows the same root-owned connection as identity; state never opens a competing feed. */
export declare function createStateTransport<T>(options: {
  readonly connection: import('./client.js').IdentityConnection; readonly resource: StateResource<T>;
}): StateTransport<T>;
export interface StateEnvelope<T> {
  readonly address: StateAddress; readonly version: StateVersion; readonly schemaVersion: number;
  readonly value: T; readonly lastEditedBy: ActorSnapshot | null;
}
export type StateRead<T> =
  | { readonly status: 'present'; readonly envelope: StateEnvelope<T> }
  | { readonly status: 'empty'; readonly address: StateAddress; readonly version: StateVersion }
  | { readonly status: 'migration-required'; readonly address: StateAddress; readonly storedSchemaVersion: number };
export interface StateMutation<T> {
  /** Initialization never rebases defaults. An existing winner is adopted. */
  readonly kind: 'initialize' | 'replace';
  readonly address: StateAddress; readonly expectedVersion: StateVersion;
  readonly expected: RequestExpectation; readonly ownerSession: OwnerSessionId;
  readonly localGeneration: number; readonly operationId: OperationId;
  readonly schemaVersion: number; readonly value: T;
}
export type StateOutcome<T> =
  | { readonly status: 'saved' | 'unchanged'; readonly envelope: StateEnvelope<T>; readonly operationId: OperationId }
  | { readonly status: 'already-initialized'; readonly current: StateRead<T>; readonly operationId: OperationId }
  | { readonly status: 'conflict'; readonly current: StateRead<T>; readonly operationId: OperationId };
export type StateSave<T> = StateOutcome<T> | { readonly status: 'indeterminate'; readonly operationId: OperationId };
export interface StateInvalidation { readonly address: StateAddress; readonly version: StateVersion; readonly operationId: OperationId | null; }
export interface StateReadRequest { readonly address: StateAddress; readonly expected: RequestExpectation; }
export interface StateLookupRequest extends StateReadRequest { readonly operationId: OperationId; }
export interface StateTransport<T> {
  load(input: StateReadRequest, options?: ReadOptions): Promise<Result<StateRead<T>>>;
  save(input: StateMutation<T>, options?: ReadOptions): Promise<Result<StateSave<T>>>;
  reconcile(input: StateLookupRequest, options?: ReadOptions): Promise<Result<OperationLookup<StateOutcome<T>>>>;
  subscribe(address: StateAddress, listener: (event: StateInvalidation) => void): Unsubscribe;
}
/** Deduplicate immutable operation BEFORE CAS; replay exact original outcome even if current record advanced.
 * Same ID with changed mutation fails invalid-operation. Record+receipt commit atomically.
 * Retain receipts for receiptRetentionMs; expired IDs yield unknown, never permission to replace a pending op.
 */
export interface AtomicStateStorage<T> {
  readonly boundary: 'same-process-synchronous';
  readonly receiptRetentionMs: number;
  read(address: StateAddress, options?: ReadOptions): Promise<Result<StateRead<T>>>;
  commit(input: {
    readonly mutation: StateMutation<T>;
    /** Invoke inside the synchronous transaction immediately before mutation; no await through commit. */
    readonly validateAtCommit: () => Result<ActorSnapshot>;
  }): Promise<Result<StateSave<T>>>;
  reconcile(input: { readonly address: StateAddress; readonly operationId: OperationId }): Promise<Result<OperationLookup<StateOutcome<T>>>>;
}
export interface StateService<T> {
  read(target: ResolvedTarget<'read'> | ResolvedTarget<'write'>, recordId: string, options?: ReadOptions): Promise<Result<StateRead<T>>>;
  save(target: ResolvedTarget<'write'>, mutation: StateMutation<T>, options?: ReadOptions): Promise<Result<StateSave<T>>>;
  reconcile(target: ResolvedTarget<'read'> | ResolvedTarget<'write'>, recordId: string, operationId: OperationId): Promise<Result<OperationLookup<StateOutcome<T>>>>;
}
export declare function createStateService<T>(options: {
  readonly instanceId: InstanceId; readonly pluginId: PluginId; readonly definition: StateDefinition<T>;
  readonly storage: AtomicStateStorage<T>; readonly commits: CommitValidator;
  readonly publish: (event: StateInvalidation) => void;
}): StateService<T>;
/** Decode wrapper metadata as well as the feature value; local signals are never part of the wire codec. */
export declare function stateCodecs<T>(value: Codec<T>): {
  readonly read: Codec<StateRead<T>>; readonly mutation: Codec<StateMutation<T>>;
  readonly save: Codec<StateSave<T>>; readonly invalidation: Codec<StateInvalidation>;
  readonly lookup: Codec<OperationLookup<StateOutcome<T>>>;
};

export interface DraftKey { readonly address: StateAddress; readonly actor: IdentityKey; readonly ownerSession: OwnerSessionId; }
export interface PendingDraft<T> {
  readonly formatVersion: 1; readonly key: DraftKey; readonly schemaVersion: number;
  readonly acknowledged: Exclude<StateRead<T>, { status: 'migration-required' }>;
  readonly desired: T; readonly localGeneration: number;
  /** Exact immutable submitted mutation, separate from newer desired content. */
  readonly inFlight: StateMutation<T> | null;
}
export interface DraftCheckpoint<T> { readonly revision: number; readonly draft: PendingDraft<T>; }
export interface DraftStorage<T> {
  /** Bounded recovery lookup across prior controller incarnations; never silently choose between drafts. */
  find(address: StateAddress, actor: IdentityKey, limit: number): Promise<Result<readonly DraftCheckpoint<T>[]>>;
  write(draft: PendingDraft<T>, expectedRevision: number | null): Promise<Result<DraftCheckpoint<T>>>;
  /** An obsolete controller cannot erase a newer checkpoint. */
  remove(key: DraftKey, expectedRevision: number): Promise<Result<void>>;
}
export type ConflictDecision<T> =
  | { readonly kind: 'rebase'; readonly value: T }
  | { readonly kind: 'accept-remote' }
  | { readonly kind: 'needs-review'; readonly reason: string };
export interface ConflictContext<T> {
  readonly cause: 'save-conflict' | 'dirty-load' | 'reconnect' | 'epoch-change' | 'draft-recovery';
  /** A conflict decision is valid only for this token and this controller incarnation. */
  readonly token: ConflictToken; readonly ownerSession: OwnerSessionId;
  readonly base: StateRead<T>; readonly local: T; readonly remote: StateRead<T>;
}
export type SyncSnapshot<T> =
  | { readonly status: 'loading'; readonly address: StateAddress }
  | { readonly status: 'ready'; readonly address: StateAddress; readonly ownerSession: OwnerSessionId;
      readonly acknowledged: StateRead<T>; readonly desired: T; readonly dirty: boolean;
      readonly saving: boolean; readonly localGeneration: number; readonly remotePending: boolean }
  | { readonly status: 'blocked'; readonly address: StateAddress;
      readonly reason: 'identity-unavailable' | 'owner-changed' | 'conflict' | 'indeterminate' | 'storage-error' | 'migration-required' | 'draft-recovery';
      readonly draft: PendingDraft<T> | null; readonly conflict: ConflictContext<T> | null; readonly message: string }
  | { readonly status: 'detached'; readonly address: StateAddress; readonly draft: PendingDraft<T> | null };
export interface IdentityState<T> extends Disposable {
  getSnapshot(): SyncSnapshot<T>;
  subscribe(listener: () => void): Unsubscribe;
  start(): Promise<Result<void>>;
  edit(value: T): Result<void>;
  /** Reference-counted transition pause. Stops automatic dispatch, including work
   * awaiting a checkpoint; explicit flush remains available. Release resumes scheduling. */
  suspendAutomaticDispatch(): Unsubscribe;
  /** Waits for the pending intent observed at invocation, with a 30-second scheduler bound.
   * Timeout retains the exact uncertain operation; it cannot retract accepted work.
   */
  flush(): Promise<Result<void>>;
  /** Refresh identity first. Every remote divergence while dirty invokes conflict policy with ORIGINAL base. */
  /** Health notifications may reuse current recovery; explicit reconnects refresh authority. */
  reconnect(options?: { readonly reuseInFlight?: boolean }): Promise<Result<void>>;
  /** Rejects a token superseded by a later remote divergence, even in this same controller. */
  resolveConflict(token: ConflictToken, decision: ConflictDecision<T>): Promise<Result<void>>;
  /** Recovery selection is explicit; exact uncertain operations are reconciled before accepting/rebasing desired. */
  recover(checkpoint: DraftCheckpoint<T>): Promise<Result<void>>;
  /** Explicitly forget one exact recovery checkpoint. A newer revision cannot
   * be erased by a stale recovery list. */
  discardRecovery(checkpoint: DraftCheckpoint<T>): Promise<Result<void>>;
  /** At most 20 candidates for this address AND actual actor, across prior incarnations.
   * Store survives controller disposal; schema mismatch and another actor's draft require an explicit
   * feature import, never automatic recovery. Reconcile old uncertain operations without re-authoring.
   */
  recoveryCandidates(options?: ReadOptions): Promise<Result<readonly DraftCheckpoint<T>[]>>;
  checkpoint(): Promise<Result<DraftCheckpoint<T> | null>>;
  /** Immediate: stop writes/timers and fence late callbacks. The returned
   * in-memory draft is durable only when this controller was given DraftStorage. */
  detach(reason: 'identity-invalidated' | 'view-change' | 'unmount'): PendingDraft<T> | null;
  /** Fallible preservation is separate from unconditional detach/dispose. With
   * no DraftStorage, preserve is deliberately in-session only. Flush is bounded;
   * discard cannot recall accepted work. */
  close(options: { readonly pending: 'flush' | 'preserve' | 'discard' }): Promise<Result<void>>;
}
export declare function createIdentityState<T>(options: {
  readonly address: StateAddress; readonly expected: RequestExpectation; readonly ownerSession: OwnerSessionId;
  readonly definition: StateDefinition<T>; readonly transport: StateTransport<T>; readonly drafts?: DraftStorage<T>;
  readonly scheduler?: Scheduler; readonly debounceMs?: number;
  /** Maximum same-operation resubmissions during one explicit flush after an absent-final lookup.
   * Default 3; zero forbids resubmission. Unknown/pending outcomes never authorize a retry.
   */
  readonly retryLimit?: number;
  readonly onConflict: (context: ConflictContext<T>) => ConflictDecision<T>;
  readonly initializeEmpty: boolean;
  /** Must return the currently observed server session, not a captured initial identity. */
  readonly currentSession: () => Result<import('./host.js').ServerSession>;
}): IdentityState<T>;
export declare function stateAddressKey(address: StateAddress): string;
