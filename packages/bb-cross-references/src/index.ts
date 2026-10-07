export const FORWARD_REFERENCE_CHECK_LIMIT = 10;
export * from "./canonical.js";
import { z } from "zod";
import {
  canonicalizeIdentity, MAX_PRESENTATION_DETAIL_BYTES, MAX_PRESENTATION_LABEL_BYTES,
  MAX_PRESENTATION_URL_BYTES, MAX_KEY_VALUE_BYTES, MAX_MUTATION_ID_BYTES,
  canonicalizeResource,
  projectionPayloadJson,
  sha256Hex,
  type CanonicalIdentity,
  type CanonicalResource,
  type Presentation,
  type Resource,
  type ResourceIdentity,
} from "./canonical.js";
import {
  CrossReferenceValidationError,
  MAX_TARGETS,
  PROTOCOL_VERSION,
  validateDigest,
  validateMutationId,
  validateProducerPluginId,
  validateRevision,
} from "./canonical.js";

export {
  PROTOCOL_VERSION,
  CrossReferenceValidationError,
  type Presentation,
  type Resource,
  type ResourceIdentity,
};

export interface ApplyProjectionInput {
  protocolVersion: 1;
  producerPluginId: string;
  mutationId: string;
  source: Resource;
  revision: number;
  expectedRevision: number;
  payloadDigest: string;
  tombstone: boolean;
  targets: Resource[];
}

export type ProjectionOutcome = "applied" | "duplicate" | "equal" | "stale" | "conflict" | "cas-mismatch";

export interface ApplyProjectionResponse {
  outcome: ProjectionOutcome;
  currentRevision: number;
  currentDigest: string | null;
}

export interface NormalizedProjectionCommand extends Omit<ApplyProjectionInput, "source" | "targets"> {
  source: CanonicalResource;
  targets: CanonicalResource[];
  payloadJson: string;
  computedPayloadDigest: string;
}

export interface Projection {
  producerPluginId: string;
  source: Resource;
  revision: number;
  mutationId: string;
  payloadDigest: string;
  tombstone: boolean;
  targets: Resource[];
}

export interface GetProjectionResponse {
  projection: Projection | null;
}

export interface ListBacklinksInput {
  target: ResourceIdentity;
  pageSize?: number;
  cursor?: string;
}

export interface BacklinkRow {
  source: Resource;
  producerPluginId: string;
  revision: number;
  targetPresentation: Presentation;
  position: number;
  /** Latest source-message time across matching assertions; null when unknown. */
  lastSeenAt?: number | null;
}

export interface ListBacklinksResponse {
  rows: BacklinkRow[];
  /** Exact number of distinct source resources at this page's upper bound. */
  total: number;
  nextCursor: string | null;
}

/** The deduplicated outgoing view of stored directed edges. No inverse is persisted. */
export interface ListForwardReferencesInput {
  source: ResourceIdentity;
  /** Limits the outgoing view to one source-owner when supplied. */
  producerPluginId?: string;
  pageSize?: number;
  cursor?: string;
}

export interface ForwardReferenceRow {
  target: Resource;
  producerPluginId: string;
  revision: number;
  position: number;
  lastSeenAt?: number | null;
}

export interface ListForwardReferencesResponse {
  rows: ForwardReferenceRow[];
  /** Exact number of distinct target resources at this page's upper bound. */
  total: number;
  nextCursor: string | null;
}

/** Ephemeral HTTP reachability information for a visible forward target. */
export interface ForwardReferenceStatus {
  url: string;
  status: number | null;
  label: string;
}

/**
 * The status probe reads current outgoing occurrences but never changes the
 * directed graph. It is intentionally bounded and has no pagination because
 * it serves a compact display-time health indicator.
 */
export interface CheckForwardReferencesInput {
  source: ResourceIdentity;
  producerPluginId?: string;
}

export interface CrossReferencesChangedSignal {
  protocolVersion: 1;
  affectedIdentityDigests: string[];
  producerPluginId: string;
  sourceIdentityDigest: string;
  revision: number;
}

function assertInputRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrossReferenceValidationError("projection input must be an object.");
  }
  const fields = Object.keys(value).sort();
  if (fields.join(",") !== "expectedRevision,mutationId,payloadDigest,producerPluginId,protocolVersion,revision,source,targets,tombstone") {
    throw new CrossReferenceValidationError("projection input fields are invalid.");
  }
}

