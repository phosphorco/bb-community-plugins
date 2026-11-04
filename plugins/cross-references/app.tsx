import { BriefNavigationSurface, BriefMentionRow, briefWarning, useBriefProducerState } from './brief-producer.tsx';
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useMemo } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
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
  mentionsSubPath, parseMentionsSubPath, mentionClaimKey, mentionItemKey, mentionMessageHref, mentionExcerptParts,
  type MentionItem, type MentionSelection,
} from "./presentation.ts";
import { createCrossReferencesV2Client, type CrossReferencesV2Client } from "@phosphorco/bb-cross-references/bb";
import {
  canonicalizeIdentity, MENTIONS_V2_CHANNEL, mentionsChangedV2Schema, resolveLookupInputV2Schema,
  listMentionsInputV2Schema, type ListMentionsOutputV2, type ResolveLookupOutputV2,
} from "@phosphorco/bb-cross-references";

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

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "cross-references", title: "References", component: ThreadHeaderAction });
  app.slots.experimental_browserToolbarAction({ id: "mentions", title: "Mentions", component: BrowserMentionsAction });
  app.slots.navPanel({ id: "mentions", title: "Mentions", icon: "Link", path: "mentions", component: MentionsPanel });
});

// One mounted reader owns one page, one flight and one invalidation timer.
// Closed toolbar buttons and collapsed rows never instantiate this component.
type MentionPage = Extract<ListMentionsOutputV2, { status: "page" }>;
function useMentionClient(): CrossReferencesV2Client {
  const sdk = useSdk();
  return useMemo(() => createCrossReferencesV2Client(sdk), [sdk]);
}
function MentionResults({ selection }: { selection: MentionSelection }) {
  return <MentionResultOwner key={JSON.stringify(selection)} selection={selection} />;
}
function MentionResultOwner({ selection }: { selection: MentionSelection }) {
  const client = useMentionClient();
  const resultRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<{ page: MentionPage | null; loading: boolean; error: string | null; stale: boolean }>({ page: null, loading: true, error: null, stale: false });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const page = useRef<MentionPage | null>(null);
  const cursorUsed = useRef(false);
  const lifetime = useRef(false);
  const flight = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const described = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef<(cursor?: string, conditional?: boolean) => void>(() => {});
  const schedule = useRef<() => void>(() => {});
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const scope = useMemo(() => ({
    target: selection.query.kind === "resource" ? canonicalizeIdentity(selection.query.target).identityDigest : null,
    source: selection.source ? canonicalizeIdentity(selection.source).identityDigest : null,
  }), [selection]);

  run.current = (cursor, conditional = false) => {
    if (!lifetime.current) return;
    if (document.hidden) { pending.current = true; return; }
    if (flight.current) { pending.current = true; return; }
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = false;
    const controller = new AbortController();
    flight.current = controller;
    setView(current => ({ ...current, loading: true }));
    void (async () => {
      try {
        if (!described.current) { await client.describe(controller.signal); described.current = true; }
        const input = { ...selection, pageSize: 25,
          ...(cursor ? { cursor } : conditional && page.current ? { ifSnapshot: page.current.snapshot } : {}),
        };
        let result = await client.listMentions(input, controller.signal);
        let recovered = false;
        if (result.status === "restart") {
          // Exactly one recovery read; no repeated cursor/restart loop.
          result = await client.listMentions({ ...selection, pageSize: 25 }, controller.signal);
          recovered = true;
        }
        if (!lifetime.current || controller.signal.aborted) return;
        // A refresh queued during pagination supersedes that obsolete page.
        if (cursor && pending.current) return;
        if (result.status === "page") {
          page.current = result;
          // Position and expansion follow the page actually shown: a restart
          // recovery lands on page one, and a background refresh keeps open groups.
          cursorUsed.current = Boolean(cursor) && !recovered;
          if (!conditional) setExpanded(new Set());
          setView({ page: result, loading: false, error: null, stale: false });
        } else if (result.status === "not-modified" && page.current) {
          page.current = { ...page.current, coverage: result.coverage };
          setView({ page: page.current, loading: false, error: null, stale: false });
        } else {
          const message = result.status === "unavailable"
            ? result.reason === "read-budget" ? "Mentions are temporarily unavailable: read limit reached." : "Mention evidence is not available yet."
            : "Mentions changed while loading. Try again.";
          setView(current => ({ ...current, loading: false, error: message, stale: current.page !== null }));
        }
      } catch {
        if (lifetime.current && !controller.signal.aborted) setView(current => ({ ...current, loading: false, error: "Could not read mentions. The connection or V2 service is unavailable.", stale: current.page !== null }));
      } finally {
        if (flight.current === controller) flight.current = null;
        if (lifetime.current && pending.current) schedule.current();
      }
    })();
  };
  schedule.current = () => {
    pending.current = true;
    if (!lifetime.current || document.hidden || flight.current || timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; if (pending.current) run.current(undefined, true); }, 250);
  };
  const invalidate = useCallback((raw: unknown) => {
    const parsed = mentionsChangedV2Schema.safeParse(raw);
    if (!parsed.success) return;
    const signal = parsed.data;
    if (selection.producerPluginId && signal.producerPluginId !== selection.producerPluginId) return;
    if (scope.source && signal.sourceIdentityDigest !== scope.source) return;
    if (scope.target && !signal.scopeListClipped && !signal.affectedIdentityDigests.includes(scope.target)) return;
    schedule.current();
  }, [selection.producerPluginId, scope]);
  useRealtime(MENTIONS_V2_CHANNEL, invalidate);
  useEffect(() => {
    lifetime.current = true;
    resultRef.current?.focus();
    run.current();
    const visibility = () => {
      if (document.hidden) {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      } else if (pending.current) schedule.current();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      lifetime.current = false;
      pending.current = false;
      flight.current?.abort();
      flight.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client]);
  useEffect(() => {
    if (connection !== "connected") setView(current => ({ ...current, stale: current.page !== null }));
    else if (previousConnection.current !== "connected") schedule.current();
    previousConnection.current = connection;
  }, [connection]);

  const groups = new Map<string, { item: MentionItem; pageSlot: number }[]>();
  for (const [pageSlot, item] of (view.page?.items ?? []).entries()) {
    const key = mentionClaimKey(item);
    const group = groups.get(key);
    const slot = { item, pageSlot };
    if (group) group.push(slot); else groups.set(key, [slot]);
  }
  const atFirstPage = view.page !== null && !cursorUsed.current;
  return <BriefNavigationSurface><section ref={resultRef} tabIndex={-1} className="mentions__results" aria-label="Mention results" aria-busy={view.loading}>
    <p className="cross-references__visually-hidden" role="status" aria-live="polite">{view.loading ? "Looking for mentions…" : view.page ? `${view.page.counts.retainedOccurrences === 1 ? "1 mention" : `${view.page.counts.retainedOccurrences} mentions`} found.` : ""}</p>
    {view.loading && view.page === null && <p className="mentions__muted" aria-hidden="true">Looking for mentions…</p>}
    {view.stale && <p className="mentions__notice" role="status"><Icon name="RefreshCw" aria-hidden />Showing the last results; they may be out of date while BB reconnects.</p>}
    {view.error && <div className="mentions__notice mentions__notice--error"><p role="alert">{view.error}</p><button type="button" disabled={view.loading} onClick={() => run.current(undefined, true)}>Retry mentions</button></div>}
    {view.page && <>
      <MentionSummary page={view.page} refreshing={view.loading} onRefresh={() => run.current(undefined, true)} />
      {view.page.items.length === 0 && <p className="mentions__empty">No mentions found in the threads BB has scanned.</p>}
      <ul className="mentions__groups">{[...groups].map(([key, items]) => {
        const first = items[0]!.item;
        const occurrences = items.filter(({ item }) => item.kind === "occurrence" || item.kind === "brief-occurrence");
        const hidden = Math.max(0, occurrences.length - 3);
        let shown = 0;
        return <li key={key} className="mentions__group">
          <MentionGroupHeader item={first} count={occurrences.length} />
          <ul className="mentions__rows">{items.map(({ item, pageSlot }) => {
            if ((item.kind === "occurrence" || item.kind === "brief-occurrence") && ++shown > 3 && !expanded.has(key)) return null;
            return <li key={mentionItemKey(item, pageSlot)}><MentionRow item={item} /></li>;
          })}</ul>
          {hidden > 0 && <button type="button" className="mentions__more" aria-expanded={expanded.has(key)} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{expanded.has(key) ? "Show fewer" : `Show ${hidden} more`}</button>}
        </li>;
      })}</ul>
      {(view.page.nextCursor !== null || !atFirstPage) && <nav className="mentions__pages" aria-label="Mention pages">
        <button type="button" disabled={view.loading || atFirstPage} onClick={() => run.current()}>First page</button>
        <button type="button" disabled={view.loading || view.page.nextCursor === null} onClick={() => { if (page.current?.nextCursor) run.current(page.current.nextCursor); }}>Next page</button>
      </nav>}
    </>}
  </section></BriefNavigationSurface>;
}
const PRODUCER_LABELS: Record<string, string> = { "cross-references": "Conversation", "thread-brief": "Brief", "thread-links": "Thread link" };
function MentionGroupHeader({ item, count }: { item: MentionItem; count: number }) {
  const url = item.source.presentation.url;
  const label = item.source.presentation.label;
  const capNote = item.cap.state === "capped" ? "Only the newest 100 mentions from this thread are kept." : item.cap.state === "unknown" || item.cap.sourceHistoryUnknown ? "Some older mentions from this thread may not have been kept." : undefined;
  return <header className="mentions__group-head">
    <Icon name="MessageSquare" fallback="ChevronRight" aria-hidden />
    <h3 className="mentions__thread-heading">{url ? <UrlLink href={url} className="mentions__thread">{label}</UrlLink> : <span className="mentions__thread">{label}</span>}</h3>
    <span className="mentions__chip">{PRODUCER_LABELS[item.producerPluginId] ?? item.producerPluginId}</span>
    {count > 0 && <span className="mentions__count">{count === 1 ? "1 mention" : `${count} mentions`}</span>}
    {capNote && <span className="mentions__chip mentions__chip--warn" title={capNote} aria-label={`Partial: ${capNote}`}>Partial</span>}
  </header>;
}
function MentionSummary({ page, refreshing, onRefresh }: { page: MentionPage; refreshing: boolean; onRefresh: () => void }) {
  const { counts, coverage } = page;
  const threads = counts.indexedSources;
  const mentions = counts.retainedOccurrences;
  const partial = coverage.collectionIncomplete || coverage.retentionLimited || coverage.capHistoryUnknown || coverage.evidenceStateUnknown || coverage.authoredUrlCoverage.state === "partial" || coverage.reasons.length > 0;
  return <div className="mentions__summary">
    <div className="mentions__headline-row">
      <p className="mentions__headline">{mentions === 1 ? "1 mention" : `${mentions} mentions`} <span>from {threads === 1 ? "1 place" : `${threads} places`}</span></p>
      <button type="button" className="mentions__refresh" aria-label="Refresh mentions" title="Refresh" disabled={refreshing} onClick={onRefresh}><Icon name="RefreshCw" aria-hidden /></button>
    </div>
    <details className="mentions__about">
      <summary>{partial && <Icon name="TriangleAlert" fallback="Info" aria-hidden />}About these results{partial ? " · may be incomplete" : ""}</summary>
      <ul>
        <li>A place is one conversation or one thread brief; the same thread can appear twice. Only places BB has scanned are included, and counts cover this whole search, not just this page.</li>
        <li>{counts.confirmedOccurrences} confirmed and {counts.unconfirmedOccurrences} unconfirmed locations from {counts.producerClaims} {counts.producerClaims === 1 ? "claim" : "claims"}; {counts.excerptUnavailable} without a quotable sentence; {counts.claimsWithoutLocations} claims without a location.</li>
        {coverage.collectionIncomplete && <li>Some threads were too long to scan completely, so older mentions there may be missing or out of date.</li>}
        {coverage.retentionLimited && <li>Retention limits have dropped some older mentions.</li>}
        {coverage.capHistoryUnknown && <li>For some threads it is unknown whether older mentions were dropped.</li>}
        {coverage.legacyClaimsPresent && <li>Includes links recorded by the older Thread Links feature.</li>}
        {coverage.evidenceStateUnknown && <li>Some mentions have no confirmed location yet.</li>}
        {coverage.authoredUrlCoverage.state === "partial" && <li>The exact URL text is unknown for {coverage.authoredUrlCoverage.unknownLocations} older mentions, so an Exact URL search may miss them.</li>}
        {coverage.reasons.map(reason => <li key={reason}>{reason === "pr-family-authority-unknown" ? "Some stored references could not be confirmed as part of this pull request." : reason}</li>)}
        {coverage.reasonsClipped && <li>More coverage notes were omitted.</li>}
        <li>Groups follow their first result; at most three mentions per thread show until you expand it.</li>
      </ul>
    </details>
  </div>;
}
/** Snippets are raw source slices; show them the way the message reads, keeping the highlight. */
export function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "$1");
}
export function excerptDisplay(parts: { before: string; match: string; after: string }) {
  let { before, match, after } = parts;
  const open = /\[([^\]\n]*)\]\($/.exec(before);
  if (open && after.startsWith(")")) { before = before.slice(0, open.index); match = open[1] || match; after = after.slice(1); }
  else if (before.endsWith("[")) {
    const close = /^\]\((?:[^()\s]|\([^()\s]*\))*\)/.exec(after);
    if (close) { before = before.slice(0, -1); after = after.slice(close[0].length); }
  }
  // Emphasis or code wrapping exactly the highlighted text would otherwise leave stray delimiters.
  for (const mark of ["**", "`", "*"]) {
    if (before.endsWith(mark) && after.startsWith(mark)) { before = before.slice(0, -mark.length); after = after.slice(mark.length); break; }
  }
  return { before: cleanInlineMarkdown(before), match: cleanInlineMarkdown(match) || match, after: cleanInlineMarkdown(after) };
}
const EXCERPT_UNAVAILABLE: Record<string, string> = { "not-materialized": "Sentence not collected yet.", "indivisible-word": "The sentence is too long to quote.", "no-eligible-context": "No safe sentence to quote." };
function MentionRow({ item }: { item: MentionItem }) {
  if (item.kind === "brief-occurrence") return <BriefMentionRow item={item} />;
  const href = mentionMessageHref(item);
  const sourceUrl = item.source.presentation.url;
  const parts = mentionExcerptParts(item);
  if (item.kind !== "occurrence") {
    const note = item.kind === "unsupported" ? "This mention uses a newer format; it is still counted." : item.reason === "legacy" ? "Recorded by the older Thread Links feature; no sentence was kept." : item.reason === "producer-no-evidence" ? "Recorded without a location." : "Location not collected yet.";
    return <article className="mentions__row mentions__row--claim">
      <p className="mentions__muted">{note}</p>
      {href ? <UrlLink href={href} className="mentions__open" aria-label="Original message">Open <Icon name="ArrowUpRight" aria-hidden /></UrlLink> : sourceUrl && <UrlLink href={sourceUrl} className="mentions__open" aria-label="Open source">Open <Icon name="ArrowUpRight" aria-hidden /></UrlLink>}
    </article>;
  }
  const role = item.locator.role === "user" ? "user" : "assistant";
  const linkName = `${role === "user" ? "User" : "Assistant"} message ${item.locator.messageSeq}`;
  const how = `${item.confirmation === "retained-unconfirmed" ? "Retained, not reconfirmed on the last scan" : "Seen on the last scan"} · ${item.provenance.origin === "contributed" ? "recognized by a plugin" : "recognized by BB"} · ${item.provenance.confidence} confidence · ${item.provenance.recognition.basis}`;
  const shown = parts && item.excerpt.state === "ready" ? excerptDisplay(parts) : null;
  return <article className="mentions__row" title={how}>
    <span className={`mentions__chip mentions__chip--${role}`}>{role === "user" ? "You" : "Agent"}</span>
    <div className="mentions__body">
      {shown && item.excerpt.state === "ready" ? <p className="mentions__excerpt">
        {item.excerpt.clippedBefore && <span aria-label="Excerpt clipped before">…</span>}{shown.before}<mark>{shown.match}</mark>{shown.after}{item.excerpt.clippedAfter && <span aria-label="Excerpt clipped after">…</span>}
      </p> : <p className="mentions__muted">{item.excerpt.state === "unavailable" ? EXCERPT_UNAVAILABLE[item.excerpt.reason] ?? "Sentence unavailable." : "Sentence unavailable."}</p>}
      {item.confirmation === "retained-unconfirmed" && <span className="mentions__chip mentions__chip--warn">Not reconfirmed</span>}
    </div>
    <span className="mentions__actions">
      {href ? <UrlLink href={href} className="mentions__icon" aria-label={linkName} title={`Open ${linkName.toLowerCase()}`}><Icon name="ArrowUpRight" aria-hidden /></UrlLink>
        : sourceUrl ? <UrlLink href={sourceUrl} className="mentions__icon" aria-label="Open source" title="Exact message unavailable; open the thread"><Icon name="ArrowUpRight" aria-hidden /></UrlLink> : null}
      {item.provenance.authoredHref && <UrlLink href={item.provenance.authoredHref} className="mentions__icon" aria-label="Open mentioned link" title="Open the link as written"><Icon name="Link" fallback="ArrowUpRight" aria-hidden /></UrlLink>}
    </span>
  </article>;
}

