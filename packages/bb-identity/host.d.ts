/** Integration ports. Raw fork protocol is structural and independent of package brands. */
import type { AcceptanceOutcome, ActorReference, ActorSnapshot, Codec, Contribution, ContributionReference,
  Directory, Disposable, ExecutionProvenance, IdentityError, IdentityProfile, InstanceId, OperationLookup,
  ParticipantReader, PersonReference, PluginId, ProfilePresentation, ProviderGeneration, IssuerId, ReadOptions, RequestExpectation,
  Result, Scheduler, SendInput, SessionStamp, Unsubscribe, Wire } from './model.js';

declare const requestLease: unique symbol;
export interface IdentityCapabilities {
  readonly requestIdentity: 'singleton' | 'host-resolved';
  readonly acceptance: 'pre-dispatch-check' | 'transactional-check';
  readonly forwarding: 'singleton-convention' | 'host-bound';
  readonly directory: { readonly search: boolean; readonly lookup: boolean };
  readonly participants: boolean;
  readonly externalSend: 'source-labelled' | 'structured';
  readonly toolProvenance: 'unknown' | 'partial' | 'causal';
  readonly operationLookup: boolean;
}
/** Wire DTO; loading/disposed are local client states, not server session responses. */
export type ServerSession =
  | { readonly status: 'ready'; readonly instanceId: InstanceId; readonly mode: 'single-user' | 'multi-user';
      readonly actor: ActorSnapshot & { readonly identity: ActorReference };
      readonly stamp: SessionStamp; readonly capabilities: IdentityCapabilities }
  | { readonly status: 'unauthenticated' | 'unavailable' | 'incompatible'; readonly instanceId: InstanceId; readonly error: IdentityError };
export declare const serverSessionCodec: Codec<ServerSession>;
/** Same-process, synchronous validation only; callers must not span an await or process boundary. */
export interface LiveRequest {
  readonly [requestLease]: true;
  readonly signal: AbortSignal;
  readonly session: Extract<ServerSession, { status: 'ready' }>;
  validate(expected: RequestExpectation): Result<void>;
  /** Releases this adapter-owned scope only; never the shared host service. */
  release(): void;
}
export type HostInvalidation =
  | { readonly kind: 'session'; readonly reason: 'actor' | 'provider' | 'capabilities' }
  | { readonly kind: 'directory'; readonly keys: readonly string[] }
  | { readonly kind: 'participants'; readonly threadIds: readonly string[] }
  | { readonly kind: 'disconnected' | 'reconnected' | 'disposed' };
export interface ExternalAuthorInput { readonly subject: string; readonly presentation: ProfilePresentation; }
export interface IdentityHost<RequestContext, ToolContext, Input> extends Disposable {
  readonly pluginId: PluginId;
  readonly instanceId: InstanceId;
  session(context: RequestContext, options?: ReadOptions): Promise<ServerSession>;
  /** Resolves the request's current actor from its live session; directory capability is not required. */
  selfProfile(context: RequestContext, options?: ReadOptions): Promise<Result<IdentityProfile>>;
  openPersonRequest(context: RequestContext, options?: ReadOptions): Promise<Result<LiveRequest>>;
  readToolProvenance(context: ToolContext): Promise<Result<ExecutionProvenance>>;
  readonly directory: Directory;
  readonly participants: ParticipantReader;
  readonly history: import('./model.js').ProvenanceReader;
  /** Checks synchronously before upstream dispatch; enhanced host checks again inside acceptance. */
  send(request: LiveRequest, input: SendInput<Input>, options?: ReadOptions): Promise<AcceptanceOutcome>;
  sendExternal(author: ExternalAuthorInput, input: SendInput<Input>, options?: ReadOptions): Promise<AcceptanceOutcome>;
  lookupOperation(operationId: SendInput<Input>['operationId'], options?: ReadOptions): Promise<Result<OperationLookup<AcceptanceOutcome>>>;
  forward(request: LiveRequest, destinationPlugin: string, method: string, input: import('./model.js').Json): Promise<unknown>;
  registerProvider(provider: IdentityProvider): Promise<Result<ProviderRegistrationV1>>;
  subscribe(listener: (event: HostInvalidation) => void): Unsubscribe;
}
/** Upstream driver is implemented by /bb, not by each feature. Host namespaces use reserved local storage scope. */
export interface UpstreamDriver<RequestContext, ToolContext, Input> {
  readonly instanceId: InstanceId;
  readonly pluginId: PluginId;
  readonly inputCodec: Codec<Input>;
  readonly scheduler: Scheduler;
  session(context: RequestContext): Promise<ServerSession>;
  selfProfile(context: RequestContext, options?: ReadOptions): Promise<Result<IdentityProfile>>;
  openScope(context: RequestContext): Promise<Result<HostRequestHandle>>;
  /** Native response only; driver cannot promise request lifecycle checks inside upstream's transaction. */
  submit(input: SendInput<Input>, options?: ReadOptions): Promise<AcceptanceOutcome>;
  labelExternal(author: ExternalAuthorInput, input: readonly Input[]): readonly Input[];
  toolCorrelation(context: ToolContext): ExecutionProvenance;
  /** Ordinary SDK RPC; validates locally before dispatch, without original-request propagation. */
  forward(context: RequestContext, destinationPlugin: string, method: string,
    input: import('./model.js').Json, options?: ReadOptions): Promise<unknown>;
  subscribe(listener: (event: HostInvalidation) => void): Unsubscribe;
}

