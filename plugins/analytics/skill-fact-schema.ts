import { z } from "zod";
import {
  FORK_FREE_SKILL_EVIDENCE_VERSION,
  lifecycleEvidenceKinds,
  type PublicSkillCatalogSnapshot,
  type LifecycleObservationFact,
  type SkillMeasurementFact,
  type SkillRevisionIdentity,
} from "./skill-observation-contract.js";

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(1).max(512);
const nullableIdentifierSchema = identifierSchema.nullable();
const factIdSchema = z.string().regex(/^skillfact_v1_[a-f0-9]{64}$/u);

export const skillRevisionIdentitySchema = z.object({
  skillId: identifierSchema,
  name: z.string().min(1).max(4096),
  skillMarkdownPath: z.string().min(1).max(4096),
  sourceKind: z.enum(["builtin", "data-dir", "project", "shared-project", "shared-user", "plugin"]),
  sourceId: identifierSchema,
  pluginId: nullableIdentifierSchema,
  catalogRevision: revisionSchema,
  skillMarkdownRevision: revisionSchema,
  treeRevision: revisionSchema,
}).strict() satisfies z.ZodType<SkillRevisionIdentity>;

const observationGrainSchema = z.object({
  observationId: z.string().regex(/^skillobs_v1_[a-f0-9]{64}$/u),
  sourceEventId: identifierSchema,
  coverageEpochId: identifierSchema,
  observedAtMs: z.number().int().nonnegative(),
  sessionId: identifierSchema,
  threadId: identifierSchema,
  providerTurnId: nullableIdentifierSchema,
  principalId: identifierSchema,
  projectId: identifierSchema,
  environmentId: nullableIdentifierSchema,
  providerId: identifierSchema,
  providerModel: nullableIdentifierSchema,
}).strict();

export const skillLifecycleObservationFactSchema = observationGrainSchema.extend({
  factId: factIdSchema,
  revision: skillRevisionIdentitySchema,
  evidenceKind: z.enum(lifecycleEvidenceKinds),
  status: z.enum(["supported", "unsupported", "failure"]),
  activationObservability: z.enum(["observed", "unsupported", "unknown", "pre-instrumentation"]),
  captureTrigger: identifierSchema,
  providerEventId: nullableIdentifierSchema,
  failure: nullableIdentifierSchema,
}).strict().superRefine((fact, context) => {
  if (fact.status === "failure" && fact.failure === null) context.addIssue({ code: "custom", path: ["failure"], message: "failure facts require failure detail" });
  if (fact.status !== "failure" && fact.failure !== null) context.addIssue({ code: "custom", path: ["failure"], message: "only failure facts retain failure detail" });
  if (fact.evidenceKind === "activated" && fact.activationObservability !== "observed") context.addIssue({ code: "custom", path: ["activationObservability"], message: "activation evidence requires observed activation coverage" });
}) satisfies z.ZodType<LifecycleObservationFact>;

export const skillMeasurementFactSchema = observationGrainSchema.extend({
  factId: factIdSchema,
  revision: skillRevisionIdentitySchema,
  family: z.enum(["content-footprint", "context-occupancy", "attributable-consumption"]),
  method: z.enum(["local-content-estimate", "provider-reported-named-context-estimate", "provider-attributable-consumption"]),
  serializer: identifierSchema,
  tokenizer: identifierSchema,
  contentComponent: z.enum(["catalog-entry", "body", "reference", "asset"]).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  tokens: z.number().int().nonnegative().nullable(),
  status: z.enum(["supported", "unsupported", "failure"]),
  estimated: z.boolean(),
  rawObservationId: z.string().regex(/^skillobs_v1_[a-f0-9]{64}$/u).nullable(),
}).strict().superRefine((fact, context) => {
  if (fact.status !== "supported" && (fact.bytes !== null || fact.tokens !== null)) context.addIssue({ code: "custom", path: ["tokens"], message: "unsupported or failed measurements remain null, never zero" });
  if (fact.family === "content-footprint" && fact.contentComponent === null) context.addIssue({ code: "custom", path: ["contentComponent"], message: "content footprint identifies catalog-entry, body, reference, or asset" });
  if (fact.family !== "content-footprint" && fact.contentComponent !== null) context.addIssue({ code: "custom", path: ["contentComponent"], message: "context and consumption do not claim a loaded content component" });
  if (fact.method === "local-content-estimate" && fact.family !== "content-footprint") context.addIssue({ code: "custom", path: ["family"], message: "local estimate is a content footprint, not context or consumption" });
  if (fact.method === "provider-reported-named-context-estimate" && fact.family !== "context-occupancy") context.addIssue({ code: "custom", path: ["family"], message: "named provider estimate is context occupancy only" });
  if (fact.method === "provider-attributable-consumption" && fact.family !== "attributable-consumption") context.addIssue({ code: "custom", path: ["family"], message: "attributable consumption requires an attributable method" });
}) satisfies z.ZodType<SkillMeasurementFact>;

