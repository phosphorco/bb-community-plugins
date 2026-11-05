import { definePluginApp, useBbNavigate, useSdk, useRealtime, useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import type { PluginThreadHeaderActionProps } from '@get-bb/plugin-sdk/app';
import { createGalleryAnchorReader, GalleryBoundaryError, GALLERY_HISTORY_LIMITS } from './gallery/anchors.ts';
import { mountGalleryPane, observeGalleryDemand, GALLERY_PANE_LIMITS, sameBoundary, resolveGalleryBridge } from './gallery/pane.ts';
import { createGalleryRuntime } from './gallery/runtime.ts';
import type { GalleryRuntime } from './gallery/runtime.ts';
import { TurnGallery, openFingerprint, openAvailable } from './gallery/view.tsx';
import type { GalleryOpenPort, GalleryOpenOutcome } from './gallery/view.tsx';
import { navigateResult } from '@phosphorco/bb-turn-results/bb';
import { untilAborted } from './gallery/lifetime.ts';
import type { GalleryAnchor, GalleryTimelinePort } from './gallery/anchors.ts';
import './app.css';
interface HeaderPreload {
  observe(records: readonly MutationRecord[]): void;
  stop(): void;
  foreground(ids: readonly string[]): { id: string; dispose(): void }[];
  take(ids: readonly string[], port: GalleryTimelinePort, reset: () => void): { reader: ReturnType<typeof createGalleryAnchorReader>; rows: { id: string; turnId: string | null }[] } | null;
}

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
  function HeaderBridge({ threadId, projectId }: PluginThreadHeaderActionProps) {
    const sdk = useSdk(), connection = useRealtimeConnectionState();
    const nativeTimeline = useMemo(() => ({ sdk, port: sdk.threads }), [sdk]);
    const committedTimeline = useRef<typeof nativeTimeline | null>(null);
    useLayoutEffect(() => { committedTimeline.current = nativeTimeline; return () => { if (committedTimeline.current === nativeTimeline) committedTimeline.current = null; }; }, [nativeTimeline]);
    const timelineClient = useCallback(() => committedTimeline.current === nativeTimeline ? nativeTimeline.port : null, [nativeTimeline]);
    const marker = useRef<HTMLSpanElement>(null);
    const preload = useRef<HeaderPreload | null>(null), liveConnection = useRef('unknown');
    const nearbyDemand = useRef<((ids: readonly string[]) => void) | null>(null);
    useLayoutEffect(() => { liveConnection.current = connection; return () => { liveConnection.current = 'disconnected'; }; }, [connection]);
    const bridgeToken = useRef<object>({}), historyShare = useRef<object>({});
    const [mapping, setMapping] = useState<(NonNullable<ReturnType<typeof resolveGalleryBridge>> & { token: object; parent: Element | null }) | null>(null);
    useRealtime('results-changed', useCallback(payload => {
      if (payload && typeof payload === 'object' && 'threadId' in payload && payload.threadId === threadId) preload.current?.stop();
    }, [threadId]));
    useRealtime('plugins-changed', useCallback(() => preload.current?.stop(), []));
    useLayoutEffect(() => {
      const node = marker.current; if (!node) return;
      const route = () => {
        const path = /^\/projects\/([^/]+)\/threads\/([^/]+)$/.exec(window.location.pathname);
        try { if (!path || decodeURIComponent(path[1]!) !== projectId || decodeURIComponent(path[2]!) !== threadId) return null; } catch { return null; }
        const match = /^#msg=(0|[1-9]\d*)$/.exec(window.location.hash);
        if (window.location.hash && !match) return null;
        const sequence = match ? Number(match[1]) : null;
        return sequence !== null && !Number.isSafeInteger(sequence) ? null : { href: window.location.href, sequence };
      };
      if (!route() || typeof sdk.subscribe !== 'function') return;
      let live = true, coverage = false, core = 'unknown';
      const jobs: { route: HeaderPreload | null; nearby: HeaderPreload | null } = { route: null, nearby: null };
      const epochs = { route: 0, nearby: 0 };
      const combined: HeaderPreload = {
        observe(records) { jobs.route?.observe(records); jobs.nearby?.observe(records); },
        stop() { if (!live) return; historyShare.current = {}; for (const key of ['route', 'nearby'] as const) { epochs[key]++; jobs[key]?.stop(); jobs[key] = null; } },
        foreground(ids) { return [...(jobs.route?.foreground(ids) ?? []), ...(jobs.nearby?.foreground(ids) ?? [])]; },
        take(ids, port, reset) { return jobs.route?.take(ids, port, reset) ?? null; },
      };
      preload.current = combined;
      const chain: Element[] = []; let parent: Element | null = node;
      while (parent && parent !== document.body && chain.length < 32) { chain.push(parent); parent = parent.parentElement; }
      const headerLive = () => live && generationActive && node.isConnected && parent === document.body && !document.hidden
        && chain.every((element, i) => element.parentElement === (chain[i + 1] ?? parent));
      const stop = () => { if (live) combined.stop(); };
      const start = (nearby?: readonly string[]) => {
        if (!live) return;
        const key = nearby ? 'nearby' : 'route';
        epochs[key]++; jobs[key]?.stop(); jobs[key] = null;
        const hint = route();
        if (!hint || !coverage || !headerLive() || core !== 'connected' || liveConnection.current !== 'connected') return;
        if (!runtime && generationActive) runtime = createGalleryRuntime(sdk);
        if (!runtime) return;
        const owner = runtime, controller = new AbortController(), currentEpoch = epochs[key];
        const sharedAtBirth = historyShare.current, lineage = { current: {} };
        const resetReader = () => { lineage.current = {}; };
        let consumed = false, complete = false, arrived = false, stopped = false, adoptable = !nearby;
        const leases: ReturnType<GalleryRuntime['retain']>[] = [], media: { id: string; resource: NonNullable<Awaited<ReturnType<GalleryRuntime['image']>>>; transferred: boolean }[] = [], unwatch: (() => void)[] = [];
        const mediaKeys = new Set<string>();
        const current = () => !stopped && !controller.signal.aborted && currentEpoch === epochs[key] && headerLive()
          && core === 'connected' && liveConnection.current === 'connected' && route()?.href === hint.href && owner.isActive();
        const discovery = owner.retainDiscoveryDemand(); discovery?.visible(true);
        const reader = createGalleryAnchorReader({ async timeline(input) {
          if (!current()) throw Error('Preload retired.');
          const readerMark = lineage.current;
          const read = owner.readTimeline(input, nativeTimeline.port, { scope: sharedAtBirth, speculative: true,
            current: () => current() && historyShare.current === sharedAtBirth && lineage.current === readerMark });
          if (!input.beforeAnchorId) discovery?.warm(threadId, true);
          const result = await read; if (!current()) throw Error('Preload retired.');
          return result.state === 'ready' ? result.value : { state: 'capacity' };
        } }, threadId, resetReader);
        const timer = setTimeout(() => controller.abort('deadline'), 5000);
        const handle: HeaderPreload = {
          stop() {
            if (stopped) return; stopped = true; clearTimeout(timer); controller.abort('preload-retired');
            if (!consumed) reader.invalidate();
            discovery?.dispose(); for (const stop of unwatch) stop(); for (const item of media) if (!item.transferred) item.resource.dispose(); for (const lease of leases) lease.dispose();
          },
          foreground(ids) {
            if (!current() || !complete) return [];
            const mapped = resolveGalleryBridge(node); if (!mapped) return [];
            const rows = [...mapped.pane.querySelectorAll<HTMLElement>('[data-timeline-row-id]')]; if (rows.length > 1000) return [];
            return media.flatMap(item => {
              const matches = rows.filter(row => row.dataset.timelineRowId === item.id);
              if (item.transferred || !ids.includes(item.id) || matches.length !== 1 || matches[0]!.closest('[data-thread-window]') !== mapped.pane) return [];
              // Transfer this same passive byte resource to actual foreground
              // demand. It grants no placement/action/custom authority.
              item.resource.promote(); item.transferred = true;
              return [{ id: item.id, dispose: () => item.resource.dispose() }];
            });
          },
          observe(records) {
            if (consumed || stopped || !adoptable) return;
            const own = '[data-turn-results-bridge], [data-turn-results-sentinel], [data-turn-results-gallery], [data-turn-results-notice]';
            const native = records.filter(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest(own)
              && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.matches(own))));
            if (!native.length) return;
            // One first arrival only. Every changed node must be in a proved
            // newly attached native structure; unknown history is irreversible.
            const mapped = resolveGalleryBridge(node), known = new Set(reader.scopeRows().map(row => row.id));
            const lists = mapped ? [...mapped.pane.querySelectorAll('[data-timeline-row-list="top-level"]')] : [];
            const list = lists.length === 1 ? lists[0]! : null;
            const items = list ? [...list.children].filter(child => child.hasAttribute('data-timeline-items')) : [];
            const rows = mapped ? [...mapped.pane.querySelectorAll<HTMLElement>('[data-timeline-row-id]')] : [];
            const ids = rows.map(row => row.dataset.timelineRowId!);
            let visited = 0;
            const allowed = current() && complete && !arrived && native.length <= 64 && list && items.length === 1
              && rows.length > 0 && rows.length <= 1000 && new Set(ids).size === ids.length
              && rows.every(row => known.has(row.dataset.timelineRowId!) && row.parentElement === items[0]
                && row.closest('[data-thread-window]') === mapped!.pane && row.closest('[data-timeline-row-list]') === list)
              && native.every(record => record.type === 'childList' && !record.removedNodes.length && record.addedNodes.length > 0
                && [...record.addedNodes].every(root => {
                  if (!(root instanceof Element) || ![mapped!.pane, list, items[0], ...rows].includes(root as HTMLElement)) return false;
                  const walker = document.createTreeWalker(root, 0xffffffff); let changed: Node | null = root;
                  do {
                    if (++visited > 128 || ![1, 3, 8].includes(changed.nodeType)) return false;
                    if (changed instanceof Element && (changed.matches('[data-turn-results-gallery], [data-turn-results-bridge], [data-turn-results-sentinel]')
                      || changed.matches('[data-thread-window], [data-timeline-row-list], [data-timeline-items], [data-timeline-row-id]')
                      && ![mapped!.pane, list, items[0], ...rows].includes(changed as HTMLElement))) return false;
                    changed = walker.nextNode();
                  } while (changed);
                  return true;
                }));
            if (!allowed) { if (historyShare.current === sharedAtBirth) historyShare.current = {}; adoptable = false; for (const lease of leases) lease.passive(); }
            else arrived = true;
          },
          take(ids, port, reset) {
            if (consumed || !adoptable || !arrived || !complete || !current() || !ids.length) return null;
            if (!reader.adopt(ids, port, reset)) { adoptable = false; reader.invalidate(); for (const lease of leases) lease.passive(); return null; }
            consumed = true; clearTimeout(timer);
            return { reader, rows: reader.scopeRows() };
          },
        };
        jobs[key] = handle;
        void (async () => {
          let proof = nearby ? await reader.read(nearby, controller.signal) : await reader.nearby(hint.sequence, controller.signal);
          if (proof.automatic && current()) proof = nearby ? await reader.read(nearby, controller.signal) : await reader.nearby(hint.sequence, controller.signal, false);
          if (!current()) return;
          complete = !proof.continued && !proof.capacity; clearTimeout(timer);
          for (const anchor of proof.anchors.slice(0, nearby ? 2 : 1)) {
            const lease = owner.retain(anchor, true, undefined, true); if (lease.capacity) continue;
            if (!adoptable) lease.passive();
            leases.push(lease);
            const warmImages = () => {
              if (!current() || !lease.readComplete) return;
              for (const row of lease.store.state.rows) {
                if (mediaKeys.size >= 2) break;
                if (mediaKeys.has(row.key) || row.resolution?.fallback.kind !== 'image') continue;
                mediaKeys.add(row.key);
                void owner.image(row, true, true, controller.signal, sdk.plugins).then(resource => {
                  if (!resource) return; if (!current()) resource.dispose(); else media.push({ id: anchor.rowId, resource, transferred: false });
                }).catch(() => {});
              }
            };
            const subscription = lease.store.subscribe(warmImages); unwatch.push(() => subscription.unsubscribe()); warmImages();
          }
        })().catch(() => handle.stop());
      };
      nearbyDemand.current = ids => {
        if (!live) return;
        if (ids.length) start(ids.slice(0, 2));
        else { epochs.nearby++; jobs.nearby?.stop(); jobs.nearby = null; }
      };
      const stops: (() => void)[] = [];
      try {
        stops.push(sdk.subscribe({ event: 'thread:changed', threadId, callback: stop }));
        stops.push(sdk.subscribe({ event: 'system:config-changed', callback: stop }));
        stops.push(sdk.subscribe({ event: 'realtime:connection', callback(event) {
          if (!live) return;
          const before = core; core = event?.state ?? 'unknown';
          if (core !== 'connected') stop(); else if (before !== core || event.reconnected) start();
        } }));
        coverage = true; if (core === 'connected') start();
      } catch { stop(); live = false; if (preload.current === combined) preload.current = null; nearbyDemand.current = null; for (const stop of stops) stop(); return; }
      const visible = () => { if (document.hidden) stop(); else start(); };
      const navigation = () => { stop(); start(); };
      window.addEventListener('hashchange', navigation); window.addEventListener('popstate', navigation); document.addEventListener('visibilitychange', visible);
      return () => { stop(); live = false; if (preload.current === combined) preload.current = null; nearbyDemand.current = null; for (const unsubscribe of stops) unsubscribe(); window.removeEventListener('hashchange', navigation); window.removeEventListener('popstate', navigation); document.removeEventListener('visibilitychange', visible); };
    }, [threadId, projectId, sdk, connection]);
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
        preload.current?.observe(records);
        if (moved(records)) { update(true); return; }
        if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(changed => changed instanceof Element
          && !changed.matches('[data-turn-results-gallery], [data-turn-results-notice], [data-turn-results-sentinel]')
          && (changed.matches('[data-thread-window], [data-split-pane-id]') || changed.querySelector('[data-thread-window], [data-split-pane-id]'))))) update();
      });
      const parentObserver = new MutationObserver(records => { if (active && moved(records)) { preload.current?.stop(); update(true); } });
      const update = (retire = false) => {
        if (!active) return;
        const next = resolveGalleryBridge(node);
        const scope = next?.scope ?? node.closest('[data-split-pane-id]') ?? observed?.scope;
        const pane = next?.pane ?? null;
        // A missing mapping retains one known parent only to observe recovery;
        // it grants no authority. A valid mapping always binds its actual parent.
        const parent = next ? next.scope.parentElement : observed?.parent ?? scope?.parentElement ?? null;
        const rebound = observed?.scope !== scope || observed?.pane !== pane || observed?.parent !== parent;
        if (retire || observed && rebound) { bridgeToken.current = {}; historyShare.current = {}; }
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
      return () => { active = false; bridgeToken.current = {}; historyShare.current = {}; observer.disconnect(); parentObserver.disconnect(); observed = null; };
    }, [threadId]);
    const bridgeCurrent = useCallback(() => {
      const next = marker.current && resolveGalleryBridge(marker.current);
      return Boolean(mapping && mapping.token === bridgeToken.current && next?.pane === mapping.pane && next.scope === mapping.scope && next.scope.parentElement === mapping.parent);
    }, [mapping]);
    return <><span ref={marker} hidden aria-hidden="true" data-turn-results-bridge="" />
      {mapping && createPortal(<Sentinel threadId={threadId} bridgeCurrent={bridgeCurrent} preload={preload} nearby={nearbyDemand} historyShare={historyShare} timelineClient={timelineClient} />, mapping.pane, threadId)}</>;
  }
  function Sentinel({ threadId, bridgeCurrent, preload, nearby, historyShare, timelineClient }: { threadId: string; bridgeCurrent(): boolean; preload: { current: HeaderPreload | null }; nearby: { current: ((ids: readonly string[]) => void) | null }; historyShare: { current: object }; timelineClient(): GalleryTimelinePort | null }) {
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
    const handle = useRef<ReturnType<typeof mountGalleryPane> | null>(null);
    const reader = useRef<ReturnType<typeof createGalleryAnchorReader> | null>(null);
    const foregroundPort = useRef<GalleryTimelinePort | null>(null);
    const readerLineage = useRef<object>({});
    const foregroundMedia = useRef<{ id: string; dispose(): void }[]>([]);
    const historyRows = useRef(new Map<string, { id: string; turnId: string | null }>());
    const historyBytes = useRef(0);
    const refreshTurns = useRef<Set<string> | null>(new Set());
    const targets = useRef<string[]>([]);
    const request = useRef<AbortController | null>(null), scope = useRef(0), boundary = useRef(0);
    const historyPass = useRef<{ generation: number; version: number; targets: string[]; started: boolean } | null>(null);
    const semanticScope = useRef<number | null>(null);
    const semanticConnection = useRef<'connected' | 'connecting' | 'disconnected' | 'unknown'>('unknown');
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
      let dirty = false, disposed = false, timelineRemaining = 8, unsubscribe = () => {};
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
              check();
              if (!timelineRemaining) throw Error('Timeline action budget reached.');
              timelineRemaining--; return sdk.threads.timeline({ ...nativeInput, signal });
            }, true);
            check(); return read.state === 'ready' ? read.value : { state: 'capacity' };
          } }, threadId);
          if (!timelineRemaining) return decline('This result could not be checked within its history limit.');
          let proof = await untilAborted(fresh.read([input.scope.boundary.rowId], controller.signal, false, Math.min(4, timelineRemaining)), controller.signal);
          // Continue only this NEW latest/snapshot chain. Both units and any
          // dirty restart spend the same eight-read action budget. Each public
          // page enters the shared FIFO lane, so other demands can run.
          if (proof.automatic && !dirty && timelineRemaining)
            proof = await untilAborted(fresh.read([input.scope.boundary.rowId], controller.signal, false, Math.min(4, timelineRemaining)), controller.signal);
          if (dirty && pass === 0 && timelineRemaining) continue;
          check();
          if (proof.capacity) return decline('Results read capacity reached. Try Open after another view settles.');
          const anchor = proof.anchors.find(value => value.rowId === input.scope.boundary.rowId);
          if (!anchor || !sameBoundary(anchor, input.scope.boundary)) return decline('This result needs a complete current turn boundary before it can open.');
          const read = await owner.readScope(threadId, controller.signal, signal => {
            check(); return owner.backend.read(threadId, input.scope.boundary.turnId, signal, input.after);
          }, true);
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
      if (foregroundPort.current && !handle.current?.pendingRoots && semanticScope.current === scope.current
        && semanticConnection.current === 'connected' && previousConnection.current === 'connected') {
        const warmed = preload.current?.take(targets.current, foregroundPort.current, () => { readerLineage.current = {}; });
        if (warmed) {
          reader.current = warmed.reader; historyRows.current = new Map(warmed.rows.map(row => [row.id, row]));
          historyBytes.current = new TextEncoder().encode(JSON.stringify(warmed.rows)).length;
        }
      }
      queued.current = false;
      const controller = new AbortController(), generation = scope.current, version = boundary.current;
      const priorPass = historyPass.current;
      historyPass.current = { generation, version, targets: [...targets.current], started: !!priorPass?.started
        && priorPass.generation === generation && priorPass.version === version
        && priorPass.targets.length === targets.current.length && priorPass.targets.every(id => targets.current.includes(id)) };
      request.current = controller;
      let continuing = false;
      const timer = setTimeout(() => controller.abort('deadline'), 5000);
      try {
        const result = await reader.current.read(targets.current, controller.signal);
        if (controller.signal.aborted || !generationActive || !bridgeCurrent() || generation !== scope.current || version !== boundary.current) return;
        if (!runtime) runtime = createGalleryRuntime(sdk);
        const scopeRows = [...historyRows.current.values()];
        if (handle.current) handle.current.update(result.anchors, result.checked, scopeRows);
        else {
          const owner = runtime;
          handle.current = mountGalleryPane(sentinel.current, threadId, result.anchors, (host, anchor, current, lifetime, actionScope, displayCurrent) => {
            const presentationRoot = owner.presentationRoot(lifetime, current, displayCurrent);
            const root = createRoot(host); let shown = false, selected = anchor, verified = true;
            const render = () => root.render(<TurnGallery anchor={selected} runtime={owner} sdk={sdk} navigate={navigate}
              current={current} displayCurrent={displayCurrent} lifetime={lifetime} visible={shown} shell={host} demanded={verified} presentationRoot={presentationRoot} actionScope={actionScope} requestOpen={requestOpen} />);
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
        // Only one queued second four-page slice for this live target epoch.
        // The private reader hard-stops the chain at eight; no timer retries.
        if (result.automatic) { queued.current = true; continuing = true; }
        // Missing/limited native history never invents a completed turn or a
        // collection surface. Only proved meaningful results render inline.
      } catch (failure) {
        if (failure instanceof GalleryBoundaryError && generation === scope.current && version === boundary.current) handle.current?.update([], targets.current);
      } finally {
        clearTimeout(timer);
        if (request.current === controller) {
          if (!continuing) historyPass.current = null;
          request.current = null;
          if (queued.current && mutationTimer.current === null && generationActive && generation === scope.current && !document.hidden) queueMicrotask(() => void refresh());
        }
      }
    }, [threadId, sdk, navigate, requestOpen, bridgeCurrent]);
    const invalidateBoundary = useCallback((mutation = false, changedRows: readonly string[] | null = null) => {
      if (!reader.current || !generationActive) return;
      for (const item of foregroundMedia.current) item.dispose(); foregroundMedia.current = [];
      historyShare.current = {}; historyPass.current = null;
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
        mutationTimer.current = null;
        // Finish synchronous Header/Sentinel reset delivery before capturing
        // a new sharing token. Revocation itself remains immediate.
        queueMicrotask(() => void refresh());
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
      if (prior === connection) return;
      if (connection === 'connected') { rediscover.current = true; invalidateBoundary(); }
      else invalidateBoundary(true, null);
    }, [connection, invalidateBoundary]);
    useLayoutEffect(() => {
      if (!threadId || !sentinel.current) return;
      scope.current++;
      if (!runtime && generationActive) runtime = createGalleryRuntime(sdk);
      if (!runtime) return;
      const owner = runtime;
      const readerScope = scope.current;
      let discoveryDemand = owner.retainDiscoveryDemand();
      // Subscribe before the first latest read. These are positive reset
      // signals, not an acknowledgement/replay or proof from event silence.
      let listening = true;
      semanticConnection.current = 'unknown';
      const subscriptions: (() => void)[] = [];
      const semanticChanged = () => {
        if (listening && readerScope === scope.current && generationActive) invalidateBoundary(true, null);
      };
      try {
        subscriptions.push(sdk.subscribe({ event: 'thread:changed', threadId, callback(event) {
          if (typeof event?.id === 'string' && event.id !== threadId) return;
          // Backfill may retain timelineSequence; unknown changes are hard too.
          semanticChanged();
        } }));
        subscriptions.push(sdk.subscribe({ event: 'system:config-changed', callback: semanticChanged }));
        subscriptions.push(sdk.subscribe({ event: 'realtime:connection', callback(event) {
          if (!listening || readerScope !== scope.current || !generationActive) return;
          const next = event?.state === 'connected' || event?.state === 'connecting' || event?.state === 'disconnected'
            ? event.state : 'unknown';
          const prior = semanticConnection.current; semanticConnection.current = next;
          // This is live transport coverage, not a subscription acknowledgement
          // or semantic replay. Any existing chain/proof must start fresh when
          // coverage changes or reconnects, including unknown/disconnected.
          if ((next !== prior || next !== 'connected' || event?.reconnected)
            && (request.current || historyRows.current.size || handle.current)) semanticChanged();
        } }));
        semanticScope.current = readerScope;
      } catch {
        // Older/unavailable public subscriptions keep conservative resets.
        semanticScope.current = null;
        for (const stop of subscriptions.splice(0)) stop();
      }
      const port: GalleryTimelinePort = { async timeline(input) {
        const readerMark = readerLineage.current, shared = historyShare.current, client = timelineClient() ?? sdk.threads;
        const pending = owner.readTimeline(input, client, { scope: shared,
          current: () => generationActive && readerScope === scope.current && bridgeCurrent()
            && readerLineage.current === readerMark && historyShare.current === shared && timelineClient() === client
            && semanticConnection.current === 'connected' && previousConnection.current === 'connected',
          dispatched() {
            const pass = historyPass.current;
            if (!input.beforeAnchorId && readerLineage.current === readerMark && pass && request.current?.signal === input.signal
              && pass.generation === readerScope && pass.version === boundary.current) pass.started = true;
          },
        });
        // Real native history gets the first FIFO slot. Readiness-only
        // discovery may then negotiate before the older boundary walk ends.
        if (!input.beforeAnchorId) discoveryDemand?.warm(threadId);
        const read = await pending;
        input.signal.throwIfAborted();
        if (!generationActive || readerScope !== scope.current || !owner.isActive()) throw Error('Timeline read retired.');
        if (read.state === 'ready' && !('state' in read.value)) {
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
      } };
      foregroundPort.current = port; reader.current = createGalleryAnchorReader(port, threadId, () => { readerLineage.current = {}; });
      const stop = observeGalleryDemand(sentinel.current, (ids, _limited, reason, changedRows) => {
        targets.current = ids;
        for (const item of foregroundMedia.current) if (!ids.includes(item.id)) item.dispose();
        foregroundMedia.current = foregroundMedia.current.filter(item => ids.includes(item.id));
        for (const item of preload.current?.foreground(ids) ?? []) {
          if (foregroundMedia.current.length < 2) foregroundMedia.current.push(item); else item.dispose();
        }
        discoveryDemand ??= owner.retainDiscoveryDemand();
        discoveryDemand?.visible(ids.length > 0);
        const pass = historyPass.current;
        if (reason === 'hydration' && semanticScope.current === readerScope && semanticConnection.current === 'connected'
          && previousConnection.current === 'connected' && pass?.started
          && request.current && !request.current.signal.aborted && pass.generation === scope.current && pass.version === boundary.current
          && pass.targets.length === ids.length && pass.targets.every(id => ids.includes(id))) {
          const affected = handle.current?.invalidate(changedRows ?? undefined, true) ?? [];
          if (openValidation.current && affected.includes(openValidation.current.turnId)) openValidation.current.cancel();
          if (refreshTurns.current) for (const turn of affected) {
            refreshTurns.current.add(turn);
            if (refreshTurns.current.size > GALLERY_PANE_LIMITS.roots) { refreshTurns.current = null; break; }
          }
          // Only an already-running NEW latest chain can absorb this proved
          // body hint. Its original timer/cursors/snapshot checks stay intact.
        } else if (reason === 'demand') void refresh();
        else invalidateBoundary(reason === 'mutation' || reason === 'hydration', changedRows);
      }, ids => nearby.current?.(ids));
      const visibility = () => { if (document.hidden) { discoveryDemand?.visible(false); invalidateBoundary(); request.current?.abort(); } };
      document.addEventListener('visibilitychange', visibility);
      return () => {
        for (const item of foregroundMedia.current) item.dispose(); foregroundMedia.current = [];
        historyShare.current = {}; listening = false; semanticScope.current = null; semanticConnection.current = 'unknown'; historyPass.current = null;
        for (const unsubscribe of subscriptions) unsubscribe();
        scope.current++; boundary.current++; queued.current = false;
        if (mutationTimer.current !== null) clearTimeout(mutationTimer.current); mutationTimer.current = null;
        stop(); discoveryDemand?.dispose(); document.removeEventListener('visibilitychange', visibility); request.current?.abort(); reader.current = null; foregroundPort.current = null;
        if (handle.current) { void retirePane(handle.current); handle.current = null; }
        targets.current = []; historyRows.current.clear(); historyBytes.current = 0; refreshTurns.current = new Set();
      };
    }, [threadId, sdk, refresh, invalidateBoundary, timelineClient]);
    return <span ref={sentinel} hidden data-turn-results-sentinel="" />;

  }

  app.slots.experimental_threadHeaderAction({ id: 'turn-results-bridge', title: 'Turn results bridge', component: HeaderBridge });
});