function BrowserMentionsAction({ url, isCompactViewport }: ExperimentalPluginBrowserToolbarActionProps) {
  const navigate = useBbNavigate();
  return <button type="button" className="cross-references__trigger" aria-label="Mentions of current page" title="Mentions of current page" onClick={() => {
    let subPath = "";
    try { subPath = mentionsSubPath({ v: 1, kind: "lookup", href: url, mode: "recognize" }); } catch { subPath = "unavailable"; }
    navigate.toPluginPanel("mentions", { subPath });
  }}>{isCompactViewport ? <LinkGlyph /> : "Mentions"}</button>;
}
const MODE_HELP = "Smart match understands PR links, short forms like org/repo#123, review links and thread mentions. Exact URL matches the literal text only.";
function MentionsPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const client = useMentionClient();
  const route = useMemo(() => {
    try { return { value: parseMentionsSubPath(subPath), invalid: false }; }
    catch { return { value: null, invalid: true }; }
  }, [subPath]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"recognize" | "exact-url">("recognize");
  const [lookup, setLookup] = useState<ResolveLookupOutputV2 | null>(null);
  const [selection, setSelection] = useState<MentionSelection | null>(null);
  const [routeLabel, setRouteLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const described = useRef(false);
  const generation = useRef(0);
  const fieldId = useId();
  const modeHelpId = useId();
  const choose = useCallback((option: ResolveLookupOutputV2["options"][number]) => {
    try {
      // Outputs tolerate additions; only current input fields enter a strict query.
      // Manual choices must contain projection/validation failures just like auto-selection.
      const query = option.query.kind === "authored-url" ? { kind: "authored-url" as const, href: option.query.href }
        : { kind: "resource" as const, target: { provider: option.query.target.provider, keys: option.query.target.keys }, relation: option.query.relation };
      const input = listMentionsInputV2Schema.parse({ version: 2, query });
      const label = option.label.trim().slice(0, 256) || undefined;
      const next = mentionsSubPath({ v: 1, kind: "query", input, ...(label ? { label } : {}) });
      setRouteLabel(label ?? null);
      navigate.toPluginPanel("mentions", { subPath: next });
      setSelection(input);
      setError(null);
    } catch {
      setSelection(null);
      setError("This lookup choice is invalid or too large to open. Choose another resource.");
    }
  }, [navigate]);
  const resolve = useCallback((value: string, nextMode: "recognize" | "exact-url") => {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    const request = ++generation.current;
    setSelection(null); setLookup(null); setBusy(true); setError(null);
    void (async () => {
      try {
        const input = resolveLookupInputV2Schema.parse({ version: 2, text: value, mode: nextMode });
        if (!described.current) { await client.describe(controller.signal); described.current = true; }
        const result = await client.resolveLookup(input, controller.signal);
        if (controller.signal.aborted || generation.current !== request) return;
        setLookup(result);
        if (result.state === "ready" && result.options.length === 1) choose(result.options[0]!);
      } catch {
        if (!controller.signal.aborted && generation.current === request) setError("Could not resolve this lookup. Check its size, URL safety and V2 service availability.");
      } finally {
        if (!controller.signal.aborted && generation.current === request) setBusy(false);
      }
    })();
  }, [client, choose]);
  useEffect(() => {
    ++generation.current;
    flight.current?.abort();
    setBusy(false); setError(null); setSelection(null);
    if (route.value?.kind === "query") {
      const input = route.value.input;
      setRouteLabel(route.value.label ?? null);
      setSelection(input);
      setLookup(current => current?.options.some(option => JSON.stringify(option.query) === JSON.stringify(input.query)) ? current : null);
    }
    else if (route.value?.kind === "lookup") {
      setLookup(null);
      setText(route.value.href); setMode(route.value.mode);
      resolve(route.value.href, route.value.mode);
    } else setLookup(null);
    return () => { ++generation.current; flight.current?.abort(); };
  }, [route, resolve]);
  const queryLabel = selection === null ? null : selection.query.kind === "authored-url" ? selection.query.href
    : routeLabel ?? (selection.query.target.provider === "url" ? selection.query.target.keys.href : undefined)
    ?? lookup?.options.find(option => JSON.stringify(option.query) === JSON.stringify(selection.query))?.label
    ?? (selection.query.target.provider === "bb" ? selection.query.target.keys.thread ?? selection.query.target.keys.project : undefined);
  const scopeLabel = selection === null ? null : selection.query.kind === "authored-url" ? "Exact authored URL" : selection.query.relation === "github-pr-family" ? "Recognized PR family" : "Exact resource";
  const scopeHint = selection === null ? null : selection.query.kind === "authored-url" ? "Only mentions that wrote exactly this URL." : selection.query.relation === "github-pr-family" ? "The pull request and its reviews and comments, however they were written." : "Mentions of exactly this resource.";
  return <main className="mentions" aria-label="Mentions">
    <header className="mentions__intro">
      <h1>Mentions</h1>
      <p>Find where a pull request, thread, or link was mentioned in the conversations and briefs BB has scanned.</p>
    </header>
    <form className="mentions__search" onSubmit={event => { event.preventDefault(); resolve(text, mode); }}>
      <label htmlFor={fieldId} className="cross-references__visually-hidden">Find mentions of a resource or URL</label>
      <span className="mentions__field"><Icon name="Search" aria-hidden /><input id={fieldId} value={text} onChange={event => setText(event.target.value)} placeholder="Paste a PR link, #123, a thread, or any URL" /></span>
      <label className="mentions__mode" title={MODE_HELP}>
        <span className="cross-references__visually-hidden">Lookup mode</span>
        <span id={modeHelpId} className="cross-references__visually-hidden">{MODE_HELP}</span>
        <select aria-label="Lookup mode" aria-describedby={modeHelpId} value={mode} onChange={event => setMode(event.target.value === "exact-url" ? "exact-url" : "recognize")}><option value="recognize">Smart match</option><option value="exact-url">Exact URL</option></select>
      </label>
      <button type="submit" className="mentions__submit" disabled={busy} aria-label="Find mentions">{busy ? "Searching…" : "Find"}</button>
    </form>
    {route.invalid && <p className="mentions__notice mentions__notice--error" role="alert">This link to Mentions is invalid or too large. Paste what you are looking for above.</p>}
    {error && <p className="mentions__notice mentions__notice--error" role="alert">{error}</p>}
    {lookup && (lookup.options.length > 1 || lookup.state !== "ready") && <section className="mentions__choices" aria-label="Lookup choices">
      <p role="status">{lookup.state === "ambiguous" ? "Choose the intended resource." : lookup.state === "incomplete" ? "Recognition is incomplete. Available choices may not cover every interpretation." : lookup.state === "unrecognized" ? "No recognized resource. Try Exact URL for a supported URL." : "Choose what to search for."}</p>
      {lookup.options.map((option, index) => <button key={index} type="button" onClick={() => choose(option)}>
        <span>{option.label} · {option.basis}</span>
        <span className="mentions__chip">{option.query.kind === "resource" && option.query.relation === "github-pr-family" ? "PR family" : option.query.kind === "authored-url" ? "Exact URL" : "Exact resource"}</span>
      </button>)}
    </section>}
    {selection === null && lookup === null && !busy && !route.invalid && !error && <section className="mentions__help" aria-label="How Mentions works">
      <p>Try a PR link like <code>github.com/org/repo/pull/123</code>, a short form like <code>org/repo#123</code>, a BB thread, or any web URL. Open a result to jump to that message or brief section.</p>
      <details>
        <summary>How matching works</summary>
        <ul>
          <li><strong>Smart match</strong> finds the usual spellings: a pull request also matches its review and comment links, and <code>#123</code> written next to a link to its repository.</li>
          <li><strong>Exact URL</strong> matches only the text exactly as written.</li>
          <li>Results are grouped by conversation or brief. You can also start from the Mentions button in BB's browser or from a thread's References popup.</li>
        </ul>
      </details>
    </section>}
    {selection && <section className="mentions__answer" aria-label="Search">
      <header className="mentions__query">
        <h2 className="mentions__query-label">{queryLabel ?? "Selected resource"}</h2>
        <span className="mentions__chip" role="status">{scopeLabel}</span>
        {scopeHint && <span className="mentions__muted mentions__scope-hint">{scopeHint}</span>}
      </header>
      <MentionResults selection={selection} />
    </section>}
  </main>;
}
