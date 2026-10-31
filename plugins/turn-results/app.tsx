import { definePluginApp, useBbNavigate, useSdk, useRealtime, useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import type { PluginThreadHeaderActionProps } from '@get-bb/plugin-sdk/app';
import { createGalleryAnchorReader, GalleryBoundaryError, GALLERY_HISTORY_LIMITS } from './gallery/anchors.ts';
import { mountGalleryPane, observeGalleryDemand, GALLERY_PANE_LIMITS, sameBoundary, resolveGalleryBridge, mountGalleryNotice } from './gallery/pane.ts';
import { createGalleryRuntime } from './gallery/runtime.ts';
import type { GalleryRuntime } from './gallery/runtime.ts';
import { TurnGallery, openFingerprint, openAvailable } from './gallery/view.tsx';
import type { GalleryOpenPort, GalleryOpenOutcome } from './gallery/view.tsx';
import { navigateResult } from '@phosphorco/bb-turn-results/bb';
import { untilAborted } from './gallery/lifetime.ts';
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
  function HeaderBridge({ threadId }: PluginThreadHeaderActionProps) {
    const marker = useRef<HTMLSpanElement>(null);
    const bridgeToken = useRef<object>({});
    const [mapping, setMapping] = useState<(NonNullable<ReturnType<typeof resolveGalleryBridge>> & { token: object; parent: Element | null }) | null>(null);
    useLayoutEffect(() => {
      const node = marker.current; if (!node) return;
      let active = true;
      let observed: { scope: Element; pane: Element | null; parent: Element | null } | null = null;
      const moved = (records: readonly MutationRecord[]) => {
        const witness = observed;
        return Boolean(witness && records.some(record =>
          record.type === 'attributes' && (record.target === witness.scope || record.target === witness.pane)
          || [...record.addedNodes, ...record.removedNodes].some(changed => changed === witness.scope || changed === witness.pane
            || changed.contains(node) || Boolean(witness.pane && changed.contains(witness.pane)))));
      };
      const observer = new MutationObserver(records => {
        if (!active) return;
        if (moved(records)) { update(true); return; }
        if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(changed => changed instanceof Element
          && !changed.matches('[data-turn-results-gallery], [data-turn-results-notice], [data-turn-results-sentinel]')
          && (changed.matches('[data-thread-window], [data-split-pane-id]') || changed.querySelector('[data-thread-window], [data-split-pane-id]'))))) update();
      });
      const parentObserver = new MutationObserver(records => { if (active && moved(records)) update(true); });
      const update = (retire = false) => {
        if (!active) return;
        const next = resolveGalleryBridge(node);
        const scope = next?.scope ?? node.closest('[data-split-pane-id]') ?? observed?.scope;
        const pane = next?.pane ?? null;
        // A missing mapping retains one known parent only to observe recovery;
        // it grants no authority. A valid mapping always binds its actual parent.
        const parent = next ? next.scope.parentElement : observed?.parent ?? scope?.parentElement ?? null;
        const rebound = observed?.scope !== scope || observed?.pane !== pane || observed?.parent !== parent;
        if (retire || observed && rebound) bridgeToken.current = {};
        // Follow the current physical witness before exposing its new mapping.
        // Old callbacks stay revoked even when an observed removal/readd ends
        // at the same Element. This covers observed history, not unseen moves.
        if (rebound) {
          observer.disconnect(); parentObserver.disconnect();
          observed = scope ? { scope, pane, parent } : null;
          if (scope) observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-thread-window', 'data-split-pane-id'] });
          if (parent) parentObserver.observe(parent, { childList: true });
        }
        setMapping(prior => prior?.pane === next?.pane && prior?.scope === next?.scope && prior?.parent === next?.scope.parentElement && prior?.token === bridgeToken.current
          ? prior : next ? { ...next, token: bridgeToken.current, parent: next.scope.parentElement } : null);
      };
      update();
      return () => { active = false; bridgeToken.current = {}; observer.disconnect(); parentObserver.disconnect(); observed = null; };
    }, [threadId]);
    const bridgeCurrent = useCallback(() => {
      const next = marker.current && resolveGalleryBridge(marker.current);
      return Boolean(mapping && mapping.token === bridgeToken.current && next?.pane === mapping.pane && next.scope === mapping.scope && next.scope.parentElement === mapping.parent);
    }, [mapping]);
    return <><span ref={marker} hidden aria-hidden="true" data-turn-results-bridge="" />
      {mapping && createPortal(<Sentinel threadId={threadId} bridgeCurrent={bridgeCurrent} />, mapping.pane, threadId)}</>;
  }
  function Sentinel({ threadId, bridgeCurrent }: { threadId: string; bridgeCurrent(): boolean }) {
    const sdk = useSdk(), publicNavigate = useBbNavigate();
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
      const current = () => generationActive && bridgeCurrent() && navigationBinding.threadId !== null
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
    }, [navigationBinding, bridgeCurrent]);
    const sentinel = useRef<HTMLSpanElement>(null);
    const [targetKey, setTargetKey] = useState('[]');
    const [notice, setNotice] = useState<ReturnType<typeof mountGalleryNotice>>(null);
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
    const openValidation = useRef<{ turnId: string; dirty(): void; cancel(): void } | null>(null);
    const mutationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestOpen = useCallback<GalleryOpenPort>(async input => {
      const owner = runtime, generation = scope.current, expected = openFingerprint(input.expected);
      const controller = new AbortController(), started = performance.now();
      const decline = (reason: string): GalleryOpenOutcome => ({ state: 'declined', reason });
      const cancel = () => controller.abort('retired');
      input.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort('deadline'), 5000);
      let dirty = false, disposed = false, unsubscribe = () => {};
      const validation = { turnId: input.scope.boundary.turnId, dirty() { dirty = true; }, cancel() { controller.abort('changed'); } };
      const scopeLive = () => Boolean(owner?.isActive() && generationActive && bridgeCurrent() && generation === scope.current && !document.hidden
        && navigationBinding.activation === activationIntent && navigationBinding.threadId === threadId
        && committedNavigation.current?.binding === navigationBinding && input.scope.live());
      const factsLive = () => { const row = input.currentRow(); return Boolean(row && openAvailable(row) && openFingerprint(row) === expected); };
      const check = () => {
        controller.signal.throwIfAborted(); input.signal.throwIfAborted();
        if (performance.now() - started >= 5000) throw Error('deadline');
        if (!scopeLive() || !factsLive()) throw Error('changed');
      };
      const cleanup = () => {
        if (disposed) return; disposed = true; clearTimeout(timer);
        try { unsubscribe(); } finally {
          input.signal.removeEventListener('abort', cancel);
          if (openValidation.current === validation) openValidation.current = null;
        }
      };
      try {
        if (!owner || !threadId || !expected || !openAvailable(input.expected)) return decline('This saved result is unavailable.');
        check(); openValidation.current = validation;
        unsubscribe = input.watchCurrent(() => { if (!factsLive()) controller.abort('changed'); });
        check();
        for (let pass = 0; pass < 2; pass++) {
          dirty = false;
          const fresh = createGalleryAnchorReader({ async timeline(nativeInput) {
            check();
            const read = await owner.readScope(threadId, controller.signal, signal => {
              check(); return sdk.threads.timeline({ ...nativeInput, signal });
            });
            check(); return read.state === 'ready' ? read.value : { state: 'capacity' };
          } }, threadId);
          const proof = await untilAborted(fresh.read([input.scope.boundary.rowId], controller.signal), controller.signal);
          check();
          if (proof.capacity) return decline('Results read capacity reached. Try Open after another view settles.');
          const anchor = proof.anchors.find(value => value.rowId === input.scope.boundary.rowId);
          if (!anchor || !sameBoundary(anchor, input.scope.boundary)) return decline('This result needs a complete current turn boundary. Continue its history before opening.');
          const read = await owner.readScope(threadId, controller.signal, signal => {
            check(); return owner.backend.read(threadId, input.scope.boundary.turnId, signal, input.after);
          });
          check();
          if (read.state === 'capacity') return decline('Results read capacity reached. Try Open after another view settles.');
          const row = read.value.page.rows.find(value => value.key === input.expected.key && value.owner === input.expected.owner);
          if (!row) return decline('This saved result could not be confirmed in the current results page. Review its current details.');
          if (!openAvailable(row) || openFingerprint(row) !== expected) return decline('This saved result changed or became unavailable. Review its current details.');
          if (dirty) { if (pass === 0) continue; return decline('Turn history kept changing while checking. Try Open when it settles.'); }
          // Fresh complete native boundary + final retained/current facts.
          // No await/render/queue barrier after these final commitment fences.
          check(); cleanup();
          if (!input.consume()) return decline('This Open request is no longer current.');
          return navigateResult(navigate, row.resolution!.route);
        }
        return decline('This result could not be checked.');
      } catch {
        return decline(controller.signal.reason === 'deadline' || performance.now() - started >= 5000
          ? 'Checking reached its deadline. Try Open again.' : 'This Open request changed or is no longer current.');
      } finally { cleanup(); }
    }, [threadId, sdk, navigate, navigationBinding, bridgeCurrent]);
    const refresh = useCallback(async (): Promise<void> => {
      if (!threadId || !reader.current || !generationActive || !bridgeCurrent() || !sentinel.current || document.hidden) return;
      if (request.current) { queued.current = true; return; }
      queued.current = false;
      const controller = new AbortController(), generation = scope.current, version = boundary.current;
      request.current = controller;
      const timer = setTimeout(() => controller.abort('deadline'), 5000);
      try {
        const result = await reader.current.read(targets.current, controller.signal);
        if (controller.signal.aborted || !generationActive || !bridgeCurrent() || generation !== scope.current || version !== boundary.current) return;
        if (!runtime) runtime = createGalleryRuntime(sdk);
        const scopeRows = [...historyRows.current.values()];
        if (handle.current) handle.current.update(result.anchors, result.checked, scopeRows);
        else {
          const owner = runtime;
          handle.current = mountGalleryPane(sentinel.current, threadId, result.anchors, (host, anchor, current, lifetime, actionScope) => {
            const presentationRoot = owner.presentationRoot(lifetime, current);
            const root = createRoot(host); let shown = false, selected = anchor, verified = true;
            const render = () => root.render(<TurnGallery anchor={selected} runtime={owner} sdk={sdk} navigate={navigate}
              current={current} lifetime={lifetime} visible={shown} shell={host} demanded={verified} presentationRoot={presentationRoot} actionScope={actionScope} requestOpen={requestOpen} />);
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
        // Successful exhausted negative/pending rows stay quiet; continued
        // history and capacity retain explicit inline controls without authority.
        setError(null);
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
    }, [threadId, sdk, navigate, requestOpen, bridgeCurrent]);
    const invalidateBoundary = useCallback((mutation = false, changedRows: readonly string[] | null = null) => {
      if (!reader.current || !generationActive) return;
      boundary.current++; reader.current.invalidate();
      const affected = handle.current?.invalidate(changedRows ?? undefined) ?? [];
      const validation = openValidation.current;
      if (validation) {
        if (mutation && changedRows !== null && changedRows.every(id => handle.current?.knowsRow(id))) {
          if (affected.includes(validation.turnId)) validation.cancel();
        } else validation.dirty(); // Event names/global activity are ambiguous.
      }
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
        targets.current = ids; setTargetKey(JSON.stringify(ids)); targetCapacity.current = limited;
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
    const needsNotice = continuation || capacity || error !== null;
    useLayoutEffect(() => {
      if (!needsNotice || !sentinel.current || !bridgeCurrent()) { setNotice(null); return; }
      const next = mountGalleryNotice(sentinel.current, targets.current); setNotice(next);
      return () => next?.dispose();
    }, [needsNotice, targetKey, bridgeCurrent]);
    const noticeAction = (action: () => void) => { if (generationActive && bridgeCurrent() && notice?.current()) action(); };
    return <><span ref={sentinel} hidden data-turn-results-sentinel="" />
      {notice && createPortal(<div className="tr-inline-notice">
        {unverified && <span role="status">More history is needed to find these results. Saved results may reflect an earlier snapshot.</span>}
        {continuation && <button className="tr-more" onClick={() => noticeAction(() => void refresh())}>Continue history</button>}
        {capacity && <span role="status">Results view capacity reached. Focus a turn or continue its history.</span>}
        {error && <button className="tr-more" onClick={() => noticeAction(() => invalidateBoundary())}>{error}</button>}
      </div>, notice.element)}</>;

  }

  app.slots.experimental_threadHeaderAction({ id: 'turn-results-bridge', title: 'Turn results bridge', component: HeaderBridge });
});