/** Host-owned, structural in-process object. Not JSON, not a package-private symbol or public credential. */
export interface HostRequestHandle {
  readonly signal: AbortSignal;
  readonly session: Wire<Extract<ServerSession, { status: 'ready' }>>;
  validate(expected: Wire<RequestExpectation>): Wire<Result<void>>;
  release(): void;
}
/** Core dispatch classes; route selection does not select a person actor. */
export type ForkInvocationRouteClass =
  | 'interactive-session' | 'external-credential' | 'anonymous'
  | 'plugin-background' | 'agent-tool' | 'local-cli';
/** Fresh per invocation. It is not a provider/plugin generation registration or auth lease. */
export interface ForkInvocationScope {
  readonly signal: AbortSignal;
  validate(): { readonly ok: true } | { readonly ok: false; readonly code: 'retired' | 'invalidated' };
  release(): void;
}
/** Enhanced open-request result. Core returns the request-scoped lifecycle signal for this request/session. */
export interface ForkRequestHandle extends HostRequestHandle {
  readonly scope: ForkInvocationScope;
}
/** Opaque dispatcher context; only the registered returned handler receives it. */
export interface ForkInvocationContext<RequestContext> {
  readonly request: RequestContext; readonly scope: ForkInvocationScope;
}
/** Generation-bound dispatch binding. Disposal is exact-generation conditional. */
export interface ForkInvocationRegistration extends Disposable {
  readonly generation: string; readonly status: 'staged' | 'active' | 'retired';
}
/** One acceptance entry point prevents external work from masquerading as a person scope. */
export type ForkAcceptanceRequest<Input> = {
  readonly source:
    | { readonly kind: 'scope'; readonly scope: ForkInvocationScope }
    | { readonly kind: 'external'; readonly author: ExternalAuthorInput };
  readonly input: Wire<SendInput<Input>>;
};
/** Core-owned in-process registration result. It deliberately has no package brands.
 * The adapter normalizes this to ProviderRegistrationV1 before exposing it to provider authors.
 */
