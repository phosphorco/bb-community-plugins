import { useEffect, useId, useMemo, useRef, useState } from "react";

import "./skills-dashboard.css";

const TABLE_ROW_LIMIT = 100;
const DRAWER_ROW_LIMIT = 200;

export type SkillsDashboardFilters = Readonly<{ startMs?: number; endMs?: number; provider?: string | null; project?: string; environment?: string; skillId?: string; revision?: string }>;
export type SkillsContributor = Readonly<{ id: string; sessionId: string | null; threadId: string; eventId: string; eventSeq: number; kind: "prompt-mention" | "registered-path-command-candidate" | "catalog-snapshot"; path: string | null; outcome: string | null; shellWrapped?: boolean; joinedCommand?: boolean }>;
export type CurrentSkillRevision = Readonly<{ key: string; skillId: string; name: string; scope: string; path: string; revision: string | null; bytes: number | null; registeredPathCount: number; snapshotAtMs: number; contributorIds: readonly string[] }>;
export type Footprint = Readonly<{ key: string; name: string; revision: string | null; bytes: number | null; estimatedTokens: number | null; tokenizer: "none" | "local-bytes-divided-by-4"; sampleN: number; contributorIds: readonly string[] }>;
export type SkillsDashboardData = Readonly<{
  filters: SkillsDashboardFilters;
  filterOptions: Readonly<Partial<Record<"provider" | "project" | "environment" | "skillId", readonly string[]>>>;
  loading?: boolean;
  error?: string | null;
  exactCatalogSnapshot: boolean;
  snapshotExplanation: string;
  resultBounds: Readonly<{ currentCatalog: Readonly<{ returned: number; total: number; truncated: boolean }>; rawEvidence: Readonly<{ returned: number; total: number; truncated: boolean }> }>;
  currentCatalog: readonly CurrentSkillRevision[];
  promptMentioned: Readonly<{ count: number; contributorIds: readonly string[]; contributorsTruncated: boolean }>;
  commandCandidates: Readonly<{ count: number; contributorIds: readonly string[]; contributorsTruncated: boolean }>;
  currentFootprint: Readonly<{ partitionLabel: string; byteTotal: number | null; byteSampleN: number; byteMean: number | null; estimatedTokenTotal: number | null; estimatedTokenSampleN: number; estimatedTokenMean: number | null; method: "local-content-estimate"; tokenizer: "none"; contributorIds: readonly string[] }> | null;
  unsupported: Readonly<{ nativeProviderUseAccess: string; providerDelivery: string; actualSkillUse: string; perSkillConsumedTokens: string }>;
  footprints: readonly Footprint[];
  commandOutcomes: readonly SkillsContributor[];
  contributors: readonly SkillsContributor[];
}>;
export type SkillsDashboardProps = Readonly<{ data: SkillsDashboardData; onFiltersChange?: (filters: SkillsDashboardFilters) => void; onRetry?: () => void; onLoadContributors?: (ids: readonly string[]) => Promise<readonly SkillsContributor[]> }>;

function value(value: number | null): string { return value === null ? "Unavailable" : value.toLocaleString(); }

