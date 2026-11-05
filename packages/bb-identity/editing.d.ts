/** Opt-in editing/v1. Publication target and actual draft owner remain distinct. */
import type { Codec, ConflictToken, Disposable, IdentityError, OperationId, OperationLookup, OwnerSessionId, ReadOptions, RequestExpectation, Result, Scheduler, Unsubscribe } from './model.js';
import type { ServerSession } from './host.js';
import type { ConflictContext, ConflictDecision, PendingDraft, StateAddress, StateDefinition, StateInvalidation, StateMutation, StateOutcome, StateRead } from './state.js';
export declare const EDITING_PROTOCOL: 'bb-identity.editing/v1';
export interface EditingScope<Target> {
  /** Actual actor's draft retention address. Never the owner of a shared document. */
  readonly draftAddress: StateAddress;
  readonly schemaVersion: number;
  /** Feature-owned publication target, distinct from draft actor and session. */
  readonly target: Target;
  readonly expected: RequestExpectation;
}
export interface EditingRequest<T, Target> {
  readonly protocol: typeof EDITING_PROTOCOL;
  readonly target: Target;
  readonly mutation: StateMutation<T>;
}
export interface EditingDiagnostic { readonly code: string; readonly message: string; readonly path?: readonly (string | number)[]; }
export type EditingReceipt<T, Target> = {
  readonly protocol: typeof EDITING_PROTOCOL;
  readonly request: EditingRequest<T, Target>;
  readonly outcome: StateOutcome<T> | { readonly status: 'rejected'; readonly operationId: OperationId; readonly diagnostics: readonly EditingDiagnostic[] };
};
export type EditingSave<T, Target> = EditingReceipt<T, Target> | {
  readonly protocol: typeof EDITING_PROTOCOL; readonly status: 'indeterminate'; readonly operationId: OperationId;
};
export interface EditingTransport<T, Target> {
  /** Construct only after negotiating this version with the feature endpoint; no legacy fallback. */
  readonly protocol: typeof EDITING_PROTOCOL;
  load(scope: EditingScope<Target>, options?: ReadOptions): Promise<Result<StateRead<T>>>;
  save(request: EditingRequest<T, Target>, options?: ReadOptions): Promise<Result<EditingSave<T, Target>>>;
  reconcile(request: EditingRequest<T, Target>, options?: ReadOptions): Promise<Result<OperationLookup<EditingReceipt<T, Target>>>>;
  subscribe(scope: EditingScope<Target>, listener: (event: StateInvalidation) => void): Unsubscribe;
}
export interface EditingDraft<T, Target> {
  readonly protocol: typeof EDITING_PROTOCOL;
  readonly target: Target;
  /** desired B and exact inFlight A are independent fields. */
  readonly draft: PendingDraft<T>;
  readonly rejection: EditingReceipt<T, Target> | null;
}
export interface EditingCheckpoint<T, Target> { readonly revision: number; readonly draft: EditingDraft<T, Target>; }
export interface EditingDraftStorage<T, Target> {
  find(scope: EditingScope<Target>, limit: number): Promise<Result<readonly EditingCheckpoint<T, Target>[]>>;
  write(draft: EditingDraft<T, Target>, expectedRevision: number | null): Promise<Result<EditingCheckpoint<T, Target>>>;
  remove(key: { readonly target: Target; readonly draftKey: import('./state.js').DraftKey }, expectedRevision: number): Promise<Result<void>>;
}
export interface EditingSnapshot<T, Target> {
  readonly protocol: typeof EDITING_PROTOCOL;
  readonly status: 'loading' | 'loaded' | 'fenced' | 'detached';
  readonly scope: EditingScope<Target>;
  readonly ownerSession: OwnerSessionId;
  readonly desired: T | undefined;
  readonly localGeneration: number;
  readonly acknowledged: StateRead<T> | null;
  readonly dirty: boolean;
  readonly editable: boolean;
  readonly submitted: EditingRequest<T, Target> | null;
  readonly publication: {
    readonly eligible: boolean;
    readonly status: 'idle' | 'saving' | 'unknown' | 'conflict' | 'rejected' | 'fenced';
    readonly message: string | null;
    readonly rejection: EditingReceipt<T, Target> | null;
    readonly conflict: ConflictContext<T> | null;
  };
  readonly checkpoint: {
    readonly status: 'disabled' | 'local-only' | 'writing' | 'backed-up' | 'failed';
    readonly generation: number | null;
    readonly revision: number | null;
    readonly error: IdentityError | null;
  };
  /** Exportable even if persistence failed. Only checkpoint success proves backup. */
  readonly draft: EditingDraft<T, Target> | null;
}
export interface EditingState<T, Target> extends Disposable {
  /** Borrowed identity for shared retirement coordination; never disposed by the binding. */
  readonly draftStorage: EditingDraftStorage<T, Target> | null;
  getSnapshot(): EditingSnapshot<T, Target>;
  subscribe(listener: () => void): Unsubscribe;
  start(): Promise<Result<void>>;
  edit(value: T): Result<void>;
  /** Explicit action only; reconcile A never implicitly dispatches B. */
  flush(): Promise<Result<void>>;
  reconnect(options?: { readonly reuseInFlight?: boolean }): Promise<Result<void>>;
  resolveConflict(token: ConflictToken, decision: ConflictDecision<T>): Promise<Result<void>>;
  checkpoint(): Promise<Result<EditingCheckpoint<T, Target> | null>>;
  recover(candidate: EditingCheckpoint<T, Target>): Promise<Result<void>>;
  recoveryCandidates(options?: ReadOptions): Promise<Result<readonly EditingCheckpoint<T, Target>[]>>;
  discardRecovery(candidate: EditingCheckpoint<T, Target>): Promise<Result<void>>;
  detach(reason: 'identity-invalidated' | 'view-change' | 'unmount'): EditingDraft<T, Target> | null;
  close(options: { readonly pending: 'flush' | 'preserve' | 'discard' }): Promise<Result<void>>;
}
export declare function createIdentityEditingState<T, Target>(options: {
  readonly draftAddress: StateAddress; readonly target: Target; readonly targetCodec: Codec<Target>;
  readonly expected: RequestExpectation; readonly ownerSession: OwnerSessionId;
  readonly definition: StateDefinition<T>; readonly transport: EditingTransport<T, Target>;
  readonly drafts?: EditingDraftStorage<T, Target>; readonly scheduler?: Scheduler;
  readonly onConflict: (context: ConflictContext<T>) => ConflictDecision<T>;
  readonly initializeEmpty: boolean;
  readonly currentSession: () => Result<ServerSession>;
}): EditingState<T, Target>;
export declare function editingCodecs<T, Target>(value: Codec<T>, target: Codec<Target>): {
  /** Actual load/subscription scope. Does not create a mutation or infer shared ownership. */
  readonly scope: Codec<EditingScope<Target>>;
  readonly request: Codec<EditingRequest<T, Target>>;
  readonly receipt: Codec<EditingReceipt<T, Target>>;
  readonly save: Codec<EditingSave<T, Target>>;
  readonly lookup: Codec<OperationLookup<EditingReceipt<T, Target>>>;
  readonly draft: Codec<EditingDraft<T, Target>>;
};

