/** Raw core-to-package structural witness: no casts, package-private brands, or SDK-private imports. */
import type {
  AcceptanceOutcome,
  AttemptQuery,
  Contribution,
  ContributionQuery,
  EvidencePage,
  ExecutionProvenance,
  IdentityProfile,
  Json,
  OperationLookup,
  Page,
  Participant,
  ParticipantQuery,
  PersonReference,
  Result,
  SendInput,
  Wire,
} from '../model.js';
import {
  inspectForkExtension,
  type ExternalAuthorInput,
  type ForkAcceptanceRequest,
  type ForkIdentityExtensionSurface,
  type ForkIdentityProtocolV1,
  type ForkInvocationContext,
  type ForkInvocationRegistration,
  type ForkInvocationRouteClass,
  type ForkInvocationScope,
  type ForkIdentityProvider,
  type ForkProviderRegistration,
  type ForkRequestHandle,
  type HostInvalidation,
  type IdentityProvider,
  type ProviderBoundaryConfigurationV1,
  type ProviderDirectorySource,
  type ServerSession,
} from '../host.js';

interface RequestContext { readonly requestId: string; }
interface ToolContext { readonly toolCallId: string; }

/** This is a core-side shape; no member is extracted from the package protocol below. */
interface IndependentlyAuthoredCoreProtocol {
  readonly version: 1;
  /** Persisted host namespace from core; never inferred from plugin or request identity. */
  readonly instanceId: string;
  bindInvocation<Args extends readonly unknown[], Output>(input: {
    readonly routeClass: ForkInvocationRouteClass;
    readonly handler: (context: ForkInvocationContext<RequestContext>, ...args: Args) => Output;
  }): { readonly registration: ForkInvocationRegistration; readonly handler: (...args: Args) => Output };
  session(context: RequestContext): Promise<Wire<ServerSession>>;
  selfProfile(context: RequestContext): Promise<Wire<Result<IdentityProfile>>>;
  openRequest(context: RequestContext): Promise<Result<ForkRequestHandle>>;
  accept(input: ForkAcceptanceRequest<string>): Promise<Wire<AcceptanceOutcome>>;
  lookup(operationId: string): Promise<Wire<Result<OperationLookup<AcceptanceOutcome>>>>;
  provenance(context: ToolContext): Promise<Wire<Result<ExecutionProvenance>>>;
  historyContributions(query: Wire<ContributionQuery>): Promise<Wire<Result<EvidencePage<Contribution>>>>;
  historyAttempts(query: Wire<AttemptQuery>): Promise<Wire<Result<EvidencePage<ExecutionProvenance>>>>;
  directorySources(): readonly ProviderDirectorySource[];
  participants(input: Wire<ParticipantQuery>): Promise<Wire<Result<Page<Participant> & {
    readonly coverage: 'complete-history' | 'partial-history';
  }>>>;
  forwardRpc(scope: ForkInvocationScope, destination: { readonly pluginId: string; readonly method: string }, input: Json): Promise<unknown>;
  registerProvider(provider: ForkIdentityProvider): Promise<Result<ForkProviderRegistration>>;
  subscribe(listener: (event: HostInvalidation) => void): () => void;
}

const signal = new AbortController().signal;
const person: Wire<PersonReference> = {
  kind: 'person', key: 'https://id.example:alice', issuer: 'https://id.example', subject: 'alice',
};
const presentation = { displayName: 'Alice', handle: 'alice', avatarUrl: null };
const readySession: Wire<Extract<ServerSession, { readonly status: 'ready' }>> = {
  status: 'ready', instanceId: 'instance-1', mode: 'multi-user',
  actor: { identity: person, presentation, evidence: 'provider-verified' }, stamp: 'session-1',
  capabilities: {
    requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: true, lookup: true }, participants: true, externalSend: 'structured',
    toolProvenance: 'causal', operationLookup: true,
  },
};
const profile: Wire<IdentityProfile> = { identity: person, presentation, revision: 'profile-r1', status: 'current' };
const scope: ForkInvocationScope = {
  signal, validate: () => ({ ok: true }), release: () => {},
};
const registration: ForkInvocationRegistration = { generation: 'binding-r1', status: 'active', dispose: () => {} };
const requestHandle: ForkRequestHandle = {
  signal, session: readySession, validate: () => ({ ok: true, value: undefined }), release: () => {}, scope,
};
const input: Wire<SendInput<string>> = {
  operationId: 'operation-1', threadId: 'thread-1', input: ['continue'], mode: 'start',
};
const externalAuthor: ExternalAuthorInput = { subject: 'webhook-42', presentation };
const providerConfiguration: Readonly<ProviderBoundaryConfigurationV1> = {
  version: 1, boundaryId: 'idp-boundary', pluginId: 'idp-plugin', ingressIds: ['idp-proxy'],
  credentials: [{ name: 'authorization', source: 'header', field: 'Authorization' }],
  resolver: { timeoutMs: 1_000 },
};
/** A raw provider return deliberately uses only ordinary strings for identity fields. */
const providerRegistration: ForkProviderRegistration = {
  generation: 'provider-r1', configuration: providerConfiguration, getStatus: () => 'active', signal,
  subscribe: () => () => {}, invalidate: () => ({ ok: true, value: undefined }), dispose: () => {},
  person: (issuer, subject): Wire<Result<PersonReference>> => ({
    ok: true, value: { kind: 'person', key: `${issuer}:${subject}`, issuer, subject },
  }),
};
const provider: IdentityProvider = {
  issuers: ['https://id.example'],
  resolve: async () => ({
    status: 'resolved', issuer: 'https://id.example', subject: 'alice', presentation,
  }),
};
const rawProvider: ForkIdentityProvider = {
  issuers: ['https://id.example'],
  async validateReadiness(input) {
    const generation: string = input.generation;
    const boundary: Readonly<ProviderBoundaryConfigurationV1> = input.configuration;
    const deadline: number = input.deadlineAt;
    const abort: AbortSignal = input.signal;
    void generation;
    void boundary;
    void deadline;
    void abort;
    return { ok: true, value: undefined };
  },
  resolve: provider.resolve,
};
const accepted: Wire<AcceptanceOutcome> = {
  status: 'submitted',
  receipt: {
    evidence: 'upstream-response', operationId: 'operation-1', acceptedAt: null, references: null,
    native: { deliveryId: 'delivery-1', queuedMessageId: null, turnId: 'turn-1' },
    provenance: 'source-labelled', deduplication: 'not-guaranteed',
  },
};
const invocationContext: ForkInvocationContext<RequestContext> = { request: { requestId: 'request-1' }, scope };

