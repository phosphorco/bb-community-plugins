/** Public candidate surface: declarations must match only the checked entry subset. */
import { bindBbIdentity } from '../bb.js';
import type { BbIdentityBinding } from '../bb.js';
import {
  bindIdentityState,
  clientInvalidationCodec,
  createDirectorySearch,
  createIdentityClient,
  createIdentityClientTransport,
  createIdentityConnection,
  createIdentityFetchConnection,
  createIdentityView,
} from '../client.js';
import type { IdentityClient, IdentityConnection } from '../client.js';
import {
  BbIdentity,
  IdentityAvatar,
  IdentityLabel,
  IdentityViewPicker,
  IdentityViewStatus,
  useAcknowledgeIdentityPreservationFailure,
  useBbIdentityClient,
  useBbIdentityConnection,
  useBorrowedIdentityClient,
  useIdentityPreservationFailures,
  useIdentitySession,
  useIdentityStateBinding,
  useIdentityStateSnapshot,
  useIdentityViewActions,
  useIdentityViewSnapshot,
} from '../react.js';
import type {
  IdentityAvatarProps,
  IdentityLabelProps,
  IdentityViewPickerProps,
  IdentityViewStatusProps,
} from '../react.js';
import type { ComponentProps } from 'react';
import type { Result } from '../model.js';
import type { TargetPolicy } from '../server.js';
import type { AtomicStateStorage, StateResource } from '../state.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type Assignable<Left, Right> = [Left] extends [Right] ? true : false;

type _BindingResult = Assert<Equal<ReturnType<typeof bindBbIdentity>, Result<BbIdentityBinding>>>;
type _ProducerRenderingOption = Assert<Assignable<{ readonly externalMessageRendering: 'producer' }, NonNullable<Parameters<typeof bindBbIdentity>[1]>>>;
type _NullableConnection = Assert<Equal<ReturnType<typeof useBbIdentityConnection>, IdentityConnection | null>>;
type _NullableClient = Assert<Equal<ReturnType<typeof useBbIdentityClient>, IdentityClient | null>>;
type _BorrowedClient = Assert<Equal<ReturnType<typeof useBorrowedIdentityClient>, IdentityClient>>;
type _StateBinding = Assert<Equal<ReturnType<typeof useIdentityStateBinding<string>>, import('../client.js').IdentityStateBinding<string> | null>>;
type _StateWritePolicy = Assert<Equal<Parameters<BbIdentityBinding['state']['register']>[0]['policy'], TargetPolicy>>;
type _StateReadPolicy = Assert<Equal<Parameters<BbIdentityBinding['state']['register']>[0]['readPolicy'], TargetPolicy | undefined>>;
type _AvatarProps = Assert<Equal<ComponentProps<typeof IdentityAvatar>, IdentityAvatarProps>>;
type _LabelProps = Assert<Equal<ComponentProps<typeof IdentityLabel>, IdentityLabelProps>>;
type _PickerProps = Assert<Equal<ComponentProps<typeof IdentityViewPicker>, IdentityViewPickerProps>>;
type _StatusProps = Assert<Equal<ComponentProps<typeof IdentityViewStatus>, IdentityViewStatusProps>>;

declare const publicBinding: BbIdentityBinding;
declare const publicBb: Parameters<typeof bindBbIdentity>[0];
void bindBbIdentity(publicBb, { externalMessageRendering: 'producer' });
declare const publicResource: StateResource<string>;
declare const publicStorage: AtomicStateStorage<string>;

void publicBinding.state.register({
  resource: publicResource,
  storage: publicStorage,
  policy: { kind: 'self-only' },
  readPolicy: { kind: 'collaborators' },
});

void [
  bindIdentityState, clientInvalidationCodec, createDirectorySearch, createIdentityClient,
  createIdentityClientTransport, createIdentityConnection, createIdentityFetchConnection,
  createIdentityView, BbIdentity, useAcknowledgeIdentityPreservationFailure,
  IdentityAvatar, IdentityLabel, IdentityViewPicker, IdentityViewStatus,
  useIdentityPreservationFailures, useIdentitySession, useIdentityStateSnapshot,
  useIdentityViewActions, useIdentityViewSnapshot,
];

void publicBinding.http.route('POST', '/identity', {
  origin: 'interactive-user',
  async handle(context, invocation) {
    const profile = await publicBinding.server.selfProfile(invocation);
    return context.json(profile);
  },
}, { auth: 'local' });
