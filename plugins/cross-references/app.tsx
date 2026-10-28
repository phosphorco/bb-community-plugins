import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useMemo } from "react";
import {
  definePluginApp,
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
  const status = showStatus ? linkStatusPresentation(check, checking, checkError) : null;
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
  </>;
  return resource.presentation.url != null
    ? <a href={resource.presentation.url} className="cross-references__source-link" title={label.title} data-cross-reference-first={first || undefined} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (navigate.openUrl(resource.presentation.url!)) event.preventDefault();
      }}>{content}</a>
    : <span className="cross-references__source-link">{content}</span>;
}

function ReferenceSection({ heading, rows, total, nextCursor, loadingMore, onLoadMore, direction, checks, checking, checkError, target }: {
  target: { provider: string; keys: Record<string, string> };
  heading: string;
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
  return <section className="cross-references__section" aria-label={heading}>
    <header><strong>{heading}</strong><span>{total}</span></header>
    {rows.length === 0 && <p className="cross-references__message">No {direction === "forward" ? "forward references" : "backlinks"}.</p>}
    {rows.length > 0 && <ul>{rows.map((row, index) => {
      const resource = direction === "forward" ? (row as ForwardReferenceRow).target : (row as BacklinkRow).source;
      const url = resource.presentation.url;
      return <li key={referenceIdentityKey(resource)}><ResourceLink
        resource={resource}
        lastSeenAt={row.lastSeenAt}
        first={index === 0}
        check={direction === "forward" && url !== undefined ? checksByUrl.get(url) : undefined}
        checking={direction === "forward" && url !== undefined ? checking : undefined}
        checkError={direction === "forward" && url !== undefined ? checkError : undefined}
      />
        {direction === "forward"
          ? <button type="button" className="cross-references__close" onClick={() => navigate.toPluginPanel("mentions", { subPath: mentionsSubPath({ v: 1, kind: "query", input: { version: 2, query: { kind: "resource", target: { provider: resource.provider, keys: resource.keys }, relation: "self" } } }) })}>Mentions of this resource</button>
          : <><button type="button" className="cross-references__close" aria-expanded={expanded === referenceIdentityKey(resource)} onClick={() => setExpanded(current => current === referenceIdentityKey(resource) ? null : referenceIdentityKey(resource))}>Show context</button>
            {expanded === referenceIdentityKey(resource) && <MentionResults key={JSON.stringify([target, referenceIdentityKey(resource), row.producerPluginId])} selection={{ version: 2, query: { kind: "resource", target, relation: "self" }, source: { provider: resource.provider, keys: resource.keys }, producerPluginId: row.producerPluginId }} />}</>}
      </li>;
    })}</ul>}
    {nextCursor != null && <button type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? "Loading more…" : `Load more ${direction === "forward" ? "forward references" : "backlinks"}`}</button>}
  </section>;
}

function ReferencesDetail({ target, pages, loading, error, stale, loadingMore, checks, checking, checkError, trigger, popoverId, onClose, onLoadMore }: {
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
}) {
  const navigate = useBbNavigate();
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
      <button type="button" className="cross-references__close" onClick={() => { onClose(); navigate.toPluginPanel("mentions", { subPath: mentionsSubPath({ v: 1, kind: "query", input: { version: 2, query: { kind: "resource", target, relation: "self" } } }) }); }}>View mentions</button>
      <p className="cross-references__message">Coverage is limited to known sources and at most 50 timeline pages per scan. Supplier failures and scan budgets can leave retained, unconfirmed locations. Legacy Thread Links claims remain until source deletion. Up to 256 targets per source and the newest 100 locations per producer edge are retained; counts show distinct resources, not all mentions.</p>
      {stale && <p className="cross-references__stale" role="status">The connection is recovering; this may be briefly out of date.</p>}
      {loading && pages.forward.rows.length === 0 && pages.backlink.rows.length === 0 && <p className="cross-references__message" role="status">Checking references…</p>}
      {error != null && <p className="cross-references__error" role="alert">{error}</p>}
      <ReferenceSection target={target} heading="Forward references" rows={pages.forward.rows} total={pages.forward.total} nextCursor={pages.forward.nextCursor} loadingMore={loadingMore.forward} onLoadMore={() => onLoadMore("forward")} direction="forward" checks={checks} checking={checking} checkError={checkError} />
      <ReferenceSection target={target} heading="Backlinks" rows={pages.backlink.rows} total={pages.backlink.total} nextCursor={pages.backlink.nextCursor} loadingMore={loadingMore.backlink} onLoadMore={() => onLoadMore("backlink")} direction="backlink" checks={[]} checking={false} checkError={false} />
    </div>,
    document.body,
  );
}

