import { z } from "zod";

export const analyticsScalarSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
export const analyticsReferenceSelectionSchema = z.object({
  datumKey: z.string().min(1).max(240),
  label: z.string().min(1).max(240),
  row: z.record(z.string().max(80), analyticsScalarSchema),
  predicate: z.object({
    field: z.string().min(1).max(80),
    operator: z.literal("eq"),
    value: analyticsScalarSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value.row).length > 20) context.addIssue({ code: "custom", message: "Analytics references can include at most 20 row fields." });
});

export const createAnalyticsReferenceSchema = z.object({
  bundleId: z.string().min(1).max(64),
  queryId: z.string().min(1).max(64),
  visualizationId: z.string().min(1).max(64),
  resultGeneration: z.string().min(1).max(240),
  snapshotGenerationId: z.number().int().nonnegative().nullable(),
  snapshotUpdatedAt: z.number().int().nonnegative().nullable(),
  rangeDays: z.number().int().min(1).max(90),
  coverage: z.object({
    kind: z.enum(["exact", "lower-bound"]),
    rows: z.number().int().nonnegative(),
  }).strict(),
  selection: analyticsReferenceSelectionSchema.nullable(),
}).strict();

export type CreateAnalyticsReference = z.infer<typeof createAnalyticsReferenceSchema>;

export type AnalyticsReferenceCapsule = CreateAnalyticsReference & Readonly<{
  version: 1;
  id: string;
  token: string;
  createdAt: number;
  bundleTitle: string;
  queryTitle: string;
  querySql: string;
  visualizationTitle: string;
  visualizationKind: "metric" | "bar" | "line" | "table";
}>;

export function renderAnalyticsReference(capsule: AnalyticsReferenceCapsule): string {
  const selection = capsule.selection == null
    ? "Whole visualization"
    : [
        `Selected datum: ${capsule.selection.label}`,
        `Selected row: ${JSON.stringify(capsule.selection.row)}`,
        `Selection predicate: ${capsule.selection.predicate.field} = ${JSON.stringify(capsule.selection.predicate.value)}`,
      ].join("\n");
  return [
    `Analytics reference ${capsule.token}`,
    `Dashboard: ${capsule.bundleTitle} (${capsule.bundleId})`,
    `Visualization: ${capsule.visualizationTitle} (${capsule.visualizationId}, ${capsule.visualizationKind})`,
    `Query: ${capsule.queryTitle} (${capsule.queryId})`,
    `DuckDB SQL:\n${capsule.querySql}`,
    `Parameters: range_days=${capsule.rangeDays}`,
    `Snapshot: generation ${capsule.snapshotGenerationId ?? "unknown"}, as of ${capsule.snapshotUpdatedAt == null ? "unknown" : new Date(capsule.snapshotUpdatedAt).toISOString()}`,
    `Result generation: ${capsule.resultGeneration}`,
    `Coverage: ${capsule.coverage.kind === "exact" ? capsule.coverage.rows : `at least ${capsule.coverage.rows}`} result rows`,
    selection,
    "The reference contains a redacted analytical result, not raw tool arguments, outputs, prompts, paths, or thread content.",
  ].join("\n");
}
