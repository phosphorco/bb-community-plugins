import { briefWarning, useBriefProducerState } from './brief-producer.tsx';
import { createPortal } from "react-dom";
import { Component, Suspense, lazy, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  UrlLink,
  type ExperimentalPluginBrowserToolbarActionProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";

import type {
  BacklinkRow,
  ForwardReferenceStatus,
  ForwardReferenceRow,
  ListBacklinksResponse,
  ListForwardReferencesResponse,
} from "./model.ts";
import type { rpcContract } from "./rpc-contract.ts";
import "./app.css";
import { displayLabel, mergeReferenceRows, referenceIdentityKey, referenceRecency,
  mentionsSubPath, type MentionSelection,
} from "./presentation.ts";
export { cleanInlineMarkdown, excerptDisplay } from "./presentation.ts";

const EMPTY_BACKLINKS: ListBacklinksResponse = { rows: [], total: 0, nextCursor: null };
const EMPTY_FORWARDS: ListForwardReferencesResponse = { rows: [], total: 0, nextCursor: null };
const BB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Direction = "forward" | "backlink";
type ReferencePages = { forward: ListForwardReferencesResponse; backlink: ListBacklinksResponse };
type LoadingMore = Record<Direction, boolean>;
type ForwardReferenceChecks = { checks: ForwardReferenceStatus[]; checking: boolean; checkError: boolean };

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
  const refreshGeneration = useRef(0);
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
        const requestGeneration = ++refreshGeneration.current;
        const source = { provider: "bb", keys: { project: request.projectId, thread: request.threadId } };
        try {
          const [forward, backlink] = await Promise.all([
            rpcRef.current.call("listForwardReferences", { source, pageSize: 25 }),
            rpcRef.current.call("listBacklinks", { target: source, pageSize: 25 }),
          ]);
          if (mounted.current && request.key === identityRef.current.key && requestGeneration === refreshGeneration.current) {
            setPages({ forward, backlink });
            setError(null);
            setLoading(false);
            setStale(false);
          }
        } catch (cause) {
          if (mounted.current && request.key === identityRef.current.key && requestGeneration === refreshGeneration.current) {
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
    // Refresh replaces the complete page set and invalidates older pagination.
    // Pagination in either direction must never invalidate a refresh or its peer.
    if (cursor == null || moreInFlight.current[direction] || refreshInFlight.current || refreshPending.current || !mounted.current) return;
    moreInFlight.current[direction] = true;
    setLoadingMore((current) => ({ ...current, [direction]: true }));
    const request = identityRef.current;
    const requestGeneration = refreshGeneration.current;
    const source = { provider: "bb", keys: { project: request.projectId, thread: request.threadId } };
    try {
      if (direction === "forward") {
        const next = await rpcRef.current.call("listForwardReferences", { source, pageSize: 25, cursor });
        if (mounted.current && request.key === identityRef.current.key && requestGeneration === refreshGeneration.current) {
          setPages((current) => ({ ...current, forward: { rows: mergeReferenceRows(current.forward.rows, next.rows, (row) => row.target), total: next.total, nextCursor: next.nextCursor } }));
          setError(null);
        }
      } else {
        const next = await rpcRef.current.call("listBacklinks", { target: source, pageSize: 25, cursor });
        if (mounted.current && request.key === identityRef.current.key && requestGeneration === refreshGeneration.current) {
          setPages((current) => ({ ...current, backlink: { rows: mergeReferenceRows(current.backlink.rows, next.rows, (row) => row.source), total: next.total, nextCursor: next.nextCursor } }));
          setError(null);
        }
      }
    } catch (cause) {
      if (mounted.current && request.key === identityRef.current.key && requestGeneration === refreshGeneration.current) {
        setError(cause instanceof Error ? cause.message : "Could not load more references.");
      }
    } finally {
      moreInFlight.current[direction] = false;
      if (mounted.current) setLoadingMore((current) => ({ ...current, [direction]: false }));
    }
  }, []);

  return { pages, loading, loadingMore, error, stale, loadMore };
}

