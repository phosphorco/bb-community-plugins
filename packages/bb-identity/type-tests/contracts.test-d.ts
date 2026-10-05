/** Compile-only consumer assertions; no test/runtime implementation. */
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { bindBbIdentity } from '../bb.js';
import type { Codec, DirectoryQuery, RequestExpectation, Wire } from '../model.js';
import type { HostRequestHandle, ServerSession } from '../host.js';
import type { ReadTargetRequest, ResolvedTarget } from '../server.js';
import type { StateService } from '../state.js';
import type { IdentityContextProps } from '../react.js';
type Assert<T extends true> = T;
type Not<T extends boolean> = T extends true ? false : true;
type Assignable<A, B> = [A] extends [B] ? true : false;
type PublicBbAccepted = Assert<Assignable<BbPluginApi, Parameters<typeof bindBbIdentity>[0]>>;
type OrdinaryRead = Assert<Assignable<{
  readonly selection: { readonly kind: 'self' }; readonly policy: { readonly kind: 'self-only' }; readonly intent: 'read';
}, ReadTargetRequest>>;
type ReadCannotSave = Assert<Not<Assignable<ResolvedTarget<'read'>, Parameters<StateService<string>['save']>[0]>>>;
type WireHasNoSignal = Assert<Not<Assignable<'signal', keyof DirectoryQuery>>>;
type RootContextNeedsNoView = Assert<Assignable<{ readonly children: null }, IdentityContextProps>>;
/** An independently authored raw handle can satisfy the host boundary without package-private brands. */
type IndependentHandle = {
  readonly signal: AbortSignal;
  readonly session: Wire<Extract<ServerSession, { status: 'ready' }>>;
  validate(expected: Wire<RequestExpectation>): { readonly ok: true; readonly value: undefined };
  release(): void;
};
type StructuralHostHandle = Assert<Assignable<IndependentHandle, HostRequestHandle>>;
import type { IdentityClient, IdentityStateBinding, StateBindingSource } from '../client.js';
import type { IdentityState, StateResource, StateTransport, DraftStorage, ConflictContext, ConflictDecision } from '../state.js';
import type { IdentityProvider, ProviderDirectorySource } from '../host.js';
import type { useIdentityStateBinding } from '../react.js';
type LiveSessionComposes = Assert<Assignable<IdentityClient['currentSession'],
  Parameters<typeof import('../state.js').createIdentityState<string>>[0]['currentSession']>>;
type InSessionStateOptions = Assert<Assignable<
  Omit<Parameters<typeof import('../state.js').createIdentityState<string>>[0], 'drafts'>,
  Parameters<typeof import('../state.js').createIdentityState<string>>[0]
>>;
type BindingRecovery = Assert<Assignable<'recover' | 'discardRecovery' | 'resolveConflict' | 'checkpoint' | 'recoveryCandidates', keyof IdentityStateBinding<string>>>;
type ResolverOnly = Assert<Assignable<{ readonly issuers: readonly string[]; resolve: IdentityProvider['resolve'] }, IdentityProvider>>;
type OptionalDirectory = Assert<Assignable<{ readonly issuers: readonly string[]; readonly generation: string;
  person: ProviderDirectorySource['person'] }, ProviderDirectorySource>>;
type PreferencesSource = { readonly resource: StateResource<string>; readonly recordId: string;
  readonly transport: StateTransport<string>; readonly drafts: DraftStorage<string>;
  readonly onConflict: (context: ConflictContext<string>) => ConflictDecision<string>; readonly initializeEmpty: true };
type ResourceBinding = Assert<Assignable<PreferencesSource, StateBindingSource<string>>>;
type ResourceHook = Assert<Assignable<PreferencesSource & {
  readonly target: 'viewed-subject'; readonly editPolicy: 'collaborators';
  readonly onUnpersistedDraft: (draft: import('../state.js').PendingDraft<string>, error: import('../model.js').IdentityError) => void;
}, Parameters<typeof useIdentityStateBinding<string>>[0]>>;
type BindingConflict = Assert<Assignable<Parameters<IdentityStateBinding<string>['resolveConflict']>[1],
  Parameters<IdentityState<string>['resolveConflict']>[0]>>;
