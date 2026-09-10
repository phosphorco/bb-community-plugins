import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  canonicalizeIdentity,
  canonicalizeResource,
  MAX_PRESENTATION_DETAIL_BYTES,
  MAX_PRESENTATION_LABEL_BYTES,
  MAX_PRESENTATION_URL_BYTES,
  MAX_TARGETS,
  MAX_KEY_VALUE_BYTES,
  MAX_MUTATION_ID_BYTES,
  PROTOCOL_VERSION,
} from "./canonical.ts";
import type {
  ApplyProjectionInput,
  GetProjectionResponse,
  ListBacklinksResponse,
} from "./model.ts";
import { normalizeProjectionCommand } from "./model.ts";

const namePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

const safeInteger = (schema: z.ZodNumber) => schema.refine(Number.isSafeInteger, { message: "must be a safe integer" });

const presentationSchema = z.object({
  label: z.string().max(MAX_PRESENTATION_LABEL_BYTES),
  detail: z.string().max(MAX_PRESENTATION_DETAIL_BYTES).optional(),
  url: z.string().max(MAX_PRESENTATION_URL_BYTES).optional(),
}).strict().superRefine((value, context) => {
  try {
    canonicalizeResource({ provider: "test", keys: { resource: "placeholder" }, presentation: value });
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
    canonicalizeResource(value);
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
    normalizeProjectionCommand(value);
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
}).strict();

const listBacklinksInputSchema = z.object({
  target: resourceIdentitySchema,
  pageSize: z.number().int().min(1).max(100).refine(Number.isSafeInteger).optional(),
  cursor: z.string().max(4_096).optional(),
}).strict();

const listBacklinksOutputSchema = z.object({
  rows: z.array(backlinkRowSchema).max(100),
  nextCursor: z.string().max(4_096).nullable(),
}).strict();

export const rpcContract = defineRpcContract({
  applyProjection: {
    input: applyProjectionInputSchema,
    output: applyProjectionResponseSchema,
  },
  getProjection: {
    input: getProjectionInputSchema,
    output: getProjectionOutputSchema,
  },
  listBacklinks: {
    input: listBacklinksInputSchema,
    output: listBacklinksOutputSchema,
  },
});

export {
  applyProjectionInputSchema,
  applyProjectionResponseSchema,
  backlinkRowSchema,
  getProjectionInputSchema,
  getProjectionOutputSchema,
  listBacklinksInputSchema,
  listBacklinksOutputSchema,
  presentationSchema,
  projectionSchema,
  resourceIdentitySchema,
  resourceSchema,
};

export type ApplyProjectionRpcInput = ApplyProjectionInput;
export type GetProjectionRpcOutput = GetProjectionResponse;
export type ListBacklinksRpcOutput = ListBacklinksResponse;