/**
 * Forward-reference reachability is optional display data. It begins only
 * while the References dialog is open, follows the source identity that owns
 * the visible edges, and discards an obsolete result on route or page changes.
 */
function useForwardReferenceChecks(
  open: boolean,
  projectId: string,
  threadId: string,
  rows: readonly ForwardReferenceRow[],
): ForwardReferenceChecks {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const rowKey = JSON.stringify(rows.map((row) => [row.producerPluginId, row.revision, row.position, row.target.presentation.url]));
  const [checks, setChecks] = useState<ForwardReferenceStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);

  useEffect(() => {
    setChecks([]);
    setCheckError(false);
    if (!open || rows.length === 0) {
      setChecking(false);
      return;
    }
    let active = true;
    setChecking(true);
    const source = { provider: "bb", keys: { project: projectId, thread: threadId } };
    void rpcRef.current.call("checkForwardReferences", { source }).then(
      (result) => {
        if (!active) return;
        setChecks(result);
        setChecking(false);
      },
      () => {
        if (!active) return;
        setCheckError(true);
        setChecking(false);
      },
    );
    return () => { active = false; };
  }, [open, projectId, rowKey, rows.length, threadId]);

  return { checks, checking, checkError };
}

function LinkGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 7h3a5 5 0 0 1 0 10h-3M9 17H6A5 5 0 0 1 6 7h3m-1 5h8" /></svg>;
}

function BacklinkGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 7-5 5 5 5m-5-5h10a6 6 0 0 1 6 6v1" /></svg>;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function linkStatusPresentation(check: ForwardReferenceStatus | undefined, checking: boolean, checkError: boolean) {
  if (check === undefined) {
    if (checking) return { label: "Checking", title: "Checking link status", tone: "muted" };
    if (checkError) return { label: "Unavailable", title: "Link-status check unavailable", tone: "muted" };
    return { label: "Not checked", title: "Link was outside the bounded status scan", tone: "muted" };
  }
  if (check.label === "Available") {
    return { label: `${check.status}`, title: `Available (HTTP ${check.status})`, tone: "success" };
  }
  if (check.label === "Redirect" || check.label === "Access restricted") {
    return {
      label: check.status === null ? check.label : `${check.status}`,
      title: check.status === null ? check.label : `${check.label} (HTTP ${check.status})`,
      tone: "warning",
    };
  }
  if (check.label === "Not checked" || check.label.startsWith("BB link")) {
    return { label: "Not checked", title: "Link status was not checked", tone: "muted" };
  }
  return {
    label: check.status === null ? check.label : `${check.status}`,
    title: check.status === null ? check.label : `${check.label} (HTTP ${check.status})`,
    tone: "destructive",
  };
}

type PopoverPosition = { top: number; left: number };

