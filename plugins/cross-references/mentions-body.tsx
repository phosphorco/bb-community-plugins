import { BriefNavigationSurface, BriefMentionRow } from "./brief-producer.tsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRealtime, useRealtimeConnectionState, useSdk, UrlLink, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { mentionsSubPath, parseMentionsSubPath, mentionClaimKey, mentionItemKey, mentionMessageHref, mentionExcerptParts, excerptDisplay, type MentionItem, type MentionSelection } from "./presentation.ts";
import { createCrossReferencesV2Client, type CrossReferencesV2Client } from "@phosphorco/bb-cross-references/bb";
import { canonicalizeIdentity, MENTIONS_V2_CHANNEL, mentionsChangedV2Schema, resolveLookupInputV2Schema, listMentionsInputV2Schema, type ListMentionsOutputV2, type ResolveLookupOutputV2 } from "@phosphorco/bb-cross-references";

// One mounted reader owns one page, one flight and one invalidation timer.
// Closed toolbar buttons and collapsed rows never instantiate this component.
type MentionPage = Extract<ListMentionsOutputV2, { status: "page" }>;
function useMentionClient(): CrossReferencesV2Client {
  const sdk = useSdk();
  return useMemo(() => createCrossReferencesV2Client(sdk), [sdk]);
}
export function MentionResults({ selection }: { selection: MentionSelection }) {
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

const MODE_HELP = "Smart match understands PR links, short forms like org/repo#123, review links and thread mentions. Exact URL matches the literal text only.";
export function MentionsPanel({ subPath }: PluginNavPanelProps) {
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