export function SkillsDashboard({ data, onFiltersChange, onRetry, onLoadContributors }: SkillsDashboardProps) {
  const titleId = useId();
  const [drawer, setDrawer] = useState<Readonly<{ label: string; ids: readonly string[] }> | null>(null);
  const [drawerRows, setDrawerRows] = useState<readonly SkillsContributor[] | null>(null);
  const currentCatalog = useMemo(() => data.currentCatalog.slice(0, TABLE_ROW_LIMIT), [data.currentCatalog]);
  const open = (label: string, ids: readonly string[]) => {
    setDrawer({ label, ids }); setDrawerRows(null);
    if (onLoadContributors !== undefined && ids.length > 0) void onLoadContributors(ids).then(setDrawerRows).catch(() => setDrawerRows([]));
  };
  const change = (key: keyof SkillsDashboardFilters, raw: string) => onFiltersChange?.({ ...data.filters, [key]: key === "startMs" || key === "endMs" ? (raw === "" ? undefined : Number(raw)) : (key === "provider" && raw === "__provider-neutral__" ? null : raw || undefined) });
  return <section className="skills-dashboard" aria-labelledby={titleId} aria-busy={data.loading === true}>
    <header className="skills-dashboard__header"><h2 id={titleId}>Skills</h2><p>Current BB-visible catalog and retained public evidence. Command candidates are lexical path matches only.</p></header>
    <Filters filters={data.filters} options={data.filterOptions} onChange={change} />
    {data.loading === true && <p className="skills-dashboard__notice" role="status">Loading Skills evidence…</p>}
    {data.error != null && <div className="skills-dashboard__error" role="alert"><span>{data.error}</span>{onRetry !== undefined && <button type="button" onClick={onRetry}>Try again</button>}</div>}
    <div className="skills-dashboard__cards" aria-label="Skills summary">
      <Card label="BB-visible current revisions" value={data.resultBounds.currentCatalog.total} detail={data.exactCatalogSnapshot ? "Exact total; bounded detail below" : "No complete current catalog snapshot"} onOpen={() => open("Current catalog snapshot preview", data.currentCatalog.flatMap((row) => row.contributorIds))} />
      <Card label="Prompt-mentioned" value={data.promptMentioned.count} detail="Exact retained prompt mentions" onOpen={() => open("Prompt-mentioned", data.promptMentioned.contributorIds)} />
      <Card label="Registered-path command candidates" value={data.commandCandidates.count} detail="Lexical registered-path candidates" onOpen={() => open("Registered-path command candidates", data.commandCandidates.contributorIds)} />
      <Card label="Provider-native use/access" value="Unsupported" detail="Native provider evidence is not retained" onOpen={undefined} />
    </div>
    {data.currentFootprint !== null && <section className="skills-dashboard__footprint-summary" aria-label="Average current SKILL.md footprint"><h3>Avg current SKILL.md footprint</h3><p>{data.currentFootprint.partitionLabel}</p><p>{value(data.currentFootprint.byteTotal)} bytes total · N {data.currentFootprint.byteSampleN} · mean {value(data.currentFootprint.byteMean)} bytes</p><p>{value(data.currentFootprint.estimatedTokenTotal)} optional local estimate total · N {data.currentFootprint.estimatedTokenSampleN} · mean {value(data.currentFootprint.estimatedTokenMean)} · method {data.currentFootprint.method} · tokenizer {data.currentFootprint.tokenizer}</p><p>Unique entries in the latest complete BB-visible snapshot for this partition; current content-footprint only.</p><button type="button" onClick={() => open("Average current SKILL.md footprint", data.currentFootprint!.contributorIds)}>View contributors</button></section>}
    <p className="skills-dashboard__notice">{data.snapshotExplanation}</p>
    {(data.resultBounds.currentCatalog.truncated || data.resultBounds.rawEvidence.truncated) && <p className="skills-dashboard__notice">Summary totals are exact. Showing {data.resultBounds.currentCatalog.returned} of {data.resultBounds.currentCatalog.total} current revisions and {data.resultBounds.rawEvidence.returned} of {data.resultBounds.rawEvidence.total} retained evidence rows; refine filters for narrower detail.</p>}
    {data.exactCatalogSnapshot && data.commandCandidates.count === 0 && <p className="skills-dashboard__notice">No matching retained command observed since snapshot. This is incomplete provider-access coverage and establishes no provider-native capability outcome.</p>}

    <section className="skills-dashboard__section" aria-labelledby="current-catalog"><h3 id="current-catalog">Current catalog revisions</h3>
      {currentCatalog.length === 0 ? <p className="skills-dashboard__notice">No current BB-visible catalog revision matches these filters. The selected period may predate a complete snapshot, or capture may have failed.</p> : <div className="skills-dashboard__table-wrap" tabIndex={0}><table><thead><tr><th>Skill</th><th>Current revision</th><th>Current content-footprint estimate</th><th>Registered paths</th><th>Snapshot</th><th><span className="skills-dashboard__sr-only">Contributors</span></th></tr></thead><tbody>{currentCatalog.map((row) => <tr key={row.key}><th scope="row">{row.name}<small>{row.skillId} · {row.scope}</small></th><td><code>{row.revision ?? "Unavailable"}</code><small>{row.path}</small></td><td>{value(row.bytes)} bytes<small>Tokenizer none; content footprint only</small></td><td>{row.registeredPathCount}</td><td>{new Date(row.snapshotAtMs).toLocaleString()}</td><td><button type="button" onClick={() => open(`${row.name} current revision`, row.contributorIds)}>Details</button></td></tr>)}</tbody></table></div>}
      {data.currentCatalog.length > TABLE_ROW_LIMIT && <p className="skills-dashboard__notice">Showing {TABLE_ROW_LIMIT} of {data.currentCatalog.length} current revisions. Refine filters to inspect the rest.</p>}
    </section>
    <section className="skills-dashboard__section" aria-labelledby="footprints"><h3 id="footprints">Current SKILL.md footprint</h3>
      {data.footprints.length === 0 ? <p className="skills-dashboard__notice">No current content-footprint estimate is available because no matching complete catalog revision supplied current content bytes.</p> : <div className="skills-dashboard__table-wrap" tabIndex={0}><table><thead><tr><th>Revision</th><th>Bytes</th><th>Optional local estimate</th><th>Method / tokenizer</th><th>Sample N</th><th><span className="skills-dashboard__sr-only">Contributors</span></th></tr></thead><tbody>{data.footprints.slice(0, TABLE_ROW_LIMIT).map((row) => <tr key={row.key}><th scope="row">{row.name}<small>{row.revision ?? "Unavailable"}</small></th><td>{value(row.bytes)}</td><td>{row.estimatedTokens === null ? "Not estimated" : `${row.estimatedTokens} tokens`}</td><td>current content-footprint · {row.tokenizer}</td><td>{row.sampleN}</td><td><button type="button" onClick={() => open(`${row.name} footprint`, row.contributorIds)}>Details</button></td></tr>)}</tbody></table></div>}
      <p className="skills-dashboard__measurement-help">These are current content-footprint estimates, not injected or consumed tokens.</p>
    </section>
    <section className="skills-dashboard__section" aria-labelledby="outcomes"><h3 id="outcomes">Enclosing command outcomes</h3>
      {data.commandOutcomes.length === 0 ? <p className="skills-dashboard__notice">No completed retained command candidate matches these filters. Pending candidates and missing public evidence remain explicit coverage limits.</p> : <OutcomeTable rows={data.commandOutcomes} onOpen={open} />}
      <details><summary>Unsupported evidence</summary><p>{data.unsupported.providerDelivery}</p><p>{data.unsupported.actualSkillUse}</p><p>{data.unsupported.perSkillConsumedTokens}</p></details>
    </section>
    {drawer !== null && <Drawer label={drawer.label} ids={drawer.ids} rows={drawerRows ?? data.contributors} onClose={() => setDrawer(null)} />}
  </section>;
}