export function normalizeProjectionCommand(input: ApplyProjectionInput): NormalizedProjectionCommand {
  assertInputRecord(input);
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    throw new CrossReferenceValidationError(`protocolVersion must be ${PROTOCOL_VERSION}.`);
  }
  const producerPluginId = validateProducerPluginId(input.producerPluginId);
  const mutationId = validateMutationId(input.mutationId);
  const revision = validateRevision(input.revision, "revision", 1);
  const expectedRevision = validateRevision(input.expectedRevision, "expectedRevision", 0);
  if (typeof input.tombstone !== "boolean") {
    throw new CrossReferenceValidationError("tombstone must be a boolean.");
  }
  if (!Array.isArray(input.targets) || input.targets.length > MAX_TARGETS) {
    throw new CrossReferenceValidationError(`targets must contain at most ${MAX_TARGETS} resources.`);
  }

  const source = canonicalizeResource(input.source);
  const targets = input.targets.map((target) => canonicalizeResource(target));
  const identitySet = new Set<string>();
  for (const target of targets) {
    if (identitySet.has(target.canonicalIdentityJson)) {
      throw new CrossReferenceValidationError("targets must not contain duplicate resource identities.");
    }
    identitySet.add(target.canonicalIdentityJson);
  }
  if (input.tombstone && targets.length !== 0) {
    throw new CrossReferenceValidationError("a tombstone must have an empty target list.");
  }

  const payloadJson = projectionPayloadJson(producerPluginId, source, input.tombstone, targets);
  const computedPayloadDigest = sha256Hex(payloadJson);
  const payloadDigest = validateDigest(input.payloadDigest);
  if (payloadDigest !== computedPayloadDigest) {
    throw new CrossReferenceValidationError("payloadDigest does not match the canonical projection payload.");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    producerPluginId,
    mutationId,
    source,
    revision,
    expectedRevision,
    payloadDigest,
    tombstone: input.tombstone,
    targets,
    payloadJson,
    computedPayloadDigest,
  };
}

export function normalizeIdentityInput(input: ResourceIdentity): CanonicalIdentity {
  return canonicalizeIdentity(input);
}

export function defaultPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return 25;
  const validated = validateRevision(pageSize, "pageSize", 1);
  if (validated > 100) {
    throw new CrossReferenceValidationError("pageSize must be between 1 and 100.");
  }
  return validated;
}

const namePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

const safeInteger = (schema: z.ZodNumber) => schema.refine(Number.isSafeInteger, { message: "must be a safe integer" });

const presentationSchema = z.object({
  label: z.string().max(MAX_PRESENTATION_LABEL_BYTES),
  detail: z.string().max(MAX_PRESENTATION_DETAIL_BYTES).optional(),
  url: z.string().max(MAX_PRESENTATION_URL_BYTES).optional(),
}).strict().superRefine((value, context) => {
  try {
    canonicalizeResource({ provider: "test", keys: { resource: "placeholder" }, presentation: value as Presentation });
  } catch (cause) {
    context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
  }
});

const resourceSchema = z.object({
  provider: z.string().max(64).regex(namePattern),
  keys: z.record(z.string().max(64), z.string().max(MAX_KEY_VALUE_BYTES)),
  presentation: presentationSchema,
}).strict().superRefine((value, context) => {
  try {
    canonicalizeResource(value as Resource);
  } catch (cause) {
    context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
  }
});

const resourceIdentitySchema = z.object({
  provider: z.string().max(64).regex(namePattern),
  keys: z.record(z.string().max(64), z.string().max(MAX_KEY_VALUE_BYTES)),
}).strict().superRefine((value, context) => {
  try {
    canonicalizeIdentity(value);
  } catch (cause) {
    context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
  }
});

const producerPluginIdSchema = z.string().max(64).regex(namePattern);
const mutationIdSchema = z.string().max(MAX_MUTATION_ID_BYTES).regex(uuidPattern);
const revisionSchema = safeInteger(z.number().int());

const applyProjectionInputSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  producerPluginId: producerPluginIdSchema,
  mutationId: mutationIdSchema,
  source: resourceSchema,
  revision: revisionSchema.positive(),
  expectedRevision: revisionSchema.nonnegative(),
  payloadDigest: z.string().regex(digestPattern),
  tombstone: z.boolean(),
  targets: z.array(resourceSchema).max(MAX_TARGETS),
}).strict().superRefine((value, context) => {
  try {
    // This repeats the pure boundary checks, including the tombstone rule,
    // exact duplicate detection, payload size, and the supplied digest.
    normalizeProjectionCommand(value as ApplyProjectionInput);
  } catch (cause) {
    context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
  }
});

const applyProjectionResponseSchema = z.object({
  outcome: z.enum(["applied", "duplicate", "equal", "stale", "conflict", "cas-mismatch"]),
  currentRevision: revisionSchema.nonnegative(),
  currentDigest: z.string().regex(digestPattern).nullable(),
}).strict();

const projectionSchema = z.object({
  producerPluginId: producerPluginIdSchema,
  source: resourceSchema,
  revision: revisionSchema.nonnegative(),
  mutationId: mutationIdSchema,
  payloadDigest: z.string().regex(digestPattern),
  tombstone: z.boolean(),
  targets: z.array(resourceSchema).max(MAX_TARGETS),
}).strict();

const getProjectionInputSchema = z.object({
  producerPluginId: producerPluginIdSchema,
  source: resourceIdentitySchema,
}).strict();

const getProjectionOutputSchema = z.object({ projection: projectionSchema.nullable() }).strict();

