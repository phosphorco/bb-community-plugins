/**
 * First-consumer BB binding. This is deliberately the portable native-RPC and
 * state and HTTP composition with request-scoped response lifetimes.
 */
import type {
  BbPluginApi,
  PluginRpcContract,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
} from '@get-bb/plugin-sdk';
import type { Disposable, ExecutionProvenance, InstanceId, Result, Scheduler } from './model.js';
import type { IdentityProvider, ProviderRegistrationV1, ServerSession } from './host.js';
import type { IdentityEndpoint, IdentityServer, PersonRequest, TargetPolicy } from './server.js';
import type { AtomicStateStorage, StateResource } from './state.js';

/** IdP authors use this entry without importing adapter implementation ports. */
export type {
  IdentityProvider,
  ProviderEvidenceV1,
  ProviderBoundaryConfigurationV1,
  ProviderDirectoryRecord,
  ProviderRegistrationV1,
} from './host.js';

export type BbPromptInput = Parameters<BbPluginApi['sdk']['threads']['send']>[0]['input'][number];
/** Controls ownership of the external sender envelope at binding construction. */
export type ExternalMessageRendering = 'host' | 'producer';

/** Public SDK members consumed by this binding; unrelated SDK features may evolve independently. */
export type BbIdentityApi = Pick<BbPluginApi, 'pluginId' | 'onDispose'> & {
  readonly rpc: Pick<BbPluginApi['rpc'], 'register'>;
  readonly http?: Pick<BbPluginApi['http'], 'route'>;
  readonly realtime: Pick<BbPluginApi['realtime'], 'publish'>;
  readonly sdk: {
    /** Only the acknowledgement is common to supported 0.4 and 0.5 SDKs. */
    readonly threads: {
      readonly send: (args: Parameters<BbPluginApi['sdk']['threads']['send']>[0]) => Promise<{ readonly ok: true }>;
    };
    readonly plugins: Pick<BbPluginApi['sdk']['plugins'], 'callRpc'>;
  };
};

/** Issued only while a registered native handler is executing. */
export interface BbInvocation {
  readonly origin: 'interactive-user' | 'agent' | 'background' | 'external';
  readonly signal: AbortSignal;
  /** There is no ambient actor. The handler opens an explicit request; machine fallback is valid when no person is verified. */
  person(): Promise<Result<PersonRequest<BbPromptInput>>>;
}

export type IdentityRpcHandlers<C extends PluginRpcContract> = {
  readonly [M in keyof C]: {
    /** Declares upstream operation intent; it cannot override host evidence. */
    readonly origin: 'interactive-user' | 'background' | 'external';
    readonly handle: (
      input: StandardSchemaV1InferOutput<C[M]['input']>,
      invocation: BbInvocation,
    ) => StandardSchemaV1InferInput<C[M]['output']> | Promise<StandardSchemaV1InferInput<C[M]['output']>>;
  };
};

export interface IdentityHttpHandler {
  readonly origin: 'interactive-user' | 'external';
  readonly handle: (
    context: Parameters<Parameters<BbPluginApi['http']['route']>[2]>[0],
    invocation: BbInvocation,
  ) => Response | Promise<Response>;
}

/** Server methods accept only the invocation issued to the current handler. */
export interface BbInvocationServer {
  readonly instanceId: InstanceId;
  /** Revalidates an issued write target immediately at the feature's transaction boundary. */
  readonly commits: IdentityServer<unknown, unknown, BbPromptInput>['commits'];
  session(invocation: BbInvocation): Promise<ServerSession>;
  selfProfile(invocation: BbInvocation): Promise<Result<import('./model.js').IdentityProfile>>;
  personRequest(invocation: BbInvocation): Promise<Result<PersonRequest<BbPromptInput>>>;
  readonly sendExternal: IdentityServer<unknown, unknown, BbPromptInput>['sendExternal'];
  readonly lookupOperation: IdentityServer<unknown, unknown, BbPromptInput>['lookupOperation'];
  /** Bounded, validated provenance reads; disposal fences new raw history calls. */
  readonly history: IdentityServer<unknown, unknown, BbPromptInput>['history'];
}

/** Endpoint operations use the same issued native or HTTP invocation. */
export interface BbInvocationEndpoint extends Disposable {
  bootstrap(invocation: BbInvocation): Promise<Result<ServerSession>>;
  selfProfile(invocation: BbInvocation): Promise<Result<import('./model.js').IdentityProfile>>;
  search(invocation: BbInvocation, input: import('./model.js').DirectoryQuery): ReturnType<IdentityEndpoint<unknown>['search']>;
  profiles(invocation: BbInvocation, input: import('./model.js').ProfileQuery): ReturnType<IdentityEndpoint<unknown>['profiles']>;
  participants(invocation: BbInvocation, input: import('./model.js').ParticipantQuery): ReturnType<IdentityEndpoint<unknown>['participants']>;
  participantPreviews(invocation: BbInvocation, input: import('./model.js').ParticipantPreviewQuery): ReturnType<IdentityEndpoint<unknown>['participantPreviews']>;
}

/**
 * One binding owns its adapter, server, endpoint, native registrations and
 * state-route registrations. `dispose()` retires all of them together.
 */
export interface BbIdentityBinding extends Disposable {
  readonly server: BbInvocationServer;
  readonly endpoint: BbInvocationEndpoint;
  readonly rpc: {
    register<C extends PluginRpcContract>(contract: C, handlers: IdentityRpcHandlers<C>): Result<void>;
  };
  readonly http: {
    /** Interactive routes require local host authentication. Scope lasts through body completion or cancellation. */
    route(method: string, path: string, handler: IdentityHttpHandler,
      options?: Parameters<BbPluginApi['http']['route']>[3]): Result<void>;
  };
  readonly state: {
    register<T>(options: {
      readonly resource: StateResource<T>;
      readonly storage: AtomicStateStorage<T>;
      /** Write policy; also used for reads unless readPolicy is supplied. */
      readonly policy: TargetPolicy;
      readonly readPolicy?: TargetPolicy;
    }): Result<Disposable>;
  };
  /** Provider setup is lifecycle-scoped and never resolves an ambient person. */
  registerProvider(provider: IdentityProvider): Promise<Result<ProviderRegistrationV1>>;
  /** Tool provenance is evidence-only; the SDK tool context remains feature-owned. */
  toolProvenance(context: unknown): Promise<Result<ExecutionProvenance>>;
  /** Non-person work receives a package-issued background invocation. */
  background<T>(run: (invocation: BbInvocation) => Promise<T>): Promise<T>;
}

/**
 * Creates the supported portable native-RPC/state/HTTP binding. Capability absence
 * uses the stable upstream singleton; malformed or unavailable enhanced hosts
 * return their failure and never fall back. Callers intentionally unwrap one
 * Result during server-factory setup.
 */
export declare function bindBbIdentity(bb: BbIdentityApi, options?: {
  /** Reserved storage-scoped upstream namespace; enhanced hosts use their persisted raw instance fact. */
  readonly stateNamespace?: string;
  readonly scheduler?: Scheduler;
  /** `host` (default) adds one sender envelope; `producer` preserves a producer-owned envelope. */
  readonly externalMessageRendering?: ExternalMessageRendering;
}): Result<BbIdentityBinding>;