export interface ForkProviderRegistration extends Disposable {
  readonly generation: string;
  readonly configuration: Readonly<ProviderBoundaryConfigurationV1>;
  getStatus(): 'staged' | 'active' | 'retired';
  readonly signal: AbortSignal;
  subscribe(listener: (status: 'staged' | 'active' | 'retired') => void): Unsubscribe;
  invalidate(change: { readonly kind: 'authentication'; readonly subjects?: readonly { readonly issuer: string; readonly subject: string }[] }
    | { readonly kind: 'directory'; readonly revision: string }): Result<void>;
  /** Successful values use plain strings at the core boundary; adapter brands only after validation. */
  person(issuer: string, subject: string): Wire<Result<PersonReference>>;
}
/** Core-facing provider input. It intentionally has no package-private generation brand. */
export interface ForkIdentityProvider {
  readonly issuers: readonly string[];
  readonly validateReadiness?: (input: { readonly generation: string;
    readonly configuration: Readonly<ProviderBoundaryConfigurationV1>;
    readonly deadlineAt: number; readonly signal: AbortSignal }) => Promise<Wire<Result<void>>>;
  resolve(evidence: ProviderEvidenceV1): Promise<Wire<
    | { readonly status: 'resolved'; readonly issuer: string; readonly subject: string; readonly presentation: ProfilePresentation }
    | { readonly status: 'not-applicable' }
    | { readonly status: 'rejected' | 'unavailable'; readonly reason: string }
  >>;
  directory?(input: { readonly query: string; readonly cursor?: string; readonly limit: number;
    readonly history: 'current' | 'include-historical' }, options?: ReadOptions): Promise<Wire<Result<{
      readonly records: readonly ProviderDirectoryRecord[]; readonly nextCursor: string | null; readonly revision: string;
    }>>>;
  lookup?(subjects: readonly { readonly issuer: string; readonly subject: string }[], options?: ReadOptions): Promise<Wire<Result<{
    readonly revision: string; readonly records: readonly {
      readonly issuer: string; readonly subject: string; readonly record: ProviderDirectoryRecord | null;
    }[];
  }>>>;
}
/** Core implements these host-owned operations, not IdentityHost's fallback/directory composition. */
export interface ForkIdentityProtocolV1<RequestContext, ToolContext, Input> {
  readonly version: 1;
  /** Persisted core storage namespace; stable across plugin replacement and never request-derived. */
  readonly instanceId: string;
  /** Enables this plugin generation's producer-owned external message rendering in the SDK host. */
  experimental_useProducerMessageRendering?(): void;
  /** /bb installs exactly the returned handler through native RPC/HTTP registration after schema
   * validation. Core supplies the request-scoped context and its lifecycle signal out of band.
   */
  bindInvocation<Args extends readonly unknown[], Output>(
    input: { readonly routeClass: ForkInvocationRouteClass;
      readonly handler: (context: ForkInvocationContext<RequestContext>, ...args: Args) => Output }
  ): { readonly registration: ForkInvocationRegistration; readonly handler: (...args: Args) => Output };
  session(context: RequestContext): Promise<Wire<ServerSession>>;
  selfProfile(context: RequestContext, options?: ReadOptions): Promise<Wire<Result<IdentityProfile>>>;
  openRequest(context: RequestContext): Promise<Result<ForkRequestHandle>>;
  /** Checks source scope/live request during durable acceptance; retained receipts remain queryable after the request ends. */
  accept(input: ForkAcceptanceRequest<Input>, options?: ReadOptions): Promise<Wire<AcceptanceOutcome>>;
  lookup(operationId: string, options?: ReadOptions): Promise<Wire<Result<OperationLookup<AcceptanceOutcome>>>>;
  provenance(context: ToolContext): Promise<Wire<Result<ExecutionProvenance>>>;
  historyContributions(query: Wire<import('./model.js').ContributionQuery>, options?: ReadOptions): Promise<Wire<Result<import('./model.js').EvidencePage<Contribution>>>>;
  historyAttempts(query: Wire<import('./model.js').AttemptQuery>, options?: ReadOptions): Promise<Wire<Result<import('./model.js').EvidencePage<ExecutionProvenance>>>>;
  /** Borrowed provider callbacks; package composes/searches/normalizes them with default/external profiles. */
  directorySources(): readonly ProviderDirectorySource[];
  participants(input: Wire<import('./model.js').ParticipantQuery>, options?: ReadOptions): Promise<Wire<Awaited<ReturnType<ParticipantReader['list']>>>>;
  /** RPC-only forwarding fences the original scope and destination generation before and after work. */
  forwardRpc(scope: ForkInvocationScope, destination: { readonly pluginId: string; readonly method: string },
    input: import('./model.js').Json): Promise<unknown>;
  registerProvider(provider: ForkIdentityProvider): Promise<Result<ForkProviderRegistration>>;
  subscribe(listener: (event: HostInvalidation) => void): Unsubscribe;
}
export type ExtensionDiscovery<R, T, I> =
  | { readonly status: 'absent' }
  | { readonly status: 'supported'; readonly protocol: ForkIdentityProtocolV1<R, T, I> }
  | { readonly status: 'unsupported-version'; readonly version: number }
  | { readonly status: 'malformed'; readonly error: IdentityError };
/** The only optional fork discovery member. It is read from a trusted SDK host object, never browser data. */
export interface ForkIdentityExtensionSurface { readonly experimental_p6rIdentity?: unknown; }
/** Runs against trusted experimental_p6rIdentity property value, never a browser payload. */
export declare function inspectForkExtension<R, T, I>(value: unknown): ExtensionDiscovery<R, T, I>;
export declare function createHostAdapter<R, T, I>(options: {
  readonly upstream: UpstreamDriver<R, T, I>;
  readonly extension: ExtensionDiscovery<R, T, I>;
  readonly directory?: Directory;
}): IdentityHost<R, T, I>;

/** Operator-owned selection; supplied by host configuration, never by request payload or provider.
 * Credential names are allowlisted here; providers receive only this boundary's selected evidence.
 */
