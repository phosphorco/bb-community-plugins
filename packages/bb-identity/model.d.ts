/** Shared serializable vocabulary. No React, BB SDK, storage, or provider imports. */
declare const identityKey: unique symbol;
declare const opaqueId: unique symbol;
export type IdentityKey = string & { readonly [identityKey]: true };
export type Id<Kind extends string> = string & { readonly [opaqueId]: Kind };
export type InstanceId = Id<'instance'>;
export type PluginId = Id<'plugin'>;
export type ThreadId = Id<'thread'>;
export type ContributionId = Id<'contribution'>;
export type OperationId = Id<'operation'>;
export type Revision = Id<'revision'>;
export type Cursor = Id<'cursor'>;
export type OwnerSessionId = Id<'owner-session'>;
/** Identifies one reviewed divergence within an owner-controller incarnation. */
export type ConflictToken = Id<'conflict'>;
/** Host-issued opaque provider generation; it is not activation authority. */
export type ProviderGeneration = Id<'provider-generation'>;
/** Issuers are stable provider identifiers; canonical identity construction remains host-owned. */
export type IssuerId = string;
export type SessionStamp = Id<'server-session'>;
/** Freshness assertion only; not a credential. Rotates on actor/provider discontinuity, including A→B→A. */
export interface RequestExpectation { readonly actor: IdentityKey; readonly session: SessionStamp; }
export type TargetSelection = { readonly kind: 'self' } | { readonly kind: 'person'; readonly key: IdentityKey };
/** Injected by bindings/tests; no hidden clock in timed primitives. */
export interface Scheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): Unsubscribe;
}
/** Serializable counterpart for a structural host protocol; preserves literal discriminants. */
export type Wire<T> = T extends IdentityKey | Id<string> ? string
  : T extends readonly (infer V)[] ? readonly Wire<V>[]
  : T extends object ? { readonly [K in keyof T]: Wire<T[K]> } : T;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Unsubscribe = () => void;
export interface Disposable { dispose(): void; }
export interface ReadOptions { readonly signal?: AbortSignal; }

/** Expected failures are values. Implementations may still throw programmer errors. */
export interface IdentityError {
  readonly code: 'unavailable' | 'unauthenticated' | 'unsupported' | 'incompatible'
    | 'invalid-input' | 'not-found' | 'ambiguous' | 'stale-owner' | 'stale-context'
    | 'conflict' | 'cancelled' | 'disposed' | 'limit-exceeded' | 'invalid-operation' | 'expired';
  readonly message: string;
  readonly retry: 'never' | 'after-refresh' | 'after-reconnect' | 'same-operation';
}
export type Result<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IdentityError };

/** Codecs validate bounds/canonical form at runtime; casts are not validation. */
export interface Codec<T> {
  decode(input: unknown): Result<T>;
  encode(value: T): Json;
}
/** Validates a bounded ID at an SDK/wire boundary; IDs are never authority tokens. */
export declare function idCodec<Kind extends string>(kind: Kind): Codec<Id<Kind>>;
export declare function newOperationId(): OperationId;
export declare const identityKeyCodec: Codec<IdentityKey>;
export declare const profileCodec: Codec<IdentityProfile>;
export declare const provenanceCodec: Codec<ExecutionProvenance>;
/** Singleton belongs to host state, not the browser or package installation. */
export declare function defaultIdentityKey(instance: InstanceId): IdentityKey;

export interface ProfilePresentation {
  readonly displayName: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
}
export type IdentityReference =
  | { readonly kind: 'person'; readonly key: IdentityKey; readonly issuer: string; readonly subject: string }
  | { readonly kind: 'default-user'; readonly key: IdentityKey; readonly instanceId: InstanceId }
  | { readonly kind: 'machine'; readonly key: IdentityKey; readonly instanceId: InstanceId; readonly hostId: string | null }
  | { readonly kind: 'external'; readonly key: IdentityKey; readonly pluginId: PluginId; readonly subject: string };
