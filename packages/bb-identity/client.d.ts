/** Headless client, view transitions, and reusable state/view lifecycle binding. */
import type { Codec, Directory, Disposable, IdentityError, IdentityKey, Json, OwnerSessionId, Revision,
  ActorReference, ParticipantReader, PersonReference, ReadOptions, Result, Scheduler, TargetSelection, Unsubscribe } from './model.js';
import type { ServerSession } from './host.js';
import type { IdentityState, PendingDraft, SyncSnapshot, DraftCheckpoint, ConflictDecision,
  StateResource, StateTransport, DraftStorage, ConflictContext } from './state.js';
/** Ready snapshots expose instance, actor and session stamp together. */
export type IdentitySession = ServerSession | { readonly status: 'loading' } | { readonly status: 'disposed' };
export type ClientInvalidation =
  | { readonly kind: 'session'; readonly reason?: 'actor' | 'provider' | 'capabilities' }
  /** `revision: null` means clear all directory/search cache; it is never a synthetic ordering token. */
  | { readonly kind: 'directory'; readonly keys: readonly IdentityKey[]; readonly revision: Revision | null }
  | { readonly kind: 'participants'; readonly threadIds: readonly string[] }
  | { readonly kind: 'disconnected' | 'reconnected' };
export declare const clientInvalidationCodec: Codec<ClientInvalidation>;
export type ConnectionLinkHealth =
  | { readonly status: 'connecting' | 'healthy' | 'reconnecting' }
  | { readonly status: 'unavailable'; readonly error: IdentityError };
/** Identity and resource paths share one owner but fail/recover independently. */
export interface ConnectionHealth {
  readonly generation: number;
  readonly identity: ConnectionLinkHealth;
  readonly state: ConnectionLinkHealth;
}
export type IdentityConnectionEvent = ClientInvalidation | { readonly kind: 'state'; readonly event: import('./state.js').StateInvalidation };
/** One root owns this connection. Identity and all StateResource transports borrow it. */
export interface IdentityConnection extends Disposable {
  getHealth(): ConnectionHealth;
  subscribeHealth(listener: () => void): Unsubscribe;
  /** Package route name; callers cannot send a client-supplied actor or plugin identity. */
  request(method: string, input: Json, options?: ReadOptions): Promise<unknown>;
  subscribe(listener: (event: IdentityConnectionEvent) => void): Unsubscribe;
  /** Re-establishes route reachability and verifies authoritative identity freshness.
   * It does not reload unknown StateResources; their controllers reload/reconcile separately. */
  revalidate(options?: ReadOptions): Promise<Result<void>>;
}
export interface IdentityClientTransport {
  bootstrap(options?: ReadOptions): Promise<Result<ServerSession>>;
  selfProfile(options?: ReadOptions): Promise<Result<import('./model.js').IdentityProfile>>;
  readonly directory: Directory; readonly participants: ParticipantReader;
  subscribe(listener: (event: ClientInvalidation) => void): Unsubscribe;
}
/** Caller owns this instance; injected providers/views borrow it. start/dispose are idempotent. */
export interface IdentityClient extends Disposable {
  readonly connection: IdentityConnection;
  getSnapshot(): IdentitySession;
  /** Safe live accessor for controller dispatch. Loading/disposed return errors; never last-ready authority. */
  currentSession(): Result<ServerSession>;
  subscribe(listener: () => void): Unsubscribe;
  start(): Promise<Result<void>>;
  refresh(options?: ReadOptions): Promise<Result<void>>;
  /** Request-aware resolver/session presentation, including resolver-only providers. */
  selfProfile(options?: ReadOptions): Promise<Result<import('./model.js').IdentityProfile>>;
  readonly directory: Directory; readonly participants: ParticipantReader;
}
/** Defaults: 512 profiles, 60s stale time, 64 keys/batch, 4 concurrent reads.
 * Snapshot identity is stable until change; shared reads have independent cancellation per waiter.
 * The last observer releases its subscription. Refresh/reconnect fences older bootstrap completions.
 */
export declare function createIdentityClient(options: {
  readonly connection: IdentityConnection; readonly scheduler?: Scheduler;
  readonly profileCache?: { readonly maxEntries: number; readonly staleAfterMs: number };
}): IdentityClient;
export type ViewSnapshot =
  | { readonly status: 'ready'; readonly session: Extract<ServerSession, { status: 'ready' }>;
      readonly subject: ActorReference; readonly overriding: boolean; readonly viewGeneration: number }
  | { readonly status: 'loading' }
  | { readonly status: 'blocked'; readonly session: IdentitySession; readonly requestedSubject: IdentityKey | null;
      readonly lastReady: Extract<ViewSnapshot, { status: 'ready' }> | null; readonly error: IdentityError };
export type PendingEditPolicy = 'block' | 'flush' | 'preserve' | 'discard';
export interface ViewTransition {
  readonly id: string; readonly from: ViewSnapshot; readonly selection: TargetSelection;
  readonly pending: PendingEditPolicy; readonly signal: AbortSignal;
}
/** Phase 1 is non-destructive. No guard may discard/change ownership before every guard approves. */
export interface PreparedViewTransition {
  /** May flush/persist. Failure cancels the selection; already accepted writes are not rolled back. */
  prepare(): Promise<Result<void>>;
  /** Synchronous, non-failing finalization only after all preparation and freshness checks pass. */
  commit(): void;
  cancel(): void;
}
export interface ViewTransitionGuard {
  inspect(transition: ViewTransition): Result<PreparedViewTransition>;
  /** Mandatory invalidation immediately stops stale writes. It cannot be blocked by voluntary guards. */
  invalidate(reason: 'actor' | 'session' | 'disconnected' | 'disposed'): void;
}
export interface IdentityView extends Disposable {
  getSnapshot(): ViewSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  select(selection: TargetSelection, options?: { readonly pendingEdits?: PendingEditPolicy }): Promise<Result<void>>;
  reset(options?: { readonly pendingEdits?: PendingEditPolicy }): Promise<Result<void>>;
  registerGuard(guard: ViewTransitionGuard): Unsubscribe;
}
/** Borrows client. Owns guards/subscriptions only. New transitions cancel superseded work.
 * Ready singleton: subject=actor; self/reset idempotent; selecting another target returns unsupported.
 */
