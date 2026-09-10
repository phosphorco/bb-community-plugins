import { z } from "zod";

import { parseAnalyticsQuery } from "./sql-policy.ts";

export const ANALYTICS_BUNDLE_VERSION = 1 as const;
export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_QUERY_ROWS = 500;
export const MIN_LOADER_MAX_AGE_MS = 60_000;
export const MAX_LOADER_MAX_AGE_MS = 24 * 60 * 60_000;
export const DEFAULT_LOADER_MAX_AGE_MS = 60 * 60_000;

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

const fieldSchema = z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const querySchema = z
  .object({
    id: identifierSchema,
    title: z.string().min(1).max(120),
    sql: z.string().min(1).max(16_000),
    maxRows: z.number().int().min(1).max(MAX_QUERY_ROWS).default(100),
  })
  .strict();

const metricVisualizationSchema = z
  .object({
    id: identifierSchema,
    queryId: identifierSchema,
    kind: z.literal("metric"),
    title: z.string().min(1).max(120),
    value: fieldSchema,
    detail: fieldSchema.optional(),
    format: z.enum(["integer", "percent", "duration", "decimal"]).default("integer"),
  })
  .strict();

const barVisualizationSchema = z
  .object({
    id: identifierSchema,
    queryId: identifierSchema,
    kind: z.literal("bar"),
    title: z.string().min(1).max(120),
    x: fieldSchema,
    y: fieldSchema,
    format: z.enum(["integer", "percent", "duration", "decimal"]).default("integer"),
  })
  .strict();

const lineVisualizationSchema = z
  .object({
    id: identifierSchema,
    queryId: identifierSchema,
    kind: z.literal("line"),
    title: z.string().min(1).max(120),
    x: fieldSchema,
    y: fieldSchema,
    format: z.enum(["integer", "percent", "duration", "decimal"]).default("integer"),
  })
  .strict();

const tableColumnSchema = z
  .object({
    field: fieldSchema,
    label: z.string().min(1).max(80),
    format: z.enum(["text", "integer", "percent", "duration", "decimal"]).default("text"),
  })
  .strict();

const tableVisualizationSchema = z
  .object({
    id: identifierSchema,
    queryId: identifierSchema,
    kind: z.literal("table"),
    title: z.string().min(1).max(120),
    columns: z.array(tableColumnSchema).min(1).max(10),
  })
  .strict();

export const visualizationSchema = z.discriminatedUnion("kind", [
  metricVisualizationSchema,
  barVisualizationSchema,
  lineVisualizationSchema,
  tableVisualizationSchema,
]);

const layoutItemSchema = z
  .object({
    visualizationId: identifierSchema,
    width: z.enum(["third", "half", "full"]).default("full"),
  })
  .strict();

export const analyticsBundleSchema = z
  .object({
    version: z.literal(ANALYTICS_BUNDLE_VERSION),
    id: identifierSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    loader: z
      .object({
        id: z.literal("recent-capability-facts-v1"),
        label: z.string().min(1).max(120),
        maxAgeMs: z.number().int().min(MIN_LOADER_MAX_AGE_MS).max(MAX_LOADER_MAX_AGE_MS).default(DEFAULT_LOADER_MAX_AGE_MS),
        staleWhileRefresh: z.boolean().default(true),
      })
      .strict(),
    queries: z.array(querySchema).min(1).max(20),
    visualizations: z.array(visualizationSchema).min(1).max(30),
    layout: z.array(layoutItemSchema).min(1).max(30),
  })
  .strict()
  .superRefine((bundle, context) => {
    const queryIds = new Set<string>();
    for (const query of bundle.queries) {
      if (queryIds.has(query.id)) {
        context.addIssue({ code: "custom", message: `Duplicate query id: ${query.id}` });
      }
      queryIds.add(query.id);
    }
    const visualizationIds = new Set<string>();
    for (const visualization of bundle.visualizations) {
      if (visualizationIds.has(visualization.id)) {
        context.addIssue({ code: "custom", message: `Duplicate visualization id: ${visualization.id}` });
      }
      visualizationIds.add(visualization.id);
      if (!queryIds.has(visualization.queryId)) {
        context.addIssue({
          code: "custom",
          message: `Visualization ${visualization.id} references unknown query ${visualization.queryId}`,
        });
      }
    }
    for (const item of bundle.layout) {
      if (!visualizationIds.has(item.visualizationId)) {
        context.addIssue({
          code: "custom",
          message: `Layout references unknown visualization ${item.visualizationId}`,
        });
      }
    }
  });

export type AnalyticsBundle = z.infer<typeof analyticsBundleSchema>;
export type AnalyticsVisualization = z.infer<typeof visualizationSchema>;
export type AnalyticsFormat = "text" | "integer" | "percent" | "duration" | "decimal";

export function parseBundleSource(source: string): AnalyticsBundle {
  if (Buffer.byteLength(source, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle exceeds the ${MAX_BUNDLE_BYTES.toLocaleString()} byte limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Bundle is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return analyticsBundleSchema.parse(parsed);
}

export function validateQueryText(sql: string): void {
  parseAnalyticsQuery(sql);
}

export function validateBundleQueries(bundle: AnalyticsBundle): void {
  for (const query of bundle.queries) validateQueryText(query.sql);
}