function ResourceLink({
  resource,
  lastSeenAt,
  first,
  check,
  checking,
  checkError,
}: {
  resource: ForwardReferenceRow["target"] | BacklinkRow["source"];
  lastSeenAt?: number | null;
  first: boolean;
  check?: ForwardReferenceStatus;
  checking?: boolean;
  checkError?: boolean;
}) {
  const navigate = useBbNavigate();
  const recency = referenceRecency(lastSeenAt);
  const showStatus = checking !== undefined && checkError !== undefined && resource.presentation.url !== undefined;
  const presented = showStatus ? linkStatusPresentation(check, checking, checkError) : null;
  // Only actual link problems earn a visible badge; healthy, unchecked and in-progress states stay quiet.
  const visibleStatus = presented !== null && (presented.tone === "warning" || presented.tone === "destructive");
  const status = visibleStatus ? presented : null;
  const label = displayLabel(resource.presentation.label, resource.presentation.url);
  // Generic text with no path is dropped when the host line can carry the row alone.
  const primary = label.text ?? (resource.presentation.detail == null ? resource.presentation.label : null);
  const content = <>
    {primary !== null && <strong className={label.derived ? "cross-references__label-derived" : undefined} data-cross-reference-derived={label.derived || undefined}>{primary}</strong>}
    {label.derived && <span className="cross-references__visually-hidden">{` ${label.note}`}</span>}
    {(resource.presentation.detail != null || status !== null || recency !== null) && <span className="cross-references__link-meta">
      {resource.presentation.detail != null && <small>{resource.presentation.detail}</small>}
      {recency !== null && <time className="cross-references__recency" dateTime={recency.iso} title={recency.title} aria-label={recency.title}>{recency.text}</time>}
      {status !== null && <span className={`cross-references__link-status cross-references__link-status-${status.tone}`} title={status.title} aria-label={status.title}>{status.label}</span>}
    </span>}
    {presented !== null && !visibleStatus && <span className="cross-references__visually-hidden" aria-label={presented.title}>{presented.label}</span>}
  </>;
  return resource.presentation.url != null
    ? <a href={resource.presentation.url} className="cross-references__source-link" title={label.title} data-cross-reference-first={first || undefined} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (navigate.openUrl(resource.presentation.url!)) event.preventDefault();
      }}>{content}</a>
    : <span className="cross-references__source-link">{content}</span>;
}

function ReferenceSection({ heading, rows, total, nextCursor, loadingMore, onLoadMore, direction, checks, checking, checkError, target, loading = false }: {
  target: { provider: string; keys: Record<string, string> };
  heading: string;
  loading?: boolean;
  rows: readonly (ForwardReferenceRow | BacklinkRow)[];
  total: number;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  direction: Direction;
  checks: readonly ForwardReferenceStatus[];
  checking: boolean;
  checkError: boolean;
}) {
  const checksByUrl = new Map(checks.map((check) => [check.url, check]));
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState<string | null>(null);
  return <section className="cross-references__section" aria-label={heading} aria-busy={loading && rows.length === 0}>
    <header><strong>{heading}</strong><span>{total}</span></header>
    {rows.length === 0 && !loading && <p className="cross-references__message">No {direction === "forward" ? "forward references" : "backlinks"}.</p>}
    {rows.length > 0 && <ul>{rows.map((row, index) => {
      const resource = direction === "forward" ? (row as ForwardReferenceRow).target : (row as BacklinkRow).source;
      const url = resource.presentation.url;
      return <li key={referenceIdentityKey(resource)} className="cross-references__row"><ResourceLink
        resource={resource}
        lastSeenAt={row.lastSeenAt}
        first={index === 0}
        check={direction === "forward" && url !== undefined ? checksByUrl.get(url) : undefined}
        checking={direction === "forward" && url !== undefined ? checking : undefined}
        checkError={direction === "forward" && url !== undefined ? checkError : undefined}
      />
        {direction === "forward"
          ? <button type="button" className="cross-references__icon" aria-label="Mentions of this resource" title="Mentions of this resource" onClick={() => navigate.toPluginPanel("mentions", { subPath: mentionsSubPath({ v: 1, kind: "query", input: { version: 2, query: { kind: "resource", target: { provider: resource.provider, keys: resource.keys }, relation: "self" } } }) })}><SearchGlyph /></button>
          : <><button type="button" className="cross-references__icon" aria-label="Show context" title="Show context" aria-expanded={expanded === referenceIdentityKey(resource)} onClick={() => setExpanded(current => current === referenceIdentityKey(resource) ? null : referenceIdentityKey(resource))}><span aria-hidden="true">{expanded === referenceIdentityKey(resource) ? "▴" : "▾"}</span></button>
            {expanded === referenceIdentityKey(resource) && <MentionResults key={JSON.stringify([target, referenceIdentityKey(resource), row.producerPluginId])} selection={{ version: 2, query: { kind: "resource", target, relation: "self" }, source: { provider: resource.provider, keys: resource.keys }, producerPluginId: row.producerPluginId }} />}</>}
      </li>;
    })}</ul>}
    {nextCursor != null && <button type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? "Loading more…" : `Load more ${direction === "forward" ? "forward references" : "backlinks"}`}</button>}
  </section>;
}

