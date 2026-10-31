import { definePluginApp, useBbNavigate, useComposer, useSdk, useRealtime, useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createGalleryAnchorReader, GalleryBoundaryError, GALLERY_HISTORY_LIMITS } from './gallery/anchors.ts';
import { mountGalleryPane, observeGalleryDemand, GALLERY_PANE_LIMITS } from './gallery/pane.ts';
import { createGalleryRuntime } from './gallery/runtime.ts';
import type { GalleryRuntime } from './gallery/runtime.ts';
import { TurnGallery } from './gallery/view.tsx';
import { ResultsPanel } from './gallery/panel.tsx';
import type { GalleryAnchor } from './gallery/anchors.ts';
import './app.css';

export default definePluginApp(app => {
  let runtime: GalleryRuntime | null = null;
  let generationActive = true, activationIntent = 0;
  let stopping: Promise<void> | null = null, currentStop: (() => Promise<void>) | null = null;
  const paneHandles = new Set<ReturnType<typeof mountGalleryPane>>();
  const retirePane = (pane: ReturnType<typeof mountGalleryPane>) => {
    const pendingRoots = pane.pendingRoots, drained = pane.dispose();
    if (pendingRoots) void drained.then(() => paneHandles.delete(pane)); else paneHandles.delete(pane);
    return drained;
  };
  app.slots.threadPanelAction({ id: 'results', title: 'Results', icon: 'Images', component: function Panel(props) {
    const sdk = useSdk();
    if (!runtime && generationActive) runtime = createGalleryRuntime(sdk);
    return runtime ? <ResultsPanel {...props} runtime={runtime} /> : null;
  } });
  app.contentScripts.register({ id: 'turn-results-window-owner', mount(context) {
    const intent = ++activationIntent;
    const activate = () => {
      if (context.signal.aborted || intent !== activationIntent) return;
      generationActive = true;
      let stopped: Promise<void> | null = null;
      const stop = () => {
        if (stopped) return stopped;
        generationActive = false;
        const owner = runtime, panes = [...paneHandles].map(retirePane);
        owner?.dispose();
        stopped = Promise.all([...panes, owner?.whenDrained() ?? Promise.resolve()]).then(() => {
          if (runtime === owner) runtime = null;
          if (currentStop === stop) currentStop = null;
          if (stopping === stopped) stopping = null;
        });
        stopping = stopped; return stopped;
      };
      currentStop = stop;
      const abort = () => { void stop(); };
      context.signal.addEventListener('abort', abort, { once: true });
      return async () => { context.signal.removeEventListener('abort', abort); await stop(); };
    };
    const previous = currentStop?.() ?? stopping;
    return previous ? previous.then(activate) : activate();
  } });
  function Sentinel() {
    const composer = useComposer(), sdk = useSdk(), publicNavigate = useBbNavigate();
    const threadId = composer.scope.kind === 'thread' ? composer.scope.threadId : null;
    const activation = activationIntent;
    const navigationBinding = useMemo(() => ({ threadId, sdk, activation }), [threadId, sdk, activation]);
    const committedNavigation = useRef<{ binding: typeof navigationBinding; api: typeof publicNavigate } | null>(null);
    useLayoutEffect(() => {
      const committed = { binding: navigationBinding, api: publicNavigate };
      committedNavigation.current = committed;
      return () => { if (committedNavigation.current === committed) committedNavigation.current = null; };
    }, [navigationBinding, publicNavigate]);
    const navigate = useMemo<typeof publicNavigate>(() => {
      // Public navigation may acquire new callbacks every render. Publish only
      // committed callbacks without tying history/root ownership to that identity.
      const current = () => generationActive && navigationBinding.threadId !== null
        && navigationBinding.activation === activationIntent && committedNavigation.current?.binding === navigationBinding
        ? committedNavigation.current.api : null;
      return {
        toThread: (...args) => { current()?.toThread(...args); },
        toProject: (...args) => { current()?.toProject(...args); },
        toPluginPanel: (...args) => { current()?.toPluginPanel(...args); },
        toCompose: (...args) => { current()?.toCompose(...args); },
        openThreadPanel: (...args) => current()?.openThreadPanel(...args) ?? false,
        openUrl: (...args) => current()?.openUrl(...args) ?? false,
        experimental_openFilePreview: (...args) => current()?.experimental_openFilePreview(...args) ?? false,
        experimental_openFileExternally: (...args) => current()?.experimental_openFileExternally(...args) ?? false,
        experimental_openTerminal: (...args) => current()?.experimental_openTerminal(...args) ?? Promise.resolve(false),
      };
    }, [navigationBinding]);
    const sentinel = useRef<HTMLSpanElement>(null);
    const handle = useRef<ReturnType<typeof mountGalleryPane> | null>(null);
    const reader = useRef<ReturnType<typeof createGalleryAnchorReader> | null>(null);
    const historyRows = useRef(new Map<string, { id: string; turnId: string | null }>());
    const historyBytes = useRef(0);
    const refreshTurns = useRef<Set<string> | null>(new Set());
    const targets = useRef<string[]>([]), targetCapacity = useRef(false);
    const [error, setError] = useState<string | null>(null), [continuation, setContinuation] = useState(false);
    const [capacity, setCapacity] = useState(false);
    const [unverified, setUnverified] = useState(false);
    const request = useRef<AbortController | null>(null), scope = useRef(0), boundary = useRef(0);
    const queued = useRef(false), rediscover = useRef(false);
    const mutationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refresh = useCallback(async (): Promise<void> => {
      if (!threadId || !reader.current || !generationActive || !sentinel.current || document.hidden) return;
      if (request.current) { queued.current = true; return; }
      queued.current = false;
      const controller = new AbortController(), generation = scope.current, version = boundary.current;
      request.current = controller;
      const timer = setTimeout(() => controller.abort('deadline'), 5000);
      try {
        const result = await reader.current.read(targets.current, controller.signal);
        if (controller.signal.aborted || !generationActive || generation !== scope.current || version !== boundary.current) return;
        if (!runtime) runtime = createGalleryRuntime(sdk);
        const scopeRows = [...historyRows.current.values()];
        if (handle.current) handle.current.update(result.anchors, result.checked, scopeRows);
        else {
          const owner = runtime;
          handle.current = mountGalleryPane(sentinel.current, threadId, result.anchors, (host, anchor, current, lifetime) => {
            const presentationRoot = owner.presentationRoot(lifetime, current);
            const root = createRoot(host); let shown = false, selected = anchor, verified = true;
            const render = () => root.render(<TurnGallery anchor={selected} runtime={owner} sdk={sdk} navigate={navigate}
              current={current} lifetime={lifetime} visible={shown} shell={host} demanded={verified} presentationRoot={presentationRoot} />);
            render();
            return { update(nextAnchor: GalleryAnchor) { selected = nextAnchor; render(); },
              visible(next: boolean) { if (shown !== next) { shown = next; render(); } },
              suspend(next: boolean) { if (verified === next) { verified = !next; render(); } },
              beginDisposal: presentationRoot.beginDisposal, dispose: () => root.unmount(), whenDrained: presentationRoot.whenDrained };
          }, scopeRows);
          paneHandles.add(handle.current);
        }
        // Changed roots resume their own bounded resource. Unchanged roots
        // keep owner/debt cursors; an unrelated native refresh cannot restart
        // every supplier at owner1. Reconnect/membership still rediscover.
        if (rediscover.current || refreshTurns.current === null || refreshTurns.current.size) {
          runtime.invalidate(threadId, rediscover.current, refreshTurns.current ?? undefined);
        }
        refreshTurns.current = new Set();
        rediscover.current = false;
        setContinuation(result.continued);
        setUnverified(result.continued || result.capacity);
        setCapacity(targetCapacity.current || result.capacity || handle.current.capacity);
        setError(result.unplaced.length && !result.continued ? 'Some visible rows have no complete public turn boundary in this slice.' : null);
      } catch (failure) {
        if (failure instanceof GalleryBoundaryError && generation === scope.current && version === boundary.current) handle.current?.update([], targets.current);
        if (generationActive && !controller.signal.aborted && generation === scope.current && version === boundary.current) setError('Turn results could not read this conversation. Retry results.');
        else if (controller.signal.reason === 'deadline' && generation === scope.current && version === boundary.current) setError('Turn history read reached its deadline. Continue results.');
      } finally {
        clearTimeout(timer);
        if (request.current === controller) {
          request.current = null;
          if (queued.current && mutationTimer.current === null && generationActive && generation === scope.current && !document.hidden) queueMicrotask(() => void refresh());
        }
      }
    }, [threadId, sdk, navigate]);
    const invalidateBoundary = useCallback((mutation = false, changedRows: readonly string[] | null = null) => {
      if (!reader.current || !generationActive) return;
      boundary.current++; reader.current.invalidate();
      const affected = handle.current?.invalidate(changedRows ?? undefined) ?? [];
      if (!mutation || changedRows === null) refreshTurns.current = null;
      else if (refreshTurns.current) for (const turnId of affected) {
        refreshTurns.current.add(turnId);
        if (refreshTurns.current.size > GALLERY_PANE_LIMITS.roots) { refreshTurns.current = null; break; }
      }
      queued.current = true;
      // Native history is not participant membership. Only genuine source or
      // lifecycle invalidations revoke the shared ready list and finite pass.
      if (!mutation) runtime?.invalidateReadiness();
      setUnverified(true);
      if (document.hidden) {
        if (mutationTimer.current !== null) clearTimeout(mutationTimer.current);
        mutationTimer.current = null; return;
      }
      // Bound the first refresh even during streaming. Subsequent hints share
      // this timer and at most one queued fresh demand behind the active read.
      if (mutation) {
        if (mutationTimer.current === null) mutationTimer.current = setTimeout(() => { mutationTimer.current = null; void refresh(); }, 150);
      } else {
        if (mutationTimer.current !== null) clearTimeout(mutationTimer.current);
        mutationTimer.current = null; void refresh();
      }
    }, [refresh]);
    useRealtime('results-changed', useCallback(payload => {
      if (payload && typeof payload === 'object' && 'threadId' in payload && payload.threadId === threadId) invalidateBoundary();
    }, [threadId, invalidateBoundary]));
    useRealtime('plugins-changed', useCallback(() => {
      rediscover.current = true; invalidateBoundary();
    }, [invalidateBoundary]));
    const connection = useRealtimeConnectionState();
    const previousConnection = useRef(connection);
    useLayoutEffect(() => {
      const prior = previousConnection.current; previousConnection.current = connection;
      if (connection === 'connected' && prior !== connection) { rediscover.current = true; invalidateBoundary(); }
    }, [connection, invalidateBoundary]);
    useLayoutEffect(() => {
      if (!threadId || !sentinel.current) return;
      scope.current++;
      if (!runtime && generationActive) runtime = createGalleryRuntime(sdk);
      if (!runtime) return;
      const owner = runtime;
      const readerScope = scope.current;
      let discoveryDemand = owner.retainDiscoveryDemand();
      reader.current = createGalleryAnchorReader({ async timeline(input) {
        const read = await owner.readScope(threadId, input.signal, signal => sdk.threads.timeline({ ...input, signal }));
        input.signal.throwIfAborted();
        if (!generationActive || readerScope !== scope.current || !owner.isActive()) throw Error('Timeline read retired.');
        if (read.state === 'ready') {
          if (!input.beforeAnchorId) { historyRows.current.clear(); historyBytes.current = 0; }
          const charge = (value: { id: string; turnId: string | null }) => new TextEncoder().encode(JSON.stringify(value)).length;
          for (const row of read.value.rows.slice(0, GALLERY_PANE_LIMITS.rows)) if (typeof row.id === 'string' && row.id.length <= 1024
            && (row.turnId === null || typeof row.turnId === 'string' && row.turnId.length <= 1024)
            && (historyRows.current.has(row.id) || historyRows.current.size < GALLERY_PANE_LIMITS.rows)) {
            const next = { id: row.id, turnId: row.turnId }, prior = historyRows.current.get(row.id);
            const bytes = historyBytes.current - (prior ? charge(prior) : 0) + charge(next);
            if (bytes <= GALLERY_HISTORY_LIMITS.bytes) { historyRows.current.set(row.id, next); historyBytes.current = bytes; }
          }
        }
        return read.state === 'ready' ? read.value : { state: 'capacity' };
      } }, threadId);
      const stop = observeGalleryDemand(sentinel.current, (ids, limited, reason, changedRows) => {
        targets.current = ids; targetCapacity.current = limited;
        discoveryDemand ??= owner.retainDiscoveryDemand();
        discoveryDemand?.visible(ids.length > 0);
        if (!discoveryDemand) { targetCapacity.current = true; setCapacity(true); }
        if (reason === 'demand') void refresh(); else invalidateBoundary(reason === 'mutation', changedRows);
      });
      const visibility = () => { if (document.hidden) { discoveryDemand?.visible(false); invalidateBoundary(); request.current?.abort(); } };
      document.addEventListener('visibilitychange', visibility);
      return () => {
        scope.current++; boundary.current++; queued.current = false;
        if (mutationTimer.current !== null) clearTimeout(mutationTimer.current); mutationTimer.current = null;
        stop(); discoveryDemand?.dispose(); document.removeEventListener('visibilitychange', visibility); request.current?.abort(); reader.current = null;
        if (handle.current) { void retirePane(handle.current); handle.current = null; }
        targets.current = []; historyRows.current.clear(); historyBytes.current = 0; refreshTurns.current = new Set(); setError(null); setContinuation(false); setCapacity(false); setUnverified(false);
      };
    }, [threadId, sdk, refresh, invalidateBoundary]);
    return <span ref={sentinel} data-turn-results-sentinel="">
      {unverified && <span role="status">Turn history needs verification. Saved results may reflect an earlier snapshot.</span>}
      {continuation && <button className="tr-more" onClick={() => void refresh()}>Continue visible turn history</button>}
      {capacity && <span role="status">Results view capacity reached. Focus a turn or continue its history.</span>}
      {error && <button className="tr-more" onClick={() => invalidateBoundary()}>{error}</button>}
    </span>;
  }

  app.composer.customize({ id: 'turn-results-inline', scopes: ['thread'], banners: [{ id: 'turn-results-pane-sentinel', chrome: 'bare', component: Sentinel }] });
});
