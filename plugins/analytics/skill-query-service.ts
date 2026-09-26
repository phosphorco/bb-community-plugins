import {
  type CurrentCatalogRevision,
  type CurrentFootprintSummary,
  type EvidenceAggregate,
  type FootprintEstimate,
  MAX_SKILL_QUERY_CATALOG_ROWS,
  MAX_SKILL_QUERY_RAW_ROWS,
  type SkillQueryFilter,
  type SkillRawRow,
  skillQueryFilterSchema,
  skillQueryResultSchema,
  skillRawContributorRequestSchema,
  skillRawContributorResultSchema,
  type SkillsQueryResult,
} from "./skill-query-schema.ts";

/**
 * Input is deliberately projection-shaped rather than provider-shaped. The
 * projection owns SDK traversal; this query layer only bounds, filters and
 * reconciles its retained catalog and event contributors.
 */
export interface ForkFreeSkillQueryInput {
  currentCatalog: readonly CurrentCatalogRevision[];
  rawRows: readonly SkillRawRow[];
  /** Exact totals are computed in SQLite before bounded preview rows are read. */
  currentCatalogTotal?: number;
  rawEvidenceTotal?: number;
  promptMentionTotal?: number;
  commandCandidateTotal?: number;
  /** Detail rows may include catalog contributors omitted from the summary payload. */
  detailRows?: readonly SkillRawRow[];
  snapshotComplete: boolean;
  snapshotExplanation: string;
}

function matches(row: { observedAtMs: number; providerId: string | null; projectId: string; environmentId: string | null; skillId: string | null; contentRevision: string | null }, filters: SkillQueryFilter): boolean {
  return row.observedAtMs >= filters.startMs && row.observedAtMs <= filters.endMs
    && (filters.providerId === undefined || row.providerId === filters.providerId)
    && (filters.projectId === undefined || row.projectId === filters.projectId)
    && (filters.environmentId === undefined || row.environmentId === filters.environmentId)
    && (filters.skillId === undefined || row.skillId === filters.skillId)
    && (filters.contentRevision === undefined || row.contentRevision === filters.contentRevision);
}

function aggregate(key: string, label: string, rows: readonly SkillRawRow[], filters: SkillQueryFilter, total = rows.length): EvidenceAggregate {
  const contributingIds = rows.map((row) => row.id).sort();
  return { key, label, count: total, filters, contributingIds, contributorsTruncated: total > contributingIds.length };
}

function catalogContributorId(row: CurrentCatalogRevision): string { return `catalog:${row.snapshotId}:${row.skillId}`; }

