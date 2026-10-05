/** Request-bound server API; separate target intent, captured target facts, and live lifecycle validity. */
import type { AcceptanceOutcome, ActorReference, ActorSnapshot, Codec, Directory, Disposable, ExecutionProvenance,
  IdentityKey, InstanceId, OperationId, OperationLookup, ParticipantReader, PersonReference,
  PersonSendInput, ReadOptions, RequestExpectation, Result, SendInput, TargetSelection, Unsubscribe } from './model.js';
import type { ExternalAuthorInput, IdentityHost, IdentityCapabilities, ServerSession, HostInvalidation } from './host.js';

declare const resolvedTarget: unique symbol;
export interface TargetSnapshot {
  readonly actor: ActorSnapshot & { readonly identity: ActorReference };
  readonly subject: ActorReference;
  readonly expected: RequestExpectation;
}
export interface ResolvedTarget<Intent extends 'read' | 'write'> {
  readonly [resolvedTarget]: Intent;
  readonly intent: Intent;
  /** Reads frozen captured target facts for the commit checks. */
  snapshot(): TargetSnapshot;
  readonly signal: AbortSignal;
}
export interface CommitScope {
  readonly instanceId: InstanceId;
  readonly pluginId: import('./model.js').PluginId;
  readonly collection: string; readonly recordId: string;
  readonly subject: IdentityKey; readonly expected: RequestExpectation; readonly schemaVersion: number;
}
/** Validates write intent, captured actor/subject/session, address, namespace, and live lifecycle signal. */
export interface CommitValidator {
  readonly boundary: 'same-process-synchronous';
  validate(target: ResolvedTarget<'write'>, scope: CommitScope): Result<void>;
}
export type TargetPolicy = { readonly kind: 'self-only' } | { readonly kind: 'collaborators' };
export interface ReadTargetRequest {
  readonly selection: TargetSelection; readonly policy: TargetPolicy; readonly intent: 'read';
}
export interface WriteTargetRequest {
  readonly selection: TargetSelection; readonly policy: TargetPolicy; readonly intent: 'write';
  readonly expected: RequestExpectation; readonly expectedSubject: IdentityKey;
}
export type TargetRequest = ReadTargetRequest | WriteTargetRequest;
export interface PersonRequest<Input> extends Disposable {
  readonly actor: ActorSnapshot & { readonly identity: ActorReference };
  readonly expected: RequestExpectation;
  readonly capabilities: IdentityCapabilities;
  readonly signal: AbortSignal;
  target(input: ReadTargetRequest): Promise<Result<ResolvedTarget<'read'>>>;
  target(input: WriteTargetRequest): Promise<Result<ResolvedTarget<'write'>>>;
  send(input: PersonSendInput<Input>, options?: ReadOptions): Promise<AcceptanceOutcome>;
  /** Host-bound on enhanced BB; upstream preserves the singleton convention with weaker lifetime guarantees. */
  callPlugin<T>(input: { readonly pluginId: string; readonly method: string; readonly payload: import('./model.js').Json;
    readonly output: Codec<T> }, options?: ReadOptions): Promise<Result<T>>;
}
export interface IdentityServer<RequestContext, ToolContext, Input> extends Disposable {
  readonly instanceId: InstanceId;
  readonly directory: Directory;
  readonly participants: ParticipantReader;
  readonly history: import('./model.js').ProvenanceReader;
  readonly commits: CommitValidator;
  session(context: RequestContext, options?: ReadOptions): Promise<ServerSession>;
  selfProfile(context: RequestContext, options?: ReadOptions): Promise<Result<import('./model.js').IdentityProfile>>;
  subscribe(listener: (event: HostInvalidation) => void): Unsubscribe;
  personRequest(context: RequestContext, options?: ReadOptions): Promise<Result<PersonRequest<Input>>>;
  toolProvenance(context: ToolContext): Promise<Result<ExecutionProvenance>>;
  sendExternal(author: ExternalAuthorInput, input: SendInput<Input>, options?: ReadOptions): Promise<AcceptanceOutcome>;
  /** Lookup reports retained operation outcomes; IDs are scoped to this instance/plugin. */
  lookupOperation(operationId: OperationId, options?: ReadOptions): Promise<Result<OperationLookup<AcceptanceOutcome>>>;
}
export declare function createIdentityServer<R, T, I>(options: { readonly host: IdentityHost<R, T, I> }): IdentityServer<R, T, I>;
/** Wire query DTOs contain no AbortSignal. Options are local to this handler invocation. */
export interface IdentityEndpoint<RequestContext> extends Disposable {
  bootstrap(context: RequestContext, options?: ReadOptions): Promise<Result<ServerSession>>;
  selfProfile(context: RequestContext, options?: ReadOptions): Promise<Result<import('./model.js').IdentityProfile>>;
  search(context: RequestContext, input: import('./model.js').DirectoryQuery, options?: ReadOptions): ReturnType<Directory['search']>;
  profiles(context: RequestContext, input: import('./model.js').ProfileQuery, options?: ReadOptions): ReturnType<Directory['getMany']>;
  participants(context: RequestContext, input: import('./model.js').ParticipantQuery, options?: ReadOptions): ReturnType<ParticipantReader['list']>;
  participantPreviews(context: RequestContext, input: import('./model.js').ParticipantPreviewQuery, options?: ReadOptions): ReturnType<ParticipantReader['previews']>;
}
export declare function createIdentityEndpoint<R, T, I>(options: {
  readonly server: IdentityServer<R, T, I>;
  readonly publish: (event: import('./client.js').ClientInvalidation) => void;
}): IdentityEndpoint<R>;