/** Human/default identities remain valid person selections; machine actors are separate. */
export type PersonReference = Extract<IdentityReference, { kind: 'person' | 'default-user' }>;
/** An actor that can own a request or self-scoped state, including machine fallback. */
export type ActorReference = PersonReference | Extract<IdentityReference, { kind: 'machine' }>;
export type MachineReference = Extract<IdentityReference, { kind: 'machine' }>;
export interface IdentityProfile {
  readonly identity: IdentityReference;
  readonly presentation: ProfilePresentation;
  readonly revision: Revision;
  readonly status: 'current' | 'historical';
}
export interface ActorSnapshot {
  readonly identity: IdentityReference;
  readonly presentation: ProfilePresentation;
  /** Historical evidence, never permission to perform a later action. */
  readonly evidence: 'provider-verified' | 'local-user' | 'upstream-default' | 'integration-asserted' | 'legacy' | 'machine';
}
export type Origin =
  | { readonly kind: 'person'; readonly actor: ActorSnapshot & { readonly identity: PersonReference } }
  | { readonly kind: 'machine'; readonly actor: ActorSnapshot & { readonly identity: MachineReference } }
  | { readonly kind: 'external'; readonly actor: ActorSnapshot & { readonly identity: Extract<IdentityReference, { kind: 'external' }> } }
  | { readonly kind: 'agent'; readonly agentId: string | null }
  | { readonly kind: 'system'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: 'legacy' | 'upstream-unattributed' | 'missing-source' };
export interface ContributionReference {
  readonly threadId: ThreadId;
  readonly contributionId: ContributionId;
}
/** A contribution is independent of delivery grouping and execution attempts. */
export interface Contribution {
  readonly reference: ContributionReference;
  readonly author: Origin;
  readonly latestEditor: ActorSnapshot | null;
  readonly acceptedAt: string;
  readonly mentionedPeople: readonly PersonReference[];
}
export type AttemptInputSource =
  | { readonly kind: 'contribution'; readonly reference: ContributionReference }
  | { readonly kind: 'interaction'; readonly interactionId: string; readonly resolver: Origin }
  | { readonly kind: 'generated'; readonly purpose: 'continuation' | 'resolved-resource' | 'system-context';
      readonly basedOn: readonly ContributionReference[] };
/** Ordered delivery groups; an individual group can contain multiple original/generated sources. */
export interface AttemptInputGroup { readonly sources: readonly AttemptInputSource[]; }
export interface ExecutionCorrelation {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly attemptId: string;
  readonly toolCallId: string | null;
}
/** Native identifiers are opaque; lookup never guesses from text or the latest author. */
export type ContributionQuery = (
  | { readonly kind: 'references'; readonly references: readonly ContributionReference[] }
  | { readonly kind: 'native-message'; readonly threadId: ThreadId; readonly messageId: string }
  | { readonly kind: 'native-event'; readonly threadId: ThreadId; readonly eventId: string }
) & {
  /** Cursor is bound to this exact query and retained-history snapshot. */
  readonly cursor?: Cursor;
  readonly limit?: number;
};
export type EvidencePage<T> =
  | { readonly status: 'known' | 'partial'; readonly items: readonly T[]; readonly nextCursor: Cursor | null;
      /** Traversal completeness is distinct from known/partial evidence. */
      readonly traversal: 'complete' | 'continued'; readonly missing: readonly string[] }
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable'; readonly reason: 'unsupported' | 'missing-history' | 'outage' };
export type AttemptQuery = ({ readonly kind: 'operation'; readonly operationId: OperationId }
  | { readonly kind: 'contribution'; readonly reference: ContributionReference }) & {
    readonly cursor?: Cursor; readonly limit?: number;
  };
/** Bounded reads: 100 references, default 50/max 200 attempts. Known has no missing facts.
 * Each attempt preserves execution-time snapshots. A queued operation may be pending;
 * a known empty result is authoritative only within retained coverage, never inferred upstream.
 */
export interface ProvenanceReader {
  contributions(query: ContributionQuery, options?: ReadOptions): Promise<Result<EvidencePage<Contribution>>>;
  attempts(query: AttemptQuery, options?: ReadOptions): Promise<Result<EvidencePage<ExecutionProvenance>>>;
}
/** Snapshots are fixed when the attempt accepts input, unaffected by later edits.
 * Known: every referenced contribution appears exactly once in contributions, with no unresolved causal source.
 * Partial: missing references are explicit. Consumers never choose the first/latest author as a substitute.
 */
