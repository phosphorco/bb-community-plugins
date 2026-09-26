import { z } from "zod";

/** A narrow, bounded read contract for public-SDK Skills evidence. */
export const MAX_SKILL_QUERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_SKILL_QUERY_RAW_ROWS = 200;
export const MAX_SKILL_QUERY_CATALOG_ROWS = 100;

const text = z.string().min(1).max(4_096);
const optionalText = text.optional();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const skillQueryFilterSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  providerId: text.nullable().optional(),
  projectId: optionalText,
  environmentId: optionalText,
  skillId: optionalText,
  contentRevision: hash.optional(),
}).strict().superRefine((value, context) => {
  if (value.endMs < value.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "endMs must not precede startMs" });
  if (value.endMs - value.startMs > MAX_SKILL_QUERY_WINDOW_MS) context.addIssue({ code: "custom", path: ["endMs"], message: "Skills query window exceeds its bounded maximum" });
});
export type SkillQueryFilter = z.infer<typeof skillQueryFilterSchema>;

export const currentCatalogRevisionSchema = z.object({
  snapshotId: text,
  capturedAtMs: z.number().int().nonnegative(),
  providerId: text.nullable(),
  projectId: text,
  environmentId: text.nullable(),
  skillId: text,
  name: text,
  scope: text,
  pluginId: text.nullable(),
  filePath: text,
  contentRevision: hash.nullable(),
  contentBytes: z.number().int().nonnegative().nullable(),
  registeredPathCount: z.number().int().nonnegative(),
}).strict();
export type CurrentCatalogRevision = z.infer<typeof currentCatalogRevisionSchema>;

const contributorBase = {
  id: text,
  observedAtMs: z.number().int().nonnegative(),
  sessionId: text.nullable(),
  threadId: text,
  eventId: text,
  eventSeq: z.number().int().positive(),
  providerId: text.nullable(),
  projectId: text,
  environmentId: text.nullable(),
  skillId: text.nullable(),
  contentRevision: hash.nullable(),
};

export const rawContributorSchema = z.discriminatedUnion("kind", [
  z.object({ ...contributorBase, kind: z.literal("prompt-mention"), mention: text, historicalRevision: z.null() }).strict(),
  z.object({ ...contributorBase, kind: z.literal("registered-path-command-candidate"), registeredPath: text, itemId: text, startEventId: text, completedEventId: text.nullable(), executionStatus: z.enum(["pending", "completed", "failed", "declined", "incomplete"]), exitCode: z.number().int().nullable(), outputBytes: z.number().int().nonnegative().nullable(), outputTruncated: z.boolean().nullable(), shellWrapped: z.boolean(), joinedCommand: z.boolean(), historicalRevision: z.null() }).strict(),
  z.object({ ...contributorBase, kind: z.literal("catalog-snapshot"), snapshotId: text, completeness: z.literal("complete") }).strict(),
]);
export type SkillRawRow = z.infer<typeof rawContributorSchema>;

export const evidenceAggregateSchema = z.object({
  key: text,
  label: text,
  count: z.number().int().nonnegative(),
  filters: skillQueryFilterSchema,
  contributingIds: z.array(text).max(MAX_SKILL_QUERY_RAW_ROWS),
  contributorsTruncated: z.boolean(),
}).strict();
export type EvidenceAggregate = z.infer<typeof evidenceAggregateSchema>;

export const footprintEstimateSchema = z.object({
  key: text,
  revision: currentCatalogRevisionSchema,
  method: z.literal("current-content-footprint"),
  tokenizer: z.enum(["none", "local-bytes-divided-by-4"]),
  bytes: z.number().int().nonnegative().nullable(),
  estimatedTokens: z.number().int().nonnegative().nullable(),
  sampleN: z.number().int().nonnegative(),
  contributingIds: z.array(text).max(MAX_SKILL_QUERY_RAW_ROWS),
  filters: skillQueryFilterSchema,
}).strict().superRefine((value, context) => {
  if (value.tokenizer === "none" && value.estimatedTokens !== null) context.addIssue({ code: "custom", path: ["estimatedTokens"], message: "tokenizer none has no token estimate" });
  if (value.tokenizer === "local-bytes-divided-by-4" && value.bytes !== null && value.estimatedTokens !== Math.ceil(value.bytes / 4)) context.addIssue({ code: "custom", path: ["estimatedTokens"], message: "local estimate is ceil(bytes / 4)" });
});
export type FootprintEstimate = z.infer<typeof footprintEstimateSchema>;

/** One partition: unique entries in one latest complete current snapshot. */
export const currentFootprintSummarySchema = z.object({
  snapshotId: text,
  providerId: text.nullable(),
  partitionLabel: text,
  projectId: text,
  environmentId: text.nullable(),
  method: z.literal("local-content-estimate"),
  tokenizer: z.literal("none"),
  byteTotal: z.number().int().nonnegative().nullable(),
  byteSampleN: z.number().int().nonnegative(),
  byteMean: z.number().nonnegative().nullable(),
  estimatedTokenTotal: z.number().int().nonnegative().nullable(),
  estimatedTokenSampleN: z.number().int().nonnegative(),
  estimatedTokenMean: z.number().nonnegative().nullable(),
  contributingIds: z.array(text).max(MAX_SKILL_QUERY_RAW_ROWS),
}).strict();
export type CurrentFootprintSummary = z.infer<typeof currentFootprintSummarySchema>;

export const coverageSchema = z.object({
  exactCatalogSnapshot: z.boolean(),
  snapshotExplanation: text,
  providerAccessCoverage: z.literal("incomplete-or-unsupported"),
  historicalRevisionCoverage: z.literal("revision-unknown"),
}).strict();
export type SkillsCoverage = z.infer<typeof coverageSchema>;

export const resultBoundsSchema = z.object({
  currentCatalog: z.object({ returned: z.number().int().nonnegative(), total: z.number().int().nonnegative(), truncated: z.boolean() }).strict(),
  rawEvidence: z.object({ returned: z.number().int().nonnegative(), total: z.number().int().nonnegative(), truncated: z.boolean() }).strict(),
}).strict();

export const skillQueryResultSchema = z.object({
  filters: skillQueryFilterSchema,
  coverage: coverageSchema,
  bounds: resultBoundsSchema,
  currentCatalog: z.array(currentCatalogRevisionSchema).max(MAX_SKILL_QUERY_CATALOG_ROWS),
  promptMentions: evidenceAggregateSchema,
  commandCandidates: evidenceAggregateSchema,
  commandOutcomes: z.array(rawContributorSchema).max(MAX_SKILL_QUERY_RAW_ROWS),
  footprints: z.array(footprintEstimateSchema).max(MAX_SKILL_QUERY_RAW_ROWS),
  currentFootprint: currentFootprintSummarySchema.nullable(),
  unsupported: z.object({ nativeActivation: text, providerDelivery: text, actualSkillUse: text, perSkillConsumedTokens: text }).strict(),
  rawRows: z.array(rawContributorSchema).max(MAX_SKILL_QUERY_RAW_ROWS),
}).strict();
export type SkillsQueryResult = z.infer<typeof skillQueryResultSchema>;

export const skillRawContributorRequestSchema = z.object({ filters: skillQueryFilterSchema, ids: z.array(text).min(1).max(MAX_SKILL_QUERY_RAW_ROWS) }).strict();
export const skillRawContributorResultSchema = z.array(rawContributorSchema).max(MAX_SKILL_QUERY_RAW_ROWS);
