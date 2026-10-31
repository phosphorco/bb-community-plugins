import type { BbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from '@tanstack/react-store';
import { z } from 'zod';
import { canonicalByteLength, canonicalJson, sha256Canonical } from '@phosphorco/bb-turn-results';
import { navigateResult } from '@phosphorco/bb-turn-results/bb';
import type { GalleryObservation } from './index.ts';
import type { GalleryAnchor } from './anchors.ts';
import type { GalleryActionScope, GalleryActionCapture } from './pane.ts';
import type { GalleryRuntime, GalleryPresentationRoot } from './runtime.ts';
import type { PresentationLifetime } from './presentation-lifetime.ts';
import { HostedCanvas } from './presentation.ts';
import { lookupPresentation } from '@phosphorco/bb-context-recognition/presentation';
import { paneColumns, packResults } from './packing.ts';
import { projectResults } from './projection.ts';

type Sdk = ReturnType<typeof useSdk>;
const mediaRaw = z.unknown().transform(value => { canonicalByteLength(value, 16384); return value; });
const mediaOutput = z.discriminatedUnion('state', [
  z.object({ version: z.literal(1), state: z.literal('unavailable'), reason: z.string().max(128) }),
  z.object({ version: z.literal(1), state: z.literal('ready'), lease: z.object({
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/), leaseGeneration: z.string().max(128),
    baseUrl: z.string().regex(/^\/api\/v1\/file-previews\/[A-Za-z0-9-]{1,128}$/), url: z.string().max(4096),
    expiresAtMs: z.number().int().nonnegative(), resolvedAt: z.number().int().nonnegative(),
  }), image: z.object({ mimeType: z.literal('image/png'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(32768), height: z.number().int().min(1).max(32768), sizeBytes: z.number().int().min(1).max(8388608) }) }),
]);
type MediaHandle = ReturnType<GalleryRuntime['media']['retain']>;
function LoadedImage({ handle, alt, open }: { handle: MediaHandle; alt: string; open: OpenClick }) {
  const state = useSelector(handle.store);
  const [decodeError, setDecodeError] = useState(false);
  if (state.url && !decodeError) return <button className="tr-image-action" onClick={open} aria-label={`Open ${alt}`} title="Image bytes match the saved generation">
    <img src={state.url} alt={alt} onLoad={event => {
      const image = event.currentTarget;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 32768 || image.naturalHeight > 32768 || image.naturalWidth * image.naturalHeight > 16777216) setDecodeError(true);
    }} onError={() => setDecodeError(true)} />
  </button>;
  return <div className="tr-placeholder"><span>{decodeError ? 'Image could not be displayed' : state.state === 'loading' ? 'Loading image…' : state.error ?? 'Generated image'}</span>
    {(decodeError || state.state === 'error') && <button onClick={() => { setDecodeError(false); handle.retry(); }}>Retry image</button>}</div>;
}
function ImageCanvas({ row, runtime, sdk, open, lifetime }: { row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; open: OpenClick; lifetime: AbortSignal }) {
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
    const target = route.target;
    void sha256Canonical({ target, sha256 }).then(fingerprint => {
      if (!live) return;
      resource = runtime.media.retain({ key: row.key, fingerprint, sha256, async acquire(signal) {
        const raw = await sdk.plugins.callRpc({ pluginId: row.owner, method: 'turnResultImagesV1Media',
          input: { version: 1, identity: JSON.parse(canonicalJson(row.identity)) }, outputSchema: mediaRaw, signal });
        signal.throwIfAborted();
        const output = mediaOutput.parse(raw);
        if (output.state !== 'ready') throw Error(output.reason);
        if (output.image.sha256 !== sha256 || output.image.width * output.image.height > 16777216
          || output.lease.targetFingerprint !== fingerprint || !output.lease.url.startsWith(`${output.lease.baseUrl}/`)
          || output.lease.expiresAtMs - output.lease.resolvedAt > 120000 || output.lease.expiresAtMs <= output.lease.resolvedAt) throw Error('Image binding changed.');
        return output.lease;
      } }, false);
      setHandle(resource);
      observer.observe(host.current!);
    }).catch(() => { /* Data fallback and native open action remain accessible. */ });
    const observer = new IntersectionObserver(entries => { if (live && resource) resource.visible(entries.some(entry => entry.isIntersecting)); });
    return () => { lifetime.removeEventListener('abort', abort); live = false; observer.disconnect(); resource?.dispose(); };
  }, [runtime, sdk, row.key, sha256, route?.kind === 'file' ? canonicalJson(route.target) : '', lifetime]);
  const alt = resolution?.fallback.kind === 'image' ? resolution.fallback.alt : 'Result image';
  return <div ref={host} className="tr-canvas">{handle ? <LoadedImage handle={handle} alt={alt} open={open} /> : <div className="tr-placeholder">{resolution?.fallback.title ?? 'Image result'}</div>}</div>;
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
export function ResultCard({ row, runtime, sdk, navigate, current, lifetime, presentationRoot, mode = 'docked', customEnabled = true,
  actionScope, requestOpen, currentRow, watchCurrent, readAfter }: {
  row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean; lifetime: AbortSignal;
  presentationRoot?: GalleryPresentationRoot | undefined; mode?: 'docked' | 'full'; customEnabled?: boolean;
  actionScope?: GalleryActionScope | undefined; requestOpen?: GalleryOpenPort | undefined;
  readAfter?: { seq: number; key: string } | undefined;
  currentRow?: (() => GalleryObservation | null) | undefined; watchCurrent?: ((changed: () => void) => () => void) | undefined;
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
  const full = () => {
    if (!current() || !value || !site.current || !runtime.isActive()) return;
    // Contributor controls retire with the dock. The consumer action survives
    // that handoff; dialog close still checks its exact native/revision scope.
    runtime.openDialog({ row, sdk, navigate, siteKey: site.current.key, retireDock: site.current.retire,
      opener: expandButton.current, openerCurrent: current });
  };
  const destination = Boolean(value && (value.route.kind === 'file' || value.route.kind === 'url'));
  const caption = runtime.caption(row);
  const detail = value && 'description' in value.fallback && value.fallback.description || value?.fallback.title;
  const description = detail?.replace(/\s+/gu, ' ').trim().slice(0, 140);
  const content = <><span className="tr-result-symbol" aria-hidden="true">{value?.route.kind === 'file' ? '▤' : value?.route.kind === 'url' ? '↗' : '•'}</span>
    {description && description !== caption && <span className="tr-excerpt">{description}</span>}</>;
  const fallback = value?.fallback.kind === 'image' ? <ImageCanvas row={row} runtime={runtime} sdk={sdk} open={open} lifetime={lifetime} />
    : destination ? <button className="tr-canvas tr-data-action" onClick={open} aria-label={`Open ${caption}`}>{content}</button>
      : <div className="tr-canvas tr-data-action">{content}</div>;
  return <article ref={card} className="tr-card" data-result-key={row.key}>
    <PresentationCanvas row={row} runtime={runtime} sdk={sdk} navigate={navigate} current={current} lifetime={lifetime}
      presentationRoot={presentationRoot} mode={mode} enabled={customEnabled} site={site} requestFull={full} fallback={fallback} />
    <div className="tr-caption"><span>{caption}</span><div>
      {mode === 'docked' && value?.presentation && <button ref={expandButton} onClick={full} className="tr-expand-icon" aria-label="Expand result" title="Expand result">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
      </button>}
      {destination && <button onClick={open} className={mode === 'docked' ? 'tr-open-icon' : undefined} aria-label={`Open ${caption}`} title="Open result">
        {mode === 'docked' ? <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="M6 3H3v10h10v-3M9 3h4v4M7 9l6-6" /></svg> : 'Open'}
      </button>}
    </div></div>
    {openStatus && <small className="tr-freshness" role="status" data-turn-result-open-status="">{openStatus}</small>}
  </article>;
}
function PresentationCanvas({ row, runtime, sdk, navigate, current, lifetime, presentationRoot, mode, enabled, site, requestFull, fallback }: {
  row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean; lifetime: AbortSignal;
  presentationRoot?: GalleryPresentationRoot | undefined; mode: 'docked' | 'full'; enabled: boolean;
  site: { current: CardSite | null }; requestFull(): void; fallback: React.ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null), latest = useRef({ current, row, enabled });
  const ownedSite = useRef<PresentationLifetime | null>(null);
  const [scope, setScope] = useState<PresentationLifetime | null>(null), [retry, setRetry] = useState(0);
  const [ready, setReady] = useState<{ id: number; key: string } | null>(null), [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ maxWidth: 320, maxHeight: 240, preferredHeight: 240 });
  const readyPlugins = useSelector(runtime.readyOwners), dialogs = useSelector(runtime.dialogSites);
  const presentation = row.resolution?.presentation;
  const authorityKey = canonicalJson([enabled, current(), row.owner, row.identity, row.resolution?.revision ?? null, presentation ?? null]);
  const [committedAuthority, setCommittedAuthority] = useState<string | null>(null);
  // Public host availability is calculated during render. Publish a committed
  // authority change before allowing that calculation to reuse this site; a
  // layout-ref update alone provides no subsequent render on unchanged recovery.
  useLayoutEffect(() => { latest.current = { current, row, enabled }; setCommittedAuthority(authorityKey); });
  useLayoutEffect(() => {
    const node = container.current;
    if (!presentation || !node || lifetime.aborted) return;
    const root = presentationRoot ?? runtime.presentationRoot(lifetime, () => latest.current.current());
    const key = canonicalJson([root.id, row.key]);
    const owned = root.site(row.key, { visible: false, focused: false, dialog: mode === 'full', order: root.id, activation: 0 }, () =>
      latest.current.enabled && latest.current.current() && runtime.isReadyOwner(latest.current.row.owner)
      && lookupPresentation(latest.current.row.owner, latest.current.row.resolution?.presentation?.schema ?? '')?.methods.length === 0
      && (mode === 'full' || runtime.dialogSites.state.active !== key && runtime.dialogSites.state.pending !== key));
    if (!owned) return;
    ownedSite.current = owned;
    setScope(owned);
    const handle: CardSite = { key, retire: () => owned.request.setAvailable(false) }; site.current = handle;
    let activation = 0;
    const update = () => {
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
  }, [runtime, lifetime, presentationRoot, row.key, Boolean(presentation), mode, retry, site]);
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
  }, [runtime, lifetime, presentationRoot, row.key, Boolean(presentation), mode, retry]);
  const snapshot = useSyncExternalStore(scope?.request.subscribe ?? (() => () => {}), scope?.request.getSnapshot ?? (() => null), () => null);
  const revision = row.resolution ? canonicalJson([row.resolution.revision.epoch, row.resolution.revision.sequence]) : '';
  const binding = canonicalJson([revision, presentation ?? null, retry]);
  const shown = enabled && snapshot?.state === 'granted' && snapshot.lease?.id === ready?.id && ready?.key === binding
    && !snapshot.signal?.aborted && readyPlugins.has(row.owner) && (mode === 'full' || dialogs.active !== site.current?.key && dialogs.pending !== site.current?.key);
  return <div ref={container} className={`tr-upper${mode === 'full' ? ' tr-upper-full' : ''}`}>
    <div className="tr-fallback" style={{ visibility: shown ? 'hidden' : 'visible' }} aria-hidden={shown || undefined}>{fallback}</div>
    {presentation && scope && snapshot?.state !== 'capacity' && snapshot?.state !== 'released' && <div className="tr-hosted" style={{ pointerEvents: shown ? 'auto' : 'none' }}>
      <HostedCanvas lifetime={scope} identity={row.identity.artifact} stamp={{ ...presentation, pluginId: row.owner }} revision={revision}
        sdk={sdk} readyPlugins={enabled && committedAuthority === authorityKey ? readyPlugins : new Set()} mode={mode} size={size} consumer={{ pluginId: 'turn-results', surface: mode === 'full' ? 'dialog' : 'gallery' }}
        navigate={{ toThread: id => navigate.toThread(id), openUrl: url => { navigate.openUrl(url); }, openFile: () => false }}
        fallback={null} retryKey={retry} {...(mode === 'docked' ? { requestFull } : {})}
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
export function TurnGallery({ anchor, runtime, sdk, navigate, current, lifetime, visible = true, shell, demanded = true, presentationRoot, actionScope, requestOpen }: {
  anchor: GalleryAnchor; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean;
  lifetime: AbortSignal; visible?: boolean; shell?: HTMLElement | undefined; demanded?: boolean; presentationRoot?: GalleryPresentationRoot | undefined;
  actionScope?: GalleryActionScope | undefined; requestOpen?: GalleryOpenPort | undefined;
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
    memory={memory} shell={shell} presentationRoot={presentationRoot} actionScope={actionScope} requestOpen={requestOpen} /> : null;
}
function GalleryContents({ resource, runtime, sdk, navigate, current, lifetime, memory, shell, presentationRoot, actionScope, requestOpen }: {
  resource: ReturnType<GalleryRuntime['retain']>; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate;
  current(): boolean; lifetime: AbortSignal; memory: LayoutMemory; shell?: HTMLElement | undefined; presentationRoot?: GalleryPresentationRoot | undefined;
  actionScope?: GalleryActionScope | undefined; requestOpen?: GalleryOpenPort | undefined;
}) {
  const state = useSelector(resource.store), container = useRef<HTMLElement>(null);
  const rows = projectResults(state.rows), hasContent = rows.length > 0;
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
      ...(value.presentation ? value.spans : value.fallback.kind === 'image' ? { width: 2, height: 2 } : { width: 1, height: 1 }) });
    return { key: result.key, ...memory.spans.get(result.key)! };
  }), columns);
  if (!hasContent) return null;
  return <section ref={container} className="tr-gallery" aria-label="Turn results">
    <div className="tr-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {rows.map((result, index) => { const place = packing.placements[index]!;
        return <div key={result.key} style={{ gridColumn: `${place.column + 1} / span ${place.width}`, gridRow: `${place.row + 1} / span ${place.height}` }}>
          {result.kind === 'single' ? <ResultCard row={result.row} runtime={runtime} sdk={sdk} navigate={navigate}
            current={() => current() && resource.store.state.rows.some(row => row.key === result.row.key && row.owner === result.row.owner && canonicalJson(row.identity) === canonicalJson(result.row.identity)
              && canonicalJson(row.resolution?.revision ?? null) === canonicalJson(result.row.resolution?.revision ?? null))}
            lifetime={lifetime} presentationRoot={presentationRoot} actionScope={actionScope} requestOpen={requestOpen}
            readAfter={state.bindings?.[result.row.key]?.after ?? undefined}
            currentRow={() => resource.store.state.rows.find(row => row.key === result.row.key && row.owner === result.row.owner) ?? null}
            watchCurrent={changed => { const subscription = resource.store.subscribe(changed); return () => subscription.unsubscribe(); }} />
            : <article className="tr-card"><div className="tr-data-action">
              {result.rows.map(row => openAvailable(row) ? <button key={row.key} onClick={() => {
                openOutcome = Symbol(); pendingOpen?.supersede();
                const latest = resource.store.state.rows.find(next => next.key === row.key && next.owner === row.owner), fact = openFingerprint(row);
                if (current() && fact && latest && openAvailable(latest) && openFingerprint(latest) === fact) navigateResult(navigate, row.resolution!.route);
              }}>{row.owner}</button> : <span key={row.key}>{row.owner}</span>)}
            </div><div className="tr-caption">Multiple result sources</div></article>}
        </div>;
      })}
    </div>
    {state.limited && <small className="tr-limit">Some results could not fit in this view.</small>}
  </section>;
}