export type ExecutionProvenance =
  | { readonly status: 'known'; readonly correlation: ExecutionCorrelation;
      readonly inputGroups: readonly AttemptInputGroup[]; readonly contributions: readonly Contribution[] }
  | { readonly status: 'partial'; readonly correlation: ExecutionCorrelation | null;
      readonly inputGroups: readonly AttemptInputGroup[]; readonly contributions: readonly Contribution[];
      readonly missing: readonly ContributionReference[]; readonly reason: string }
  | { readonly status: 'unknown'; readonly correlation: ExecutionCorrelation | null; readonly reason: string };
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: Cursor | null;
  /** Cursors are bound to the same query and snapshot; a stale cursor errors. */
  readonly revision: Revision;
}
export interface PageRequest { readonly cursor?: Cursor; readonly limit: number; }
export interface DirectoryQuery extends PageRequest {
  readonly query: string; readonly kinds: readonly IdentityReference['kind'][];
  readonly history: 'current' | 'include-historical';
}
export interface ProfileQuery { readonly keys: readonly IdentityKey[]; }
export interface ParticipantQuery extends PageRequest { readonly threadId: ThreadId; }
export interface ParticipantPreviewQuery { readonly threadIds: readonly ThreadId[]; readonly perThreadLimit: number; }
export interface Directory {
  search(input: DirectoryQuery, options?: ReadOptions): Promise<Result<Page<IdentityProfile>>>;
  getMany(input: ProfileQuery, options?: ReadOptions): Promise<Result<readonly ProfileLookup[]>>;
  /** Invalidations, not an unbounded global roster broadcast. */
  subscribe(keys: readonly IdentityKey[], listener: (event: DirectoryInvalidation) => void): Unsubscribe;
}
export type ProfileLookup = { readonly key: IdentityKey; readonly status: 'found'; readonly profile: IdentityProfile }
  | { readonly key: IdentityKey; readonly status: 'missing' };
/** `null` is an explicit conservative reset when the producer has no authoritative directory revision. */
export interface DirectoryInvalidation { readonly keys: readonly IdentityKey[]; readonly revision: Revision | null; }
export interface Participant {
  readonly identity: IdentityReference;
  readonly presentation: ProfilePresentation;
  readonly roles: readonly ('author' | 'editor' | 'mentioned' | 'interaction-resolver')[];
}
/** Deduplicated people/external identities from retained visible durable history; aggregates roles.
 * Excludes queue-only drafts. Mentioned-only identities need no fabricated authorship evidence.
 */
export interface ParticipantReader {
  list(input: ParticipantQuery, options?: ReadOptions): Promise<Result<Page<Participant> & { readonly coverage: 'complete-history' | 'partial-history' }>>;
  /** Bounded preview per thread; hasMore prevents interpreting truncation as absence. */
  previews(input: ParticipantPreviewQuery, options?: ReadOptions): Promise<Result<readonly {
    readonly threadId: ThreadId; readonly participants: readonly Participant[]; readonly hasMore: boolean;
    readonly coverage: 'complete-history' | 'partial-history'; readonly revision: Revision;
  }[]>>;
}

export interface NativeSubmissionIds {
  readonly deliveryId: string | null; readonly queuedMessageId: string | null;
  readonly turnId: string | null;
}
export type AcceptanceReceipt =
  | { readonly evidence: 'host-accepted'; readonly operationId: OperationId; readonly acceptedAt: string;
      readonly references: readonly ContributionReference[]; readonly native: NativeSubmissionIds;
      readonly provenance: 'structured'; readonly deduplication: 'guaranteed'; readonly retainedUntil: string }
  | { readonly evidence: 'upstream-response'; readonly operationId: OperationId;
      readonly acceptedAt: null; readonly references: null; readonly native: NativeSubmissionIds;
      readonly provenance: 'source-labelled' | 'upstream-default'; readonly deduplication: 'not-guaranteed' };
/** Upstream successful submission does not fabricate exact native acceptance evidence. */
export type AcceptanceOutcome =
  | { readonly status: 'submitted'; readonly receipt: AcceptanceReceipt }
  | { readonly status: 'rejected'; readonly error: IdentityError }
  | { readonly status: 'indeterminate'; readonly operationId: OperationId; readonly message: string };
export type OperationLookup<Outcome> =
  | { readonly status: 'final'; readonly outcome: Outcome }
  | { readonly status: 'pending' }
  | { readonly status: 'absent-final'; readonly retry: 'same-operation-only' }
  | { readonly status: 'unknown'; readonly reason: 'unsupported' | 'expired' | 'unavailable' };
export interface SendInput<Input> {
  readonly operationId: OperationId;
  readonly threadId: ThreadId;
  readonly input: readonly Input[];
  /** `auto` steers active work and starts idle work; it is never normalized by this package. */
  readonly mode: 'auto' | 'start' | 'steer-if-active' | 'queue-if-active';
}
export interface PersonSendInput<Input> extends SendInput<Input> { readonly expected: RequestExpectation; }
