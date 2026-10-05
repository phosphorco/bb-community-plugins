/** Thin public candidate facade over the committed-only React composition. */
import { BbIdentityReact } from './react-runtime.js';
import type { ComponentType } from 'react';
import type {
  BbIdentityComponents,
  IdentityAvatarProps,
  IdentityLabelProps,
  IdentityViewPickerProps,
  IdentityViewStatusProps,
  useAcknowledgeIdentityPreservationFailure as UseAcknowledgeIdentityPreservationFailure,
  useBbIdentityClient as UseBbIdentityClient,
  useBbIdentityConnection as UseBbIdentityConnection,
  useBorrowedIdentityClient as UseBorrowedIdentityClient,
  useIdentityPreservationFailures as UseIdentityPreservationFailures,
  useIdentitySession as UseIdentitySession,
  useIdentityStateBinding as UseIdentityStateBinding,
  useIdentityStateSnapshot as UseIdentityStateSnapshot,
  useIdentityViewActions as UseIdentityViewActions,
  useIdentityViewSnapshot as UseIdentityViewSnapshot,
} from './react.js';

export const BbIdentity: BbIdentityComponents = {
  Provider: BbIdentityReact.Provider,
  Context: BbIdentityReact.Context,
};
export const IdentityAvatar: ComponentType<IdentityAvatarProps> = BbIdentityReact.IdentityAvatar;
export const IdentityLabel: ComponentType<IdentityLabelProps> = BbIdentityReact.IdentityLabel;
export const IdentityViewPicker: ComponentType<IdentityViewPickerProps> = BbIdentityReact.IdentityViewPicker;
export const IdentityViewStatus: ComponentType<IdentityViewStatusProps> = BbIdentityReact.IdentityViewStatus;

export const useBbIdentityConnection: typeof UseBbIdentityConnection = () => BbIdentityReact.useNativeIdentityConnection();
export const useBbIdentityClient: typeof UseBbIdentityClient = () => BbIdentityReact.useNativeIdentityClient();
export const useBorrowedIdentityClient: typeof UseBorrowedIdentityClient = () => BbIdentityReact.useBorrowedIdentityClient();
export const useIdentitySession: typeof UseIdentitySession = () => BbIdentityReact.useIdentitySession();
export const useIdentityStateBinding: typeof UseIdentityStateBinding = BbIdentityReact.useBoundIdentityState;
export const useIdentityStateSnapshot: typeof UseIdentityStateSnapshot = BbIdentityReact.useIdentityStateSnapshot;
export const useIdentityViewSnapshot: typeof UseIdentityViewSnapshot = () => BbIdentityReact.useIdentityViewSnapshot();
export const useIdentityViewActions: typeof UseIdentityViewActions = () => BbIdentityReact.useIdentityViewActions();
export const useIdentityPreservationFailures: typeof UseIdentityPreservationFailures = () => BbIdentityReact.usePreservationFailures();
export const useAcknowledgeIdentityPreservationFailure: typeof UseAcknowledgeIdentityPreservationFailure = () => BbIdentityReact.useAcknowledgePreservationFailure();
