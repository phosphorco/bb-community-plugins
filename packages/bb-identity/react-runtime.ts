/**
 * React composition behind the public `/react` entry, supplying the
 * provider/context/native/state-binding slice required by the first consumer.
 */
import * as React from 'react';
import { useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { PluginRpcClient, PluginRealtimeConnectionState, StandardSchemaV1 } from '@get-bb/plugin-sdk/app';
import type {
  IdentityClient, IdentityConnection, IdentitySession, IdentityStateBinding, IdentityStateBindingOptions,
  IdentityView, PendingEditPolicy, StateBindingSource, ViewSnapshot,
} from './client.js';
import type { IdentityError, IdentityProfile, ProfilePresentation, Result } from './model.js';
import type { ConflictContext, ConflictDecision, PendingDraft, SyncSnapshot } from './state.js';
import { bindIdentityState } from './client-state-binding-runtime.js';
import { createNativeIdentityConnection, nativeIdentityRealtimeChannel } from './bb-client-connection-runtime.js';
import { createIdentityClient } from './client-runtime.js';
import { createIdentityView } from './client-view-runtime.js';
import { createDraftRetirementOwner, type DraftRetirementOwner } from './draft-retirement-runtime.js';
import { identityRpcMethods } from './rpc-routes-runtime.js';

const waitingForBinding = Object.freeze({ status: 'waiting-for-identity' as const });

type NativeMethod = (typeof identityRpcMethods)[keyof typeof identityRpcMethods];
type NativeContract = {
  readonly [Method in NativeMethod]: {
    readonly input: StandardSchemaV1<unknown, unknown>;
    readonly output: StandardSchemaV1<unknown, unknown>;
  };
};

/** Only public SDK hooks are injectable; React itself is always the real React runtime. */
export interface NativeIdentityReactHooks {
  useRpc(): PluginRpcClient<NativeContract>;
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  useRealtimeConnectionState(): PluginRealtimeConnectionState;
}

export interface InternalIdentityProviderProps {
  readonly client: IdentityClient | null;
  readonly fallback?: React.ReactNode;
  readonly children?: React.ReactNode;
}
export type InternalIdentityContextProps = {
  readonly children?: React.ReactNode;
} & (
  | { readonly view?: never; readonly pendingEdits?: PendingEditPolicy }
  | { readonly view: IdentityView; readonly pendingEdits?: never }
);

export interface PreservationFailure {
  /** Exact Provider-root generation; acknowledgement never clears a newer failure. */
  readonly generation: number;
  readonly draft: PendingDraft<unknown>;
  readonly error: IdentityError;
}

export interface IdentityAvatarProps {
  readonly presentation: ProfilePresentation | null;
  readonly label: string;
  readonly className?: string;
}

export interface IdentityLabelProps {
  readonly profile: IdentityProfile | null;
  readonly fallback: string;
  readonly className?: string;
  readonly primaryClassName?: string;
  readonly secondaryClassName?: string;
}

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
  readonly selectedProfile?: IdentityProfile | null;
  readonly selectionDisabled?: boolean;
  readonly labels: IdentityViewPickerLabels;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly searchClassName?: string;
  readonly resultsClassName?: string;
  readonly avatarClassName?: string;
  readonly onResult?: (result: Result<void>) => void;
}

export interface IdentityViewStatusLabels {
  readonly viewing: string;
  readonly returnSelf: string;
}

export interface IdentityViewStatusProps {
  readonly labels: IdentityViewStatusLabels;
  readonly className?: string;
  readonly returnSelfAttributes?: Readonly<Record<string, string>>;
  readonly onResult?: (result: Result<void>) => void;
}

function safeAvatarUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function avatarInitials(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean);
  return `${words[0]?.[0] ?? '?'}${words.length > 1 ? words.at(-1)?.[0] ?? '' : ''}`.toLocaleUpperCase();
}

function joinClassNames(...values: readonly (string | undefined)[]): string | undefined {
  const value = values.filter((entry): entry is string => Boolean(entry)).join(' ');
  return value || undefined;
}

