import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import type {
  BacklinkRow,
  ForwardReferenceRow,
  ListBacklinksResponse,
  ListForwardReferencesResponse,
} from "./model.ts";
import type { rpcContract } from "./rpc-contract.ts";
import "./app.css";

const EMPTY_BACKLINKS: ListBacklinksResponse = { rows: [], total: 0, nextCursor: null };
const EMPTY_FORWARDS: ListForwardReferencesResponse = { rows: [], total: 0, nextCursor: null };
const BB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Direction = "forward" | "backlink";
type ReferencePages = { forward: ListForwardReferencesResponse; backlink: ListBacklinksResponse };
type LoadingMore = Record<Direction, boolean>;

function identityKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`;
}

async function exactThreadIdentityDigest(projectId: string, threadId: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null || !BB_ID_PATTERN.test(projectId) || !BB_ID_PATTERN.test(threadId)) return null;
  const identity = JSON.stringify({ provider: "bb", keys: { project: projectId, thread: threadId } });
  const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function signalMatches(payload: unknown, digest: string | null): boolean {
  if (digest == null || typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const signal = payload as { protocolVersion?: unknown; affectedIdentityDigests?: unknown };
  return signal.protocolVersion === 1
    && Array.isArray(signal.affectedIdentityDigests)
    && signal.affectedIdentityDigests.includes(digest);
}

function emptyPages(): ReferencePages {
  return { forward: EMPTY_FORWARDS, backlink: EMPTY_BACKLINKS };
}

function useThreadReferences(projectId: string, threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const identityRef = useRef({ projectId, threadId, key: identityKey(projectId, threadId) });
  identityRef.current = { projectId, threadId, key: identityKey(projectId, threadId) };
  const digestRef = useRef<string | null>(null);
  const [pages, setPages] = useState<ReferencePages>(emptyPages);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<LoadingMore>({ forward: false, backlink: false });
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const initializedIdentity = useRef<string | null>(null);
  const refreshInFlight = useRef(false);
  const refreshPending = useRef(false);
  const moreInFlight = useRef<Record<Direction, boolean>>({ forward: false, backlink: false });
  const pendingSignals = useRef<unknown[]>([]);
  const pendingSignalOverflow = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    refreshPending.current = true;
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      while (refreshPending.current && mounted.current) {
        refreshPending.current = false;
        const request = identityRef.current;
        const requestSequence = ++sequence.current;
        const source = { provider: "bb", keys: { project: request.projectId, thread: request.threadId } };
        try {
          const [forward, backlink] = await Promise.all([
            rpcRef.current.call("listForwardReferences", { source, pageSize: 25 }),
            rpcRef.current.call("listBacklinks", { target: source, pageSize: 25 }),
          ]);
          if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
            setPages({ forward, backlink });
            setError(null);
            setLoading(false);
            setStale(false);
          }
        } catch (cause) {
          if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
            setError(cause instanceof Error ? cause.message : "Could not load references.");
            setLoading(false);
          }
        }
      }
    } finally {
      refreshInFlight.current = false;
      if (refreshPending.current && mounted.current) void refresh();
    }
  }, []);

  useEffect(() => {
    let active = true;
    digestRef.current = null;
    pendingSignals.current = [];
    pendingSignalOverflow.current = false;
    void exactThreadIdentityDigest(projectId, threadId).then((next) => {
      if (!active) return;
      digestRef.current = next;
      const shouldRefresh = pendingSignalOverflow.current || pendingSignals.current.some((payload) => signalMatches(payload, next));
      pendingSignals.current = [];
      pendingSignalOverflow.current = false;
      if (shouldRefresh) void refresh();
    });
    return () => { active = false; };
  }, [projectId, refresh, threadId]);

  useEffect(() => {
    const key = identityKey(projectId, threadId);
    if (initializedIdentity.current === key) return;
    initializedIdentity.current = key;
    setPages(emptyPages());
    setError(null);
    setLoading(true);
    setStale(false);
    void refresh();
  }, [projectId, refresh, threadId]);

  useRealtime("cross-references-changed", useCallback((payload: unknown) => {
    if (digestRef.current == null) {
      if (pendingSignals.current.length < 32) pendingSignals.current.push(payload);
      else pendingSignalOverflow.current = true;
      return;
    }
    if (signalMatches(payload, digestRef.current)) void refresh();
  }, [refresh]));

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "reconnecting") {
      setStale(true);
      previousConnection.current = connection;
      return;
    }
    if (connection === "connected" && previousConnection.current !== "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  const loadMore = useCallback(async (direction: Direction) => {
    const cursor = pagesRef.current[direction].nextCursor;
    if (cursor == null || moreInFlight.current[direction] || !mounted.current) return;
    moreInFlight.current[direction] = true;
    setLoadingMore((current) => ({ ...current, [direction]: true }));
    const request = identityRef.current;
    const requestSequence = ++sequence.current;
    const source = { provider: "bb", keys: { project: request.projectId, thread: request.threadId } };
    try {
      if (direction === "forward") {
        const next = await rpcRef.current.call("listForwardReferences", { source, pageSize: 25, cursor });
        if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
          setPages((current) => ({ ...current, forward: { rows: [...current.forward.rows, ...next.rows], total: next.total, nextCursor: next.nextCursor } }));
          setError(null);
        }
      } else {
        const next = await rpcRef.current.call("listBacklinks", { target: source, pageSize: 25, cursor });
        if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
          setPages((current) => ({ ...current, backlink: { rows: [...current.backlink.rows, ...next.rows], total: next.total, nextCursor: next.nextCursor } }));
          setError(null);
        }
      }
    } catch (cause) {
      if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
        setError(cause instanceof Error ? cause.message : "Could not load more references.");
      }
    } finally {
      moreInFlight.current[direction] = false;
      if (mounted.current) setLoadingMore((current) => ({ ...current, [direction]: false }));
    }
  }, []);

  return { pages, loading, loadingMore, error, stale, loadMore };
}

function LinkGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.5 14.5 14.5 9.5m-8.1 8.1 1.8-1.8m4.4-4.4 1.8-1.8a3.3 3.3 0 0 0-4.7-4.7L8 6.7m8.1 8.1-1.8 1.8a3.3 3.3 0 0 1-4.7-4.7l1.8-1.8" /></svg>;
}

function BacklinkGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 7-5 5 5 5m-5-5h10a6 6 0 0 1 6 6v1" /></svg>;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

type PopoverPosition = { top: number; left: number };

function ResourceLink({ resource, first }: { resource: ForwardReferenceRow["target"] | BacklinkRow["source"]; first: boolean }) {
  const navigate = useBbNavigate();
  const content = <><strong>{resource.presentation.label}</strong>{resource.presentation.detail != null && <small>{resource.presentation.detail}</small>}</>;
  return resource.presentation.url != null
    ? <a href={resource.presentation.url} className="cross-references__source-link" data-cross-reference-first={first || undefined} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (navigate.openUrl(resource.presentation.url!)) event.preventDefault();
      }}>{content}</a>
    : <span className="cross-references__source-link">{content}</span>;
}

function ReferenceSection({ heading, rows, total, nextCursor, loadingMore, onLoadMore, direction }: {
  heading: string;
  rows: readonly (ForwardReferenceRow | BacklinkRow)[];
  total: number;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  direction: Direction;
}) {
  return <section className="cross-references__section" aria-label={heading}>
    <header><strong>{heading}</strong><span>{total}</span></header>
    {rows.length === 0 && <p className="cross-references__message">No {direction === "forward" ? "forward references" : "backlinks"}.</p>}
    {rows.length > 0 && <ul>{rows.map((row, index) => <li key={`${row.producerPluginId}:${row.revision}:${row.position}:${index}`}><ResourceLink resource={direction === "forward" ? (row as ForwardReferenceRow).target : (row as BacklinkRow).source} first={index === 0} /></li>)}</ul>}
    {nextCursor != null && <button type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? "Loading more…" : `Load more ${direction === "forward" ? "forward references" : "backlinks"}`}</button>}
  </section>;
}

function ReferencesDetail({ pages, loading, error, stale, loadingMore, trigger, popoverId, onClose, onLoadMore }: {
  pages: ReferencePages;
  loading: boolean;
  error: string | null;
  stale: boolean;
  loadingMore: LoadingMore;
  trigger: HTMLButtonElement;
  popoverId: string;
  onClose: () => void;
  onLoadMore: (direction: Direction) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ top: 8, left: 8 });
  const updatePosition = useCallback(() => {
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(360, Math.max(240, window.innerWidth - 16));
    const left = Math.min(Math.max(8, bounds.right - width), Math.max(8, window.innerWidth - width - 8));
    const estimatedHeight = Math.min(420, Math.max(180, window.innerHeight * 0.7));
    const top = bounds.bottom + 7 + estimatedHeight <= window.innerHeight - 8 ? bounds.bottom + 7 : Math.max(8, bounds.top - estimatedHeight - 7);
    setPosition({ top, left });
  }, [trigger]);
  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => { window.removeEventListener("resize", updatePosition); window.removeEventListener("scroll", updatePosition, true); };
  }, [updatePosition]);
  useEffect(() => {
    const firstFocusable = contentRef.current?.querySelector<HTMLElement>("button, a, [tabindex='0']");
    (firstFocusable ?? contentRef.current)?.focus();
  }, []);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || (!contentRef.current?.contains(target) && !trigger.contains(target))) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown, true); };
  }, [onClose, trigger]);
  return createPortal(
    <div ref={contentRef} className="cross-references__popover" id={popoverId} role="dialog" aria-label="References" tabIndex={-1} style={{ top: position.top, left: position.left }}>
      <header><strong>References</strong><button type="button" className="cross-references__close" onClick={onClose} aria-label="Close references">Close</button></header>
      {stale && <p className="cross-references__stale" role="status">The connection is recovering; this may be briefly out of date.</p>}
      {loading && pages.forward.rows.length === 0 && pages.backlink.rows.length === 0 && <p className="cross-references__message" role="status">Checking references…</p>}
      {error != null && <p className="cross-references__error" role="alert">{error}</p>}
      <ReferenceSection heading="Forward references" rows={pages.forward.rows} total={pages.forward.total} nextCursor={pages.forward.nextCursor} loadingMore={loadingMore.forward} onLoadMore={() => onLoadMore("forward")} direction="forward" />
      <ReferenceSection heading="Backlinks" rows={pages.backlink.rows} total={pages.backlink.total} nextCursor={pages.backlink.nextCursor} loadingMore={loadingMore.backlink} onLoadMore={() => onLoadMore("backlink")} direction="backlink" />
    </div>,
    document.body,
  );
}

function ThreadHeaderAction({ threadId, projectId }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const { pages, loading, loadingMore, error, stale, loadMore } = useThreadReferences(projectId, threadId);
  const [open, setOpen] = useState(false);
  const popoverId = `cross-references-thread-detail-${useId().replaceAll(":", "")}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  const forwardCount = pages.forward.total;
  const backlinkCount = pages.backlink.total;
  const count = forwardCount + backlinkCount;
  // Keep the header quiet until this exact thread has a relationship to show.
  // Once visible, its dialog owns refresh/loading detail for that relationship.
  if (loading || count === 0) return null;
  return <>
    <button ref={triggerRef} type="button" className="cross-references__trigger" aria-label={`Cross-references: ${countLabel(forwardCount, "forward reference")}, ${countLabel(backlinkCount, "backlink")}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={popoverId} title="Show cross-references" onClick={() => setOpen((current) => !current)}>
      <span className="cross-references__metric" aria-hidden="true"><LinkGlyph /><span className="cross-references__count">{forwardCount}</span></span>
      <span className="cross-references__metric" aria-hidden="true"><BacklinkGlyph /><span className="cross-references__count">{backlinkCount}</span></span>
    </button>
    {open && triggerRef.current != null && <ReferencesDetail pages={pages} loading={loading} loadingMore={loadingMore} error={error} stale={stale} trigger={triggerRef.current} popoverId={popoverId} onClose={close} onLoadMore={loadMore} />}
  </>;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "cross-references", title: "References", component: ThreadHeaderAction });
});
