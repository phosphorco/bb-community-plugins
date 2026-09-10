import { z } from "zod";

export const ANALYTICS_EXECUTION_CONTRACT_VERSION = 2 as const;
export const ANALYTICS_REFERENCE_CAPSULE_VERSION = 2 as const;
const MiB = 1024 * 1024;
export const EXECUTION_LIMITS = Object.freeze({
  maxBundleBytes: 256 * 1024,
  maxSqlBytes: 16 * 1024,
  maxAstNodes: 4_096,
  maxBoundParameters: 32,
  maxParameterBytes: 32 * 1024,
  maxColumns: 64,
  maxRows: 500,
  maxCells: 32_000,
  maxCellStringBytes: 2_000,
  maxCanonicalResultBytes: 4 * MiB,
  maxQueuedExecutions: 32,
  /** Aggregate UTF-8 bytes of queued resolved descriptors, not facts or process memory. */
  maxQueuedBytes: 4 * MiB,
  queryDeadlineMs: 2_000,
  workerStartupDeadlineMs: 15_000,
  materializationDeadlineMs: 5_000,
  parentKillGraceMs: 1_000,
  databaseMemoryLimitBytes: 256 * MiB,
  maxTransferChunkBytes: 256 * 1024,
  maxTransferChunks: 256,
  maxTransferRowsPerChunk: 1_000,
  idleWorkerTtlMs: 5 * 60_000,
  cacheMaxEntries: 24,
  cacheMaxBytes: 4 * MiB,
  cacheTtlMs: 5 * 60_000,
  executionRecordTtlMs: 90 * 86_400_000,
  referenceTtlMs: 365 * 86_400_000,
  maxReferenceBytes: 64 * 1024,
  retainedProjectionDays: 90,
  pullFreshnessMs: 60 * 60_000,
});
export const SELECTED_EXECUTION_RUNTIME = Object.freeze({
  kind: "isolated-wasm-duckdb" as const,
  packageName: "@duckdb/duckdb-wasm" as const,
  packageVersion: "1.33.1-dev57.0" as const,
  ownership: "plugin-owned-node-child" as const,
  databaseMemoryLimitBytes: EXECUTION_LIMITS.databaseMemoryLimitBytes,
  bootstrap: Object.freeze({
    statement: "LOAD json" as const,
    externalAccessBeforeLoad: true,
    allowUnsignedExtensions: false,
    allowCommunityExtensions: false,
    autoinstallKnownExtensions: false,
    autoloadKnownExtensions: false,
    externalAccessAfterLoad: false,
    lockConfigurationBeforeAuthoredSql: true,
  }),
  nativeAddonPackaging: "disqualified" as const,
  productionQualification: "pending" as const,
});

const encoder = new TextEncoder();
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
function utf8String(max: number) {
  return z.string().superRefine((value, context) => {
    if (utf8ByteLength(value) > max)
      context.addIssue({
        code: "custom",
        message: "String exceeds UTF-8 byte limit " + max + ".",
      });
  });
}
function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
      .join(",") +
    "}"
  );
}
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);
const field = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const revision = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const executionId = z
  .string()
  .min(20)
  .max(200)
  .regex(/^analytics-exec_[A-Za-z0-9_-]+$/);
const snapshotId = z
  .string()
  .min(20)
  .max(200)
  .regex(/^analytics-snapshot_[A-Za-z0-9_-]+$/);
export const executionReferenceIdSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^analytics-ref_[A-Za-z0-9_-]+$/);
export const executionReferenceTokenSchema = z
  .string()
  .regex(/^analytics-ref:v2:[A-Za-z0-9_-]+$/)
  .max(240);
export const executionReferenceExpirySchema = safeInteger;
const referenceId = executionReferenceIdSchema;
const datumKey = z
  .string()
  .min(1)
  .max(240)
  .regex(/^analytics-datum_[A-Za-z0-9_-]+$/);
const physicalKey = z
  .string()
  .min(20)
  .max(200)
  .regex(/^analytics-physical_[A-Za-z0-9_-]+$/);
const decimalText = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const canonicalScalarSchema = z.union([
  utf8String(EXECUTION_LIMITS.maxCellStringBytes),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const utcRangeSchema = z
  .object({ startInclusiveMs: safeInteger, endExclusiveMs: safeInteger })
  .strict()
  .superRefine((range, context) => {
    if (range.endExclusiveMs <= range.startInclusiveMs)
      context.addIssue({
        code: "custom",
        message: "endExclusiveMs must be greater than startInclusiveMs.",
      });
  });
export const resultExtentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), rows: safeInteger }).strict(),
  z.object({ kind: z.literal("lower-bound"), rows: safeInteger }).strict(),
]);
export const sourceScopeSchema = z
  .object({
    scopeKey: z
      .string()
      .min(16)
      .max(200)
      .regex(/^analytics-scope_[A-Za-z0-9_-]+$/),
    projection: z.literal("tool_execution_fact_v1"),
    storage: z.literal("plugin-owned-sqlite"),
  })
  .strict();
