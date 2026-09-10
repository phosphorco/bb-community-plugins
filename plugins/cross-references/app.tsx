import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import type { BacklinkRow, ListBacklinksResponse } from "./model.ts";
import type { rpcContract } from "./rpc-contract.ts";
import "./app.css";

const EMPTY_PAGE: ListBacklinksResponse = { rows: [], nextCursor: null };
const BB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function identityKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`;
}

async function exactThreadIdentityDigest(projectId: string, threadId: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) return null;
  if (!BB_ID_PATTERN.test(projectId) || !BB_ID_PATTERN.test(threadId)) return null;
  // Keep the browser digest's input identical to canonicalizeIdentity()'s
  // frozen v1 BB thread form; do not hash arbitrary host-provided strings.
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

function useThreadBacklinks(projectId: string, threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const identityRef = useRef({ projectId, threadId, key: identityKey(projectId, threadId) });
  identityRef.current = { projectId, threadId, key: identityKey(projectId, threadId) };
  const digestRef = useRef<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [page, setPage] = useState<ListBacklinksResponse>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const initializedIdentity = useRef<string | null>(null);
  const inFlight = useRef(false);
  const refreshPending = useRef(false);
  const pageRef = useRef(page);
  pageRef.current = page;
  const moreInFlight = useRef(false);
  const pendingSignals = useRef<unknown[]>([]);
  const pendingSignalOverflow = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    digestRef.current = null;
    pendingSignals.current = [];
    pendingSignalOverflow.current = false;
    setDigest(null);
    void exactThreadIdentityDigest(projectId, threadId).then((next) => {
      if (active) {
        digestRef.current = next;
        setDigest(next);
        const shouldRefresh = pendingSignalOverflow.current || pendingSignals.current.some((payload) => signalMatches(payload, next));
        pendingSignals.current = [];
        pendingSignalOverflow.current = false;
        if (shouldRefresh) void refresh();
      }
    });
    return () => { active = false; };
  }, [projectId, threadId]);

  const loadMore = useCallback(async () => {
    const request = identityRef.current;
    const cursor = pageRef.current.nextCursor;
    if (cursor == null || inFlight.current || moreInFlight.current || !mounted.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    const requestSequence = ++sequence.current;
    try {
      const next = await rpcRef.current.call("listBacklinks", {
        target: { provider: "bb", keys: { project: request.projectId, thread: request.threadId } },
        pageSize: 25,
        cursor,
      });
      if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
        setPage((current) => ({ rows: [...current.rows, ...next.rows], nextCursor: next.nextCursor }));
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
        setError(cause instanceof Error ? cause.message : "Could not load more linked sources.");
      }
    } finally {
      moreInFlight.current = false;
      if (mounted.current) setLoadingMore(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    refreshPending.current = true;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (refreshPending.current && mounted.current) {
        refreshPending.current = false;
        const request = identityRef.current;
        const requestSequence = ++sequence.current;
        try {
          const next = await rpcRef.current.call("listBacklinks", {
            target: { provider: "bb", keys: { project: request.projectId, thread: request.threadId } },
            pageSize: 25,
          });
          if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
            setPage(next);
            setError(null);
            setLoading(false);
            setStale(false);
          }
        } catch (cause) {
          if (mounted.current && request.key === identityRef.current.key && requestSequence === sequence.current) {
            setError(cause instanceof Error ? cause.message : "Could not load linked sources.");
            setLoading(false);
          }
        }
      }
    } finally {
      inFlight.current = false;
      if (refreshPending.current && mounted.current) void refresh();
    }
  }, []);

  useEffect(() => {
    const key = identityKey(projectId, threadId);
    if (initializedIdentity.current === key) return;
    initializedIdentity.current = key;
    setPage(EMPTY_PAGE);
    setError(null);
    setLoading(true);
    setStale(false);
    void refresh();
  }, [projectId, threadId, refresh]);

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

  return { digest, page, loading, loadingMore, error, stale, loadMore };
}

function LinkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9.5 14.5 14.5 9.5m-8.1 8.1 1.8-1.8m4.4-4.4 1.8-1.8a3.3 3.3 0 0 0-4.7-4.7L8 6.7m8.1 8.1-1.8 1.8a3.3 3.3 0 0 1-4.7-4.7l1.8-1.8" />
    </svg>
  );
}

type PopoverPosition = { top: number; left: number };

function BacklinkDetail({
  page,
  loading,
  error,
  stale,
  loadingMore,
  trigger,
  popoverId,
  onClose,
  onLoadMore,
}: {
  page: ListBacklinksResponse;
  loading: boolean;
  error: string | null;
  stale: boolean;
  loadingMore: boolean;
  trigger: HTMLButtonElement;
  popoverId: string;
  onClose: () => void;
  onLoadMore: () => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ top: 8, left: 8 });

  const updatePosition = useCallback(() => {
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(360, Math.max(240, window.innerWidth - 16));
    const left = Math.min(Math.max(8, bounds.right - width), Math.max(8, window.innerWidth - width - 8));
    const estimatedHeight = Math.min(360, Math.max(150, window.innerHeight * 0.6));
    const top = bounds.bottom + 7 + estimatedHeight <= window.innerHeight - 8
      ? bounds.bottom + 7
      : Math.max(8, bounds.top - estimatedHeight - 7);
    setPosition({ top, left });
  }, [trigger]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={contentRef}
      className="cross-references__popover"
      id={popoverId}
      role="dialog"
      aria-label="Linked sources"
      tabIndex={-1}
      style={{ top: position.top, left: position.left }}
    >
      <header>
        <strong>Linked sources</strong>
        <span>{page.rows.length}</span>
        <button type="button" className="cross-references__close" onClick={onClose} aria-label="Close linked sources">Close</button>
      </header>
      {stale && <p className="cross-references__stale" role="status">The connection is recovering; this may be briefly out of date.</p>}
      {loading && page.rows.length === 0 && <p className="cross-references__message" role="status">Checking linked sources…</p>}
      {error != null && <p className="cross-references__error" role="alert">{error}</p>}
      {!loading && page.rows.length === 0 && error == null && <p className="cross-references__message">No linked sources found.</p>}
      {page.rows.length > 0 && (
        <ul>
          {page.rows.map((row, index) => <BacklinkRowView key={`${row.producerPluginId}:${row.revision}:${row.position}:${index}`} row={row} first={index === 0} />)}
        </ul>
      )}
      {page.nextCursor != null && <button type="button" onClick={onLoadMore} disabled={loadingMore || loading} aria-busy={loadingMore}>
        {loadingMore ? "Loading more…" : "Load more linked sources"}
      </button>}
    </div>,
    document.body,
  );
}

function BacklinkRowView({ row, first }: { row: BacklinkRow; first: boolean }) {
  const navigate = useBbNavigate();
  const content = (
    <>
      <strong>{row.source.presentation.label}</strong>
      {row.source.presentation.detail != null && <small>{row.source.presentation.detail}</small>}
    </>
  );
  return (
    <li>
      {row.source.presentation.url != null
        ? <a href={row.source.presentation.url} className="cross-references__source-link" data-cross-reference-first={first || undefined} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (navigate.openUrl(row.source.presentation.url!)) event.preventDefault();
          }}>{content}</a>
        : <span className="cross-references__source-link">{content}</span>}
    </li>
  );
}

function ThreadHeaderAction({ threadId, projectId, isCompactViewport }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const { page, loading, loadingMore, error, stale, loadMore } = useThreadBacklinks(projectId, threadId);
  const [open, setOpen] = useState(false);
  const popoverId = `cross-references-thread-detail-${useId().replaceAll(":", "")}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="cross-references__trigger"
        aria-label={`Linked sources: ${page.rows.length}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        aria-busy={loading}
        title="Show linked sources"
        onClick={() => setOpen((current) => !current)}
      >
        <LinkGlyph />
        {!isCompactViewport && <span>Links</span>}
        {page.rows.length > 0 && <span className="cross-references__count">{page.rows.length}</span>}
      </button>
      {open && triggerRef.current != null && (
        <BacklinkDetail page={page} loading={loading} loadingMore={loadingMore} error={error} stale={stale} trigger={triggerRef.current} popoverId={popoverId} onClose={close} onLoadMore={loadMore} />
      )}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "cross-references",
    title: "Cross References",
    component: ThreadHeaderAction,
  });
});