/** Owned by the shared binding lifetime; subject is always the actual actor. */
export interface EditingBindingOptions<T, Target> {
  readonly resourceKey: string;
  readonly target: Target; readonly targetCodec: Codec<Target>;
  readonly client: import('./client.js').IdentityClient;
  readonly view: import('./client.js').IdentityView;
  create(input: { readonly session: Extract<ServerSession, { status: 'ready' }>;
    readonly subject: import('./model.js').ActorReference; readonly ownerSession: OwnerSessionId }): EditingState<T, Target>;
  readonly onUnpersistedDraft?: (draft: EditingDraft<T, Target>, error: IdentityError) => void;
}
export interface IdentityEditingBinding<T, Target> extends Disposable {
  getSnapshot(): EditingSnapshot<T, Target> | { readonly status: 'waiting-for-identity' };
  subscribe(listener: () => void): Unsubscribe;
  currentOwnerSession(): OwnerSessionId | null;
  edit(value: T): Result<void>;
  flush(): Promise<Result<void>>;
  reconnect(owner: OwnerSessionId): Promise<Result<void>>;
  checkpoint(owner: OwnerSessionId): Promise<Result<EditingCheckpoint<T, Target> | null>>;
  recoveryCandidates(owner: OwnerSessionId, options?: ReadOptions): Promise<Result<readonly EditingCheckpoint<T, Target>[]>>;
  recover(owner: OwnerSessionId, checkpoint: EditingCheckpoint<T, Target>): Promise<Result<void>>;
  discardRecovery(owner: OwnerSessionId, checkpoint: EditingCheckpoint<T, Target>): Promise<Result<void>>;
  resolveConflict(owner: OwnerSessionId, token: ConflictToken, decision: ConflictDecision<T>): Promise<Result<void>>;
}
export declare function bindIdentityEditingState<T, Target>(options: EditingBindingOptions<T, Target>): IdentityEditingBinding<T, Target>;
export declare const EDITING_LIMITS: { readonly bytes: number; readonly diagnostics: number; readonly message: number; readonly code: number; readonly path: number };