const COVERAGE_HELP = "Coverage is limited to known sources and at most 50 timeline pages per scan. Supplier failures and scan budgets can leave retained, unconfirmed locations. Legacy Thread Links claims remain until source deletion. Up to 256 targets per source and the newest 100 locations per producer edge are retained; counts show distinct resources, not all mentions.";

function SearchGlyph() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

/** One small control holds every explanation, so the popup body stays links only. */
function ReferencesInfo({ notes, open, onOpenChange }: { notes: readonly string[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const descriptionId = useId();
  const warn = notes.length > 0;
  return <span className="cross-references__info-wrap" onMouseEnter={() => onOpenChange(true)} onMouseLeave={() => onOpenChange(false)}>
    <button type="button" className={warn ? "cross-references__info cross-references__info--warn" : "cross-references__info"}
      aria-label={warn ? "Reference warning" : "References information"} aria-describedby={descriptionId} aria-expanded={open}
      onFocus={() => onOpenChange(true)} onBlur={() => onOpenChange(false)} onClick={() => onOpenChange(!open)}>
      <span aria-hidden="true">{warn ? "!" : "i"}</span>
    </button>
    <span id={descriptionId} role="tooltip" className={open ? "cross-references__info-bubble" : "cross-references__info-bubble cross-references__visually-hidden"}>
      {notes.map((note) => <span key={note} className="cross-references__info-note">{note}</span>)}
      <span>{COVERAGE_HELP}</span>
    </span>
  </span>;
}

function ReferencesDetail({ target, pages, loading, error, stale, loadingMore, checks, checking, checkError, trigger, popoverId, onClose, onLoadMore, briefMessage }: {
  target: { provider: string; keys: Record<string, string> };
  pages: ReferencePages;
  loading: boolean;
  error: string | null;
  stale: boolean;
  loadingMore: LoadingMore;
  checks: readonly ForwardReferenceStatus[];
  checking: boolean;
  checkError: boolean;
  trigger: HTMLButtonElement;
  popoverId: string;
  onClose: () => void;
  onLoadMore: (direction: Direction) => void;
  briefMessage?: string | null;
}) {
  const navigate = useBbNavigate();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ top: 8, left: 8 });
  const [infoOpen, setInfoOpen] = useState(false);
  const infoOpenRef = useRef(false);
  infoOpenRef.current = infoOpen;
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
    const firstFocusable = contentRef.current?.querySelector<HTMLElement>("button[aria-label='Close references']") ?? contentRef.current?.querySelector<HTMLElement>("button, a, [tabindex='0']");
    (firstFocusable ?? contentRef.current)?.focus();
  }, []);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || (!contentRef.current?.contains(target) && !trigger.contains(target))) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (infoOpenRef.current) { setInfoOpen(false); return; }
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown, true); };
  }, [onClose, trigger]);
  return createPortal(
    <div ref={contentRef} className="cross-references__popover" id={popoverId} role="dialog" aria-label="References" tabIndex={-1} style={{ top: position.top, left: position.left }}>
      <header>
        <strong>References</strong>
        <span className="cross-references__actions">
          <ReferencesInfo open={infoOpen} onOpenChange={setInfoOpen} notes={[
            stale ? "Reconnecting; these links may be briefly out of date." : null,
            error,
            briefMessage ?? null,
          ].filter((note): note is string => note != null)} />
          <button type="button" className="cross-references__icon" title="View mentions" aria-label="View mentions" onClick={() => { onClose(); navigate.toPluginPanel("mentions", { subPath: mentionsSubPath({ v: 1, kind: "query", input: { version: 2, query: { kind: "resource", target, relation: "self" } } }) }); }}>
            <SearchGlyph />
          </button>
          <button type="button" className="cross-references__icon" onClick={onClose} aria-label="Close references" title="Close">×</button>
        </span>
      </header>
      <p className="cross-references__visually-hidden" role="status">{loading ? "Checking references…" : ""}</p>
      <p className="cross-references__visually-hidden" role="alert">{error ?? ""}</p>
      <ReferenceSection target={target} heading="Forward references" loading={loading} rows={pages.forward.rows} total={pages.forward.total} nextCursor={pages.forward.nextCursor} loadingMore={loadingMore.forward} onLoadMore={() => onLoadMore("forward")} direction="forward" checks={checks} checking={checking} checkError={checkError} />
      <ReferenceSection target={target} heading="Backlinks" loading={loading} rows={pages.backlink.rows} total={pages.backlink.total} nextCursor={pages.backlink.nextCursor} loadingMore={loadingMore.backlink} onLoadMore={() => onLoadMore("backlink")} direction="backlink" checks={[]} checking={false} checkError={false} />
    </div>,
    document.body,
  );
}