export const sourceCoverageSchema = z
  .object({
    /** Changes whenever coverage metadata changes, even when fact generation does not. */
    coverageRevision: safeInteger,
    retention: z
      .object({
        startInclusiveMs: safeInteger.nullable(),
        earliestVerifiedRetainedInclusiveMs: safeInteger.nullable(),
        endExclusiveMs: safeInteger,
        policyDays: z.literal(EXECUTION_LIMITS.retainedProjectionDays),
      })
      .strict(),
    observed: z
      .object({
        earliestFactMs: safeInteger.nullable(),
        latestFactMs: safeInteger.nullable(),
        asOfMs: safeInteger,
        projectionGeneration: safeInteger,
        projectionRevision: revision,
      })
      .strict(),
    population: z
      .object({
        candidateThreads: safeInteger,
        selectedThreads: safeInteger,
        loadedThreads: safeInteger,
        retainedFacts: safeInteger,
        cappedThreads: safeInteger,
        listPages: safeInteger,
        eventPages: safeInteger,
        eventBytes: safeInteger,
        safeFailureCount: safeInteger,
        lastSafeFailureAtMs: safeInteger.nullable(),
        candidateThreadLimit: z.number().int().min(1),
        threadPageLimit: z.number().int().min(1),
        eventPageLimit: z.number().int().min(1),
        maxEventsPerThread: z.number().int().min(1),
        maxEventBytes: safeInteger,
      })
      .strict(),
    mode: z.enum([
      "complete-retained-projection",
      "partial-retained-projection",
      "degraded-observed",
    ]),
    incompleteReasons: z
      .array(
        z.enum([
          "range-precedes-earliest-verified-retained",
          "backfill-in-progress",
          "source-page-cap",
          "thread-event-cap",
          "source-read-failure",
          "reconciliation-pending",
          "retention-boundary-unknown",
        ]),
      )
      .max(7),
    backfill: z
      .object({
        state: z.enum([
          "not-requested",
          "running",
          "partial",
          "complete",
          "failed",
        ]),
        direction: z.literal("newest-to-oldest"),
        completeRange: utcRangeSchema.nullable(),
        resumable: z.boolean(),
      })
      .strict(),
    reconciliation: z
      .object({
        observedAsOfMs: safeInteger,
        lastFullReconciliationAtMs: safeInteger.nullable(),
        deletionConfirmation: z.enum(["none", "confirmed", "pending-retry"]),
        sourceSemantics: z.literal("eventually-reconciled-observed-as-of"),
      })
      .strict(),
    degraded: z.boolean(),
  })
  .strict()
  .superRefine((coverage, context) => {
    const observed = coverage.observed;
    if (
      observed.earliestFactMs != null &&
      observed.latestFactMs != null &&
      observed.earliestFactMs > observed.latestFactMs
    )
      context.addIssue({
        code: "custom",
        message: "earliestFactMs cannot follow latestFactMs.",
      });
    const population = coverage.population;
    if (
      population.selectedThreads > population.candidateThreads ||
      population.candidateThreads > population.candidateThreadLimit ||
      population.loadedThreads > population.selectedThreads ||
      population.cappedThreads > population.selectedThreads ||
      population.eventBytes > population.maxEventBytes
    )
      context.addIssue({
        code: "custom",
        message: "Coverage population/budget counts are inconsistent.",
      });
    const retention = coverage.retention;
    if (
      retention.startInclusiveMs != null &&
      retention.endExclusiveMs <= retention.startInclusiveMs
    )
      context.addIssue({
        code: "custom",
        message: "Retained interval must be ordered.",
      });
    if (
      retention.earliestVerifiedRetainedInclusiveMs != null &&
      (retention.startInclusiveMs == null ||
        retention.earliestVerifiedRetainedInclusiveMs <
          retention.startInclusiveMs ||
        retention.earliestVerifiedRetainedInclusiveMs >=
          retention.endExclusiveMs)
    )
      context.addIssue({
        code: "custom",
        message:
          "earliestVerifiedRetainedInclusiveMs must lie in the retained interval.",
      });
    if (retention.endExclusiveMs > observed.asOfMs)
      context.addIssue({
        code: "custom",
        message: "Retained endpoint cannot be after observed-as-of.",
      });
    if (
      coverage.backfill.state === "complete" &&
      (coverage.backfill.completeRange == null ||
        coverage.retention.startInclusiveMs == null ||
        coverage.backfill.completeRange.startInclusiveMs !==
          coverage.retention.startInclusiveMs ||
        coverage.backfill.completeRange.endExclusiveMs !==
          coverage.retention.endExclusiveMs)
    )
      context.addIssue({
        code: "custom",
        message:
          "Complete backfill means all of the declared retained interval was reconciled.",
      });
    if (
      coverage.mode === "complete-retained-projection" &&
      (coverage.incompleteReasons.length !== 0 ||
        coverage.backfill.state !== "complete")
    )
      context.addIssue({
        code: "custom",
        message:
          "Complete coverage requires completed backfill and no incomplete reasons.",
      });
    if (
      coverage.mode !== "complete-retained-projection" &&
      coverage.incompleteReasons.length === 0
    )
      context.addIssue({
        code: "custom",
        message: "Incomplete/degraded coverage requires an explicit reason.",
      });
  });
export const executionSnapshotSchema = z
  .object({
    version: z.literal(ANALYTICS_EXECUTION_CONTRACT_VERSION),
    snapshotId,
    sourceScope: sourceScopeSchema,
    frozenRange: utcRangeSchema,
    capturedAtMs: safeInteger,
    coverage: sourceCoverageSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.frozenRange.endExclusiveMs > snapshot.capturedAtMs ||
      snapshot.coverage.observed.asOfMs !== snapshot.capturedAtMs ||
      snapshot.coverage.reconciliation.observedAsOfMs !== snapshot.capturedAtMs
    )
      context.addIssue({
        code: "custom",
        message:
          "Frozen endpoint and coverage must be tied to the snapshot observed-as-of time.",
      });
    const earliest =
      snapshot.coverage.retention.earliestVerifiedRetainedInclusiveMs;
    if (
      earliest != null &&
      snapshot.frozenRange.startInclusiveMs < earliest &&
      !snapshot.coverage.incompleteReasons.includes(
        "range-precedes-earliest-verified-retained",
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "A range preceding verified retention must declare incomplete coverage.",
      });
  });

export const boundParameterSchema = z
  .object({
    name: identifier,
    logicalType: z.enum([
      "utf8",
      "integer",
      "decimal",
      "float64",
      "boolean",
      "timestamp_utc_ms",
      "date_utc",
      "null",
    ]),
    value: canonicalScalarSchema,
  })
  .strict()
  .superRefine((parameter, context) => {
    const valid =
      (parameter.logicalType === "utf8" &&
        typeof parameter.value === "string") ||
      (parameter.logicalType === "integer" &&
        typeof parameter.value === "number" &&
        Number.isSafeInteger(parameter.value)) ||
      (parameter.logicalType === "decimal" &&
        typeof parameter.value === "string" &&
        decimalText.test(parameter.value)) ||
      (parameter.logicalType === "float64" &&
        typeof parameter.value === "number" &&
        Number.isFinite(parameter.value)) ||
      (parameter.logicalType === "boolean" &&
        typeof parameter.value === "boolean") ||
      (parameter.logicalType === "timestamp_utc_ms" &&
        typeof parameter.value === "number" &&
        Number.isSafeInteger(parameter.value)) ||
      (parameter.logicalType === "date_utc" &&
        typeof parameter.value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parameter.value)) ||
      (parameter.logicalType === "null" && parameter.value === null);
    if (!valid)
      context.addIssue({
        code: "custom",
        message:
          "Value does not match parameter logical type " +
          parameter.logicalType +
          ".",
      });
  });
