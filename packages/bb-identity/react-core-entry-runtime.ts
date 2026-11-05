/** Borrowed-client public core facade over the committed-only React composition. */
import { BbIdentityReactCore as BbIdentityReact } from './react-core-runtime.js';
import type { ComponentType } from 'react';
import type {
  BbIdentityComponents,
  IdentityAvatarProps,
  IdentityLabelProps,
  IdentityViewPickerProps,
  IdentityViewStatusProps,
  useAcknowledgeIdentityPreservationFailure as UseAcknowledgeIdentityPreservationFailure,
  useBorrowedIdentityClient as UseBorrowedIdentityClient,
  useIdentityPreservationFailures as UseIdentityPreservationFailures,
  useIdentitySession as UseIdentitySession,
  useIdentityStateBinding as UseIdentityStateBinding,
  useIdentityStateSnapshot as UseIdentityStateSnapshot,
  useIdentityViewActions as UseIdentityViewActions,
  useIdentityViewSnapshot as UseIdentityViewSnapshot,
} from './react-core.js';

export const BbIdentity: BbIdentityComponents = {
  Provider: BbIdentityReact.Provider,
  Context: BbIdentityReact.Context,
};
export const IdentityAvatar: ComponentType<IdentityAvatarProps> = BbIdentityReact.IdentityAvatar;
export const IdentityLabel: ComponentType<IdentityLabelProps> = BbIdentityReact.IdentityLabel;
export const IdentityViewPicker: ComponentType<IdentityViewPickerProps> = BbIdentityReact.IdentityViewPicker;
export const IdentityViewStatus: ComponentType<IdentityViewStatusProps> = BbIdentityReact.IdentityViewStatus;

export const useBorrowedIdentityClient: typeof UseBorrowedIdentityClient = () => BbIdentityReact.useBorrowedIdentityClient();
export const useIdentitySession: typeof UseIdentitySession = () => BbIdentityReact.useIdentitySession();
export const useIdentityStateBinding: typeof UseIdentityStateBinding = BbIdentityReact.useBoundIdentityState;
export const useIdentityStateSnapshot: typeof UseIdentityStateSnapshot = BbIdentityReact.useIdentityStateSnapshot;
export const useIdentityViewSnapshot: typeof UseIdentityViewSnapshot = () => BbIdentityReact.useIdentityViewSnapshot();
export const useIdentityViewActions: typeof UseIdentityViewActions = () => BbIdentityReact.useIdentityViewActions();
export const useIdentityPreservationFailures: typeof UseIdentityPreservationFailures = () => BbIdentityReact.usePreservationFailures();
export const useAcknowledgeIdentityPreservationFailure: typeof UseAcknowledgeIdentityPreservationFailure = () => BbIdentityReact.useAcknowledgePreservationFailure();

export const useIdentityEditingBinding: typeof import('./react-core.js').useIdentityEditingBinding = BbIdentityReact.useBoundIdentityEditing;
export const useIdentityEditingSnapshot: typeof import('./react-core.js').useIdentityEditingSnapshot = BbIdentityReact.useIdentityEditingSnapshot;
export const useIdentityEditingPreservationFailures: typeof import('./react-core.js').useIdentityEditingPreservationFailures = BbIdentityReact.useEditingPreservationFailures;
export const useAcknowledgeIdentityEditingPreservationFailure: typeof import('./react-core.js').useAcknowledgeIdentityEditingPreservationFailure = BbIdentityReact.useAcknowledgeEditingPreservationFailure;