const backlinkRowSchema = z.object({
  source: resourceSchema,
  producerPluginId: producerPluginIdSchema,
  revision: revisionSchema.nonnegative(),
  targetPresentation: presentationSchema,
  position: z.number().int().min(0).max(MAX_TARGETS - 1).refine(Number.isSafeInteger),
  lastSeenAt: revisionSchema.nonnegative().nullable().optional(),
}).strict();

const listBacklinksInputSchema = z.object({
  target: resourceIdentitySchema,
  pageSize: z.number().int().min(1).max(100).refine(Number.isSafeInteger).optional(),
  cursor: z.string().max(4_096).optional(),
}).strict();

const listBacklinksOutputSchema = z.object({
  rows: z.array(backlinkRowSchema).max(100),
  total: revisionSchema.nonnegative(),
  nextCursor: z.string().max(4_096).nullable(),
}).strict();

const forwardReferenceRowSchema = z.object({
  target: resourceSchema,
  producerPluginId: producerPluginIdSchema,
  revision: revisionSchema.nonnegative(),
  position: z.number().int().min(0).max(MAX_TARGETS - 1).refine(Number.isSafeInteger),
  lastSeenAt: revisionSchema.nonnegative().nullable().optional(),
}).strict();

const listForwardReferencesInputSchema = z.object({
  source: resourceIdentitySchema,
  producerPluginId: producerPluginIdSchema.optional(),
  pageSize: z.number().int().min(1).max(100).refine(Number.isSafeInteger).optional(),
  cursor: z.string().max(4_096).optional(),
}).strict();

const listForwardReferencesOutputSchema = z.object({
  rows: z.array(forwardReferenceRowSchema).max(100),
  total: revisionSchema.nonnegative(),
  nextCursor: z.string().max(4_096).nullable(),
}).strict();

const checkForwardReferencesInputSchema = z.object({
  source: resourceIdentitySchema,
  producerPluginId: producerPluginIdSchema.optional(),
}).strict();

const forwardReferenceStatusSchema = z.object({
  url: z.string().max(MAX_PRESENTATION_URL_BYTES),
  status: z.number().int().min(100).max(599).nullable(),
  label: z.string().min(1).max(128),
}).strict();

const checkForwardReferencesOutputSchema = z.array(forwardReferenceStatusSchema).max(FORWARD_REFERENCE_CHECK_LIMIT);


export {
  applyProjectionInputSchema,
  applyProjectionResponseSchema,
  backlinkRowSchema,
  checkForwardReferencesInputSchema,
  checkForwardReferencesOutputSchema,
  forwardReferenceStatusSchema,
  getProjectionInputSchema,
  getProjectionOutputSchema,
  listBacklinksInputSchema,
  listBacklinksOutputSchema,
  listForwardReferencesInputSchema,
  listForwardReferencesOutputSchema,
  presentationSchema,
  projectionSchema,
  resourceIdentitySchema,
  resourceSchema,
};

export const CROSS_REFERENCES_PLUGIN_ID = "cross-references";
export const CROSS_REFERENCES_PROTOCOL = "cross-references" as const;
export const LIMITS = Object.freeze({ callMs: 5_000, describeMs: 1_000, responseBytes: 1024 * 1024 });
export const describeInputSchema = z.null();
export const describeOutputSchema = z.object({
  protocol: z.literal(CROSS_REFERENCES_PROTOCOL),
  versions: z.array(z.number().int().positive().refine(Number.isSafeInteger)).max(16),
});
export const crossReferencesRpcSchemas = {
  "crossReferences.describe": { input: describeInputSchema, output: describeOutputSchema },
  applyProjection: { input: applyProjectionInputSchema, output: applyProjectionResponseSchema },
  getProjection: { input: getProjectionInputSchema, output: getProjectionOutputSchema },
  listBacklinks: { input: listBacklinksInputSchema, output: listBacklinksOutputSchema },
  listForwardReferences: { input: listForwardReferencesInputSchema, output: listForwardReferencesOutputSchema },
  checkForwardReferences: { input: checkForwardReferencesInputSchema, output: checkForwardReferencesOutputSchema },
} as const;
export interface ReferenceSnapshot {
  revision: number;
  targets: Resource[];
  status: { state: "synced" | "pending" | "degraded" | "blocked"; error: string | null };
}
export const referenceSnapshotSchema = z.object({
  revision: revisionSchema.nonnegative(),
  targets: z.array(resourceSchema).max(MAX_TARGETS),
  status: z.object({ state: z.enum(["synced", "pending", "degraded", "blocked"]), error: z.string().max(4096).nullable() }),
});
export type GetProjectionInput = z.infer<typeof getProjectionInputSchema>;
export type ApplyProjectionRpcInput = ApplyProjectionInput;
export type CheckForwardReferencesRpcInput = CheckForwardReferencesInput;
export type CheckForwardReferencesRpcOutput = ForwardReferenceStatus[];
export type GetProjectionRpcOutput = GetProjectionResponse;
export type ListBacklinksRpcOutput = ListBacklinksResponse;
export type ListForwardReferencesRpcOutput = ListForwardReferencesResponse;

export type AttachmentSnapshot = ReferenceSnapshot;