function checkParameters(
  parameters: readonly { name: string }[],
  context: z.RefinementCtx,
) {
  if (
    new Set(parameters.map((parameter) => parameter.name)).size !==
    parameters.length
  )
    context.addIssue({
      code: "custom",
      message: "Bound parameter names must be unique.",
    });
  if (
    utf8ByteLength(canonicalJson(parameters)) >
    EXECUTION_LIMITS.maxParameterBytes
  )
    context.addIssue({
      code: "custom",
      message: "Bound parameters exceed their UTF-8 byte limit.",
    });
}
/** Only untrusted client shape: it cannot post SQL, snapshot, scope, or cacheability. */
export const executionLocatorSchema = z
  .object({
    bundleId: identifier,
    queryId: identifier,
    range: utcRangeSchema,
    parameters: z
      .array(boundParameterSchema)
      .max(EXECUTION_LIMITS.maxBoundParameters),
  })
  .strict()
  .superRefine((input, context) => checkParameters(input.parameters, context));

/**
 * Browser-safe strings for trusted host SHA-256 hashing. SQL is exact source;
 * parameter declarations are canonical sorted name/type pairs and omit values.
 */
export function sqlSha256Input(sql: string): string {
  return sql;
}
export function parameterDeclarationDigestInput(
  parameters: readonly { name: string; logicalType: string }[],
): string {
  return canonicalJson(
    parameters
      .map((parameter) => ({
        name: parameter.name,
        logicalType: parameter.logicalType,
      }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
  );
}
export const queryAdmissionRequestSchema = z
  .object({
    sql: utf8String(EXECUTION_LIMITS.maxSqlBytes).min(1),
    parameters: z
      .array(boundParameterSchema)
      .max(EXECUTION_LIMITS.maxBoundParameters),
    cacheability: z.enum(["stable", "volatile-uncacheable"]),
  })
  .strict()
  .superRefine((query, context) => checkParameters(query.parameters, context));
export const queryAdmissionAttestationSchema = z
  .object({
    astPolicyRevision: revision,
    astNodeCount: z.number().int().min(1).max(EXECUTION_LIMITS.maxAstNodes),
    sqlSha256: revision,
    parameterDeclarationDigest: revision,
    cacheability: z.enum(["stable", "volatile-uncacheable"]),
  })
  .strict();
export const admittedQuerySchema = z
  .object({
    id: identifier,
    revision,
    title: utf8String(120).min(1),
    sql: utf8String(EXECUTION_LIMITS.maxSqlBytes).min(1),
    maxRows: z.number().int().min(1).max(EXECUTION_LIMITS.maxRows),
    astNodeCount: z.number().int().min(1).max(EXECUTION_LIMITS.maxAstNodes),
    astPolicyRevision: revision,
    sqlSha256: revision,
    parameterDeclarationDigest: revision,
    resultContractRevision: revision,
    cacheability: z.enum(["stable", "volatile-uncacheable"]),
    parameters: z
      .array(boundParameterSchema)
      .max(EXECUTION_LIMITS.maxBoundParameters),
  })
  .strict()
  .superRefine((query, context) => checkParameters(query.parameters, context));
export function assertAdmittedQueryAttestation(
  query: z.infer<typeof admittedQuerySchema>,
  attestation: z.infer<typeof queryAdmissionAttestationSchema>,
): void {
  if (
    query.astPolicyRevision !== attestation.astPolicyRevision ||
    query.astNodeCount !== attestation.astNodeCount ||
    query.sqlSha256 !== attestation.sqlSha256 ||
    query.parameterDeclarationDigest !==
      attestation.parameterDeclarationDigest ||
    query.cacheability !== attestation.cacheability
  ) {
    throw new Error(
      "Query admission attestation does not match the admitted query.",
    );
  }
}
export const resolvedExecutionSchema = z
  .object({
    version: z.literal(ANALYTICS_EXECUTION_CONTRACT_VERSION),
    executionId,
    snapshot: executionSnapshotSchema,
    bundleId: identifier,
    bundleRevision: revision,
    query: admittedQuerySchema,
  })
  .strict();

/** Exact physical reuse identity; lineage revision remains separate from physical sharing. */
export const physicalCacheKeyInputSchema = z
  .object({
    sourceScope: sourceScopeSchema,
    projectionGeneration: safeInteger,
    projectionRevision: revision,
    endpoint: utcRangeSchema,
    normalizedSql: utf8String(EXECUTION_LIMITS.maxSqlBytes).min(1),
    astPolicyRevision: revision,
    resultContractRevision: revision,
    parameters: z
      .array(boundParameterSchema)
      .max(EXECUTION_LIMITS.maxBoundParameters),
    maxRows: z.number().int().min(1).max(EXECUTION_LIMITS.maxRows),
  })
  .strict()
  .superRefine((input, context) => checkParameters(input.parameters, context));
export function derivePhysicalCacheKeyInput(
  resolved: z.infer<typeof resolvedExecutionSchema>,
): z.infer<typeof physicalCacheKeyInputSchema> | null {
  if (resolved.query.cacheability !== "stable") return null;
  return {
    sourceScope: resolved.snapshot.sourceScope,
    projectionGeneration:
      resolved.snapshot.coverage.observed.projectionGeneration,
    projectionRevision: resolved.snapshot.coverage.observed.projectionRevision,
    endpoint: resolved.snapshot.frozenRange,
    normalizedSql: resolved.query.sql,
    astPolicyRevision: resolved.query.astPolicyRevision,
    resultContractRevision: resolved.query.resultContractRevision,
    parameters: [...resolved.query.parameters].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
    maxRows: resolved.query.maxRows,
  };
}
/** Pure serialization to hash/store; no field may be omitted by a repository. */
export function canonicalPhysicalCacheKeyInput(
  resolved: z.infer<typeof resolvedExecutionSchema>,
): string | null {
  const input = derivePhysicalCacheKeyInput(resolved);
  return input == null ? null : canonicalJson(input);
}

/** The only retained queue payload: resolved metadata, SQL, and typed values—never source facts. */
export function queuedResolvedDescriptorBytes(
  resolved: z.infer<typeof resolvedExecutionSchema>,
): number {
  return utf8ByteLength(
    canonicalJson({
      version: resolved.version,
      executionId: resolved.executionId,
      snapshot: resolved.snapshot,
      bundleId: resolved.bundleId,
      bundleRevision: resolved.bundleRevision,
      query: resolved.query,
    }),
  );
}

/**
 * Pure queue admission guard. A scheduler calls this before retaining/enqueuing
 * a descriptor and before source handoff/fact materialization begins.
 */
export function assertQueueAdmission(
  queuedExecutions: number,
  queuedDescriptorBytes: number,
  next: z.infer<typeof resolvedExecutionSchema>,
): void {
  const nextBytes = queuedResolvedDescriptorBytes(next);
  if (
    queuedExecutions >= EXECUTION_LIMITS.maxQueuedExecutions ||
    queuedDescriptorBytes + nextBytes > EXECUTION_LIMITS.maxQueuedBytes
  ) {
    throw new Error(
      "queue-full: resolved execution descriptor exceeds queue admission budget.",
    );
  }
}

export const analyticalColumnSchema = z
  .object({
    name: field,
    logicalType: z.enum([
      "utf8",
      "integer",
      "decimal",
      "float64",
      "boolean",
      "timestamp_utc_ms",
      "date_utc",
    ]),
    nullable: z.boolean(),
  })
  .strict();
export const canonicalRowSchema = z
  .record(field, canonicalScalarSchema)
  .superRefine((row, context) => {
    if (Object.keys(row).length > EXECUTION_LIMITS.maxColumns)
      context.addIssue({
        code: "custom",
        message: "A canonical row has too many cells.",
      });
  });
function rowMatchesColumns(
  row: Record<string, unknown>,
  columns: readonly { name: string; logicalType: string; nullable: boolean }[],
): string | null {
  const expected = new Map(columns.map((column) => [column.name, column]));
  if (
    Object.keys(row).length !== expected.size ||
    Object.keys(row).some((name) => !expected.has(name))
  )
    return "Row fields must exactly match declared columns.";
  for (const [name, value] of Object.entries(row)) {
    const column = expected.get(name);
    if (column == null) continue;
    if (value === null) {
      if (!column.nullable)
        return "Non-nullable column " + name + " contains null.";
      continue;
    }
    const valid =
      (column.logicalType === "utf8" && typeof value === "string") ||
      (column.logicalType === "integer" &&
        typeof value === "number" &&
        Number.isSafeInteger(value)) ||
      (column.logicalType === "decimal" &&
        typeof value === "string" &&
        decimalText.test(value)) ||
      (column.logicalType === "float64" &&
        typeof value === "number" &&
        Number.isFinite(value)) ||
      (column.logicalType === "boolean" && typeof value === "boolean") ||
      (column.logicalType === "timestamp_utc_ms" &&
        typeof value === "number" &&
        Number.isSafeInteger(value)) ||
      (column.logicalType === "date_utc" &&
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value));
    if (!valid)
      return (
        "Value for " + name + " does not match " + column.logicalType + "."
      );
  }
  return null;
}
export function canonicalResultWireBytes(value: unknown): number {
  return utf8ByteLength(canonicalJson(value));
}
/** Opaque, deterministic, execution-scoped keys; repeated equal rows receive ordinal suffixes. */
export function deriveExecutionDatumKeys(
  id: string,
  rows: readonly Record<string, unknown>[],
): string[] {
  if (!executionId.safeParse(id).success)
    throw new Error("Datum keys require a validated execution ID.");
  if (rows.length > EXECUTION_LIMITS.maxRows)
    throw new Error("Datum keys exceed the bounded execution row count.");
  const suffix = id.slice("analytics-exec_".length);
  return rows.map(
    (_row, ordinal) => "analytics-datum_" + suffix + "_" + ordinal,
  );
}
export function verifyExecutionDatumKeys(
  id: string,
  rows: readonly Record<string, unknown>[],
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(keys) === canonicalJson(deriveExecutionDatumKeys(id, rows))
  );
}
export const canonicalResultSchema = z
  .object({
    columns: z
      .array(analyticalColumnSchema)
      .min(1)
      .max(EXECUTION_LIMITS.maxColumns),
    rows: z.array(canonicalRowSchema).max(EXECUTION_LIMITS.maxRows),
    datumKeys: z.array(datumKey).max(EXECUTION_LIMITS.maxRows),
    resultExtent: resultExtentSchema,
    resultTruncated: z.boolean(),
    encodedBytes: z
      .number()
      .int()
      .min(0)
      .max(EXECUTION_LIMITS.maxCanonicalResultBytes),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      new Set(result.columns.map((column) => column.name)).size !==
      result.columns.length
    )
      context.addIssue({
        code: "custom",
        message: "Result column names must be unique.",
      });
    if (result.rows.length !== result.datumKeys.length)
      context.addIssue({
        code: "custom",
        message: "Rows and datumKeys must have equal length.",
      });
    if (result.rows.length * result.columns.length > EXECUTION_LIMITS.maxCells)
      context.addIssue({
        code: "custom",
        message: "Result exceeds canonical cell limit.",
      });
    for (const row of result.rows) {
      const error = rowMatchesColumns(row, result.columns);
      if (error != null) {
        context.addIssue({ code: "custom", message: error });
        break;
      }
    }
    if (new Set(result.datumKeys).size !== result.datumKeys.length)
      context.addIssue({
        code: "custom",
        message: "datumKeys must be unique within execution.",
      });
    if (
      result.resultExtent.kind === "exact" &&
      result.resultExtent.rows !== result.rows.length
    )
      context.addIssue({
        code: "custom",
        message: "Exact extent must equal returned rows.",
      });
    if (
      result.resultExtent.kind === "lower-bound" &&
      result.resultExtent.rows <= result.rows.length
    )
      context.addIssue({
        code: "custom",
        message: "Lower-bound extent must exceed returned rows.",
      });
    if (result.resultTruncated !== (result.resultExtent.kind === "lower-bound"))
      context.addIssue({
        code: "custom",
        message: "resultTruncated must agree with extent.",
      });
    const actual = canonicalResultWireBytes({
      columns: result.columns,
      rows: result.rows,
      datumKeys: result.datumKeys,
      resultExtent: result.resultExtent,
      resultTruncated: result.resultTruncated,
    });
    if (result.encodedBytes !== actual)
      context.addIssue({
        code: "custom",
        message: "encodedBytes must equal measured canonical UTF-8 wire bytes.",
      });
  });
