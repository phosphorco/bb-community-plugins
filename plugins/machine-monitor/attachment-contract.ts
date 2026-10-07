import { z } from "zod";

import {
  canonicalizeResource as canonicalizeSharedResource,
  serializeResource, sha256Hex, projectionPayloadJson, projectionPayloadDigest,
  machineMonitorResource, threadResource, urlResource,
  isExactBbThreadResource, isUrlResource,
  type Presentation, type ResourceIdentity, type Resource, type CanonicalResource,
} from "@phosphorco/bb-cross-references";
export {
  serializeResource, sha256Hex, projectionPayloadJson, projectionPayloadDigest,
  machineMonitorResource, threadResource, urlResource,
  isExactBbThreadResource, isUrlResource,
  type Presentation, type ResourceIdentity, type Resource, type CanonicalResource,
};
import { MAX_REFERENCE_LABEL_BYTES, MAX_REFERENCE_URL_BYTES } from "./reference-validation.ts";

export const CROSS_REFERENCES_PLUGIN_ID = "cross-references";
export const CROSS_REFERENCES_PROTOCOL_VERSION = 1 as const;
export const MACHINE_MONITOR_PRODUCER_ID = "machine-monitor";
export const MACHINE_MONITOR_ROUTE = "/plugins/machine-monitor/machine-monitor";
export const MAX_ATTACHMENT_TARGETS = 256;
export const MAX_KEY_VALUE_BYTES = MAX_REFERENCE_URL_BYTES;
export const MAX_PRESENTATION_LABEL_BYTES = MAX_REFERENCE_LABEL_BYTES;
export const MAX_PRESENTATION_DETAIL_BYTES = 1_024;
export const MAX_PRESENTATION_URL_BYTES = 2_048;
export const MAX_PRESENTATION_BYTES = 4 * 1_024;
export const MAX_KEY_VALUE_MATERIAL_BYTES = 8_192;
export const MAX_CANONICAL_IDENTITY_BYTES = 16 * 1_024;
export const MAX_PROJECTION_PAYLOAD_BYTES = 256 * 1_024;

const namePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeRevision = (schema: z.ZodNumber) => schema.refine(Number.isSafeInteger, { message: "must be a safe integer" });

export type ProjectionCommand = {
  protocolVersion: 1;
  producerPluginId: string;
  mutationId: string;
  source: Resource;
  revision: number;
  expectedRevision: number;
  payloadDigest: string;
  tombstone: false;
  targets: Resource[];
};

export type ProjectionResponse = {
  outcome: "applied" | "duplicate" | "equal" | "stale" | "conflict" | "cas-mismatch";
  currentRevision: number;
  currentDigest: string | null;
};

export type AttachmentStatusState = "synced" | "pending" | "degraded" | "blocked";
export type DeliveryFailureKind = "aborted" | "absent" | "transient" | "incompatible" | "blocked";

export type AttachmentStatus = {
  state: AttachmentStatusState;
  sourceRevision: number;
  desiredRevision: number;
  lastAckedRevision: number;
  pending: boolean;
  inFlight: boolean;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  errorKind: Exclude<DeliveryFailureKind, "aborted"> | null;
};

export type AttachmentSnapshot = {
  sourceRevision: number;
  targets: Resource[];
  status: AttachmentStatus;
};

export type ReplaceAttachmentsInput = {
  expectedSourceRevision: number;
  targets: Resource[];
};

export type ReplaceAttachmentsResponse = {
  outcome: "applied" | "unchanged" | "cas-mismatch";
  sourceRevision: number;
  targets: Resource[];
  status: AttachmentStatus;
};

export type AttachmentError = {
  kind: DeliveryFailureKind;
  code: string | null;
  status: number | null;
  message: string;
};

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

function fail(message: string): never {
  throw new AttachmentValidationError(message);
}

/** Preserve Machine Monitor's local error type while using the shared v1 codec. */
export function canonicalizeResource(value: Resource): CanonicalResource {
  try { return canonicalizeSharedResource(value); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    fail(message.replace(/must match \^\[A-Za-z0-9_\-\]\{1,128\}\$\./, "has an invalid BB id."));
  }
}

