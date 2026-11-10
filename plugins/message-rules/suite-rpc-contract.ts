import { z } from "zod";
import {
  ConnectionSchema,
  RuleSchema,
  GroupSchema,
} from "./contracts/model.ts";
const project = z.object({ projectId: z.string().min(1).max(200) });
const json = z.unknown();
export const contract = {
  snapshot: {
    input: project.extend({
      discoverFiles: z.boolean().default(true),
      requestId: z.string().optional(),
    }),
    output: json,
  },
  configure: {
    input: project.extend({
      revision: z.number().int().nullable(),
      hostId: z.string().min(1),
      root: z.string().min(1),
      connection: ConnectionSchema,
    }),
    output: json,
  },
  saveGroup: {
    input: project.extend({ revision: z.number().int(), group: GroupSchema }),
    output: json,
  },
  deleteGroup: {
    input: project.extend({ revision: z.number().int(), groupId: z.string() }),
    output: json,
  },
  saveRule: {
    input: project.extend({ revision: z.number().int(), rule: RuleSchema }),
    output: json,
  },
  deleteRule: {
    input: project.extend({ revision: z.number().int(), ruleId: z.string() }),
    output: json,
  },
  saveFile: {
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
    input: project.extend({
      revision: z.number().int(),
      occurrenceId: z.string(),
      enabled: z.boolean(),
    }),
    output: json,
  },
  assignTest: {
    input: project.extend({
      revision: z.number().int(),
      occurrenceId: z.string(),
      groupId: z.string(),
    }),
    output: json,
  },
  startSuite: {
    input: project.extend({
      requestId: z.string().min(1).max(200),
      basis: z.string(),
      hasRelevantDrafts: z.boolean(),
    }),
    output: json,
  },
  cancelSuite: { input: project.extend({ runId: z.string() }), output: json },
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
    tokenAccounting: z.boolean(),
    mode: z.string(),
  }),
  delivery: z.object({ state: z.string(), reason: z.string() }),
  unresolved: z.array(z.unknown()),
});

export const snapshotSchema = baseSnapshotSchema.extend({
  acknowledgedRun: baseSnapshotSchema.shape.run.unwrap().optional(),
});