export const executionErrorSchema = z
  .object({
    code: z.enum([
      "invalid-request",
      "stale-snapshot",
      "admission-denied",
      "identity-unavailable",
      "identity-mismatch",
      "queue-full",
      "queue-timeout",
      "cancelled",
      "worker-startup-timeout",
      "materialization-limit",
      "materialization-timeout",
      "query-timeout",
      "result-limit",
      "worker-crashed",
      "record-expired",
    ]),
    retryable: z.boolean(),
    message: utf8String(500).min(1),
  })
  .strict();
export type QueryAdmissionOutcome =
  | Readonly<{
      kind: "admitted";
      admission: z.infer<typeof queryAdmissionAttestationSchema>;
    }>
  | Readonly<{ kind: "error"; error: z.infer<typeof executionErrorSchema> }>;
export const executionResultSchema = z
  .object({
    version: z.literal(ANALYTICS_EXECUTION_CONTRACT_VERSION),
    executionId,
    resolved: resolvedExecutionSchema,
    coverage: sourceCoverageSchema,
    result: canonicalResultSchema,
    startedAtMs: safeInteger,
    completedAtMs: safeInteger,
    elapsedMs: z.number().finite().min(0).max(EXECUTION_LIMITS.queryDeadlineMs),
    cache: z
      .object({
        status: z.enum(["miss", "physical-reuse", "uncacheable"]),
        physicalExecutionKey: physicalKey.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.completedAtMs < result.startedAtMs)
      context.addIssue({
        code: "custom",
        message: "completedAtMs cannot precede startedAtMs.",
      });
    if (
      !verifyExecutionDatumKeys(
        result.executionId,
        result.result.rows,
        result.result.datumKeys,
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "datumKeys must be the deterministic execution-scoped keys for these rows.",
      });
    if (
      canonicalJson(result.coverage) !==
      canonicalJson(result.resolved.snapshot.coverage)
    )
      context.addIssue({
        code: "custom",
        message: "Result coverage must equal snapshot coverage.",
      });
    if (
      result.cache.status === "uncacheable" &&
      (result.cache.physicalExecutionKey != null ||
        result.resolved.query.cacheability !== "volatile-uncacheable")
    )
      context.addIssue({
        code: "custom",
        message: "Only volatile queries are uncacheable, without physical key.",
      });
    if (
      result.cache.status !== "uncacheable" &&
      (result.cache.physicalExecutionKey == null ||
        result.resolved.query.cacheability !== "stable")
    )
      context.addIssue({
        code: "custom",
        message: "Stable cacheable execution requires physical key.",
      });
  });

const format = z.enum(["text", "integer", "percent", "duration", "decimal"]);
const metric = z
  .object({
    id: identifier,
    queryId: identifier,
    kind: z.literal("metric"),
    title: utf8String(120).min(1),
    value: field,
    detail: field.optional(),
    format,
    layoutPosition: z.number().int().min(0).max(29),
  })
  .strict();
const chart = z
  .object({
    id: identifier,
    queryId: identifier,
    kind: z.enum(["bar", "line"]),
    title: utf8String(120).min(1),
    x: field,
    y: field,
    format,
    layoutPosition: z.number().int().min(0).max(29),
  })
  .strict();
const table = z
  .object({
    id: identifier,
    queryId: identifier,
    kind: z.literal("table"),
    title: utf8String(120).min(1),
    columns: z
      .array(z.object({ field, label: utf8String(80).min(1), format }).strict())
      .min(1)
      .max(10),
    layoutPosition: z.number().int().min(0).max(29),
  })
  .strict();
export const visualizationSnapshotSchema = z.discriminatedUnion("kind", [
  metric,
  chart,
  table,
]);
function visualizationFields(
  visualization: z.infer<typeof visualizationSnapshotSchema>,
): string[] {
  if (visualization.kind === "metric")
    return [
      visualization.value,
      ...(visualization.detail == null ? [] : [visualization.detail]),
    ];
  return visualization.kind === "table"
    ? visualization.columns.map((column) => column.field)
    : [visualization.x, visualization.y];
}
export const immutableBundleSnapshotSchema = z
  .object({
    id: identifier,
    version: z.literal(1),
    revision,
    title: utf8String(120).min(1),
    description: utf8String(500).min(1),
    loader: z
      .object({
        id: z.literal("recent-capability-facts-v1"),
        label: utf8String(120).min(1),
        maxAgeMs: z.number().int().min(60_000).max(86_400_000),
        staleWhileRefresh: z.boolean(),
      })
      .strict(),
  })
  .strict();
const figureContextSchema = z
  .object({
    visualization: visualizationSnapshotSchema,
    plotted: z
      .object({
        plottedRows: z.number().int().min(0).max(EXECUTION_LIMITS.maxRows),
        total: resultExtentSchema,
        reduction: z.enum(["none", "top-n", "downsampled"]),
      })
      .strict(),
  })
  .strict();
export const executionDefinitionSchema = z
  .object({
    bundle: immutableBundleSnapshotSchema,
    query: admittedQuerySchema,
    figures: z.array(figureContextSchema).min(1).max(30),
  })
  .strict()
  .superRefine((definition, context) => {
    const ids = definition.figures.map((figure) => figure.visualization.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        message: "Captured visualization IDs must be unique.",
      });
    for (const figure of definition.figures) {
      if (figure.visualization.queryId !== definition.query.id)
        context.addIssue({
          code: "custom",
          message:
            "Every captured visualization must consume the captured query.",
        });
    }
  });