function ThreadHeaderAction({ threadId, projectId }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const { pages, loading, loadingMore, error, stale, loadMore } = useThreadReferences(projectId, threadId);
  const brief=useBriefProducerState(threadId);
  const [open, setOpen] = useState(false);
  const { checks, checking, checkError } = useForwardReferenceChecks(open, projectId, threadId, pages.forward.rows);
  const popoverId = `cross-references-thread-detail-${useId().replaceAll(":", "")}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  const forwardCount = pages.forward.total;
  const backlinkCount = pages.backlink.total;
  const count = forwardCount + backlinkCount;
  const directionLabels = [
    forwardCount > 0 ? countLabel(forwardCount, "forward reference") : null,
    backlinkCount > 0 ? countLabel(backlinkCount, "backlink") : null,
  ].filter((label): label is string => label !== null);
  // Keep the header quiet until this exact thread has a relationship to show.
  // Once visible, its dialog owns refresh/loading detail for that relationship.
  const hasBrief=brief.state?.status!=null||Boolean(brief.state?.projection?.targets.length);
  if ((loading || count === 0) && !hasBrief) return null;
  return <>
    <button ref={triggerRef} type="button" className="cross-references__trigger" aria-label={`Cross-references: ${directionLabels.length?directionLabels.join(", "):"Thread Brief"}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={popoverId} title="Show cross-references" onClick={() => setOpen((current) => !current)}>
      {count===0&&hasBrief&&<span>Brief references</span>}
      {forwardCount > 0 && <span className="cross-references__metric" aria-hidden="true"><LinkGlyph /><span className="cross-references__count">{forwardCount}</span></span>}
      {backlinkCount > 0 && <span className="cross-references__metric" aria-hidden="true"><BacklinkGlyph /><span className="cross-references__count">{backlinkCount}</span></span>}
    </button>
    {open && triggerRef.current != null && <ReferencesDetail target={{ provider: "bb", keys: { project: projectId, thread: threadId } }} pages={pages} loading={loading} loadingMore={loadingMore} error={error} stale={stale} checks={checks} checking={checking} checkError={checkError} trigger={triggerRef.current} popoverId={popoverId} onClose={close} onLoadMore={loadMore} briefMessage={briefWarning(brief)} />}
  </>;
}

export const PANEL_LOAD_RECOVERY_MS = 10_000;
type LoadSurface<Props extends object> = () => Promise<{ default: ComponentType<Props> }>;

class SurfaceLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function SurfaceRecovery({ children, retire }: { children: ReactNode; retire: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => {
    if (content.current?.contains(document.activeElement)) retire();
  }, [retire]);
  return <div ref={content} className="cr-body-load-status">{children}</div>;
}

function SurfaceLoading({ name, retry, retire }: { name: string; retry: () => void; retire: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), PANEL_LOAD_RECOVERY_MS);
    return () => clearTimeout(timer);
  }, []);
  return <SurfaceRecovery retire={retire}>
    <div role="status">{slow ? `${name} is taking longer to load.` : `Loading ${name}…`}</div>
    {slow && <RetrySurface name={name} retry={retry} />}
  </SurfaceRecovery>;
}

