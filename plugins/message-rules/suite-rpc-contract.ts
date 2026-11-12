import { z } from "zod";
import { PreviewPlacementResultV1Schema, PublicationV1Schema } from "@phosphorco/bb-message-admission/protocol";
import {
  ConnectionSchema,
  RuleSchema,
  GroupSchema,
} from "./contracts/model.ts";
const project = z.object({ projectId: z.string().min(1).max(200) });
const json = z.unknown();
export const contract = {
  snapshot: {
    experimental_description:
      "Read the global catalog, current saved basis, latest run and unresolved effects. Set discoverFiles false for metadata only; requestId reconciles that exact start; runId reads an exact cancellation target without starting work.",
    input: project.extend({
      discoverFiles: z.boolean().default(true),
      requestId: z.string().optional(),
      runId: z.string().optional(),
    }),
    output: json,
  },
  configure: {
    experimental_description:
      "Update global connection limits and the default host/absolute fixture directory using the current catalog revision. Existing imported locations remain in place.",
    input: project.extend({
      revision: z.number().int().nullable(),
      hostId: z.string().min(1),
      root: z.string().min(1),
      connection: ConnectionSchema,
    }),
    output: json,
  },
  saveGroup: {
    experimental_description:
      "Create or replace a group using the current catalog revision and complete group value. New groups should remain disabled until deliberately scoped.",
    input: project.extend({ revision: z.number().int(), group: GroupSchema }),
    output: json,
  },
  deleteGroup: {
    experimental_description:
      "Delete a group using the current catalog revision. Nonempty groups must be resolved first.",
    input: project.extend({ revision: z.number().int(), groupId: z.string() }),
    output: json,
  },
  saveRule: {
    experimental_description:
      "Create or replace a rule using the current catalog revision and complete rule value. Actions: reject/proceed/steer/queue/queue-batched; check always/jev is a predicate. A rule belongs to a saved group; saving does not enforce live messages.",
    input: project.extend({ revision: z.number().int(), rule: RuleSchema }),
    output: json,
  },
  deleteRule: {
    experimental_description:
      "Delete a rule using the current catalog revision.",
    input: project.extend({ revision: z.number().int(), ruleId: z.string() }),
    output: json,
  },
  saveFile: {
    experimental_description:
      "Save a direct Markdown fixture with its expected hash and exact host/root/location revision. Include occurrenceId for existing tests and groupId for new tests. Never replay an uncertain write.",
    input: project.extend({
      occurrenceId: z.string().optional(),
      groupId: z.string().optional(),
      path: z.string().min(1).max(200),
      source: z.string().max(262144),
      hash: z.string().nullable(),
      location: z.object({
        hostId: z.string(),
        root: z.string(),
        revision: z.number().int().nonnegative(),
      }),
    }),
    output: json,
  },
  toggleTest: {
    experimental_description:
      "Change enabled suite membership using the current catalog revision and stable occurrence ID. Does not rewrite fixture bytes.",
    input: project.extend({
      revision: z.number().int(),
      occurrenceId: z.string(),
      enabled: z.boolean(),
    }),
    output: json,
  },
  assignTest: {
    experimental_description:
      "Move test organization to a saved group using the current catalog revision. Ownership does not restrict evaluation or change fixture project identity.",
    input: project.extend({
      revision: z.number().int(),
      occurrenceId: z.string(),
      groupId: z.string(),
    }),
    output: json,
  },
  startSuite: {
    experimental_description:
      "Explicitly start saved tests and all applicable groups. Omit selectedOccurrenceIds for Test all; otherwise select 1..100 saved enabled nonmissing fixtures. Selection is deduplicated and frozen against the exact saved basis. May invoke paid configured JEV. Reconcile unknown outcomes with snapshot requestId; never change selection under the same requestId.",
    input: project.extend({
      requestId: z.string().min(1).max(200),
      basis: z.string(),
      hasRelevantDrafts: z.boolean(),
      selectedOccurrenceIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
    }),
    output: json,
  },
  cancelSuite: {
    experimental_description:
      "Persist cancellation of the specified global run. Cancellation does not prove remote effects stopped and never authorizes replay.",
    input: project.extend({ runId: z.string() }),
    output: json,
  },
} as const;