function addExecutionDefinitionResultConsistencyIssues(
  definition: z.infer<typeof executionDefinitionSchema>,
  result: z.infer<typeof executionResultSchema>,
  context: { addIssue(issue: { code: "custom"; message: string }): void },
): void {
  if (result.executionId !== result.resolved.executionId)
    context.addIssue({
      code: "custom",
      message: "Execution result ID must equal resolved lineage ID.",
    });
  if (
    definition.bundle.id !== result.resolved.bundleId ||
    definition.bundle.revision !== result.resolved.bundleRevision ||
    canonicalJson(definition.query) !== canonicalJson(result.resolved.query)
  )
    context.addIssue({
      code: "custom",
      message:
        "Execution definition must exactly match captured bundle/query authority.",
    });
  const fields = new Set(result.result.columns.map((column) => column.name));
  for (const figure of definition.figures) {
    for (const name of visualizationFields(figure.visualization))
      if (!fields.has(name))
        context.addIssue({
          code: "custom",
          message: "Visualization field " + name + " is absent from result schema.",
        });
    if (
      canonicalJson(figure.plotted.total) !==
        canonicalJson(result.result.resultExtent) ||
      figure.plotted.plottedRows > result.result.rows.length ||
      (figure.plotted.reduction === "none" &&
        figure.plotted.plottedRows !== result.result.rows.length)
    )
      context.addIssue({
        code: "custom",
        message:
          "Figure plotted count, total, and reduction must match canonical result.",
      });
  }
}

