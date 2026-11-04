import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rowSchema = z.object({
  id: z.string(),
  owner: z.string(),
  owner_title: z.string().nullable(),
  project: z.string(),
  subject: z.string(),
  state: z.string(),
  kind: z.enum(["observation", "after", "interval", "idle"]),
  created_at: z.number(),
  expires_at: z.number().nullable(),
  next_at: z.number().nullable(),
  last_check_at: z.number().nullable(),
  classification: z.string().nullable(),
  delivery: z.string().nullable(),
  problem: z.string().nullable(),
  stop_pending: z.boolean(),
  generation: z.number(),
});
export const listInput = z.object({
  threadId: z.string().optional(),
  view: z.enum(["active", "history"]).default("active"),
  query: z.string().max(200).default(""),
  project: z.string().optional(),
  state: z
    .enum([
      "preparing",
      "watching",
      "running",
      "reviewing",
      "uncertain",
      "fulfilled",
      "failed",
      "expired",
      "cancelled",
    ])
    .optional(),
  offset: z.number().int().min(0).max(1000000).default(0),
});
const scope = z.object({ id: z.string(), threadId: z.string().optional() });
export const runSchema = z.object({
  id: z.string(),
  started_at: z.number(),
  ended_at: z.number(),
  duration_ms: z.number(),
  exit_code: z.number().nullable(),
  problem: z.string().nullable(),
  classification: z.string().nullable(),
  output: z.string(),
  output_truncated: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});
export const findingSchema = z.object({
  id: z.string(),
  occurrence: z.string(),
  created_at: z.number(),
  outcome: z.string(),
  summary: z.string(),
  evidence: z.string(),
  delivery: z.string(),
  problem: z.string().nullable(),
  withdrawal_pending: z.boolean(),
});
export const detailSchema = z.object({
  row: rowSchema,
  mode: z.string(),
  condition: z.string(),
  evidence_requirement: z.string(),
  interpretation: z.string().nullable(),
  coverage: z.string().nullable(),
  interval_seconds: z.number().nullable(),
  classifier: z.string().nullable(),
  checks: z.number(),
  observer_turns: z.number(),
  recipe_revisions: z.number(),
  runs: z.array(runSchema),
  findings: z.array(findingSchema),
});
export const uiContract = defineRpcContract({
  subscriptionsList: {
    input: listInput,
    output: z.object({
      rows: z.array(rowSchema),
      total: z.number(),
      projects: z.array(z.string()),
      observed_at: z.number(),
    }),
  },
  subscriptionDetail: { input: scope, output: detailSchema },
  subscriptionDiagnostics: {
    input: scope,
    output: z.object({
      observer_thread_id: z.string().nullable(),
      launch: z.string().nullable(),
      review_wake: z.string().nullable(),
      script: z.string().nullable(),
      revisions: z.array(
        z.object({
          script: z.string(),
          interpretation: z.string(),
          coverage: z.string(),
        }),
      ),
    }),
  },
  cancelSubscription: {
    input: scope.extend({ owner: z.string(), generation: z.number() }),
    output: z.object({
      state: z.string(),
      shutdown: z.string(),
      already_dispatched: z.string(),
    }),
  },
});
export type SubscriptionRow = z.infer<typeof rowSchema>;
export type SubscriptionDetail = z.infer<typeof detailSchema>;
export type ListInput = z.infer<typeof listInput>;