export function isMachineMonitorAttachmentTarget(resource: CanonicalResource): boolean {
  return isExactBbThreadResource(resource) || isUrlResource(resource);
}

export function newMutationId(): string {
  return globalThis.crypto.randomUUID();
}

export function createProjectionCommand(
  revision: number,
  expectedRevision: number,
  targets: readonly CanonicalResource[],
  mutationId = newMutationId(),
): ProjectionCommand {
  if (!Number.isSafeInteger(revision) || revision < 1) fail("revision must be a positive safe integer.");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("expectedRevision must be a nonnegative safe integer.");
  if (!uuidPattern.test(mutationId)) fail("mutationId must be a lower-case UUID.");
  const source = canonicalizeResource(machineMonitorResource());
  const payloadDigest = projectionPayloadDigest(MACHINE_MONITOR_PRODUCER_ID, source, false, targets);
  return {
    protocolVersion: CROSS_REFERENCES_PROTOCOL_VERSION,
    producerPluginId: MACHINE_MONITOR_PRODUCER_ID,
    mutationId,
    source: serializeResource(source),
    revision,
    expectedRevision,
    payloadDigest,
    tombstone: false,
    targets: targets.map(serializeResource),
  };
}

const presentationSchema = z.object({
  label: z.string().max(MAX_PRESENTATION_LABEL_BYTES),
  detail: z.string().max(MAX_PRESENTATION_DETAIL_BYTES).optional(),
  url: z.string().max(MAX_PRESENTATION_URL_BYTES).optional(),
}).strict();

const resourceSchema = z.object({
  provider: z.string().max(64).regex(namePattern),
  keys: z.record(z.string().max(64), z.string().max(MAX_KEY_VALUE_BYTES)),
  presentation: presentationSchema,
}).strict().superRefine((value, context) => {
  try { canonicalizeResource(value); } catch (cause) {
    context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
  }
});

const statusSchema = z.object({
  state: z.enum(["synced", "pending", "degraded", "blocked"]),
  sourceRevision: z.number().int().nonnegative(),
  desiredRevision: z.number().int().nonnegative(),
  lastAckedRevision: z.number().int().nonnegative(),
  pending: z.boolean(),
  inFlight: z.boolean(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  errorKind: z.enum(["absent", "transient", "incompatible", "blocked"]).nullable(),
}).strict();

export const attachmentRpcSchemas = {
  replaceAttachments: {
    input: z.object({
      expectedSourceRevision: z.number().int().nonnegative().refine(Number.isSafeInteger),
      targets: z.array(resourceSchema).max(MAX_ATTACHMENT_TARGETS),
    }).strict(),
    output: z.object({
      outcome: z.enum(["applied", "unchanged", "cas-mismatch"]),
      sourceRevision: z.number().int().nonnegative(),
      targets: z.array(resourceSchema).max(MAX_ATTACHMENT_TARGETS),
      status: statusSchema,
    }).strict(),
  },
  getAttachments: {
    input: z.null(),
    output: z.object({
      sourceRevision: z.number().int().nonnegative(),
      targets: z.array(resourceSchema).max(MAX_ATTACHMENT_TARGETS),
      status: statusSchema,
    }).strict(),
  },
  attachmentStatus: {
    input: z.null(),
    output: statusSchema,
  },
} as const;

export const projectionResponseSchema = z.object({
  outcome: z.enum(["applied", "duplicate", "equal", "stale", "conflict", "cas-mismatch"]),
  currentRevision: z.number().int().nonnegative(),
  currentDigest: z.string().regex(digestPattern).nullable(),
}).strict();

export const projectionSchema = z.object({
  producerPluginId: z.string().max(64).regex(namePattern),
  source: resourceSchema,
  revision: safeRevision(z.number().int().nonnegative()),
  mutationId: z.string().regex(uuidPattern),
  payloadDigest: z.string().regex(digestPattern),
  tombstone: z.boolean(),
  targets: z.array(resourceSchema).max(MAX_ATTACHMENT_TARGETS),
}).strict();

export const getProjectionResponseSchema = z.object({ projection: projectionSchema.nullable() }).strict();

export function exactTargetIdentity(resource: CanonicalResource): ResourceIdentity {
  return { provider: resource.provider, keys: resource.keys };
}