const independentlyAuthoredCoreProtocol: IndependentlyAuthoredCoreProtocol = {
  version: 1,
  instanceId: 'instance-proof-r1',
  bindInvocation: (binding) => ({ registration, handler: (...args) => binding.handler(invocationContext, ...args) }),
  session: async () => readySession,
  selfProfile: async () => ({ ok: true, value: profile }),
  openRequest: async () => ({ ok: true, value: requestHandle }),
  accept: async () => accepted,
  lookup: async () => ({ ok: true, value: { status: 'pending' } }),
  provenance: async () => ({ ok: true, value: { status: 'unknown', correlation: null, reason: 'not-recorded' } }),
  historyContributions: async () => ({
    ok: true, value: { status: 'known', items: [], nextCursor: null, traversal: 'complete', missing: [] },
  }),
  historyAttempts: async () => ({
    ok: true, value: { status: 'known', items: [], nextCursor: null, traversal: 'complete', missing: [] },
  }),
  directorySources: () => [],
  participants: async () => ({
    ok: true, value: { items: [], nextCursor: null, revision: 'participants-r1', coverage: 'complete-history' },
  }),
  forwardRpc: async () => undefined,
  async registerProvider(candidate) {
    const readiness = candidate.validateReadiness;
    if (readiness !== undefined) {
      const result = await readiness({
        generation: 'provider-r1', configuration: providerConfiguration,
        deadlineAt: 4_102_444_800_000, signal,
      });
      if (!result.ok) return result;
    }
    return { ok: true, value: providerRegistration };
  },
  subscribe: () => () => {},
};

const structuralProtocol: ForkIdentityProtocolV1<RequestContext, ToolContext, string> = independentlyAuthoredCoreProtocol;

/** The sole optional discovery member flows through runtime inspection before use. */
export async function useRawHostContract(surface: ForkIdentityExtensionSurface): Promise<void> {
  const discovery = inspectForkExtension<RequestContext, ToolContext, string>(surface.experimental_p6rIdentity);
  if (discovery.status !== 'supported') return;

  const protocol: ForkIdentityProtocolV1<RequestContext, ToolContext, string> = discovery.protocol;
  const bound = protocol.bindInvocation({
    routeClass: 'interactive-session',
    handler: (context, payload: string) => { context.scope.validate(); return payload.length; },
  });
  const boundRegistration: ForkInvocationRegistration = bound.registration;
  const handler: (payload: string) => number = bound.handler;
  const opened = await protocol.openRequest({ requestId: 'request-2' });
  if (!opened.ok) return;
  const scoped: ForkAcceptanceRequest<string> = { source: { kind: 'scope', scope: opened.value.scope }, input };
  const external: ForkAcceptanceRequest<string> = { source: { kind: 'external', author: externalAuthor }, input };

  await protocol.accept(scoped);
  await protocol.accept(external);
  await structuralProtocol.registerProvider(rawProvider);
  await structuralProtocol.openRequest({ requestId: 'request-2' });
  await structuralProtocol.selfProfile({ requestId: 'request-2' });
  await protocol.forwardRpc(opened.value.scope, { pluginId: 'notifications', method: 'register' }, { step: 'begin' });
  void boundRegistration;
  void handler;
}