export interface ProviderBoundaryConfigurationV1 {
  readonly version: 1; readonly boundaryId: string; readonly pluginId: string;
  readonly ingressIds: readonly string[];
  readonly credentials: readonly { readonly name: string; readonly source: 'header' | 'cookie'; readonly field: string }[];
  readonly resolver: { readonly timeoutMs: number };
}
/** In-process envelope: credentials await provider verification, transport facts are host-established.
 * Never log/persist credentials in profiles, bootstrap, provenance, or generic event payloads.
 */
export interface ProviderEvidenceV1 {
  readonly version: 1; readonly configuration: ProviderBoundaryConfigurationV1;
  readonly request: { readonly authority: string; readonly method: string; readonly pathname: string;
    readonly transport: 'http' | 'websocket'; readonly receivedAt: number };
  readonly ingress: { readonly id: string | null; readonly kind: 'owned-proxy' | 'local' | 'unverified';
    readonly authenticatedPeer: string | null };
  readonly credentials: readonly { readonly name: string; readonly value: string }[];
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}
export interface ProviderDirectoryRecord {
  readonly issuer: string; readonly subject: string; readonly presentation: ProfilePresentation;
  readonly status: 'current' | 'historical';
}
export interface IdentityProvider {
  readonly issuers: readonly IssuerId[];
  /** Optional provider-local readiness. Host structural/configuration checks are mandatory.
   * It receives no request evidence or credentials and cannot resolve an actor.
   */
  readonly validateReadiness?: (input: { readonly generation: ProviderGeneration;
    readonly configuration: Readonly<ProviderBoundaryConfigurationV1>;
    readonly deadlineAt: number; readonly signal: AbortSignal }) => Promise<Result<void>>;
  resolve(evidence: ProviderEvidenceV1): Promise<
    | { readonly status: 'resolved'; readonly issuer: string; readonly subject: string; readonly presentation: ProfilePresentation }
    | { readonly status: 'not-applicable' }
    | { readonly status: 'rejected' | 'unavailable'; readonly reason: string }
  >;
  /** Issuer/subject records are normalized into keys by the package; providers do not invent codecs. */
  directory?(input: { readonly query: string; readonly cursor?: string; readonly limit: number; readonly history: 'current' | 'include-historical' }, options?: ReadOptions): Promise<Result<{
    readonly records: readonly ProviderDirectoryRecord[]; readonly nextCursor: string | null; readonly revision: string;
  }>>;
  /** Revisions/cursors belong to a provider generation and directory snapshot. Stale cursors fail
   * explicitly; outages are errors, never empty/missing. Reject undeclared issuer records.
   */
  lookup?(subjects: readonly { readonly issuer: string; readonly subject: string }[], options?: ReadOptions): Promise<Result<{
    readonly revision: string; readonly records: readonly {
    readonly issuer: string; readonly subject: string; readonly record: ProviderDirectoryRecord | null;
  }[] }>>;
}
export interface ProviderDirectorySource {
  readonly issuers: readonly string[];
  readonly generation: string;
  readonly directory?: NonNullable<IdentityProvider['directory']>;
  readonly lookup?: NonNullable<IdentityProvider['lookup']>;
  person(issuer: string, subject: string): Wire<Result<PersonReference>>;
}
/** Atomic activation belongs to the enhanced host; failure retains old generation, sockets reauthenticate.
 * Disposal is generation-scoped. Provider removal yields unavailable, never absent-capability singleton mode.
 */
/** Package-normalized registration; request lifecycle remains separate from provider state. */
export interface ProviderRegistrationV1 extends Disposable {
  readonly generation: ProviderGeneration;
  /** Registration during factory execution stages a candidate, it does not wait for activation.
   * Host commits replacement only after plugin activation succeeds; failed candidates are cleaned up
   * while prior provider resources remain live. Stale disposal/invalidation cannot affect a successor.
   */
  getStatus(): 'staged' | 'active' | 'retired';
  /** Read-only non-secret configuration captured for this generation's readiness validation. */
  readonly configuration: Readonly<ProviderBoundaryConfigurationV1>;
  readonly signal: AbortSignal;
  subscribe(listener: (status: 'staged' | 'active' | 'retired') => void): Unsubscribe;
  /** Authentication invalidation updates provider enrichment; it does not by itself block ordinary work.
   * Directory changes do not alone change actors.
   */
  invalidate(change: { readonly kind: 'authentication'; readonly subjects?: readonly { readonly issuer: string; readonly subject: string }[] }
    | { readonly kind: 'directory'; readonly revision: string }): Result<void>;
  person(issuer: IssuerId, subject: string): Result<PersonReference>;
  /** Removes only this generation's registration when it is still current; never retires the plugin generation. */
  dispose(): void;
}
