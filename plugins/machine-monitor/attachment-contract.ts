import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

/**
 * This is the deliberately small client-side copy of the frozen Cross
 * References v1 wire contract.  Machine Monitor treats Cross References as an
 * optional peer, so importing its package (or its database) here would make
 * local attachments unavailable when that peer is not installed.
 */
export const CROSS_REFERENCES_PLUGIN_ID = "cross-references";
export const CROSS_REFERENCES_PROTOCOL_VERSION = 1 as const;
export const MACHINE_MONITOR_PRODUCER_ID = "machine-monitor";
export const MACHINE_MONITOR_ROUTE = "/plugins/machine-monitor/machine-monitor";
export const MAX_ATTACHMENT_TARGETS = 256;
export const MAX_KEY_VALUE_BYTES = 512;
export const MAX_PRESENTATION_LABEL_BYTES = 256;
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
const controlPattern = /\p{Cc}/u;
const encoder = new TextEncoder();
const safeRevision = (schema: z.ZodNumber) => schema.refine(Number.isSafeInteger, { message: "must be a safe integer" });

export type Presentation = {
  label: string;
  detail?: string;
  url?: string;
};

export type ResourceIdentity = {
  provider: string;
  keys: Record<string, string>;
};

export type Resource = ResourceIdentity & {
  presentation: Presentation;
};

export type CanonicalResource = Resource & {
  canonicalKeysJson: string;
  canonicalIdentityJson: string;
  identityDigest: string;
  presentationJson: string;
};

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

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(`${label} must be a plain object.`);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail(`${label} must not contain symbol keys.`);
}

function assertNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${label} contains unknown field ${key}.`);
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(`${label} contains malformed Unicode.`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(`${label} contains malformed Unicode.`);
    }
  }
}

function safeText(value: string, label: string, maxBytes: number, nonblank = false): string {
  assertWellFormedUnicode(value, label);
  if (controlPattern.test(value)) fail(`${label} contains a Unicode control character.`);
  if (nonblank && value.trim().length === 0) fail(`${label} must not be blank.`);
  if (byteLength(value) > maxBytes) fail(`${label} exceeds its ${maxBytes}-byte limit.`);
  return value;
}

function validateName(value: unknown, label: string): string {
  if (typeof value !== "string" || !namePattern.test(value)) fail(`${label} has an invalid name.`);
  return value;
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) fail(`${label} has an invalid BB id.`);
  return value;
}

function validateBbIdentity(provider: string, keys: Record<string, string>): void {
  if (provider !== "bb") return;
  const names = Object.keys(keys);
  if (names.length === 1 && names[0] === "project") {
    validateId(keys.project, "projectId");
    return;
  }
  if (names.length === 2 && names[0] === "project" && names[1] === "thread") {
    validateId(keys.project, "projectId");
    validateId(keys.thread, "threadId");
    return;
  }
  if (names.length === 2 && names[0] === "page" && names[1] === "plugin"
    && keys.page === "machine-monitor" && keys.plugin === "machine-monitor") {
    return;
  }
  fail("provider bb must use a v1 project, thread, or Machine Monitor identity.");
}

function canonicalizeKeys(value: unknown): { keys: Record<string, string>; canonicalKeysJson: string } {
  assertPlainObject(value, "resource.keys");
  const names = Object.keys(value);
  if (names.length < 1 || names.length > 32) fail("resource.keys must contain between 1 and 32 entries.");
  let materialBytes = 0;
  const entries = names.map((key) => {
    validateName(key, "resource key");
    const raw = value[key];
    if (typeof raw !== "string") fail(`resource key ${key} must have a string value.`);
    const normalized = safeText(raw.normalize("NFC"), `resource key ${key}`, MAX_KEY_VALUE_BYTES, true);
    materialBytes += byteLength(key) + byteLength(normalized);
    return [key, normalized] as const;
  });
  if (materialBytes > MAX_KEY_VALUE_MATERIAL_BYTES) fail("resource key/value material is too large.");
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const keys = Object.fromEntries(entries) as Record<string, string>;
  return { keys, canonicalKeysJson: JSON.stringify(keys) };
}

function canonicalizePresentation(value: unknown): { presentation: Presentation; presentationJson: string } {
  assertPlainObject(value, "resource.presentation");
  assertNoUnknownKeys(value, ["label", "detail", "url"], "resource.presentation");
  if (typeof value.label !== "string") fail("resource.presentation.label must be a string.");
  const presentation: Presentation = {
    label: safeText(value.label, "resource.presentation.label", MAX_PRESENTATION_LABEL_BYTES, true),
  };
  if (value.detail !== undefined) {
    if (typeof value.detail !== "string") fail("resource.presentation.detail must be a string.");
    presentation.detail = safeText(value.detail, "resource.presentation.detail", MAX_PRESENTATION_DETAIL_BYTES, true);
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string") fail("resource.presentation.url must be a string.");
    const url = safeText(value.url, "resource.presentation.url", MAX_PRESENTATION_URL_BYTES, true);
    if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) {
      presentation.url = url;
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("resource.presentation.url must use http(s).");
        presentation.url = url;
      } catch {
        fail("resource.presentation.url must be a valid http(s) URL.");
      }
    } else {
      fail("resource.presentation.url must be a same-origin route or http(s) URL.");
    }
  }
  const presentationJson = JSON.stringify(presentation);
  if (byteLength(presentationJson) > MAX_PRESENTATION_BYTES) fail("resource.presentation is too large.");
  return { presentation, presentationJson };
}

export function canonicalizeResource(value: Resource): CanonicalResource {
  assertPlainObject(value, "resource");
  assertNoUnknownKeys(value, ["provider", "keys", "presentation"], "resource");
  const provider = validateName(value.provider, "resource.provider");
  const identity = canonicalizeKeys(value.keys);
  validateBbIdentity(provider, identity.keys);
  const identityObject = { provider, keys: identity.keys };
  const canonicalIdentityJson = JSON.stringify(identityObject);
  if (byteLength(canonicalIdentityJson) > MAX_CANONICAL_IDENTITY_BYTES) fail("resource identity is too large.");
  const presentation = canonicalizePresentation(value.presentation);
  return {
    provider,
    keys: identity.keys,
    canonicalKeysJson: identity.canonicalKeysJson,
    canonicalIdentityJson,
    identityDigest: sha256Hex(canonicalIdentityJson),
    presentation: presentation.presentation,
    presentationJson: presentation.presentationJson,
  };
}

export function serializeResource(resource: CanonicalResource): Resource {
  return { provider: resource.provider, keys: resource.keys, presentation: resource.presentation };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectionPayloadJson(
  producerPluginId: string,
  source: CanonicalResource,
  tombstone: boolean,
  targets: readonly CanonicalResource[],
): string {
  const json = JSON.stringify({
    protocolVersion: CROSS_REFERENCES_PROTOCOL_VERSION,
    producerPluginId,
    source: serializeResource(source),
    tombstone,
    targets: targets.map(serializeResource),
  });
  if (byteLength(json) > MAX_PROJECTION_PAYLOAD_BYTES) fail("projection payload is too large.");
  return json;
}

export function projectionPayloadDigest(
  producerPluginId: string,
  source: CanonicalResource,
  tombstone: boolean,
  targets: readonly CanonicalResource[],
): string {
  return sha256Hex(projectionPayloadJson(producerPluginId, source, tombstone, targets));
}

export function machineMonitorResource(): Resource {
  return {
    provider: "bb",
    keys: { page: "machine-monitor", plugin: "machine-monitor" },
    presentation: { label: "Machine Monitor", url: MACHINE_MONITOR_ROUTE },
  };
}

export function isExactBbThreadResource(resource: CanonicalResource): boolean {
  const keys = Object.keys(resource.keys);
  return resource.provider === "bb" && keys.length === 2 && keys[0] === "project" && keys[1] === "thread"
    && idPattern.test(resource.keys.project!) && idPattern.test(resource.keys.thread!);
}

export function threadResource(projectId: string, threadId: string, presentation: Presentation): Resource {
  return {
    provider: "bb",
    keys: { project: validateId(projectId, "projectId"), thread: validateId(threadId, "threadId") },
    presentation,
  };
}

export function newMutationId(): string {
  return randomUUID();
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