function selectableProfile(profile: IdentityProfile): boolean {
  return profile.identity.kind === 'person' || profile.identity.kind === 'default-user';
}

interface FailureSink {
  report(draft: PendingDraft<unknown>, error: IdentityError): void;
  acknowledge(generation: number): boolean;
  snapshot(): readonly PreservationFailure[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function createFailureSink(): FailureSink {
  let disposed = false;
  const listeners = new Set<() => void>();
  /** Presentation only: this is not a second checkpoint/retry store. */
  const entries = new Map<string, PreservationFailure>();
  let current: readonly PreservationFailure[] = Object.freeze([]);
  let nextGeneration = 0;
  const keyFor = (draft: PendingDraft<unknown>) => JSON.stringify([
    draft.key.address.instanceId, draft.key.address.pluginId, draft.key.address.collection,
    draft.key.address.recordId, draft.key.address.owner, draft.key.actor, draft.key.ownerSession,
    draft.schemaVersion,
  ]);
  const emit = () => { for (const listener of [...listeners]) try { listener(); } catch {} };
  return {
    report(draft, error) {
      if (disposed) return;
      const key = keyFor(draft);
      entries.delete(key);
      /* Consumers can retain the displayed record; its acknowledgement token
       * must stay immutable even when feature UI handles arbitrary objects. */
      entries.set(key, Object.freeze({ generation: ++nextGeneration, draft, error }));
      /** Keep presentation bounded; durable recovery remains feature DraftStorage's job. */
      while (entries.size > 16) entries.delete(entries.keys().next().value!);
      current = Object.freeze([...entries.values()]);
      emit();
    },
    acknowledge(generation) {
      if (disposed) return false;
      const entry = [...entries.entries()].find(([, failure]) => failure.generation === generation);
      if (!entry) return false;
      entries.delete(entry[0]); current = Object.freeze([...entries.values()]); emit();
      return true;
    },
    snapshot: () => current,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { if (disposed) return; disposed = true; entries.clear(); current = Object.freeze([]); listeners.clear(); },
  };
}

interface ProviderRoot {
  readonly retirements: DraftRetirementOwner;
  readonly failures: FailureSink;
  dispose(): void;
}
function createProviderRoot(): ProviderRoot {
  const retirements = createDraftRetirementOwner();
  const failures = createFailureSink();
  let disposed = false;
  return {
    retirements, failures,
    dispose() {
      if (disposed) return;
      disposed = true;
      /* This settles waiters but never cancels an already accepted preservation task. */
      retirements.dispose(); failures.dispose();
    },
  };
}

interface ProviderContextValue { readonly root: ProviderRoot; readonly client: IdentityClient; }
interface ViewRoot extends ProviderContextValue { readonly view: IdentityView; }

/**
 * Acquire only after React commits.  Several lower-level constructors subscribe
 * immediately, so a useState initializer or useMemo allocation could leak from
 * a discarded render.  A changed key returns null until its committed owner is
 * published; no render can observe the prior client/view/binding as current.
 */
function useCommittedResource<Key, Value>(
  key: Key,
  create: () => Value,
  dispose: (value: Value) => void,
): Value | null {
  type Entry = { readonly key: Key; readonly epoch: number; readonly value: Value };
  const [entry, setEntry] = React.useState<Entry | null>(null);
  const epoch = React.useRef(0);
  React.useLayoutEffect(() => {
    const current = ++epoch.current;
    const value = create();
    setEntry({ key, epoch: current, value });
    return () => {
      try { dispose(value); } catch {}
      /* StrictMode's following setup publishes its fresh value; an unmount
       * must not schedule a state update merely to clear an unreachable entry. */
    };
    // The key is the full ownership identity.  Callers memoize it from every
    // construction input, so ordinary rerenders retain the committed owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return entry !== null && entry.epoch === epoch.current && Object.is(entry.key, key) ? entry.value : null;
}

function requireContext<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} requires an enclosing BbIdentity Provider.`);
  return value;
}

/**
 * Source-only internal subset.  It intentionally does not claim the complete
 * declared BbIdentity component API before those controls are implemented.
 */
export interface IdentityReactRuntime {
  readonly Provider: React.ComponentType<InternalIdentityProviderProps>;
  readonly Context: React.ComponentType<InternalIdentityContextProps>;
  readonly IdentityAvatar: React.ComponentType<IdentityAvatarProps>;
  readonly IdentityLabel: React.ComponentType<IdentityLabelProps>;
  readonly IdentityViewPicker: React.ComponentType<IdentityViewPickerProps>;
  readonly IdentityViewStatus: React.ComponentType<IdentityViewStatusProps>;
  useBorrowedIdentityClient(): IdentityClient;
  /** Snapshot of the explicitly borrowed Provider client. */
  useIdentitySession(): IdentitySession;
  /** Null until the committed hook root owns a live adapter. */
  useNativeIdentityConnection(): IdentityConnection | null;
  /** Null until the committed hook root owns a live client. */
  useNativeIdentityClient(): IdentityClient | null;
  /** Null until the binding's committed controller/view subscriptions are live. */
  useBoundIdentityState<T>(options: Omit<IdentityStateBindingOptions<T>, 'client' | 'view'> & StateBindingSource<T>): IdentityStateBinding<T> | null;
  useIdentityStateSnapshot<T>(binding: IdentityStateBinding<T> | null): SyncSnapshot<T> | { readonly status: 'waiting-for-identity' };
  /** Existing declared view primitives, exposed only in this internal slice. */
  useIdentityViewSnapshot(): ViewSnapshot;
  useIdentityViewActions(): Pick<IdentityView, 'select' | 'reset'>;
  usePreservationFailures(): readonly PreservationFailure[];
  /** Removes only the exact presentation generation; retry remains feature-owned. */
  useAcknowledgePreservationFailure(): (generation: number) => boolean;
}

export function createIdentityReactRuntime(native: NativeIdentityReactHooks): IdentityReactRuntime {
  const ProviderContext = React.createContext<ProviderContextValue | null>(null);
  const ViewContext = React.createContext<ViewRoot | null>(null);

  const Provider: React.ComponentType<InternalIdentityProviderProps> = ({ client, children, fallback }) => {
    /* The retirement/error lifetime follows the mounted Provider, never a borrowed client prop. */
    const root = useCommittedResource('provider-root', createProviderRoot, value => value.dispose());
    const context = React.useMemo<ProviderContextValue | null>(() => root === null || client === null ? null : { root, client }, [root, client]);
    if (context === null) return fallback ?? null;
    return React.createElement(ProviderContext.Provider, { value: context }, children);
  };

  const Context: React.ComponentType<InternalIdentityContextProps> = (props) => {
    const provider = requireContext(React.useContext(ProviderContext), 'BbIdentity.Context');
    const viewKey = React.useMemo(() => ({ client: provider.client, supplied: props.view ?? null, pending: props.pendingEdits ?? null }),
      [provider.client, props.view, props.pendingEdits]);
    const view = useCommittedResource(viewKey, () => props.view ?? createIdentityView({
      client: provider.client,
      ...(props.pendingEdits ? { pendingEdits: props.pendingEdits } : {}),
    }), value => { if (!props.view) value.dispose(); });
    /* This memo is unconditional: pending->live must not alter hook order. */
    const root = React.useMemo<ViewRoot | null>(() => view === null ? null : ({ ...provider, view }), [provider, view]);
    if (root === null) return null;
    return React.createElement(ViewContext.Provider, { value: root }, props.children);
  };

  const useBorrowedIdentityClient = (): IdentityClient => requireContext(React.useContext(ProviderContext), 'useBorrowedIdentityClient').client;
  const useIdentitySession = (): IdentitySession => {
    const client = useBorrowedIdentityClient();
    return React.useSyncExternalStore(
      React.useCallback(listener => client.subscribe(listener), [client]),
      React.useCallback(() => client.getSnapshot(), [client]),
      React.useCallback(() => client.getSnapshot(), [client]),
    );
  };

  const useNativeIdentityConnection = (): IdentityConnection | null => {
    const rpc = native.useRpc();
    const realtimeState = native.useRealtimeConnectionState();
    const adapter = useCommittedResource(rpc, () => createNativeIdentityConnection({ rpc, realtimeState }), value => value.dispose());
    const receive = React.useCallback((payload: unknown) => { adapter?.acceptRealtime(payload); }, [adapter]);
    native.useRealtime(nativeIdentityRealtimeChannel, receive);
    React.useEffect(() => { adapter?.setRealtimeState(realtimeState); }, [adapter, realtimeState]);
    return adapter?.connection ?? null;
  };

  const useNativeIdentityClient = (): IdentityClient | null => {
    const connection = useNativeIdentityConnection();
    const client = useCommittedResource(connection, () => connection === null ? null : createIdentityClient({ connection }), value => value?.dispose());
    React.useEffect(() => { if (client !== null) void client.start(); }, [client]);
    return client;
  };

  const useIdentityStateSnapshot = <T,>(binding: IdentityStateBinding<T> | null): SyncSnapshot<T> | { readonly status: 'waiting-for-identity' } =>
    React.useSyncExternalStore(
      React.useCallback(listener => binding?.subscribe(listener) ?? (() => {}), [binding]),
      React.useCallback(() => binding?.getSnapshot() ?? waitingForBinding, [binding]),
      React.useCallback(() => binding?.getSnapshot() ?? waitingForBinding, [binding]),
    );

  const useBoundIdentityState = <T,>(options: Omit<IdentityStateBindingOptions<T>, 'client' | 'view'> & StateBindingSource<T>): IdentityStateBinding<T> | null => {
    const root = requireContext(React.useContext(ViewContext), 'useBoundIdentityState');
    const suppliedConflict = 'resource' in options && options.resource !== undefined ? options.onConflict : null;
    const callbacks = React.useRef<{
      failure: ((draft: PendingDraft<T>, error: IdentityError) => void) | undefined;
      conflict: ((context: ConflictContext<T>) => ConflictDecision<T>) | null;
    }>({ failure: options.onUnpersistedDraft, conflict: suppliedConflict });
    /* Render never mutates behavior observed by an already committed controller. */
    React.useLayoutEffect(() => {
      callbacks.current = { failure: options.onUnpersistedDraft, conflict: suppliedConflict };
    }, [options.onUnpersistedDraft, suppliedConflict]);
    const sourceKey = React.useMemo(() => {
      if ('resource' in options && options.resource !== undefined) return { kind: 'resource' as const, resource: options.resource, recordId: options.recordId, drafts: options.drafts,
        initializeEmpty: options.initializeEmpty, scheduler: options.scheduler ?? null };
      return { kind: 'custom' as const, create: options.create };
    }, ['create' in options ? options.create : null, 'resource' in options ? options.resource : null,
      'recordId' in options ? options.recordId : null, 'drafts' in options ? options.drafts : null,
      'initializeEmpty' in options ? options.initializeEmpty : null,
      'scheduler' in options ? options.scheduler : null]);
    const key = React.useMemo(() => ({ root, source: sourceKey, target: options.target, editPolicy: options.editPolicy }),
      [root, sourceKey, options.target, options.editPolicy]);
    const binding = useCommittedResource(key, () => {
      const onUnpersistedDraft = (draft: PendingDraft<T>, error: IdentityError) => {
        if ('resource' in options && options.resource !== undefined && options.drafts) root.root.failures.report(draft, error);
        try { callbacks.current.failure?.(draft, error); } catch {}
      };
      if ('resource' in options && options.resource !== undefined) {
        return bindIdentityState({
          ...options, client: root.client, view: root.view, onUnpersistedDraft,
          onConflict(context) { return callbacks.current.conflict?.(context) ?? { kind: 'needs-review', reason: 'Committed conflict callback is unavailable.' }; },
        }, root.root.retirements);
      }
      return bindIdentityState({ ...options, client: root.client, view: root.view, onUnpersistedDraft }, root.root.retirements);
    }, value => value.dispose());
    /* Subscribe here so a hook consumer rerenders without inventing a second store. */
    useIdentityStateSnapshot(binding);
    return binding;
  };

  const useIdentityViewSnapshot = (): ViewSnapshot => {
    const root = requireContext(React.useContext(ViewContext), 'useIdentityViewSnapshot');
    return React.useSyncExternalStore(
      React.useCallback(listener => root.view.subscribe(listener), [root.view]),
      React.useCallback(() => root.view.getSnapshot(), [root.view]),
      React.useCallback(() => root.view.getSnapshot(), [root.view]),
    );
  };

  const useIdentityViewActions = (): Pick<IdentityView, 'select' | 'reset'> => {
    const root = requireContext(React.useContext(ViewContext), 'useIdentityViewActions');
    return React.useMemo(() => ({ select: root.view.select.bind(root.view), reset: root.view.reset.bind(root.view) }), [root.view]);
  };

  const IdentityAvatar: React.ComponentType<IdentityAvatarProps> = ({ presentation, label, className }) => {
    const imageUrl = React.useMemo(() => safeAvatarUrl(presentation?.avatarUrl ?? null), [presentation?.avatarUrl]);
    const [failedImageUrl, setFailedImageUrl] = React.useState<string | null>(null);
    React.useEffect(() => { setFailedImageUrl(null); }, [imageUrl]);
    const accessibleLabel = presentation?.displayName || label;
    if (imageUrl !== null && failedImageUrl !== imageUrl) {
      return React.createElement('img', {
        className,
        src: imageUrl,
        alt: accessibleLabel,
        crossOrigin: 'anonymous',
        referrerPolicy: 'no-referrer',
        onError: () => setFailedImageUrl(imageUrl),
      });
    }
    return React.createElement('span', { className, role: 'img', 'aria-label': accessibleLabel }, avatarInitials(accessibleLabel));
  };

  const IdentityLabel: React.ComponentType<IdentityLabelProps> = ({ profile, fallback, className, primaryClassName, secondaryClassName }) => {
    const displayName = profile?.presentation.displayName || fallback;
    const handle = profile?.presentation.handle ?? null;
    return React.createElement('span', { className },
      React.createElement('strong', { className: primaryClassName }, displayName),
      handle === null ? null : React.createElement('small', { className: secondaryClassName }, handle),
    );
  };

  const IdentityViewPicker: React.ComponentType<IdentityViewPickerProps> = (props) => {
    const client = useBorrowedIdentityClient();
    const view = useIdentityViewSnapshot();
    const actions = useIdentityViewActions();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [results, setResults] = React.useState<readonly IdentityProfile[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const searchGeneration = React.useRef(0);
    const actionGeneration = React.useRef(0);
    const shellRef = React.useRef<HTMLDivElement | null>(null);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const popupRef = React.useRef<HTMLDivElement | null>(null);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const active = view.status === 'ready' ? view : view.status === 'blocked' ? view.lastReady : null;
    const canSearch = active !== null
      && active.session.mode === 'multi-user'
      && active.session.capabilities.directory.search;
    const scope = active === null ? null : `${active.session.instanceId}:${active.session.stamp}:${active.subject.key}:${active.viewGeneration}`;
    const selectedKey = active?.subject.key ?? null;
    const close = React.useCallback(() => {
      setOpen(false);
      setQuery('');
      queueMicrotask(() => triggerRef.current?.focus());
    }, []);

    React.useEffect(() => {
      const current = ++searchGeneration.current;
      setResults([]);
      setError(null);
      if (!open || !canSearch || props.selectionDisabled || scope === null) return;
      const timer = window.setTimeout(() => {
        setLoading(true);
        void client.directory.search({
          query,
          kinds: ['person', 'default-user'],
          history: 'current',
          limit: 20,
        }).then((result) => {
          if (searchGeneration.current !== current) return;
          if (result.ok) setResults(result.value.items.filter(selectableProfile));
          else setError(result.error.message);
        }, () => {
          if (searchGeneration.current === current) setError(props.labels.searchUnavailable);
        }).finally(() => {
          if (searchGeneration.current === current) setLoading(false);
        });
      }, query ? 150 : 0);
      return () => window.clearTimeout(timer);
    }, [canSearch, client, open, props.labels.searchUnavailable, props.selectionDisabled, query, scope]);

    React.useLayoutEffect(() => {
      if (!open || !canSearch) return;
      const popup = popupRef.current;
      const trigger = triggerRef.current;
      if (popup === null || trigger === null) return;
      const position = () => {
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft ?? 0;
        const top = viewport?.offsetTop ?? 0;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        const anchor = trigger.getBoundingClientRect();
        popup.style.maxWidth = `${Math.max(0, width - 24)}px`;
        popup.style.maxHeight = `${Math.max(0, height - 24)}px`;
        const bounds = popup.getBoundingClientRect();
        const x = Math.max(left + 12, Math.min(anchor.left, left + width - bounds.width - 12));
        const below = anchor.bottom + 8;
        const y = below + bounds.height <= top + height - 12
          ? below
          : Math.max(top + 12, anchor.top - bounds.height - 8);
        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;
      };
      popup.showPopover?.();
      position();
      inputRef.current?.focus({ preventScroll: true });
      const onPointerDown = (event: PointerEvent) => {
        if (event.target instanceof Node && !shellRef.current?.contains(event.target)) close();
      };
      const observer = new ResizeObserver(position);
      observer.observe(popup);
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
      window.visualViewport?.addEventListener('resize', position);
      window.visualViewport?.addEventListener('scroll', position);
      document.addEventListener('pointerdown', onPointerDown);
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
        window.visualViewport?.removeEventListener('resize', position);
        window.visualViewport?.removeEventListener('scroll', position);
        document.removeEventListener('pointerdown', onPointerDown);
      };
    }, [canSearch, close, open]);

    const profiles = React.useMemo(() => {
      const byKey = new Map<string, IdentityProfile>();
      if (props.selectedProfile !== undefined && props.selectedProfile !== null && selectableProfile(props.selectedProfile)) {
        byKey.set(props.selectedProfile.identity.key, props.selectedProfile);
      }
      for (const profile of results) byKey.set(profile.identity.key, profile);
      return [...byKey.values()];
    }, [props.selectedProfile, results]);
    const select = React.useCallback(async (profile: IdentityProfile | null): Promise<void> => {
      const current = ++actionGeneration.current;
      const result = profile === null || profile.identity.kind === 'default-user'
        ? await actions.reset()
        : profile.identity.kind === 'person'
          ? await actions.select({ kind: 'person', key: profile.identity.key })
          : { ok: false as const, error: { code: 'unsupported' as const, message: 'This identity cannot be selected as a view.', retry: 'never' as const } };
      if (actionGeneration.current !== current) return;
      props.onResult?.(result);
      if (result.ok) close();
      else setError(result.error.message);
    }, [actions, close, props]);
    const onKeyDown = React.useCallback((event: React.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    }, [close]);

    if (!canSearch) return null;
    const triggerLabel = active?.overriding
      ? props.selectedProfile?.presentation.displayName ?? props.labels.viewingFallback
      : props.labels.trigger;
    return React.createElement('div', { ref: shellRef, style: { position: 'relative' } },
      React.createElement('button', {
        ref: triggerRef,
        type: 'button',
        className: props.className,
        disabled: props.selectionDisabled === true,
        'aria-label': props.labels.trigger,
        title: props.labels.trigger,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'data-bb-identity-view-picker': '',
        onClick: () => { setError(null); setOpen(true); },
      },
      props.selectedProfile === undefined || props.selectedProfile === null
        ? React.createElement('svg', { 'aria-hidden': true, width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 },
            React.createElement('circle', { cx: 12, cy: 8, r: 4 }),
            React.createElement('path', { d: 'M4 21v-2a8 8 0 0 1 16 0v2' }))
        : React.createElement(IdentityAvatar, {
          presentation: props.selectedProfile.presentation,
          label: triggerLabel,
          ...(props.avatarClassName ? { className: props.avatarClassName } : {}),
        }),
      React.createElement('span', null, triggerLabel)),
      !open ? null : React.createElement('div', {
        ref: popupRef,
        popover: 'manual',
        role: 'dialog',
        'aria-label': props.labels.dialog,
        className: props.contentClassName,
        style: { position: 'fixed', margin: 0, padding: 0, inset: 'auto', overflowY: 'auto' },
        onKeyDown,
      },
      React.createElement('label', { className: props.searchClassName },
        React.createElement('span', null, props.labels.search),
        React.createElement('input', {
          ref: inputRef,
          value: query,
          onChange: event => setQuery(event.currentTarget.value),
          placeholder: props.labels.search,
          'aria-label': props.labels.search,
          'data-bb-identity-view-search': '',
        }),
      ),
      React.createElement('div', { className: props.resultsClassName, role: 'listbox' },
        active?.overriding ? React.createElement('button', {
          type: 'button', role: 'option', 'aria-selected': false,
          onClick: () => { void select(null); },
        }, props.labels.self) : null,
        profiles.map(profile => React.createElement('button', {
          type: 'button', role: 'option', key: profile.identity.key,
          'aria-selected': profile.identity.key === selectedKey,
          'data-bb-identity-view-option': '',
          disabled: props.selectionDisabled === true,
          onClick: () => { void select(profile); },
        },
        React.createElement(IdentityAvatar, {
          presentation: profile.presentation,
          label: props.labels.viewingFallback,
          ...(props.avatarClassName ? { className: props.avatarClassName } : {}),
        }),
        React.createElement(IdentityLabel, { profile, fallback: props.labels.viewingFallback }),
        profile.identity.key === selectedKey ? React.createElement('span', { 'aria-hidden': true }, '✓') : null,
        )),
        !loading && error !== null ? React.createElement('p', { role: 'alert' }, error) : null,
        !loading && error === null && profiles.length === 0 ? React.createElement('p', null, props.labels.noResults) : null,
        loading ? React.createElement('p', { role: 'status' }, 'Searching…') : null,
      ),
      ),
    );
  };

  const IdentityViewStatus: React.ComponentType<IdentityViewStatusProps> = (props) => {
    const view = useIdentityViewSnapshot();
    const actions = useIdentityViewActions();
    const [error, setError] = React.useState<string | null>(null);
    const active = view.status === 'ready' ? view : view.status === 'blocked' ? view.lastReady : null;
    if (active?.overriding !== true) return null;
    const reset = async () => {
      const result = await actions.reset();
      props.onResult?.(result);
      if (!result.ok) setError(result.error.message);
    };
    return React.createElement('span', { className: props.className },
      React.createElement('span', null, props.labels.viewing),
      React.createElement('button', {
        type: 'button',
        ...props.returnSelfAttributes,
        'data-bb-identity-return-self': '',
        onClick: () => { void reset(); },
      }, props.labels.returnSelf),
      error === null ? null : React.createElement('span', { role: 'alert' }, error),
    );
  };

  const usePreservationFailures = (): readonly PreservationFailure[] => {
    const root = requireContext(React.useContext(ProviderContext), 'usePreservationFailures');
    return React.useSyncExternalStore(
      React.useCallback(listener => root.root.failures.subscribe(listener), [root.root]),
      React.useCallback(() => root.root.failures.snapshot(), [root.root]),
      React.useCallback(() => root.root.failures.snapshot(), [root.root]),
    );
  };
  const useAcknowledgePreservationFailure = (): ((generation: number) => boolean) => {
    const root = requireContext(React.useContext(ProviderContext), 'useAcknowledgePreservationFailure');
    return React.useCallback(generation => root.root.failures.acknowledge(generation), [root.root]);
  };

  return { Provider, Context, IdentityAvatar, IdentityLabel, IdentityViewPicker, IdentityViewStatus,
    useBorrowedIdentityClient, useIdentitySession, useNativeIdentityConnection, useNativeIdentityClient,
    useBoundIdentityState, useIdentityStateSnapshot, useIdentityViewSnapshot, useIdentityViewActions,
    usePreservationFailures, useAcknowledgePreservationFailure };
}

/** Installed-SDK composition reexported by the public `/react` entry. */
export const BbIdentityReact = createIdentityReactRuntime({
  useRpc: () => useRpc<NativeContract>(),
  useRealtime,
  useRealtimeConnectionState,
});