export const skillCoverageEpochFactSchema = z.object({
  coverageEpochId: identifierSchema,
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().nonnegative().nullable(),
  source: z.literal("skill-observation-v1"),
  lifecycleCoverage: z.enum(["observed", "unsupported", "unknown", "pre-instrumentation"]),
  activationCoverage: z.enum(["observed", "unsupported", "unknown", "pre-instrumentation"]),
  reason: z.string().min(1).max(4096),
}).strict().superRefine((epoch, context) => {
  if (epoch.endedAtMs !== null && epoch.endedAtMs < epoch.startedAtMs) context.addIssue({ code: "custom", path: ["endedAtMs"], message: "coverage epoch cannot end before it starts" });
});

const publicPathSchema = z.string().min(1).max(4096).refine((value) => value.startsWith("/") && !value.includes("\0"), "public registered paths are absolute and NUL-free");

export const publicSkillCatalogSnapshotSchema = z.object({
  version: z.literal(FORK_FREE_SKILL_EVIDENCE_VERSION),
  snapshotId: identifierSchema,
  capturedAtMs: z.number().int().nonnegative(),
  projectId: identifierSchema,
  environmentId: nullableIdentifierSchema,
  source: z.literal("sdk.skills.list/getContent/listFiles"),
  entries: z.array(z.object({
    skillId: identifierSchema,
    name: z.string().min(1).max(4096),
    provider: identifierSchema.nullable(),
    scope: z.enum(["bb-builtin", "bb-user", "bb-project", "provider-user", "provider-project", "shared-user", "shared-project", "plugin"]),
    pluginId: nullableIdentifierSchema,
    filePath: publicPathSchema,
    contentRevision: revisionSchema.nullable(),
    contentBytes: z.number().int().nonnegative().nullable(),
    registeredPaths: z.array(publicPathSchema).max(4096),
    filesTruncated: z.boolean(),
  }).strict()).max(4096),
}).strict().superRefine((snapshot, context) => {
  for (const [index, entry] of snapshot.entries.entries()) {
    if (entry.filesTruncated) context.addIssue({ code: "custom", path: ["entries", index, "filesTruncated"], message: "complete public catalog snapshots reject truncated file lists" });
  }
}) satisfies z.ZodType<PublicSkillCatalogSnapshot>;

export const publicSkillCatalogCaptureSchema = z.object({
  captureId: identifierSchema,
  trigger: z.enum(["thread.created", "thread.active", "refresh"]),
  capturedAtMs: z.number().int().nonnegative(),
  completeness: z.enum(["complete", "failed"]),
  error: z.string().min(1).max(4096).nullable(),
  snapshot: publicSkillCatalogSnapshotSchema.nullable(),
}).strict().superRefine((capture, context) => {
  if (capture.completeness === "complete" && (capture.snapshot === null || capture.error !== null)) context.addIssue({ code: "custom", message: "complete capture requires an error-free snapshot" });
  if (capture.completeness === "failed" && (capture.snapshot !== null || capture.error === null)) context.addIssue({ code: "custom", message: "failed capture retains an error and no empty catalog" });
});