export const storedExecutionRecordSchema = z
  .object({
    version: z.literal(ANALYTICS_EXECUTION_CONTRACT_VERSION),
    result: executionResultSchema,
    snapshot: executionSnapshotSchema,
    definition: executionDefinitionSchema,
    createdAtMs: safeInteger,
    expiresAtMs: safeInteger,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.createdAtMs !== record.result.completedAtMs)
      context.addIssue({
        code: "custom",
        message: "Record creation must equal execution completion.",
      });
    if (
      record.expiresAtMs <= record.createdAtMs ||
      record.expiresAtMs - record.createdAtMs >
        EXECUTION_LIMITS.executionRecordTtlMs
    )
      context.addIssue({
        code: "custom",
        message: "Execution record expiry exceeds bounded retention.",
      });
    if (
      canonicalJson(record.snapshot) !==
      canonicalJson(record.result.resolved.snapshot)
    )
      context.addIssue({
        code: "custom",
        message: "Stored snapshot must equal execution snapshot.",
      });
    addExecutionDefinitionResultConsistencyIssues(
      record.definition,
      record.result,
      context,
    );
  });
export const createExecutionReferenceRequestSchema = z
  .object({
    executionId,
    visualizationId: identifier,
    targetDatumKey: datumKey.optional(),
  })
  .strict();
export const executionReferenceCapsuleV2Schema = z
  .object({
    version: z.literal(ANALYTICS_REFERENCE_CAPSULE_VERSION),
    referenceId,
    token: executionReferenceTokenSchema,
    createdAtMs: safeInteger,
    expiresAtMs: executionReferenceExpirySchema,
    executionId,
    snapshot: executionSnapshotSchema,
    definition: executionDefinitionSchema,
    visualizationId: identifier,
    parameters: z
      .array(boundParameterSchema)
      .max(EXECUTION_LIMITS.maxBoundParameters),
    resultSchema: z
      .array(analyticalColumnSchema)
      .min(1)
      .max(EXECUTION_LIMITS.maxColumns),
    resultExtent: resultExtentSchema,
    resultTruncated: z.boolean(),
    targetDatumKey: datumKey.nullable(),
    capturedSelectedRow: canonicalRowSchema.nullable(),
  })
  .strict()
  .superRefine((capsule, context) => {
    const expectedToken =
      "analytics-ref:v2:" + capsule.referenceId.slice("analytics-ref_".length);
    if (capsule.token !== expectedToken)
      context.addIssue({
        code: "custom",
        message:
          "Reference token suffix must identify the same reference record.",
      });
    if (
      capsule.expiresAtMs <= capsule.createdAtMs ||
      capsule.expiresAtMs - capsule.createdAtMs >
        EXECUTION_LIMITS.referenceTtlMs
    )
      context.addIssue({
        code: "custom",
        message: "Reference expiry exceeds bounded retention.",
      });
    if (
      (capsule.targetDatumKey == null) !==
      (capsule.capturedSelectedRow == null)
    )
      context.addIssue({
        code: "custom",
        message: "Selected datum key and captured row must appear together.",
      });
    if (capsule.capturedSelectedRow != null) {
      const error = rowMatchesColumns(
        capsule.capturedSelectedRow,
        capsule.resultSchema,
      );
      if (error != null) context.addIssue({ code: "custom", message: error });
    }
    if (
      capsule.resultTruncated !==
      (capsule.resultExtent.kind === "lower-bound")
    )
      context.addIssue({
        code: "custom",
        message: "Reference truncation must agree with extent.",
      });
    const figure = capsule.definition.figures.find(
      (candidate) => candidate.visualization.id === capsule.visualizationId,
    );
    if (figure == null)
      context.addIssue({
        code: "custom",
        message: "Reference visualization must be captured by its definition.",
      });
    else
      for (const name of visualizationFields(figure.visualization))
        if (!capsule.resultSchema.some((column) => column.name === name))
          context.addIssue({
            code: "custom",
            message:
              "Visualization field " +
              name +
              " is absent from reference schema.",
          });
    if (canonicalResultWireBytes(capsule) > EXECUTION_LIMITS.maxReferenceBytes)
      context.addIssue({
        code: "custom",
        message: "Reference capsule exceeds byte limit.",
      });
  });

export const executeQueryResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("success"),
      result: executionResultSchema,
      definition: executionDefinitionSchema,
    })
    .strict(),
  z.object({ kind: z.literal("error"), error: executionErrorSchema }).strict(),
]).superRefine((response, context) => {
  if (response.kind === "success")
    addExecutionDefinitionResultConsistencyIssues(
      response.definition,
      response.result,
      context,
    );
});