function RetrySurface({ name, retry }: { name: string; retry: () => void }) {
  return <button type="button" onClick={retry}
    className="cr-body-load-retry">
    Retry loading {name}
  </button>;
}

class SurfaceBoundary extends Component<{ name: string; children: ReactNode; retry: () => void; retire: () => void }, { error: SurfaceLoadError | null }> {
  state: { error: SurfaceLoadError | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    // Surface render failures retain BB's native slot crash handling.
    if (!(error instanceof SurfaceLoadError)) throw error;
    return { error };
  }

  render() {
    if (this.state.error) return <SurfaceRecovery retire={this.props.retire}>
      <div role="alert">{this.props.name} could not load.</div>
      <details className="cr-body-load-details">
        <summary>Error details</summary>
        <pre>{this.state.error.message}</pre>
      </details>
      <RetrySurface name={this.props.name} retry={this.props.retry} />
    </SurfaceRecovery>;
    return this.props.children;
  }
}

/** React owns module caching. Each surface retains its selected lazy component;
 * the mounted Mentions body keeps its existing input and reader lifetimes. */
export function createMentionsBodyLoader<Props extends object>(name: string, load: LoadSurface<Props>, className = "cr-body-loader") {
  const loadWithError = async () => {
    try { return await load(); }
    catch (cause) { throw new SurfaceLoadError(cause); }
  };
  let currentPanel = lazy(loadWithError);
  return function MentionsBodyLoader(props: Props) {
    const region = useRef<HTMLDivElement>(null);
    const [{ Panel, attempt }, setSelection] = useState(() => ({ Panel: currentPanel, attempt: 0 }));
    const retry = () => {
      const nextPanel = lazy(loadWithError);
      currentPanel = nextPanel;
      setSelection(previous => ({ Panel: nextPanel, attempt: previous.attempt + 1 }));
    };
    const retire = useCallback(() => region.current?.focus({ preventScroll: true }), []);
    const Surface = Panel as ComponentType<Props>;
    return <div ref={region} role="region" aria-label={name} tabIndex={-1}
      data-cr-body-loader="" className={className}>
      <SurfaceBoundary name={name} key={attempt} retry={retry} retire={retire}>
        <Suspense fallback={<SurfaceLoading name={name} retry={retry} retire={retire} />}>
          <Surface {...props} />
        </Suspense>
      </SurfaceBoundary>
    </div>;
  };
}

const MentionsPanel = createMentionsBodyLoader<PluginNavPanelProps>("Mentions", async () => {
  const module = await import("./mentions-body.tsx");
  return { default: module.MentionsPanel };
}, "cr-body-loader cr-body-panel");
const MentionResults = createMentionsBodyLoader<{ selection: MentionSelection }>("Expanded mentions", async () => {
  const module = await import("./mentions-body.tsx");
  return { default: module.MentionResults };
});

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "cross-references", title: "References", component: ThreadHeaderAction });
  app.slots.experimental_browserToolbarAction({ id: "mentions", title: "Mentions", component: BrowserMentionsAction });
  app.slots.navPanel({ id: "mentions", title: "Mentions", icon: "Link", path: "mentions", component: MentionsPanel });
});

function BrowserMentionsAction({ url, isCompactViewport }: ExperimentalPluginBrowserToolbarActionProps) {
  const navigate = useBbNavigate();
  return <button type="button" className="cross-references__trigger" aria-label="Mentions of current page" title="Mentions of current page" onClick={() => {
    let subPath = "";
    try { subPath = mentionsSubPath({ v: 1, kind: "lookup", href: url, mode: "recognize" }); } catch { subPath = "unavailable"; }
    navigate.toPluginPanel("mentions", { subPath });
  }}>{isCompactViewport ? <LinkGlyph /> : "Mentions"}</button>;
}
