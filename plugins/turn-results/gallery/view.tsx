import type { BbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from '@tanstack/react-store';
import { z } from 'zod';
import { canonicalByteLength, canonicalJson, sha256Canonical } from '@phosphorco/bb-turn-results';
import { navigateResult } from '@phosphorco/bb-turn-results/bb';
import type { GalleryObservation } from './index.ts';
import type { GalleryAnchor } from './anchors.ts';
import type { GalleryRuntime, GalleryPresentationRoot } from './runtime.ts';
import type { PresentationLifetime } from './presentation-lifetime.ts';
import { HostedCanvas } from './presentation.ts';
import { lookupPresentation } from '@phosphorco/bb-context-recognition/presentation';
import { initialResultLimit, paneColumns, packResults } from './packing.ts';
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
function LoadedImage({ handle, alt, open }: { handle: MediaHandle; alt: string; open(): void }) {
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
function ImageCanvas({ row, runtime, sdk, open, lifetime }: { row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; open(): void; lifetime: AbortSignal }) {
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
export function ResultCard({ row, runtime, sdk, navigate, current, lifetime, presentationRoot, mode = 'docked', customEnabled = true }: {
  row: GalleryObservation; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean; lifetime: AbortSignal;
  presentationRoot?: GalleryPresentationRoot | undefined; mode?: 'docked' | 'full'; customEnabled?: boolean;
}) {
  const site = useRef<CardSite | null>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const value = row.resolution;
  const open = () => { if (current() && value) navigateResult(navigate, value.route); };
  const full = () => {
    if (!current() || !value || !site.current || !runtime.isActive()) return;
    // Contributor controls retire with the dock. The consumer action survives
    // that handoff; dialog close still checks its exact native/revision scope.
    runtime.openDialog({ row, sdk, navigate, siteKey: site.current.key, retireDock: site.current.retire,
      opener: expandButton.current, openerCurrent: current });
  };
  const fallback = value?.fallback.kind === 'image' ? <ImageCanvas row={row} runtime={runtime} sdk={sdk} open={open} lifetime={lifetime} />
    : <button className="tr-canvas tr-data-action" onClick={open} disabled={!value || value.route.kind === 'unavailable'}>
      <strong>{value?.fallback.title ?? 'Recognized result'}</strong>
      {value && 'description' in value.fallback && <span>{value.fallback.description}</span>}
      {value?.fallback.kind === 'card' && value.fallback.fields?.map(field => <span key={field.label}>{field.label}: {field.value}</span>)}
    </button>;
  return <article className="tr-card" data-result-key={row.key}>
    <PresentationCanvas row={row} runtime={runtime} sdk={sdk} navigate={navigate} current={current} lifetime={lifetime}
      presentationRoot={presentationRoot} mode={mode} enabled={customEnabled} site={site} requestFull={full} fallback={fallback} />
    <div className="tr-caption"><span>{runtime.caption(row)}</span><div>
      {mode === 'docked' && value?.presentation && <button ref={expandButton} onClick={full}>Expand result</button>}
      <button onClick={open} disabled={!value || value.route.kind === 'unavailable'}>Open</button>
    </div></div>
    {row.freshness !== 'fresh' && <small className="tr-freshness" title="This describes the result source record, separately from image loading and byte verification.">
      {row.freshness === 'disconnected' ? 'Source disconnected · saved result details'
        : row.freshness === 'unsupported' ? 'Source version unsupported · saved result details'
        : row.freshness === 'stale' ? 'Source details were checked earlier' : 'Source details have not been checked'}
    </small>}
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
  const status = useSelector(runtime.presentationStatus);
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
    {presentation && (failed || snapshot?.state === 'stalled' || snapshot?.state === 'capacity' || snapshot?.state === 'queued' && status.stalled > 0) && <div className="tr-custom-status" role="status">
      {snapshot?.state === 'stalled' || snapshot?.state === 'queued' && status.stalled > 0 ? 'Custom view is waiting for cleanup.' : snapshot?.state === 'capacity' ? 'Custom view capacity reached.' : 'Custom view could not be displayed.'}
      <button onClick={() => { setReady(null); setFailed(false); setRetry(value => value + 1); }}>Retry custom view</button>
    </div>}
  </div>;
}
interface LayoutMemory { columns: number; expanded: boolean; spans: Map<string, { width: number; height: number }> }
// Weakly owned by the exact in-flow shell, not by an unbounded turn-history map.
const layouts = new WeakMap<HTMLElement, LayoutMemory>();
export function TurnGallery({ anchor, runtime, sdk, navigate, current, lifetime, visible = true, shell, demanded = true, presentationRoot }: {
  anchor: GalleryAnchor; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate; current(): boolean;
  lifetime: AbortSignal; visible?: boolean; shell?: HTMLElement | undefined; demanded?: boolean; presentationRoot?: GalleryPresentationRoot | undefined;
}) {
  const [resource, setResource] = useState<ReturnType<GalleryRuntime['retain']> | null>(null), [attempt, setAttempt] = useState(0);
  const localLayout = useRef<LayoutMemory>({ columns: 1, expanded: false, spans: new Map() });
  const memory = shell ? layouts.get(shell) ?? localLayout.current : localLayout.current;
  if (shell && !layouts.has(shell)) layouts.set(shell, memory);
  useLayoutEffect(() => {
    if (!visible || lifetime.aborted) { setResource(null); return; }
    const next = runtime.retain(anchor, demanded); setResource(next);
    const abort = () => next.dispose(); lifetime.addEventListener('abort', abort, { once: true });
    return () => {
      if (shell) { const height = shell.getBoundingClientRect().height; if (height > 0) shell.style.minHeight = `${height}px`; }
      lifetime.removeEventListener('abort', abort); next.dispose();
    };
  }, [runtime, anchor.threadId, anchor.turnId, anchor.turnSeqStart, anchor.turnSeqEnd, lifetime, visible, shell, attempt]);
  useLayoutEffect(() => { resource?.visible(demanded); }, [resource, demanded]);
  return <div>{resource?.capacity ? <div role="status">Results view capacity reached. <button onClick={() => setAttempt(value => value + 1)}>Retry this turn</button></div>
    : resource ? <GalleryContents resource={resource} runtime={runtime} sdk={sdk} navigate={navigate} current={current} lifetime={lifetime} memory={memory} shell={shell} presentationRoot={presentationRoot} /> : null}</div>;
}
function GalleryContents({ resource, runtime, sdk, navigate, current, lifetime, memory, shell, presentationRoot }: {
  resource: ReturnType<GalleryRuntime['retain']>; runtime: GalleryRuntime; sdk: Sdk; navigate: BbNavigate;
  current(): boolean; lifetime: AbortSignal; memory: LayoutMemory; shell?: HTMLElement | undefined; presentationRoot?: GalleryPresentationRoot | undefined;
}) {
  const state = useSelector(resource.store), container = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(memory.columns), [expanded, setExpanded] = useState(memory.expanded);
  const spans = useRef(memory.spans);
  useLayoutEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width;
      if (width !== undefined) { const next = paneColumns(width); memory.columns = next; setColumns(next); }
    });
    observer.observe(container.current); return () => observer.disconnect();
  }, [memory]);
  useLayoutEffect(() => { if (shell && state.rows.length && !state.busy) shell.style.minHeight = ''; }, [shell, state.rows, state.busy]);
  const rows = projectResults(state.rows);
  const admitted = rows.slice(0, expanded ? 24 : initialResultLimit(columns));
  const retained = new Set(admitted.map(result => result.key));
  for (const key of spans.current.keys()) if (!retained.has(key)) spans.current.delete(key);
  const packing = packResults(admitted.map(result => {
    if (!spans.current.has(result.key)) spans.current.set(result.key, result.kind === 'single' ? result.row.resolution?.spans ?? { width: 2, height: 2 } : { width: 2, height: 1 });
    return { key: result.key, ...spans.current.get(result.key)! };
  }), columns);
  return <section ref={container} className="tr-gallery" aria-label="Turn results">
    <div className="tr-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {admitted.map((result, index) => { const place = packing.placements[index]!;
        return <div key={result.key} style={{ gridColumn: `${place.column + 1} / span ${place.width}`, gridRow: `${place.row + 1} / span ${place.height}` }}>
          {result.kind === 'single' ? <ResultCard row={result.row} runtime={runtime} sdk={sdk} navigate={navigate}
            current={() => current() && resource.store.state.rows.some(row => row.key === result.row.key && row.owner === result.row.owner && canonicalJson(row.identity) === canonicalJson(result.row.identity)
              && canonicalJson(row.resolution?.revision ?? null) === canonicalJson(result.row.resolution?.revision ?? null))}
            lifetime={lifetime} presentationRoot={presentationRoot} />
            : <article className="tr-card"><details className="tr-data-action"><summary>Multiple result sources ({result.rows.length})</summary>
              {result.rows.map(row => <button key={row.key} onClick={() => { if (current() && row.resolution) navigateResult(navigate, row.resolution.route); }}>{row.owner}: {row.resolution?.fallback.title ?? 'Recognized result'}</button>)}
            </details><div className="tr-caption">Multiple result sources</div></article>}
        </div>;
      })}
    </div>
    {(rows.length > admitted.length || state.continued) && <button className="tr-more" disabled={state.busy} onClick={() => {
      if (state.rows.length >= 8 && rows.length <= admitted.length) navigate.openThreadPanel({ actionId: 'results', params: { turnId: state.rows[0]!.identity.ref.source.turnId } });
      else { memory.expanded = true; setExpanded(true); resource.more(); }
    }}>Show more results</button>}
    {state.error && <div className="tr-error" role="status">{state.error}<button disabled={state.busy} onClick={() => resource.more()}>Retry results</button></div>}
    {!rows.length && state.busy && <small className="tr-freshness">Finding turn results…</small>}
  </section>;
}