export declare function createIdentityView(options: {
  readonly client: IdentityClient; readonly initialSelection?: TargetSelection;
  readonly pendingEdits?: PendingEditPolicy;
}): IdentityView;
export interface IdentityStateBinding<T> extends Disposable {
  getSnapshot(): SyncSnapshot<T> | { readonly status: 'waiting-for-identity' };
  subscribe(listener: () => void): Unsubscribe;
  edit(value: T): Result<void>;
  flush(): Promise<Result<void>>;
  /** Token is the current controller incarnation, including while blocked; null before creation.
   * Recovery/conflict commands check it before work AND after awaits, returning stale-context on change.
   */
  currentOwnerSession(): OwnerSessionId | null;
  /** Revalidates this exact writable controller incarnation, then runs its
   * bounded reconciliation. The owner token is checked before revalidation,
   * before controller work, and after it settles; a changed view/session
   * returns stale-context rather than recovering a replacement controller. */
  reconnect(expected: OwnerSessionId): Promise<Result<void>>;
  recoveryCandidates(expected: OwnerSessionId, options?: ReadOptions): Promise<Result<readonly DraftCheckpoint<T>[]>>;
  checkpoint(expected: OwnerSessionId): Promise<Result<DraftCheckpoint<T> | null>>;
  recover(expected: OwnerSessionId, checkpoint: DraftCheckpoint<T>): Promise<Result<void>>;
  /** Explicitly forget one exact checkpoint from the current actor/resource
   * recovery list. Revision-conditional removal preserves newer drafts. */
  discardRecovery(expected: OwnerSessionId, checkpoint: DraftCheckpoint<T>): Promise<Result<void>>;
  resolveConflict(expected: OwnerSessionId, token: import('./model.js').ConflictToken, decision: ConflictDecision<T>): Promise<Result<void>>;
}
export type StateBindingSource<T> =
  | { create(input: { readonly session: Extract<ServerSession, { status: 'ready' }>;
        readonly subject: ActorReference; readonly ownerSession: OwnerSessionId }): IdentityState<T>;
      readonly resource?: never }
  | { readonly create?: never; readonly resource: StateResource<T>; readonly recordId: string;
      /** Omit for preferences whose unsaved edits are deliberately in-session only. */
      readonly drafts?: DraftStorage<T>;
      readonly onConflict: (context: ConflictContext<T>) => ConflictDecision<T>;
      readonly initializeEmpty: boolean; readonly scheduler?: Scheduler };
/** Owns controllers and transition guards; borrows view/client. Handles invalidation and reconnect centrally. */
export interface IdentityStateBindingOptions<T> {
  readonly client: IdentityClient; readonly view: IdentityView;
  readonly target: 'actor' | 'viewed-subject';
  readonly editPolicy: 'actor-only' | 'collaborators';
  /** Called only when this binding opted into durable draft preservation. */
  readonly onUnpersistedDraft?: (draft: PendingDraft<T>, error: IdentityError) => void;
}
export declare function bindIdentityState<T>(options: IdentityStateBindingOptions<T> & StateBindingSource<T>): IdentityStateBinding<T>;

export type DirectorySearchSnapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly page: import('./model.js').Page<import('./model.js').IdentityProfile> }
  | { readonly status: 'error'; readonly error: IdentityError };
export interface DirectorySearch extends Disposable {
  getSnapshot(): DirectorySearchSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  search(query: import('./model.js').DirectoryQuery): Promise<Result<void>>;
  next(): Promise<Result<void>>;
}
/** Reusable for filters/recipients; does not select a viewed identity. */
export declare function createDirectorySearch(client: IdentityClient): DirectorySearch;

/** Raw network seam for decoder tests and non-React integrations. Never accepts client-supplied actor authority. */
/** Explicit low-level inputs for tests and non-React native roots. Health controls all borrowed state transports. */
export interface IdentityConnectionInputs {
  readonly request: IdentityConnection['request'];
  readonly subscribe: (listener: (payload: unknown) => void) => Unsubscribe;
  readonly getHealth: () => ConnectionHealth;
  readonly subscribeHealth: (listener: () => void) => Unsubscribe;
  readonly revalidate: (options?: ReadOptions) => Promise<Result<void>>;
  readonly dispose?: () => void;
}
export declare function createIdentityConnection(inputs: IdentityConnectionInputs): IdentityConnection;
/** Owns runtime decoding of all identity responses and invalidations; malformed != empty/default-user. */
export declare function createIdentityClientTransport(connection: IdentityConnection): IdentityClientTransport;
/** Explicit independent-root fallback. It uses ordinary request/response routes, not a retained poll feed.
 * endpoint is the owning plugin's HTTP base URL; fetch and root signal are caller-owned inputs.
 */
export declare function createIdentityFetchConnection(options: {
  readonly endpoint: URL; readonly fetch: typeof globalThis.fetch; readonly signal: AbortSignal;
  readonly scheduler?: Scheduler;
}): IdentityConnection;