// Validate authoritative snapshots on both the server and browser boundaries.
const occurrenceSchema = z.object({
  occurrenceId: z.string(),
  path: z.string(),
  logicalId: z.string().nullable(),
  hash: z.string().nullable(),
  enabled: z.boolean(),
  missing: z.boolean(),
  source: z.string().nullable(),
  error: z.string().nullable(),
  groupId: z.string().optional(),
  projectId: z.string().nullable().optional(),
  sourceProjectId: z.string().optional(),
  sourceOccurrenceId: z.string().optional(),
  location: z
    .object({
      hostId: z.string(),
      root: z.string(),
      revision: z.number().int(),
    })
    .optional(),
  ownership: z.string().optional(),
  ruleAliases: z.record(z.string(), z.string()).optional(),
});
const configSchema = z.object({
  locationRevision: z.number().int().nonnegative().default(0),
  hostId: z.string(),
  root: z.string(),
  connection: ConnectionSchema,
});
const ruleResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int(),
  status: z.enum(["not-applicable", "allow", "reject", "unknown"]),
  reason: z.string().optional(),
  observations: z.record(z.string(), z.unknown()),
  action: z.enum(["reject", "proceed", "steer", "queue", "queue-batched"]).optional(),
  applies: z.boolean().optional(),
});
const evaluationSchema = z.object({
  version: z.string(),
  inputHash: z.string(),
  policy: z.enum(["allow", "reject", "unknown"]),
  rules: z.array(ruleResultSchema),
  advice: z.array(z.object({ text: z.string(), ruleIds: z.array(z.string()) })),
  groups: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        revision: z.number(),
        status: z.enum([
          "in-scope",
          "outside-scope",
          "disabled",
          "scope-unavailable",
        ]),
      }),
    )
    .optional(),
  contextAdmission: z.enum(["verified-counter", "provider-checked"]).optional(),
  plannedBatch: z.array(z.string()).optional(),
  nativePlacement:z.discriminatedUnion("state",[
    z.object({state:z.literal("simulated"),inputHash:z.string(),result:PreviewPlacementResultV1Schema}),
    z.object({state:z.enum(["unsupported","unknown","not-run"]),reason:z.string()}),
  ]).optional(),
  evidenceTokens: z.array(z.string()).optional(),
  route: z.object({ action: z.enum(["proceed", "steer", "queue", "queue-batched"]), ruleIds: z.array(z.string()) }).optional(),
  errors: z.array(z.string()),
});
const resultSchema = z.object({
  occurrenceId: z.string(),
  path: z.string(),
  status: z.enum(["pass", "fail", "error", "unknown"]),
  reason: z.string(),
  evaluation: evaluationSchema.optional(),
});
const frozenSchema = z.object({
  selectedOccurrenceIds: z.array(z.string()).optional(),
  version: z.string(),
  projectId: z.string(),
  config: configSchema,
  groups: z.array(GroupSchema).default([]),
  rules: z.array(RuleSchema),
  occurrences: z.array(occurrenceSchema),
  basis: z.string(),
  denominator: z.number().int().nonnegative(),
  actor: z.unknown(),
});
const baseSnapshotSchema = z.object({
  catalog: z
    .object({
      aliases: z.array(
        z.object({
          projectId: z.string(),
          kind: z.enum(["group", "rule", "test"]),
          oldId: z.string(),
          id: z.string(),
        }),
      ),
      sources: z.array(
        z.object({
          projectId: z.string(),
          defaultGroupId: z.string().nullable(),
        }),
      ),
      notes: z.array(z.string()),
    })
    .optional(),
  project: z
    .object({
      id: z.string(),
      revision: z.number().int(),
      config: configSchema,
      groups: z.array(GroupSchema).default([]),
      rules: z.array(RuleSchema),
      occurrences: z.array(occurrenceSchema),
    })
    .nullable(),
  basis: z.string().nullable(),
  run: z
    .object({
      id: z.string(),
      requestId: z.string(),
      inputHash: z.string(),
      status: z.enum([
        "running",
        "complete",
        "cancelled",
        "stopped-unknown",
        "stopped-ownership-unknown",
        "stopped-incompatible-version",
      ]),
      owner: z.string(),
      generation: z.number().int(),
      frozen: frozenSchema,
      results: z.array(resultSchema),
      error: z.string().nullable(),
      createdAt: z.number(),
      quiescent: z.boolean(),
    })
    .nullable(),
  readError: z.string().nullable(),
  connection: z.object({
    configured: z.boolean(),
    source:z.string().optional(),ownerPluginId:z.string().optional(),reason:z.string().optional(),
    tokenAccounting: z.boolean(),
    mode: z.string(),
  }),
  delivery: z.object({ state: z.string(), reason: z.string(), activeKnown:z.boolean().optional(),generationReady:z.boolean().optional(),activePublication:PublicationV1Schema.nullable().optional() }),
  unresolved: z.array(z.unknown()),
});

export const snapshotSchema = baseSnapshotSchema.extend({
  acknowledgedRun: baseSnapshotSchema.shape.run.unwrap().optional(),
  savedOccurrenceId: z.string().optional(),
});