function ThreadHeaderAction({ threadId, projectId }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const { pages, loading, loadingMore, error, stale, loadMore } = useThreadReferences(projectId, threadId);
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
  if (loading || count === 0) return null;
  return <>
    <button ref={triggerRef} type="button" className="cross-references__trigger" aria-label={`Cross-references: ${directionLabels.join(", ")}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={popoverId} title="Show cross-references" onClick={() => setOpen((current) => !current)}>
      {forwardCount > 0 && <span className="cross-references__metric" aria-hidden="true"><LinkGlyph /><span className="cross-references__count">{forwardCount}</span></span>}
      {backlinkCount > 0 && <span className="cross-references__metric" aria-hidden="true"><BacklinkGlyph /><span className="cross-references__count">{backlinkCount}</span></span>}
    </button>
    {open && triggerRef.current != null && <ReferencesDetail target={{ provider: "bb", keys: { project: projectId, thread: threadId } }} pages={pages} loading={loading} loadingMore={loadingMore} error={error} stale={stale} checks={checks} checking={checking} checkError={checkError} trigger={triggerRef.current} popoverId={popoverId} onClose={close} onLoadMore={loadMore} />}
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
        if (result.status === "restart") {
          // Exactly one recovery read; no repeated cursor/restart loop.
          result = await client.listMentions({ ...selection, pageSize: 25 }, controller.signal);
        }
        if (!lifetime.current || controller.signal.aborted) return;
        // A refresh queued during pagination supersedes that obsolete page.
        if (cursor && pending.current) return;
        if (result.status === "page") {
          page.current = result;
          setExpanded(new Set());
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
  return <section ref={resultRef} tabIndex={-1} className="mentions__results" aria-label="Mention results" aria-busy={view.loading}>
    {view.loading && <p role="status">Loading mentions…</p>}
    {view.stale && <p role="status">Showing the last available results; they may be out of date.</p>}
    {view.error && <p role="alert">{view.error}</p>}
    {view.error && <button type="button" disabled={view.loading} onClick={() => run.current(undefined, true)}>Retry mentions</button>}
    {view.page && <>
      <MentionCoverage page={view.page} />
      {view.page.items.length === 0 && <p>No matching stored mentions in known sources.</p>}
      <ul className="mentions__groups">{[...groups].map(([key, items]) => {
        const first = items[0]!.item;
        const occurrences = items.filter(({ item }) => item.kind === "occurrence");
        const hidden = Math.max(0, occurrences.length - 3);
        let shown = 0;
        return <li key={key}>
          <strong>{first.source.presentation.label}</strong>
          <small>Producer: {first.producerPluginId} · {first.cap.state === "uncapped" ? "No known location clipping" : first.cap.state === "capped" ? "Locations capped at 100" : "Location cap history unknown"}{first.cap.sourceHistoryUnknown ? " · Source clipping history unknown" : ""}</small>
          <ul>{items.map(({ item, pageSlot }) => {
            if (item.kind === "occurrence" && ++shown > 3 && !expanded.has(key)) return null;
            return <li key={mentionItemKey(item, pageSlot)}><MentionRow item={item} /></li>;
          })}</ul>
          {hidden > 0 && <button type="button" aria-expanded={expanded.has(key)} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{expanded.has(key) ? "Show three locations on this page" : `Show ${hidden} more locations on this page`}</button>}
        </li>;
      })}</ul>
      <nav aria-label="Mention pages">
        <button type="button" disabled={view.loading} onClick={() => run.current()}>First page</button>
        <button type="button" disabled={view.loading || view.page.nextCursor === null} onClick={() => { if (page.current?.nextCursor) run.current(page.current.nextCursor); }}>Next page</button>
      </nav>
      <p className="mentions__note">This page contains {view.page.items.length} rows. Groups follow their first result; locations within each group are newest first. Three locations per claim are initially shown on this page; disclosure reveals the rest of this page.</p>
    </>}
  </section>;
}
function MentionCoverage({ page }: { page: MentionPage }) {
  const { counts, coverage } = page;
  return <div className="mentions__coverage">
    <p>{counts.retainedOccurrences} stored locations · {counts.confirmedOccurrences} confirmed · {counts.unconfirmedOccurrences} unconfirmed · {counts.producerClaims} producer claims · {counts.indexedSources} sources</p>
    <p>Known sources only. Counts cover the query, not just this page or all-time mentions.</p>
    {coverage.collectionIncomplete && <p>Collection is incomplete; unvisited evidence may be retained.</p>}
    {coverage.retentionLimited && <p>Retention limits have clipped stored evidence.</p>}
    {coverage.capHistoryUnknown && <p>Some source clipping history is unknown.</p>}
    {coverage.legacyClaimsPresent && <p>Legacy claims are included.</p>}
    {coverage.evidenceStateUnknown && <p>Some claims have unknown or unbound evidence.</p>}
    <p>{counts.claimsWithoutLocations} claims without locations · {counts.excerptUnavailable} locations without excerpts</p>
    {coverage.authoredUrlCoverage.state === "partial" && <p>Historical authored URLs are unknown for {coverage.authoredUrlCoverage.unknownLocations} known locations; an Exact URL search may miss them.</p>}
    {coverage.reasons.length > 0 && <details><summary>Coverage details</summary><ul>{coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
    {coverage.reasonsClipped && <p>Additional coverage reasons were clipped.</p>}
  </div>;
}
function MentionRow({ item }: { item: MentionItem }) {
  const href = mentionMessageHref(item);
  const sourceUrl = item.source.presentation.url;
  const parts = mentionExcerptParts(item);
  return <article className="mentions__row">
    {href ? <UrlLink href={href}>{item.kind === "occurrence" ? `${item.locator.role === "user" ? "User" : "Assistant"} message ${item.locator.messageSeq}` : "Original message"}</UrlLink>
      : <>{sourceUrl && <UrlLink href={sourceUrl}>Open source</UrlLink>}<span>Exact message location unavailable.</span></>}
    {item.kind === "occurrence" ? <>
      {parts && item.excerpt.state === "ready" ? <p className="mentions__excerpt">
        {item.excerpt.clippedBefore && <span aria-label="Excerpt clipped before">…</span>}{parts.before}<mark>{parts.match}</mark>{parts.after}{item.excerpt.clippedAfter && <span aria-label="Excerpt clipped after">…</span>}
      </p> : <p>Excerpt unavailable: {item.excerpt.state === "unavailable" ? ({ "not-materialized": "not collected", "indivisible-word": "a word exceeds the excerpt limit", "no-eligible-context": "no eligible safe context" }[item.excerpt.reason]) : "unsupported"}.</p>}
      {item.excerpt.state === "ready" && (item.excerpt.matchClippedBefore || item.excerpt.matchClippedAfter) && <small>The highlighted match is clipped; the link opens the full original location.</small>}
      <small>{item.confirmation === "retained-unconfirmed" ? "Retained, unconfirmed location" : "Observed location"} · {item.provenance.origin === "contributed" ? "Supplier recognition" : "Native recognition"} · {item.provenance.confidence} confidence · {item.provenance.recognition.basis}</small>
      {item.provenance.authoredHref && <UrlLink href={item.provenance.authoredHref}>Authored destination</UrlLink>}
    </> : <p>{item.kind === "unsupported" ? "Evidence format unsupported; this claim is still included." : item.reason === "legacy" ? "Legacy claim: no collected location or excerpt." : item.reason === "producer-no-evidence" ? "This producer supplied a claim without location evidence." : "Location evidence has not been collected yet."}</p>}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const described = useRef(false);
  const generation = useRef(0);
  const fieldId = useId();
  const choose = useCallback((option: ResolveLookupOutputV2["options"][number]) => {
    try {
      // Outputs tolerate additions; only current input fields enter a strict query.
      // Manual choices must contain projection/validation failures just like auto-selection.
      const query = option.query.kind === "authored-url" ? { kind: "authored-url" as const, href: option.query.href }
        : { kind: "resource" as const, target: { provider: option.query.target.provider, keys: option.query.target.keys }, relation: option.query.relation };
      const input = listMentionsInputV2Schema.parse({ version: 2, query });
      const next = mentionsSubPath({ v: 1, kind: "query", input });
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
  return <main className="mentions" aria-label="Mentions">
    <h1>Mentions</h1>
    <form onSubmit={event => { event.preventDefault(); resolve(text, mode); }}>
      <label htmlFor={fieldId}>Find mentions of a resource or URL</label>
      <input id={fieldId} value={text} onChange={event => setText(event.target.value)} placeholder="Paste a resource or URL" />
      <label>Lookup mode <select value={mode} onChange={event => setMode(event.target.value === "exact-url" ? "exact-url" : "recognize")}><option value="recognize">Recognize</option><option value="exact-url">Exact URL</option></select></label>
      <button type="submit" disabled={busy}>{busy ? "Resolving…" : "Find mentions"}</button>
    </form>
    <p className="mentions__note">Recognize finds typed resources, including supported PR families. Exact URL searches the literal authored URL without merging aliases.</p>
    {route.invalid && <p role="alert">This lookup route is invalid, unsupported or too large. Paste a supported resource or URL.</p>}
    {error && <p role="alert">{error}</p>}
    {lookup && <section aria-label="Lookup choices">
      {lookup.state !== "ready" && <p role="status">{lookup.state === "ambiguous" ? "Choose the intended resource." : lookup.state === "incomplete" ? "Recognition is incomplete. Available choices may not cover every interpretation." : "No recognized resource. Try Exact URL for a supported URL."}</p>}
      {lookup.options.length > 1 || lookup.state !== "ready" ? lookup.options.map((option, index) => <button key={index} type="button" onClick={() => choose(option)}>{option.label} · {option.basis}{option.query.kind === "resource" && option.query.relation === "github-pr-family" ? " · PR family" : option.query.kind === "authored-url" ? " · Exact authored URL" : " · Exact resource"}</button>) : null}
    </section>}
    {selection && <><p className="mentions__note">{selection.query.kind === "authored-url" ? selection.query.href : selection.query.target.provider === "url" ? selection.query.target.keys.href : selection.query.target.provider === "bb" ? selection.query.target.keys.thread ?? selection.query.target.keys.project : "Selected stored resource"}</p><p role="status">{selection.query.kind === "authored-url" ? "Exact authored URL" : selection.query.relation === "github-pr-family" ? "Recognized PR family" : "Exact resource"}</p><MentionResults selection={selection} /></>}
  </main>;
}