function Filters({ filters, options, onChange }: Readonly<{ filters: SkillsDashboardFilters; options: SkillsDashboardData["filterOptions"]; onChange: (key: keyof SkillsDashboardFilters, raw: string) => void }>) { return <fieldset className="skills-dashboard__filters"><legend>Filters</legend><label>From <input aria-label="From timestamp" type="number" value={filters.startMs ?? ""} onChange={(event) => onChange("startMs", event.target.value)} /></label><label>To <input aria-label="To timestamp" type="number" value={filters.endMs ?? ""} onChange={(event) => onChange("endMs", event.target.value)} /></label>{(["provider", "project", "environment", "skillId"] as const).map((key) => <label key={key}>{key === "skillId" ? "Skill" : key[0]!.toUpperCase() + key.slice(1)}<select value={filters[key] === null ? "__provider-neutral__" : filters[key] ?? ""} onChange={(event) => onChange(key, event.target.value)}><option value="">All</option>{key === "provider" && <option value="__provider-neutral__">Provider-neutral</option>}{(options[key] ?? []).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}</fieldset>; }
function Card({ label, value: cardValue, detail, onOpen }: Readonly<{ label: string; value: number | string; detail: string; onOpen?: () => void }>) { return <article className="skills-dashboard__card"><h3>{label}</h3><p className="skills-dashboard__value">{typeof cardValue === "number" ? cardValue.toLocaleString() : cardValue}</p><p>{detail}</p>{onOpen !== undefined && <button type="button" onClick={onOpen}>View contributors</button>}</article>; }
function OutcomeTable({ rows, onOpen }: Readonly<{ rows: readonly SkillsContributor[]; onOpen: (label: string, ids: readonly string[]) => void }>) { return <div className="skills-dashboard__table-wrap" tabIndex={0}><table><thead><tr><th>Thread / event</th><th>Candidate path</th><th>Enclosing outcome</th><th>Command shape</th><th><span className="skills-dashboard__sr-only">Contributor</span></th></tr></thead><tbody>{rows.slice(0, TABLE_ROW_LIMIT).map((row) => <tr key={row.id}><th scope="row">{row.threadId}<small>{row.eventId} · seq {row.eventSeq}</small></th><td>{row.path ?? "Unavailable"}</td><td>{row.outcome ?? "Pending"}</td><td>{row.shellWrapped ? "Shell-wrapped" : "Direct"}{row.joinedCommand ? " · joined" : ""}</td><td><button type="button" onClick={() => onOpen(`Command candidate ${row.id}`, [row.id])}>Details</button></td></tr>)}</tbody></table></div>; }
function Drawer({ label, ids, rows, onClose }: Readonly<{ label: string; ids: readonly string[]; rows: readonly SkillsContributor[]; onClose: () => void }>) { const button = useRef<HTMLButtonElement>(null); const selected = rows.filter((row) => ids.includes(row.id)); useEffect(() => { button.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]); return <div className="skills-dashboard__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="skills-dashboard__drawer" role="dialog" aria-modal="true" aria-label={`${label} raw contributors`}><header><div><h3>Raw contributors</h3><p>{label}</p></div><button ref={button} type="button" onClick={onClose}>Close</button></header><p>N {selected.length} of {ids.length} requested contributor rows.</p>{selected.length !== ids.length && <p className="skills-dashboard__error" role="alert">Some requested contributor rows are unavailable in this bounded result.</p>}<div className="skills-dashboard__drawer-list">{selected.slice(0, DRAWER_ROW_LIMIT).map((row) => <article key={row.id}><h4>{row.id}</h4><dl><dt>Session</dt><dd>{row.sessionId ?? "No session retained"}</dd><dt>Thread</dt><dd>{row.threadId}</dd><dt>Event</dt><dd>{row.eventId} · seq {row.eventSeq}</dd><dt>Evidence</dt><dd>{row.kind}</dd><dt>Path</dt><dd>{row.path ?? "Not retained"}</dd><dt>Outcome</dt><dd>{row.outcome ?? "Not retained"}</dd></dl></article>)}</div>{selected.length > DRAWER_ROW_LIMIT && <p className="skills-dashboard__notice">Showing {DRAWER_ROW_LIMIT} of {selected.length} rows. Refine filters to inspect the rest.</p>}</aside></div>; }