export const createExecutionReferenceResponseSchema = z
  .object({
    id: executionReferenceIdSchema,
    token: executionReferenceTokenSchema,
    label: utf8String(120).min(1),
    expiresAtMs: executionReferenceExpirySchema,
  })
  .strict()
  .superRefine((response, context) => {
    const expectedToken =
      "analytics-ref:v2:" + response.id.slice("analytics-ref_".length);
    if (response.token !== expectedToken)
      context.addIssue({
        code: "custom",
        path: ["token"],
        message: "Reference token suffix must identify the same reference ID.",
      });
  });

/** Actual v1 stored shape, decoded only as unverified client lineage. */
const legacyScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const legacyExtentSchema = z
  .object({
    kind: z.enum(["exact", "lower-bound"]),
    rows: z.number().int().nonnegative(),
  })
  .strict();
export const legacyStoredReferenceCapsuleSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    token: z.string().regex(/^analytics-ref:v1:/),
    createdAt: z.number().finite(),
    bundleId: z.string(),
    bundleTitle: z.string(),
    queryId: z.string(),
    queryTitle: z.string(),
    querySql: z.string(),
    visualizationId: z.string(),
    visualizationTitle: z.string(),
    visualizationKind: z.enum(["metric", "bar", "line", "table"]),
    resultGeneration: z.string(),
    snapshotGenerationId: z.number().int().nonnegative().nullable(),
    snapshotUpdatedAt: z.number().finite().nullable(),
    rangeDays: z.number().int(),
    coverage: legacyExtentSchema,
    selection: z
      .object({
        datumKey: z.string(),
        label: z.string(),
        row: z.record(z.string(), legacyScalarSchema),
        predicate: z
          .object({
            field: z.string(),
            operator: z.literal("eq"),
            value: legacyScalarSchema,
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const legacyReferenceResolutionSchema = z
  .object({
    version: z.literal(1),
    token: z.string().regex(/^analytics-ref:v1:/),
    lineage: z.literal("legacy-client-lineage"),
    retroverified: z.literal(false),
    capsule: legacyStoredReferenceCapsuleSchema,
    message: z.literal(
      "This historical reference preserves legacy client-supplied lineage and was not retroactively verified.",
    ),
  })
  .strict();
export function decodeLegacyStoredReferenceCapsule(
  value: unknown,
): z.infer<typeof legacyReferenceResolutionSchema> {
  const capsule = legacyStoredReferenceCapsuleSchema.parse(value);
  return {
    version: 1,
    token: capsule.token,
    lineage: "legacy-client-lineage",
    retroverified: false,
    capsule,
    message:
      "This historical reference preserves legacy client-supplied lineage and was not retroactively verified.",
  };
}

export type ExecutionRecordLookup =
  | Readonly<{
      kind: "found";
      record: z.infer<typeof storedExecutionRecordSchema>;
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "expired" }>;
export type ReferencePreparationOutcome =
  | Readonly<{
      kind: "prepared";
      capsule: z.infer<typeof executionReferenceCapsuleV2Schema>;
    }>
  | Readonly<{ kind: "error"; error: z.infer<typeof executionErrorSchema> }>;
export type ReferencePreparationInput = Readonly<{
  admission: HostAdmission;
  lookup: ExecutionRecordLookup;
  locator: z.infer<typeof createExecutionReferenceRequestSchema>;
  nowMs: number;
  issuedReferenceId: string;
}>;
function referenceError(
  code: z.infer<typeof executionErrorSchema>["code"],
  retryable: boolean,
  message: string,
): ReferencePreparationOutcome {
  return { kind: "error", error: { code, retryable, message } };
}
/**
 * Pure authoritative preparation. Lookup/admission are supplied by a future
 * service, while this function proves no client row, SQL, or context is used.
 */
export function prepareExecutionReference(
  input: ReferencePreparationInput,
): ReferencePreparationOutcome {
  const locator = createExecutionReferenceRequestSchema.safeParse(
    input.locator,
  );
  const issuedId = referenceId.safeParse(input.issuedReferenceId);
  if (!locator.success || !issuedId.success)
    return referenceError(
      "invalid-request",
      false,
      "Invalid reference locator or issued reference ID.",
    );
  if (input.admission.kind === "rejected")
    return { kind: "error", error: input.admission.error };
  if (input.lookup.kind === "missing")
    return referenceError(
      "record-expired",
      false,
      "Execution record is unavailable.",
    );
  if (input.lookup.kind === "expired")
    return referenceError(
      "record-expired",
      false,
      "Execution record has expired.",
    );
  const parsedRecord = storedExecutionRecordSchema.safeParse(
    input.lookup.record,
  );
  if (!parsedRecord.success)
    return referenceError(
      "invalid-request",
      false,
      "Stored execution record is invalid.",
    );
  const record = parsedRecord.data;
  if (input.nowMs >= record.expiresAtMs)
    return referenceError(
      "record-expired",
      false,
      "Execution record has expired.",
    );
  if (locator.data.executionId !== record.result.executionId)
    return referenceError(
      "identity-mismatch",
      false,
      "Requested execution does not match retained record.",
    );
  if (
    canonicalJson(input.admission.sourceScope) !==
    canonicalJson(record.snapshot.sourceScope)
  )
    return referenceError(
      "identity-mismatch",
      false,
      "Current admission does not match retained execution scope.",
    );
  const figure = record.definition.figures.find(
    (candidate) => candidate.visualization.id === locator.data.visualizationId,
  );
  if (figure == null)
    return referenceError(
      "invalid-request",
      false,
      "Visualization is not part of the retained execution.",
    );
  const datumIndex =
    locator.data.targetDatumKey == null
      ? -1
      : record.result.result.datumKeys.indexOf(locator.data.targetDatumKey);
  if (locator.data.targetDatumKey != null && datumIndex < 0)
    return referenceError(
      "invalid-request",
      false,
      "Datum is not part of the retained execution.",
    );
  const expiresAtMs = input.nowMs + EXECUTION_LIMITS.referenceTtlMs;
  const capsule = {
    version: ANALYTICS_REFERENCE_CAPSULE_VERSION,
    referenceId: issuedId.data,
    token: "analytics-ref:v2:" + issuedId.data.slice("analytics-ref_".length),
    createdAtMs: input.nowMs,
    expiresAtMs,
    executionId: record.result.executionId,
    snapshot: record.snapshot,
    definition: record.definition,
    visualizationId: figure.visualization.id,
    parameters: record.result.resolved.query.parameters,
    resultSchema: record.result.result.columns,
    resultExtent: record.result.result.resultExtent,
    resultTruncated: record.result.result.resultTruncated,
    targetDatumKey: locator.data.targetDatumKey ?? null,
    capturedSelectedRow:
      datumIndex < 0 ? null : record.result.result.rows[datumIndex],
  };
  const parsedCapsule = executionReferenceCapsuleV2Schema.safeParse(capsule);
  return parsedCapsule.success
    ? { kind: "prepared", capsule: parsedCapsule.data }
    : referenceError(
        "invalid-request",
        false,
        "Retained execution cannot produce a valid reference.",
      );
}

/** Trusted internal handoff only: a DB path can never arise from locator/RPC input. */
export type TrustedSourceHandoff = Readonly<{
  kind: "node-sqlite-readonly" | "generation-checked-stream";
  sourceScope: z.infer<typeof sourceScopeSchema>;
  snapshotId: string;
  sourceGeneration: number;
  /**
   * Positive persisted analytics_index_state.fact_projection_version read in
   * the same trusted SQLite snapshot as generation/facts. This is distinct
   * from projectionRevision, the host-owned semantic/code revision hash.
   */
  factProjectionVersion: number;
  readonlyDatabasePath?: string;
  maxChunkBytes: number;
  maxRowsPerChunk: number;
}>;
export type ResolvedWorkerInput = Readonly<{
  resolved: z.infer<typeof resolvedExecutionSchema>;
  source: TrustedSourceHandoff;
}>;
export function assertTrustedSourceHandoff(
  handoff: TrustedSourceHandoff,
): void {
  if (
    !Number.isSafeInteger(handoff.factProjectionVersion) ||
    handoff.factProjectionVersion < 1
  ) {
    throw new Error(
      "Trusted source handoff requires a positive factProjectionVersion.",
    );
  }
}
export type ExecutionWorkerOutcome = Readonly<
  | { kind: "success"; result: z.infer<typeof executionResultSchema> }
  | { kind: "error"; error: z.infer<typeof executionErrorSchema> }
>;
export interface ExecutionSnapshotProvider {
  createSnapshot(
    input: Readonly<{
      sourceScope: z.infer<typeof sourceScopeSchema>;
      range: z.infer<typeof utcRangeSchema>;
    }>,
  ): Promise<z.infer<typeof executionSnapshotSchema>>;
}
/**
 * The resolver gates current BB shared-workspace access. It has no local
 * tenant/person model: request identity comes only from the public bb-identity
 * seam when configured, and a configured failure returns an explicit denial.
 */
export const hostAdmissionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("admitted"),
      model: z.literal("shared-high-trust-equal-information"),
      sourceScope: sourceScopeSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("rejected"), error: executionErrorSchema })
    .strict(),
]);
export type HostAdmission = z.infer<typeof hostAdmissionSchema>;
export function assertAdmissionMatchesResolved(
  admission: Extract<HostAdmission, { kind: "admitted" }>,
  input: ResolvedWorkerInput,
): void {
  assertTrustedSourceHandoff(input.source);
  if (
    canonicalJson(admission.sourceScope) !==
    canonicalJson(input.resolved.snapshot.sourceScope)
  )
    throw new Error(
      "identity-mismatch: admitted source scope differs from resolved snapshot scope.",
    );
}
export interface HostAdmissionGate {
  admit(
    requestIdentity: unknown,
    locator: z.infer<typeof executionLocatorSchema>,
  ): Promise<HostAdmission>;
}
export interface ResolvedExecutionProvider {
  resolve(
    admission: Extract<HostAdmission, { kind: "admitted" }>,
    locator: z.infer<typeof executionLocatorSchema>,
  ): Promise<ResolvedWorkerInput>;
}
/** Reparses every execution in the locked child before ResolvedExecution exists. */
export interface LockedChildQueryAdmission {
  admitQuery(
    input: z.infer<typeof queryAdmissionRequestSchema>,
    signal?: AbortSignal,
  ): Promise<QueryAdmissionOutcome>;
}
/** Every lookup and resolution receives fresh admission from the host boundary. */
export interface AuthorizedReferenceResolver {
  lookupExecution(
    admission: Extract<HostAdmission, { kind: "admitted" }>,
    executionId: string,
  ): Promise<ExecutionRecordLookup>;
  resolveReference(
    admission: Extract<HostAdmission, { kind: "admitted" }>,
    referenceId: string,
    nowMs: number,
  ): Promise<ReferencePreparationOutcome>;
}
export interface IsolatedExecutionWorker {
  execute(
    input: ResolvedWorkerInput,
    sharedJobSignal: AbortSignal,
  ): Promise<ExecutionWorkerOutcome>;
  close(): Promise<void>;
}
export interface SharedExecutionCoordinator {
  /** One caller cancellation detaches only that caller; job cancellation waits for no subscribers. */ subscribe(
    input: ResolvedWorkerInput,
    subscriberSignal: AbortSignal,
  ): Promise<ExecutionWorkerOutcome>;
}
export interface ExecutionResultRepository {
  /** Cache eviction never deletes immutable authority before expiresAtMs. */
  getExecutionRecord(
    id: string,
  ): Promise<z.infer<typeof storedExecutionRecordSchema> | null>;
  saveExecutionRecord(
    record: z.infer<typeof storedExecutionRecordSchema>,
  ): Promise<void>;
  getReference(
    id: string,
  ): Promise<z.infer<typeof executionReferenceCapsuleV2Schema> | null>;
  saveReference(
    capsule: z.infer<typeof executionReferenceCapsuleV2Schema>,
  ): Promise<void>;
}
export type ExecutionLocator = z.infer<typeof executionLocatorSchema>;
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export type ResolvedExecution = z.infer<typeof resolvedExecutionSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export type ExecutionDefinition = z.infer<typeof executionDefinitionSchema>;
export type StoredExecutionRecord = z.infer<typeof storedExecutionRecordSchema>;
export type CreateExecutionReferenceRequest = z.infer<
  typeof createExecutionReferenceRequestSchema
>;
export type ExecutionReferenceCapsuleV2 = z.infer<
  typeof executionReferenceCapsuleV2Schema
>;