/** Public evidence never supports provider delivery, use, activation, or token allocation. */
export function queryForkFreeSkillEvidence(input: ForkFreeSkillQueryInput, untrustedFilters: unknown): SkillsQueryResult {
  const filters = skillQueryFilterSchema.parse(untrustedFilters);
  // Catalog membership has its own bounded relation. It must not consume the
  // evidence-detail budget or make a summary query fail as captures grow.
  const matchingRawRows = input.rawRows.filter((row) => row.kind !== "catalog-snapshot" && matches(row, filters)).sort((a, b) => a.observedAtMs - b.observedAtMs || a.id.localeCompare(b.id));
  const rawEvidenceTotal = input.rawEvidenceTotal ?? matchingRawRows.length;
  const matchingPromptMentionTotal = input.promptMentionTotal ?? matchingRawRows.filter((row) => row.kind === "prompt-mention").length;
  const matchingCommandCandidateTotal = input.commandCandidateTotal ?? matchingRawRows.filter((row) => row.kind === "registered-path-command-candidate").length;
  const rawRows = matchingRawRows.slice(0, MAX_SKILL_QUERY_RAW_ROWS);
  const matchingCatalog = input.currentCatalog.filter((row) =>
    (filters.providerId === undefined || row.providerId === filters.providerId)
    && (filters.projectId === undefined || row.projectId === filters.projectId)
    && (filters.environmentId === undefined || row.environmentId === filters.environmentId)
    && (filters.skillId === undefined || row.skillId === filters.skillId)
    && (filters.contentRevision === undefined || row.contentRevision === filters.contentRevision),
  );
  // Membership from thread.created/thread.active snapshots is not a sample.
  // A public capture is partitioned by project/environment, so choose the
  // latest complete snapshot per requested partition rather than letting one
  // newly captured project make another selected project look current.
  const partition = (row: CurrentCatalogRevision) => `${row.projectId}\u0000${row.environmentId ?? ""}`;
  const latestAt = new Map<string, number>();
  for (const row of matchingCatalog) latestAt.set(partition(row), Math.max(latestAt.get(partition(row)) ?? -1, row.capturedAtMs));
  const currentCatalogAll = [...new Map(matchingCatalog
    .filter((row) => row.capturedAtMs === latestAt.get(partition(row)))
    // Across partitions, the overview grain is a unique current skill
    // revision. Keep the newest representative; project/environment filters
    // still expose the exact selected partition.
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs || a.skillId.localeCompare(b.skillId))
    .map((row) => [`${row.skillId}:${row.contentRevision ?? "unavailable"}`, row])).values()];
  const currentCatalogTotal = input.currentCatalogTotal ?? currentCatalogAll.length;
  const currentCatalog = currentCatalogAll.slice(0, MAX_SKILL_QUERY_CATALOG_ROWS);
  const currentCatalogTruncated = currentCatalogTotal > currentCatalog.length;
  const mentions = rawRows.filter((row) => row.kind === "prompt-mention");
  const candidates = rawRows.filter((row) => row.kind === "registered-path-command-candidate");
  const footprints: FootprintEstimate[] = currentCatalog.map((revision) => ({
    key: `${revision.snapshotId}:${revision.skillId}:${revision.contentRevision ?? "unavailable"}`,
    revision,
    method: "current-content-footprint",
    tokenizer: revision.contentBytes === null ? "none" : "local-bytes-divided-by-4",
    bytes: revision.contentBytes,
    estimatedTokens: revision.contentBytes === null ? null : Math.ceil(revision.contentBytes / 4),
    sampleN: revision.contentBytes === null ? 0 : 1,
    contributingIds: [catalogContributorId(revision)],
    filters,
  }));
  const knownBytes = currentCatalog.filter((row) => row.contentBytes !== null).map((row) => row.contentBytes!);
  const byteTotal = knownBytes.length === 0 ? null : knownBytes.reduce((total, bytes) => total + bytes, 0);
  const currentFootprint: CurrentFootprintSummary | null = currentCatalog.length === 0 || currentCatalogTruncated || new Set(currentCatalog.map((row) => `${row.projectId}\n${row.environmentId ?? ""}`)).size !== 1
    ? null
    : {
      snapshotId: currentCatalog[0]!.snapshotId, providerId: filters.providerId === undefined ? null : filters.providerId, partitionLabel: filters.providerId === undefined ? "All provider partitions" : filters.providerId === null ? "Provider-neutral" : `Provider ${filters.providerId}`, projectId: currentCatalog[0]!.projectId, environmentId: currentCatalog[0]!.environmentId,
      method: "local-content-estimate", tokenizer: "none", byteTotal, byteSampleN: knownBytes.length,
      byteMean: byteTotal === null ? null : byteTotal / knownBytes.length,
      estimatedTokenTotal: byteTotal === null ? null : knownBytes.reduce((total, bytes) => total + Math.ceil(bytes / 4), 0),
      estimatedTokenSampleN: knownBytes.length,
      estimatedTokenMean: byteTotal === null ? null : knownBytes.reduce((total, bytes) => total + Math.ceil(bytes / 4), 0) / knownBytes.length,
      contributingIds: currentCatalog.map(catalogContributorId),
    };
  const selectionHasSnapshot = currentCatalog.length > 0;
  const selectionHasCatalog = matchingCatalog.length > 0;
  const selectionHasRetainedEvidence = rawEvidenceTotal > 0;
  const selectedPeriodPredatesSnapshot = selectionHasSnapshot
    && filters.endMs < Math.min(...currentCatalog.map((row) => row.capturedAtMs));
  const selectionExplanation = !selectionHasCatalog
    ? `No complete BB-visible current catalog snapshot is retained for the selected project, environment, provider, skill, or revision.`
    : selectedPeriodPredatesSnapshot
      ? `A complete BB-visible current catalog snapshot exists for this selection, but the selected period predates that snapshot; retained event evidence may be unavailable.`
      : !selectionHasRetainedEvidence
        ? `A complete BB-visible current catalog snapshot exists for this selection, but no retained thread evidence matches the selected period.`
        : "A missing matching command is incomplete provider-access coverage and establishes no provider-native capability outcome.";
  // Freshness and capture failures apply even to empty selections; do not
  // replace the collector's notice with a generic empty-result explanation.
  const snapshotExplanation = `${selectionExplanation} ${input.snapshotExplanation}`;
  const coverage = {
    exactCatalogSnapshot: selectionHasSnapshot,
    snapshotExplanation,
    providerAccessCoverage: "incomplete-or-unsupported" as const,
    historicalRevisionCoverage: "revision-unknown" as const,
  };
  return skillQueryResultSchema.parse({
    filters, coverage,
    bounds: {
      currentCatalog: { returned: currentCatalog.length, total: currentCatalogTotal, truncated: currentCatalogTruncated },
      rawEvidence: { returned: rawRows.length, total: rawEvidenceTotal, truncated: rawEvidenceTotal > rawRows.length },
    },
    currentCatalog,
    promptMentions: aggregate("prompt-mentioned", "Prompt-mentioned", mentions, filters, matchingPromptMentionTotal),
    commandCandidates: aggregate("registered-path-command-candidates", "Registered-path command candidates", candidates, filters, matchingCommandCandidateTotal),
    commandOutcomes: candidates.filter((row) => row.completedEventId !== null),
    footprints,
    currentFootprint,
    unsupported: {
      nativeActivation: "Unsupported: public retained events contain no provider-native activation signal.",
      providerDelivery: "Unsupported: command candidates do not prove provider delivery.",
      actualSkillUse: "Unsupported: mentions and command candidates do not prove actual skill use or access.",
      perSkillConsumedTokens: "Unsupported: retained token reports are aggregate-only and are not apportioned to skills.",
    },
    rawRows,
  });
}

/** A bounded adapter used by later composition once the projection supplies rows. */
export class SkillQueryService {
  private readonly source: (filters: SkillQueryFilter) => ForkFreeSkillQueryInput;
  constructor(source: ((filters: SkillQueryFilter) => ForkFreeSkillQueryInput) | (() => ForkFreeSkillQueryInput)) { this.source = source; }
  query(input: unknown): SkillsQueryResult {
    const filters = skillQueryFilterSchema.parse(input);
    return queryForkFreeSkillEvidence(this.source(filters), filters);
  }
  rawContributors(input: unknown, ids: readonly string[]): readonly SkillRawRow[] {
    const request = skillRawContributorRequestSchema.parse({ filters: input, ids });
    const source = this.source(request.filters);
    const rows = (source.detailRows ?? source.rawRows).filter((row) => matches(row, request.filters) && request.ids.includes(row.id));
    if (rows.length !== request.ids.length) throw new Error("Skills raw drilldown requested a contributor outside its exact filtered result.");
    return skillRawContributorResultSchema.parse(rows);
  }
}
