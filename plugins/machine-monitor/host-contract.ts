import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  FLEET_CONTRACT_VERSION,
  hostCollectionPayloadSchema,
} from "./fleet-contract.ts";

/**
 * These are the daemon-side RPC payloads.  In particular, none contains a
 * machine ID: only the central coordinator may bind an authenticated target
 * host (or the local BB server) to a received observation.
 */
export const HOST_CONTRACT_VERSION = FLEET_CONTRACT_VERSION;
export const MAX_HOST_DIRECTORY_PATHS = 8;
export const MAX_HOST_MEMORY_PROCESSES = 12;

const controlCharacter = /\p{Cc}/u;
const boundedId = (maxLength = 128) => z.string().min(1).max(maxLength)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine((value) => !controlCharacter.test(value), "must not contain control characters");
const boundedText = (maxLength = 256) => z.string().min(1).max(maxLength)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine((value) => !controlCharacter.test(value), "must not contain control characters");
const timestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nonnegativeFiniteNumberSchema = z.number().finite().min(0);

export const hostPlatformSchema = z.enum(["darwin", "linux", "wsl", "unknown"]);
export const hostCapabilitySchema = z.enum([
  "core-sampling",
  "directory-sampling",
  "memory-diagnostics",
  "linux-memory-pressure",
  "process-attribution",
]);

export const hostDescriptionSchema = z.object({
  contractVersion: z.literal(HOST_CONTRACT_VERSION),
  collectorSessionId: boundedId(128),
  observedAtMs: timestampSchema,
  hostName: boundedText(256),
  platform: hostPlatformSchema,
  platformDetail: boundedText(256),
  capabilities: z.array(hostCapabilitySchema).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({ code: "custom", message: "capabilities must be unique", path: ["capabilities"] });
  }
});

/** The core response is intentionally the identity-free fleet payload. */
export const hostCoreSampleSchema = hostCollectionPayloadSchema;

export const hostDirectoryRequestSchema = z.object({
  directoryId: boundedId(128),
  paths: z.array(boundedText(1_024))
    .min(1)
    .max(MAX_HOST_DIRECTORY_PATHS),
}).strict().superRefine((value, context) => {
  if (new Set(value.paths).size !== value.paths.length) context.addIssue({ code: "custom", message: "paths must be unique", path: ["paths"] });
});

export const hostDirectorySampleSchema = z.object({
  contractVersion: z.literal(HOST_CONTRACT_VERSION),
  collectorSessionId: boundedId(128),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  observedAtMs: timestampSchema,
  directoryId: boundedId(128),
  bytes: nonnegativeFiniteNumberSchema.nullable(),
  onRootFilesystem: z.boolean().nullable(),
  partial: z.boolean(),
  availability: z.enum(["available", "unavailable", "not-collected"]),
  reason: z.string().min(1).max(256).nullable(),
}).strict().superRefine((value, context) => {
  const available = value.availability === "available";
  if (available !== (value.bytes != null && value.onRootFilesystem != null)) {
    context.addIssue({ code: "custom", message: "available directories require a value and filesystem fact", path: ["bytes"] });
  }
  if (!available && (value.bytes != null || value.onRootFilesystem != null)) {
    context.addIssue({ code: "custom", message: "unavailable directories cannot carry a value", path: ["bytes"] });
  }
});

export const hostMemoryDiagnosticRequestSchema = z.object({
  includeProcessDetails: z.boolean(),
}).strict();

const hostMemoryProcessSchema = z.object({
  pid: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  startTime: nonnegativeFiniteNumberSchema,
  name: boundedText(256),
  workload: boundedText(256),
  workloadDetail: boundedText(256).nullable(),
  rssBytes: nonnegativeFiniteNumberSchema,
  rssDeltaBytes: z.number().finite().nullable(),
  minorFaultsPerSecond: nonnegativeFiniteNumberSchema.nullable(),
  majorFaultsPerSecond: nonnegativeFiniteNumberSchema.nullable(),
}).strict();

export const hostMemoryDiagnosticSchema = z.object({
  contractVersion: z.literal(HOST_CONTRACT_VERSION),
  collectorSessionId: boundedId(128),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  observedAtMs: timestampSchema,
  processDetailsCollectedAtMs: timestampSchema.nullable(),
  sampleIntervalMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  pressureSomePercent: nonnegativeFiniteNumberSchema.nullable(),
  pressureFullPercent: nonnegativeFiniteNumberSchema.nullable(),
  swapInPagesPerSecond: nonnegativeFiniteNumberSchema.nullable(),
  swapOutPagesPerSecond: nonnegativeFiniteNumberSchema.nullable(),
  refaultPagesPerSecond: nonnegativeFiniteNumberSchema.nullable(),
  reclaimPagesPerSecond: nonnegativeFiniteNumberSchema.nullable(),
  bbCgroupMemoryBytes: nonnegativeFiniteNumberSchema.nullable(),
  processes: z.array(hostMemoryProcessSchema).max(MAX_HOST_MEMORY_PROCESSES),
}).strict();

/**
 * This contract owns daemon-local measurements only.  It is kept separate
 * from the browser/server fleet RPCs so an authenticated target must be
 * supplied by the server-side host client, never by daemon data.
 */
export const hostRpcContract = defineRpcContract({
  describe: {
    input: z.null(),
    output: hostDescriptionSchema,
  },
  coreSample: {
    input: z.null(),
    output: hostCoreSampleSchema,
  },
  directorySample: {
    input: hostDirectoryRequestSchema,
    output: hostDirectorySampleSchema,
  },
  memoryDiagnostics: {
    input: hostMemoryDiagnosticRequestSchema,
    output: hostMemoryDiagnosticSchema,
  },
});

export type HostDescription = z.infer<typeof hostDescriptionSchema>;
export type HostCoreSample = z.infer<typeof hostCoreSampleSchema>;
export type HostDirectorySample = z.infer<typeof hostDirectorySampleSchema>;
export type HostMemoryDiagnostic = z.infer<typeof hostMemoryDiagnosticSchema>;
