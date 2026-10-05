/**
 * React ownership, state hooks and shared normalized identity presentation.
 * Feature conflict presentation and retry policy remain feature-owned.
 */
import type { ComponentType, ReactNode } from 'react';
import type {
  IdentityClient,
  IdentityConnection,
  IdentitySession,
  IdentityStateBinding,
  IdentityStateBindingOptions,
  IdentityView,
  PendingEditPolicy,
  StateBindingSource,
  ViewSnapshot,
} from './client.js';
import type { IdentityError, IdentityProfile, ProfilePresentation, Result } from './model.js';
import type { PendingDraft, SyncSnapshot } from './state.js';

export interface IdentityProviderProps {
  /** Borrowed: Provider never starts or disposes this client. Null suspends
   * children while retaining this mounted Provider's preservation/failure owner. */
  readonly client: IdentityClient | null;
  /** Rendered until a non-null client and the Provider owner are committed. */
  readonly fallback?: ReactNode;
  readonly children?: ReactNode;
}

export type IdentityContextProps = { readonly children?: ReactNode } & (
  | { readonly view?: never; readonly pendingEdits?: PendingEditPolicy }
  | { readonly view: IdentityView; readonly pendingEdits?: never }
);

/** Provider and Context establish ownership for the exported hooks/controls. */
export interface BbIdentityComponents {
  readonly Provider: ComponentType<IdentityProviderProps>;
  /** Borrows an injected view or owns a default view for this Context subtree. */
  readonly Context: ComponentType<IdentityContextProps>;
}
export declare const BbIdentity: BbIdentityComponents;

/** Presentation is supplied by the caller; this component never fetches a profile. */
export interface IdentityAvatarProps {
  readonly presentation: ProfilePresentation | null;
  /** Human-readable fallback and accessible label; never pass an opaque identity key. */
  readonly label: string;
  readonly className?: string;
}
export declare const IdentityAvatar: ComponentType<IdentityAvatarProps>;

/** Compact normalized profile label. The fallback is caller-owned product wording. */
export interface IdentityLabelProps {
  readonly profile: IdentityProfile | null;
  readonly fallback: string;
  readonly className?: string;
  readonly primaryClassName?: string;
  readonly secondaryClassName?: string;
}
export declare const IdentityLabel: ComponentType<IdentityLabelProps>;

export interface IdentityViewPickerLabels {
  readonly trigger: string;
  readonly self: string;
  readonly viewingFallback: string;
  readonly dialog: string;
  readonly search: string;
  readonly noResults: string;
  readonly searchUnavailable: string;
}
export interface IdentityViewPickerProps {
  /** Presentation only; selection always uses the normalized profile identity. */
  readonly selectedProfile?: IdentityProfile | null;
  /** Disables selecting a different view, but never the separate return-self control. */
  readonly selectionDisabled?: boolean;
  readonly labels: IdentityViewPickerLabels;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly searchClassName?: string;
  readonly resultsClassName?: string;
  readonly avatarClassName?: string;
  /** Observes the same Result displayed by the control; feature retry policy stays local. */
  readonly onResult?: (result: Result<void>) => void;
}
/** Uses the current Context view/client; no module-global client, view, or directory cache. */
export declare const IdentityViewPicker: ComponentType<IdentityViewPickerProps>;

export interface IdentityViewStatusLabels {
  readonly viewing: string;
  readonly returnSelf: string;
}
export interface IdentityViewStatusProps {
  readonly labels: IdentityViewStatusLabels;
  readonly className?: string;
  /** Feature-specific selectors remain feature-owned. */
  readonly returnSelfAttributes?: Readonly<Record<string, string>>;
  readonly onResult?: (result: Result<void>) => void;
}
/** Shows an overriding-view status and its always-available, scope-fenced return action. */
export declare const IdentityViewStatus: ComponentType<IdentityViewStatusProps>;

/** Native SDK hook composition. Null means committed acquisition is still pending. */
export declare function useBbIdentityConnection(): IdentityConnection | null;
/** Native SDK hook composition. Null means the committed connection/client is not live yet. */
export declare function useBbIdentityClient(): IdentityClient | null;
/** Reads the explicitly borrowed Provider client; missing Provider is a setup error. */
export declare function useBorrowedIdentityClient(): IdentityClient;
export declare function useIdentitySession(): IdentitySession;

/** Framework-neutral binding ownership attached to the default Context view. */
export declare function useIdentityStateBinding<T>(
  options: Omit<IdentityStateBindingOptions<T>, 'client' | 'view'> & StateBindingSource<T>,
): IdentityStateBinding<T> | null;
/** Renderable snapshot for a nullable committed binding. */
export declare function useIdentityStateSnapshot<T>(binding: IdentityStateBinding<T> | null):
  | SyncSnapshot<T>
  | { readonly status: 'waiting-for-identity' };

export declare function useIdentityViewSnapshot(): ViewSnapshot;
export declare function useIdentityViewActions(): Pick<IdentityView, 'select' | 'reset'>;

/** Presentation-only failure record. The immutable generation acknowledges exactly one record. */
export interface IdentityPreservationFailure {
  readonly generation: number;
  readonly draft: PendingDraft<unknown>;
  readonly error: IdentityError;
}
export declare function useIdentityPreservationFailures(): readonly IdentityPreservationFailure[];
/** Returns false for an absent or superseded generation; feature code owns retry/recovery. */
export declare function useAcknowledgeIdentityPreservationFailure(): (generation: number) => boolean;
