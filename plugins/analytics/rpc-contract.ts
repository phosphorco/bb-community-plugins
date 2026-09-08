import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { analyticsBundleSchema } from "./bundle-contract.ts";
import { createAnalyticsReferenceSchema } from "./analytics-reference.ts";

const indexStateSchema = z.object({
  status: z.enum(["empty", "indexing", "ready", "error"]),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  generationId: z.number().int().nonnegative(),
  snapshotUpdatedAt: z.number().int().nonnegative().nullable(),
  lastFullReconciliationAt: z.number().int().nonnegative().nullable(),
  degraded: z.boolean(),
  lastError: z.string().nullable(),
  loadedThreads: z.number().int().nonnegative(),
  factCount: z.number().int().nonnegative(),
  truncatedThreads: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable(),
  // Kept during the contract transition for older Analytics app surfaces.
  error: z.string().nullable(),
  factProjectionVersion: z.number().int().nonnegative(),
}).strict();

const bundleSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  builtin: z.boolean(),
}).strict();

export const rpcContract = defineRpcContract({
  catalog: {
    input: z.null(),
    output: z.object({
      bundles: z.array(bundleSummarySchema),
      index: indexStateSchema,
    }).strict(),
  },
  getBundle: {
    input: z.object({
      bundleId: z.string().min(1).max(64),
    }).strict(),
    output: z.object({
      bundle: analyticsBundleSchema,
      builtin: z.boolean(),
    }).strict(),
  },
  requestRefresh: {
    input: z.null(),
    output: indexStateSchema,
  },
  saveBundle: {
    input: z.object({ source: z.string() }).strict(),
    output: bundleSummarySchema,
  },
  deleteBundle: {
    input: z.object({ id: z.string().min(1).max(64) }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  createReference: {
    input: createAnalyticsReferenceSchema,
    output: z.object({
      id: z.string(),
      token: z.string(),
      label: z.string(),
    }).strict(),
  },
});

export type AnalyticsCatalogResponse = z.infer<typeof rpcContract.catalog.output>;
export type AnalyticsBundleResponse = z.infer<typeof rpcContract.getBundle.output>;
