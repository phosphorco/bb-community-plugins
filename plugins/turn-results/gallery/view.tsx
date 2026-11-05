import type { BbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from '@tanstack/react-store';
import { canonicalByteLength, canonicalJson } from '@phosphorco/bb-turn-results';
import { navigateResult } from '@phosphorco/bb-turn-results/bb';
import type { GalleryObservation } from './index.ts';
import type { GalleryAnchor } from './anchors.ts';
import type { GalleryActionScope, GalleryActionCapture } from './pane.ts';
import type { GalleryRuntime, GalleryPresentationRoot } from './runtime.ts';
import type { PresentationLifetime } from './presentation-lifetime.ts';
import { HostedCanvas } from './presentation.ts';
import { lookupPresentation, subscribePresentations } from '@phosphorco/bb-context-recognition/presentation';
import { paneColumns, packResults } from './packing.ts';
import { projectResults } from './projection.ts';

type Sdk = ReturnType<typeof useSdk>;
type MediaHandle = ReturnType<GalleryRuntime['media']['retain']>;
function LoadedImage({ handle, alt, open, actionsReady }: { handle: MediaHandle; alt: string; open: OpenClick; actionsReady: boolean }) {
  const state = useSelector(handle.store);
  const [decodeError, setDecodeError] = useState(false);
  if (state.url && !decodeError) return <button className="tr-image-action" onClick={open} disabled={!actionsReady} aria-label={`Open ${alt}`} title="Image bytes match the saved generation">
    <img src={state.url} alt={alt} onLoad={event => {
      const image = event.currentTarget;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 32768 || image.naturalHeight > 32768 || image.naturalWidth * image.naturalHeight > 16777216) setDecodeError(true);
    }} onError={() => setDecodeError(true)} />
  </button>;
  return <div className="tr-placeholder"><span>{decodeError ? 'Image could not be displayed' : state.state === 'loading' ? 'Loading image…' : state.error ?? 'Generated image'}</span>
    {(decodeError || state.state === 'error') && <button disabled={!actionsReady} onClick={() => { if (!actionsReady) return; setDecodeError(false); handle.retry(); }}>Retry image</button>}</div>;
}
function ImageCanvas({ row, runtime, sdk, open, lifetime, actionsReady }: { row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; open: OpenClick; lifetime: AbortSignal; actionsReady: boolean }) {
  const host = useRef<HTMLDivElement>(null), [handle, setHandle] = useState<MediaHandle | null>(null);
  const resolution = row.resolution;
  const location = resolution?.provenance.artifactLocation;
  const sha256 = location?.state === 'verified' ? location.sha256 : undefined;
  const route = resolution?.route;
  useLayoutEffect(() => {
    if (!sha256 || route?.kind !== 'file' || row.owner !== 'turn-result-images' || !host.current) return;
    let live = !lifetime.aborted, resource: MediaHandle | null = null;
    const abort = () => { live = false; resource?.dispose(); };
    lifetime.addEventListener('abort', abort, { once: true });
    void runtime.image(row, false, false, lifetime, sdk.plugins).then(next => {
      if (!live) { next?.dispose(); return; }
      resource = next;
      if (!resource) return;
      setHandle(resource);
      observer.observe(host.current!);
    }).catch(() => { /* Data fallback and native open action remain accessible. */ });
    const observer = new IntersectionObserver(entries => { if (live && resource) resource.visible(entries.some(entry => entry.isIntersecting)); });
    return () => { lifetime.removeEventListener('abort', abort); live = false; observer.disconnect(); resource?.dispose(); };
  }, [runtime, sdk, row.key, sha256, route?.kind === 'file' ? canonicalJson(route.target) : '', lifetime]);
  const alt = resolution?.fallback.kind === 'image' ? resolution.fallback.alt : 'Result image';
  return <div ref={host} className="tr-canvas">{handle ? <LoadedImage handle={handle} alt={alt} open={open} actionsReady={actionsReady} /> : <div className="tr-placeholder">{resolution?.fallback.title ?? 'Image result'}</div>}</div>;
}
interface CardSite { key: string; retire(): void }
type OpenClick = (event: React.MouseEvent<HTMLButtonElement>) => void;
export type GalleryOpenOutcome = ReturnType<typeof navigateResult> | { state: 'declined'; reason: string };
export interface GalleryOpenRequest {
  after?: { seq: number; key: string } | undefined;
  expected: GalleryObservation; scope: GalleryActionCapture; signal: AbortSignal;
  currentRow(): GalleryObservation | null; watchCurrent(changed: () => void): () => void; consume(): boolean;
}
export type GalleryOpenPort = (input: GalleryOpenRequest) => Promise<GalleryOpenOutcome>;
/** Factual target, not clock-derived freshness or display ordering. */
export function openFingerprint(row: GalleryObservation): string | null {
  try { return canonicalJson({ key: row.key, owner: row.owner, identity: row.identity, resolution: row.resolution,
    corrections: row.corrections, unresolved: row.unresolved, sourceExpired: row.sourceExpired, retracted: row.retracted }, 16384); }
  catch { return null; }
}
export function openAvailable(row: GalleryObservation) {
  return Boolean(row.resolution && (row.resolution.route.kind === 'file' || row.resolution.route.kind === 'url') && row.resolution.availability.state !== 'unavailable'
    && !row.retracted && !row.sourceExpired && row.currentAvailability?.state !== 'unavailable');
}
// One explicit user intent in this loaded module/window; not a value store.
interface OpenOperation { cancel(): void; supersede(): void }
let pendingOpen: OpenOperation | null = null;
let openOutcome: symbol | null = null;
/** Visual text only. Full source title remains the action name/fingerprint. */
function visibleCardTitle(title: string): string {
  const visible = title.replace(/^Fixed in ([0-9a-fA-F]{8})[0-9a-fA-F]{32}\. /u, 'Fixed in $1… ').replace(/(?<![\p{L}\p{N}_])([0-9a-fA-F]{8})[0-9a-fA-F]{32}(?![\p{L}\p{N}_])/gu, '$1…');
  const points = Array.from(visible);
  if (points.length <= 95 && Array.from(title).length < 120) return visible;
  const limit = Math.min(95, points.length - 1);
  let prefix = points.slice(0, limit).join('');
  const boundary = prefix.lastIndexOf(' ');
  if (boundary >= prefix.length / 2) prefix = prefix.slice(0, boundary);
  return prefix.trimEnd() + '…';
}
export function ResultCard({ row, runtime, sdk, navigate, current, lifetime, presentationRoot, mode = 'docked', customEnabled = true,
  actionScope, requestOpen, currentRow, watchCurrent, readAfter, sourceChoice = false, displayCurrent = current, collectionReady = () => true }: {
  row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean; lifetime: AbortSignal;
  presentationRoot?: GalleryPresentationRoot | undefined; mode?: 'docked' | 'full'; customEnabled?: boolean;
  actionScope?: GalleryActionScope | undefined; requestOpen?: GalleryOpenPort | undefined;
  readAfter?: { seq: number; key: string } | undefined; sourceChoice?: boolean;
  currentRow?: (() => GalleryObservation | null) | undefined; watchCurrent?: ((changed: () => void) => () => void) | undefined;
  displayCurrent?: (() => boolean) | undefined;
  collectionReady?: (() => boolean) | undefined;
}) {
  const site = useRef<CardSite | null>(null);
  const card = useRef<HTMLElement>(null), operation = useRef<OpenOperation | null>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [openStatus, setOpenStatus] = useState<string | null>(null);
  const value = row.resolution;
  const fact = openFingerprint(row);
  useLayoutEffect(() => { setOpenStatus(null); return () => operation.current?.cancel(); }, [fact, lifetime]);
  const showOutcome = (result: GalleryOpenOutcome) => setOpenStatus(result.state === 'handled' ? null
      : result.state === 'declined' ? result.reason
      : result.state === 'invalid' ? 'The saved result destination is invalid.'
      : result.state === 'unavailable' ? 'This result has no available destination.'
      : 'The Open request was not accepted. You can try Open again.');
  const open: OpenClick = event => {
    // A later explicit action retires outcome ownership, including when the
    // new action takes the direct/unavailable branch and creates no request.
    const outcome = Symbol(); openOutcome = outcome;
    operation.current?.supersede(); pendingOpen?.supersede();
    if (!collectionReady()) return; // Provisional positives cannot start direct Open or Checking/capture.
    const latest = currentRow ? currentRow() : row;
    // Saved unavailable is authoritative even when the display clock masks it.
    if (!latest || !openAvailable(latest)) { setOpenStatus('This saved result is unavailable.'); return; }
    if (!fact || openFingerprint(latest) !== fact) { setOpenStatus('This saved result changed. Review its current details.'); return; }
    if (current()) { showOutcome(navigateResult(navigate, value!.route)); return; }
    const scope = actionScope?.capture(), element = card.current;
    if (!fact || !scope || !scope.live() || !element || !requestOpen || !currentRow || !watchCurrent || lifetime.aborted || !runtime.isActive()) {
      scope?.release(); setOpenStatus('This result needs verification before it can open. Try Open again after verification.'); return;
    }
    const controller = new AbortController(), initiating = event.nativeEvent;
    let consumed = false, cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      document.removeEventListener('pointerdown', later, true); document.removeEventListener('keydown', later, true);
      document.removeEventListener('focusin', focus, true); document.removeEventListener('visibilitychange', hidden);
      lifetime.removeEventListener('abort', cancel);
      if (pendingOpen === owned) pendingOpen = null;
    };
    const cancel = () => { controller.abort('retired'); cleanup(); };
    const supersede = () => {
      if (operation.current === owned) {
        operation.current = null;
        const latest = currentRow();
        if (!lifetime.aborted && card.current === element && element.isConnected && latest && openFingerprint(latest) === fact)
          setOpenStatus(previous => previous === 'Checking this saved result…' ? null : previous);
      }
      cancel();
    };
    const owned = { cancel, supersede };
    const later = (next: Event) => { if (next !== initiating) cancel(); };
    const focus = (next: Event) => { if (next !== initiating && !element.contains(next.target as Node)) cancel(); };
    const hidden = () => { if (document.hidden) cancel(); };
    pendingOpen = owned; operation.current = owned;
    // Initiating pointerdown/keydown already happened. Its own native click
    // dispatch is excluded; only a later gesture or departing focus cancels.
    document.addEventListener('pointerdown', later, true); document.addEventListener('keydown', later, true);
    document.addEventListener('focusin', focus, true); document.addEventListener('visibilitychange', hidden);
    lifetime.addEventListener('abort', cancel, { once: true });
    setOpenStatus('Checking this saved result…');
    const consume = () => {
      const latest = currentRow();
      if (consumed || controller.signal.aborted || pendingOpen !== owned || operation.current !== owned || !scope.live()
        || !element.isConnected || !latest || openFingerprint(latest) !== fact) return false;
      consumed = true; cleanup(); return true;
    };
    void requestOpen({ after: readAfter, expected: row, scope, signal: controller.signal, currentRow, watchCurrent, consume }).then(result => {
      const latest = currentRow();
      // A revoked action capture never regains action authority. A separately
      // confirmed current card may still display that old intent's decline.
      if (openOutcome === outcome && operation.current === owned && !lifetime.aborted && element.isConnected && (scope.live() || current()) && latest && openFingerprint(latest) === fact) showOutcome(result);
    }, () => {
      if (openOutcome === outcome && operation.current === owned && !lifetime.aborted && element.isConnected && scope.live()) setOpenStatus('This result could not be checked. Try Open again.');
    }).finally(() => {
      cleanup(); scope.release();
      if (operation.current === owned) {
        operation.current = null;
        const latest = currentRow();
        // Clear only this operation's pending marker on this exact card. Never
        // publish an old outcome onto a replacement/factually changed card.
        if (!lifetime.aborted && card.current === element && element.isConnected && latest && openFingerprint(latest) === fact)
          setOpenStatus(previous => previous === 'Checking this saved result…' ? null : previous);
      }
    });
  };
  const expansionAllowed = () => {
    const entry = value?.presentation && lookupPresentation(row.owner, value.presentation.schema);
    // Old registrations omit this additive metadata and keep their full view.
    return !entry || !('supportsExpansion' in entry) || entry.supportsExpansion !== false;
  };
  const supportsExpansion = useSyncExternalStore(subscribePresentations, expansionAllowed, () => true);
  const full = () => {
    if (!collectionReady() || !current() || !value || !site.current || !runtime.isActive() || !expansionAllowed()) return;
    // Contributor controls retire with the dock. The consumer action survives
    // that handoff; dialog close still checks its exact native/revision scope.
    runtime.openDialog({ row, sdk, navigate, siteKey: site.current.key, retireDock: site.current.retire,
      opener: expandButton.current, openerCurrent: current });
  };
  const destination = Boolean(value && (value.route.kind === 'file' || value.route.kind === 'url'));
  const caption = useSelector(runtime.captionLabels, () => runtime.caption(row));
  const title = value?.fallback.title.replace(/\s+/gu, ' ').trim().slice(0, 256);
  const visibleTitle = !value?.presentation && value?.fallback.kind === 'card'
    ? title && visibleCardTitle(title) : title;
  const detail = value && 'description' in value.fallback ? value.fallback.description : undefined;
  const description = detail?.replace(/\s+/gu, ' ').trim().slice(0, 140);
  const target = value?.route.kind === 'url' ? value.route.href : value?.route.kind === 'file' ? value.route.target.path : '';
  const openName = `Open ${title || caption}${target ? ` — ${target}` : ''}`;
  const content = <>{title && <span className="tr-result-title">{visibleTitle}</span>}
    {description && description !== title && description !== caption && <span className="tr-excerpt">{description}</span>}</>;
  if (sourceChoice) return <article ref={card}>
    <button onClick={open} disabled={!collectionReady()} aria-label={`${row.owner}: ${openName}`}>{row.owner}</button>
    {openStatus && <small className="tr-freshness" role="status" data-turn-result-open-status="">{openStatus}</small>}
  </article>;
  const fallback = value?.fallback.kind === 'image' ? <ImageCanvas row={row} runtime={runtime} sdk={sdk} open={open} lifetime={lifetime} actionsReady={collectionReady()} />
    : destination ? <button className="tr-canvas tr-data-action" onClick={open} disabled={!collectionReady()} aria-label={openName}>{content}</button>
      : <div className="tr-canvas tr-data-action">{content}</div>;
  return <article ref={card} className="tr-card" data-result-key={row.key}>
    <PresentationCanvas row={row} runtime={runtime} sdk={sdk} navigate={navigate} current={current} displayCurrent={displayCurrent}
      bindingCurrent={() => { const latest = currentRow ? currentRow() : row; return Boolean(latest && !latest.sourceExpired && !latest.retracted
        && !latest.unresolved && fact && openFingerprint(latest) === fact); }} lifetime={lifetime}
      presentationRoot={presentationRoot} mode={mode} enabled={customEnabled} site={site} fallback={fallback} />
    <div className="tr-caption"><span>{value?.fallback.kind !== 'image' && title === caption ? null : caption}</span><div>
      {mode === 'docked' && value?.presentation && supportsExpansion && <button ref={expandButton} onClick={full} disabled={!collectionReady()} className="tr-expand-icon" aria-label={`Expand ${title || caption}`} title={`Expand ${title || caption}`}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
      </button>}
      {destination && (value?.presentation || value?.fallback.kind === 'image') && <button onClick={open} disabled={!collectionReady()} className={mode === 'docked' ? supportsExpansion ? 'tr-open-icon' : 'tr-open-primary' : undefined} aria-label={openName} title="Open result">
        {mode === 'docked' && supportsExpansion ? <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="M6 3H3v10h10v-3M9 3h4v4M7 9l6-6" /></svg> : 'Open'}
      </button>}
    </div></div>
    {openStatus && <small className="tr-freshness" role="status" data-turn-result-open-status="">{openStatus}</small>}
  </article>;
}
function PresentationCanvas({ row, runtime, sdk, navigate, current, displayCurrent, bindingCurrent, lifetime, presentationRoot, mode, enabled, site, fallback }: {
  row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean; lifetime: AbortSignal;
  displayCurrent(): boolean;
  bindingCurrent(): boolean;
  presentationRoot?: GalleryPresentationRoot | undefined; mode: 'docked' | 'full'; enabled: boolean;
  site: { current: CardSite | null }; fallback: React.ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null), latest = useRef({ current, displayCurrent, bindingCurrent, row, enabled });
  const ownedSite = useRef<PresentationLifetime | null>(null);
  const [scope, setScope] = useState<PresentationLifetime | null>(null), [retry, setRetry] = useState(0);
  const [fallbackFocused, setFallbackFocused] = useState(false);
  const [ready, setReady] = useState<{ id: number; key: string } | null>(null), [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ maxWidth: 320, maxHeight: 240, preferredHeight: 240 });
  const readyPlugins = useSelector(runtime.readyOwners), dialogs = useSelector(runtime.dialogSites);
  const presentation = row.resolution?.presentation;
  const authorityKey = canonicalJson([enabled, displayCurrent(), row.owner, row.identity, row.resolution?.revision ?? null, presentation ?? null]);
  const [committedAuthority, setCommittedAuthority] = useState<string | null>(null);
  // Public host availability is calculated during render. Publish a committed
  // authority change before allowing that calculation to reuse this site; a
  // layout-ref update alone provides no subsequent render on unchanged recovery.
  useLayoutEffect(() => { latest.current = { current, displayCurrent, bindingCurrent, row, enabled }; setCommittedAuthority(authorityKey); });
  useLayoutEffect(() => {
    const node = container.current;
    if (!presentation || !node || lifetime.aborted || !enabled) return;
    const root = presentationRoot ?? runtime.presentationRoot(lifetime, () => latest.current.current(), () => latest.current.displayCurrent());
    const key = canonicalJson([root.id, row.key]);
    const owned = root.site(row.key, { visible: false, focused: false, dialog: mode === 'full', order: root.id, activation: 0 }, () =>
      latest.current.enabled && latest.current.current() && latest.current.bindingCurrent() && runtime.isReadyOwner(latest.current.row.owner)
      && lookupPresentation(latest.current.row.owner, latest.current.row.resolution?.presentation?.schema ?? '')?.methods.length === 0
      && (mode === 'full' || runtime.dialogSites.state.active !== key && runtime.dialogSites.state.pending !== key), () =>
      latest.current.enabled && latest.current.displayCurrent() && latest.current.bindingCurrent() && runtime.isReadyOwner(latest.current.row.owner)
      && lookupPresentation(latest.current.row.owner, latest.current.row.resolution?.presentation?.schema ?? '')?.methods.length === 0
      && (mode === 'full' || runtime.dialogSites.state.active !== key && runtime.dialogSites.state.pending !== key));
    if (!owned) return;
    ownedSite.current = owned;
    setScope(owned);
    const handle: CardSite = { key, retire: () => owned.request.setAvailable(false) }; site.current = handle;
    let activation = 0;
    const update = () => {
      setFallbackFocused(node.querySelector('.tr-fallback')?.contains(document.activeElement) ?? false);
      const rect = node.getBoundingClientRect(), focus = node.closest('.tr-card')?.contains(document.activeElement) ?? false;
      const shown = !document.hidden && rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      owned.request.update({ visible: shown, focused: focus, dialog: mode === 'full', order: root.id, activation });
      const maxWidth = Math.max(1, Math.min(4096, rect.width || (mode === 'full' ? 640 : 320)));
      const maxHeight = Math.max(1, Math.min(2048, rect.height || (mode === 'full' ? 480 : 240)));
      setSize(previous => previous.maxWidth === maxWidth && previous.maxHeight === maxHeight ? previous
        : { maxWidth, maxHeight, preferredHeight: Math.min(maxHeight, mode === 'full' ? 600 : 240) });
    };
    const focus = () => { activation = runtime.nextActivation(); update(); };
    const intersection = new IntersectionObserver(update), resize = new ResizeObserver(update);
    intersection.observe(node); resize.observe(node);
    const card = node.closest('.tr-card'); card?.addEventListener('focusin', focus); card?.addEventListener('focusout', update);
    document.addEventListener('visibilitychange', update); update();
    return () => {
      intersection.disconnect(); resize.disconnect(); card?.removeEventListener('focusin', focus); card?.removeEventListener('focusout', update);
      document.removeEventListener('visibilitychange', update); if (site.current === handle) site.current = null;
      owned.dispose();
    };
  }, [runtime, lifetime, presentationRoot, row.key, Boolean(presentation), mode, retry, site, enabled]);
  useEffect(() => {
    const owned = ownedSite.current;
    return () => {
      if (!owned) return;
      owned.dispose();
      // Native owns panel roots. This is a committed passive absence barrier,
      // never a fabricated root-disposal acknowledgement. Owned root holds
      // still prevent release until their real disposal finishes.
      queueMicrotask(() => { const lease = owned.request.getSnapshot().lease; if (lease) owned.committedAbsent(lease); });
    };
  }, [runtime, lifetime, presentationRoot, row.key, Boolean(presentation), mode, retry, enabled]);
  const snapshot = useSyncExternalStore(scope?.request.subscribe ?? (() => () => {}), scope?.request.getSnapshot ?? (() => null), () => null);
  const revision = row.resolution ? canonicalJson([row.resolution.revision.epoch, row.resolution.revision.sequence]) : '';
  const binding = canonicalJson([revision, presentation ?? null, retry]);
  const shown = enabled && !fallbackFocused && snapshot?.state === 'granted' && snapshot.lease?.id === ready?.id && ready?.key === binding
    && !snapshot.signal?.aborted && readyPlugins.has(row.owner) && (mode === 'full' || dialogs.active !== site.current?.key && dialogs.pending !== site.current?.key);
  return <div ref={container} className={`tr-upper${mode === 'full' ? ' tr-upper-full' : ''}`}>
    <div className="tr-fallback" style={{ visibility: shown ? 'hidden' : 'visible' }} aria-hidden={shown || undefined}>{fallback}</div>
    {presentation && scope && snapshot?.state !== 'capacity' && snapshot?.state !== 'released' && <div className="tr-hosted" inert={!shown} aria-hidden={!shown || undefined} style={{ pointerEvents: shown ? 'auto' : 'none', visibility: shown ? 'visible' : 'hidden' }}>
      <HostedCanvas lifetime={scope} identity={row.identity.artifact} stamp={{ ...presentation, pluginId: row.owner }} revision={revision}
        sdk={sdk} readyPlugins={enabled && committedAuthority === authorityKey ? readyPlugins : new Set()} mode={mode} size={size} consumer={{ pluginId: 'turn-results', surface: mode === 'full' ? 'dialog' : 'gallery' }}
        navigate={{ toThread: id => navigate.toThread(id), openUrl: url => { navigate.openUrl(url); }, openFile: () => false }}
        fallback={null} retryKey={retry}
        refresh={() => { runtime.invalidate(row.identity.ref.source.threadId, true); setRetry(value => value + 1); }}
        onReady={() => { const lease = scope.request.getSnapshot().lease; if (lease) {
          setReady(previous => previous?.id === lease.id && previous.key === binding ? previous : { id: lease.id, key: binding }); setFailed(false);
        } }}
        onDiagnostic={() => { setReady(null); setFailed(true); }} />
    </div>}
    {presentation && mode === 'full' && failed && <div className="tr-custom-status" role="status">
      Custom view could not be displayed.
      <button onClick={() => { setReady(null); setFailed(false); setRetry(value => value + 1); }}>Retry custom view</button>
    </div>}
  </div>;
}
interface LayoutMemory { columns: number; spans: Map<string, { revision: string; width: number; height: number }> }
// Geometry belongs to this exact physical shell and resolved source revision.
const layouts = new WeakMap<HTMLElement, LayoutMemory>();
export function TurnGallery({ anchor, runtime, sdk, navigate, current, lifetime, visible = true, shell, demanded = true, presentationRoot, actionScope, requestOpen, displayCurrent = current }: {
  anchor: GalleryAnchor; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean;
  lifetime: AbortSignal; visible?: boolean; shell?: HTMLElement | undefined; demanded?: boolean; presentationRoot?: GalleryPresentationRoot | undefined;
  actionScope?: GalleryActionScope | undefined; requestOpen?: GalleryOpenPort | undefined;
  displayCurrent?: (() => boolean) | undefined;
}) {
  const [resource, setResource] = useState<ReturnType<GalleryRuntime['retain']> | null>(null);
  const localLayout = useRef<LayoutMemory>({ columns: 1, spans: new Map() });
  const memory = shell ? layouts.get(shell) ?? localLayout.current : localLayout.current;
  if (shell && !layouts.has(shell)) layouts.set(shell, memory);
  useLayoutEffect(() => {
    if (!visible || lifetime.aborted) { setResource(null); return; }
    const lease = runtime.retain(anchor, demanded); setResource(lease);
    return () => {
      if (shell) { const height = shell.getBoundingClientRect().height; if (height > 0) shell.style.minHeight = `${height}px`; }
      lease.dispose();
    };
  }, [runtime, anchor.threadId, anchor.turnId, anchor.turnSeqStart, anchor.turnSeqEnd, lifetime, visible]);
  useLayoutEffect(() => { resource?.visible(demanded); }, [resource, demanded]);
  return resource && !resource.capacity ? <GalleryContents resource={resource} runtime={runtime} sdk={sdk} navigate={navigate} current={current} lifetime={lifetime}
    displayCurrent={displayCurrent} memory={memory} shell={shell} presentationRoot={presentationRoot} actionScope={actionScope} requestOpen={requestOpen} /> : null;
}
function GalleryContents({ resource, runtime, sdk, navigate, current, displayCurrent, lifetime, memory, shell, presentationRoot, actionScope, requestOpen }: {
  resource: ReturnType<GalleryRuntime['retain']>; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate;
  current(): boolean; lifetime: AbortSignal; memory: LayoutMemory; shell?: HTMLElement | undefined; presentationRoot?: GalleryPresentationRoot | undefined;
  actionScope?: GalleryActionScope | undefined; requestOpen?: GalleryOpenPort | undefined;
  displayCurrent(): boolean;
}) {
  const state = useSelector(resource.store), container = useRef<HTMLElement>(null);
  // Partial membership cannot suppress another source or declare a contested
  // group. Show each positive independently until complete membership exists.
  const rows = state.loaded ? projectResults(state.rows)
    : state.rows.flatMap(row => projectResults([row]).map(result => ({ ...result, key: row.key })));
  const hasContent = rows.length > 0;
  const [columns, setColumns] = useState(() => { const width = shell?.getBoundingClientRect().width; const value = width && width > 0 ? paneColumns(width) : memory.columns; memory.columns = value; return value; });
  useLayoutEffect(() => {
    if (!container.current) return;
    const update = (width: number) => { if (width > 0) { const next = paneColumns(width); memory.columns = next; setColumns(next); } };
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width !== undefined) update(width); });
    update(container.current.getBoundingClientRect().width); observer.observe(container.current); return () => observer.disconnect();
  }, [memory, hasContent]);
  useLayoutEffect(() => { if (shell && state.loaded && !state.busy && (!state.error || !hasContent)) shell.style.minHeight = ''; }, [shell, state.rows, state.busy, state.error, state.loaded, hasContent]);
  const retained = new Set(rows.map(result => result.key));
  for (const key of memory.spans.keys()) if (!retained.has(key)) memory.spans.delete(key);
  const packing = packResults(rows.map(result => {
    if (result.kind === 'contested') return { key: result.key, width: 1, height: 1 };
    const value = result.row.resolution;
    if (!value || result.row.unresolved) { memory.spans.delete(result.key); return { key: result.key, width: 1, height: 1 }; }
    const revision = canonicalJson([result.row.owner, value.revision]), prior = memory.spans.get(result.key);
    if (!prior || prior.revision !== revision) memory.spans.set(result.key, { revision,
      ...(value.presentation ? value.spans : value.fallback.kind === 'image' ? { width: 2, height: 2 }
        : { width: value.fallback.kind === 'card' && Array.from(value.fallback.title).length > 80 ? Math.min(2, value.spans.width) : 1, height: 1 }) });
    return { key: result.key, ...memory.spans.get(result.key)! };
  }), columns);
  if (!hasContent) return state.error && state.rows.length === 0
    ? <p className="tr-error" role="status">Saved results could not be loaded.</p> : null;
  return <section ref={container} className="tr-gallery" aria-label="Turn results">
    <div className="tr-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {rows.map((result, index) => { const place = packing.placements[index]!;
        return <div key={result.key} style={{ gridColumn: `${place.column + 1} / span ${place.width}`, gridRow: `${place.row + 1} / span ${place.height}` }}>
          {result.kind === 'single' ? <ResultCard row={result.row} runtime={runtime} sdk={sdk} navigate={navigate}
            collectionReady={() => resource.store.state.loaded === true} customEnabled={state.loaded === true}
            current={() => resource.store.state.loaded === true && current() && resource.store.state.rows.some(row => row.key === result.row.key && row.owner === result.row.owner && canonicalJson(row.identity) === canonicalJson(result.row.identity)
              && canonicalJson(row.resolution?.revision ?? null) === canonicalJson(result.row.resolution?.revision ?? null))}
            displayCurrent={() => { const fact = openFingerprint(result.row); return Boolean(fact && displayCurrent() && !result.row.sourceExpired && !result.row.retracted && !result.row.unresolved
              && resource.store.state.rows.some(row => row.key === result.row.key && openFingerprint(row) === fact)); }}
            lifetime={lifetime} presentationRoot={presentationRoot} actionScope={actionScope} requestOpen={requestOpen}
            readAfter={state.bindings?.[result.row.key]?.after ?? undefined}
            currentRow={() => resource.store.state.rows.find(row => row.key === result.row.key && row.owner === result.row.owner) ?? null}
            watchCurrent={changed => { const subscription = resource.store.subscribe(changed); return () => subscription.unsubscribe(); }} />
            : <article className="tr-card"><div className="tr-data-action">
              {result.rows.map(row => openAvailable(row) ? <ResultCard key={row.key} sourceChoice row={row} runtime={runtime} sdk={sdk} navigate={navigate}
                collectionReady={() => resource.store.state.loaded === true}
                current={() => resource.store.state.loaded === true && current() && resource.store.state.rows.some(next => next.key === row.key && next.owner === row.owner
                  && canonicalJson(next.identity) === canonicalJson(row.identity) && canonicalJson(next.resolution?.revision ?? null) === canonicalJson(row.resolution?.revision ?? null))}
                lifetime={lifetime} actionScope={actionScope} requestOpen={requestOpen}
                readAfter={state.bindings?.[row.key]?.after ?? undefined}
                currentRow={() => resource.store.state.rows.find(next => next.key === row.key && next.owner === row.owner) ?? null}
                watchCurrent={changed => { const subscription = resource.store.subscribe(changed); return () => subscription.unsubscribe(); }} />
                : <span key={row.key}>{row.owner}</span>)}
            </div><div className="tr-caption">Multiple result sources</div></article>}
        </div>;
      })}
    </div>
    {state.limited && <small className="tr-limit">Some results could not fit in this view.</small>}
  </section>;
}
