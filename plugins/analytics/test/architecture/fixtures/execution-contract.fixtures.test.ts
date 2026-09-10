import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_LIMITS,
  SELECTED_EXECUTION_RUNTIME,
  assertAdmittedQueryAttestation,
  assertQueueAdmission,
  assertTrustedSourceHandoff,
  canonicalPhysicalCacheKeyInput,
  canonicalResultWireBytes,
  canonicalScalarSchema,
  parameterDeclarationDigestInput,
  queuedResolvedDescriptorBytes,
  queryAdmissionRequestSchema,
  sqlSha256Input,
  createExecutionReferenceRequestSchema,
  createExecutionReferenceResponseSchema,
  deriveExecutionDatumKeys,
  decodeLegacyStoredReferenceCapsule,
  executeQueryResponseSchema,
  executionLocatorSchema,
  executionReferenceCapsuleV2Schema,
  hostAdmissionSchema,
  assertAdmissionMatchesResolved,
  prepareExecutionReference,
  resolvedExecutionSchema,
  storedExecutionRecordSchema,
} from "../../../execution-contract.ts";

const revision = "a".repeat(64);
const scope = {
  scopeKey: "analytics-scope_abcdefghijklmnop",
  projection: "tool_execution_fact_v1",
  storage: "plugin-owned-sqlite",
} as const;
const range = {
  startInclusiveMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_086_400_000,
} as const;
const coverage = {
  coverageRevision: 1,
  retention: {
    startInclusiveMs: 1_692_224_000_000,
    earliestVerifiedRetainedInclusiveMs: range.startInclusiveMs,
    endExclusiveMs: range.endExclusiveMs,
    policyDays: 90,
  },
  observed: {
    earliestFactMs: range.startInclusiveMs,
    latestFactMs: range.startInclusiveMs,
    asOfMs: range.endExclusiveMs,
    projectionGeneration: 7,
    projectionRevision: revision,
  },
  population: {
    candidateThreads: 200,
    selectedThreads: 80,
    loadedThreads: 80,
    retainedFacts: 1,
    cappedThreads: 0,
    listPages: 2,
    eventPages: 80,
    eventBytes: 100,
    safeFailureCount: 0,
    lastSafeFailureAtMs: null,
    candidateThreadLimit: 200,
    threadPageLimit: 200,
    eventPageLimit: 500,
    maxEventsPerThread: 500,
    maxEventBytes: 1_000,
  },
  mode: "partial-retained-projection",
  incompleteReasons: ["backfill-in-progress"],
  backfill: {
    state: "partial",
    direction: "newest-to-oldest",
    completeRange: null,
    resumable: true,
  },
  reconciliation: {
    observedAsOfMs: range.endExclusiveMs,
    lastFullReconciliationAtMs: null,
    deletionConfirmation: "pending-retry",
    sourceSemantics: "eventually-reconciled-observed-as-of",
  },
  degraded: false,
} as const;
const snapshot = {
  version: 2,
  snapshotId: "analytics-snapshot_abcdefghijklmnop",
  sourceScope: scope,
  frozenRange: range,
  capturedAtMs: range.endExclusiveMs,
  coverage,
} as const;
const parameters = [
  { name: "range_days", logicalType: "integer", value: 1 },
] as const;
const query = {
  id: "problem-tools",
  revision,
  title: "Problem tools",
  sql: "SELECT capability_key, failures FROM tool_execution_fact_v1",
  maxRows: 500,
  astNodeCount: 9,
  astPolicyRevision: revision,
  sqlSha256: revision,
  parameterDeclarationDigest: revision,
  resultContractRevision: revision,
  cacheability: "stable",
  parameters,
} as const;
const resolved = {
  version: 2,
  executionId: "analytics-exec_abcdefghijklmnop",
  snapshot,
  bundleId: "tool-reliability",
  bundleRevision: revision,
  query,
} as const;
const resolvedValue = resolvedExecutionSchema.parse(resolved);
const resultCore = {
  columns: [
    { name: "capability_key", logicalType: "utf8", nullable: false },
    { name: "failures", logicalType: "integer", nullable: false },
    { name: "failure_rate", logicalType: "float64", nullable: false },
  ],
  rows: [{ capability_key: "read_file", failures: 3, failure_rate: 12.5 }],
  datumKeys: deriveExecutionDatumKeys("analytics-exec_abcdefghijklmnop", [
    { capability_key: "read_file", failures: 3, failure_rate: 12.5 },
  ]),
  resultExtent: { kind: "exact", rows: 1 },
  resultTruncated: false,
} as const;
const result = {
  ...resultCore,
  encodedBytes: canonicalResultWireBytes(resultCore),
} as const;
const execution = {
  version: 2,
  executionId: resolved.executionId,
  resolved,
  coverage,
  result,
  startedAtMs: range.endExclusiveMs,
  completedAtMs: range.endExclusiveMs + 12,
  elapsedMs: 12,
  cache: {
    status: "miss",
    physicalExecutionKey: "analytics-physical_abcdefghijklmnop",
  },
} as const;
const definition = {
  bundle: {
    id: "tool-reliability",
    version: 1,
    revision,
    title: "Tool reliability",
    description: "Observe tool reliability.",
    loader: {
      id: "recent-capability-facts-v1",
      label: "Recent facts",
      maxAgeMs: 3_600_000,
      staleWhileRefresh: true,
    },
  },
  query,
  figures: [
    {
      visualization: {
        id: "failures",
        queryId: "problem-tools",
        kind: "bar",
        title: "Failures",
        x: "capability_key",
        y: "failures",
        format: "integer",
        layoutPosition: 0,
      },
      plotted: {
        plottedRows: 1,
        total: { kind: "exact", rows: 1 },
        reduction: "none",
      },
    },
    {
      visualization: {
        id: "failure-table",
        queryId: "problem-tools",
        kind: "table",
        title: "Failure table",
        columns: [
          { field: "capability_key", label: "Capability", format: "text" },
          { field: "failures", label: "Failures", format: "integer" },
        ],
        layoutPosition: 1,
      },
      plotted: {
        plottedRows: 1,
        total: { kind: "exact", rows: 1 },
        reduction: "none",
      },
    },
  ],
} as const;
const record = {
  version: 2,
  result: execution,
  snapshot,
  definition,
  createdAtMs: execution.completedAtMs,
  expiresAtMs: execution.completedAtMs + 86_400_000,
} as const;

test("captures immutable record, exact visualization intent, and full snapshot lineage", () => {
  assert.deepEqual(SELECTED_EXECUTION_RUNTIME.bootstrap, {
    statement: "LOAD json",
    externalAccessBeforeLoad: true,
    allowUnsignedExtensions: false,
    allowCommunityExtensions: false,
    autoinstallKnownExtensions: false,
    autoloadKnownExtensions: false,
    externalAccessAfterLoad: false,
    lockConfigurationBeforeAuthoredSql: true,
  });
  assert.doesNotThrow(() => storedExecutionRecordSchema.parse(record));
  const capsule = {
    version: 2,
    referenceId: "analytics-ref_abcdefghijklmnop",
    token: "analytics-ref:v2:abcdefghijklmnop",
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    executionId: resolved.executionId,
    snapshot,
    definition,
    visualizationId: "failures",
    parameters,
    resultSchema: result.columns,
    resultExtent: result.resultExtent,
    resultTruncated: false,
    targetDatumKey: result.datumKeys[0],
    capturedSelectedRow: result.rows[0],
  } as const;
  assert.doesNotThrow(() => executionReferenceCapsuleV2Schema.parse(capsule));
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      snapshot: {
        ...snapshot,
        frozenRange: { ...range, endExclusiveMs: range.endExclusiveMs + 1 },
      },
    }),
  );
  assert.throws(() =>
    executionReferenceCapsuleV2Schema.parse({
      ...capsule,
      capturedSelectedRow: {
        capability_key: "read_file",
        failures: "3",
        failure_rate: 12.5,
      },
    }),
  );
  assert.throws(() =>
    executionReferenceCapsuleV2Schema.parse({
      ...capsule,
      definition: {
        ...definition,
        figures: [
          {
            ...definition.figures[0],
            visualization: {
              ...definition.figures[0].visualization,
              x: "missing",
            },
          },
          definition.figures[1],
        ],
      },
    }),
  );
  assert.throws(() =>
    executionReferenceCapsuleV2Schema.parse({
      ...capsule,
      token: "analytics-ref:v2:another-record",
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      definition: {
        ...definition,
        figures: [definition.figures[0], definition.figures[0]],
      },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      definition: { ...definition, query: { ...query, sql: "SELECT 1" } },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      definition: { ...definition, query: { ...query, parameters: [] } },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      definition: {
        ...definition,
        query: { ...query, maxRows: 20, astPolicyRevision: "b".repeat(64) },
      },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      definition: {
        ...definition,
        figures: [
          definition.figures[0],
          {
            ...definition.figures[1],
            visualization: {
              ...definition.figures[1].visualization,
              columns: [{ field: "missing", label: "Missing", format: "text" }],
            },
          },
        ],
      },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      definition: {
        ...definition,
        figures: [
          {
            ...definition.figures[0],
            plotted: {
              ...definition.figures[0].plotted,
              total: { kind: "exact", rows: 9 },
            },
          },
          definition.figures[1],
        ],
      },
    }),
  );
});

test("enforces type/value, count, and measured UTF-8 byte invariants", () => {
  assert.throws(() => canonicalScalarSchema.parse("é".repeat(1_001)), /UTF-8/);
  assert.doesNotThrow(() => canonicalScalarSchema.parse(1e100));
  assert.throws(() =>
    executionLocatorSchema.parse({
      bundleId: "tool-reliability",
      queryId: "problem-tools",
      range,
      parameters: [{ name: "count", logicalType: "integer", value: 1e100 }],
    }),
  );
  assert.throws(() => canonicalScalarSchema.parse(Number.NaN));
  assert.throws(() => canonicalScalarSchema.parse(Number.POSITIVE_INFINITY));
  assert.throws(() =>
    executionLocatorSchema.parse({
      bundleId: "tool-reliability",
      queryId: "problem-tools",
      range,
      parameters: [
        { name: "flag", logicalType: "boolean", value: "not a boolean" },
      ],
    }),
  );
  assert.throws(() =>
    executionLocatorSchema.parse({
      bundleId: "tool-reliability",
      queryId: "problem-tools",
      range,
      parameters: [
        { name: "rate", logicalType: "decimal", value: "not a decimal" },
      ],
    }),
  );
  assert.doesNotThrow(() =>
    executionLocatorSchema.parse({
      bundleId: "tool-reliability",
      queryId: "problem-tools",
      range,
      parameters: [{ name: "rate", logicalType: "float64", value: 12.5 }],
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      result: {
        ...execution,
        result: {
          ...result,
          resultExtent: { kind: "exact", rows: 999 },
          encodedBytes: 0,
        },
      },
    }),
  );
  assert.equal(result.encodedBytes, canonicalResultWireBytes(resultCore));
  assert.ok(result.encodedBytes < EXECUTION_LIMITS.maxCanonicalResultBytes);
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      result: {
        ...execution,
        coverage: {
          ...coverage,
          population: { ...coverage.population, loadedThreads: 81 },
        },
      },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      result: {
        ...execution,
        coverage: {
          ...coverage,
          mode: "complete-retained-projection",
          incompleteReasons: ["backfill-in-progress"],
        },
      },
    }),
  );
  assert.throws(() =>
    storedExecutionRecordSchema.parse({
      ...record,
      snapshot: {
        ...snapshot,
        frozenRange: { ...range, startInclusiveMs: range.startInclusiveMs - 1 },
      },
    }),
  );
});

test("keeps client locators narrow and derives physical cache identity from full execution inputs", () => {
  const admissionRequest = {
    sql: query.sql,
    parameters: query.parameters,
    cacheability: query.cacheability,
  } as const;
  assert.doesNotThrow(() =>
    queryAdmissionRequestSchema.parse(admissionRequest),
  );
  assert.equal(sqlSha256Input(query.sql), query.sql);
  assert.equal(
    parameterDeclarationDigestInput([
      { name: "z", logicalType: "integer" },
      { name: "a", logicalType: "float64" },
    ]),
    parameterDeclarationDigestInput([
      { name: "a", logicalType: "float64" },
      { name: "z", logicalType: "integer" },
    ]),
  );
  assert.doesNotThrow(() =>
    assertAdmittedQueryAttestation(resolvedValue.query, {
      astPolicyRevision: query.astPolicyRevision,
      astNodeCount: query.astNodeCount,
      sqlSha256: query.sqlSha256,
      parameterDeclarationDigest: query.parameterDeclarationDigest,
      cacheability: query.cacheability,
    }),
  );
  assert.throws(() =>
    assertAdmittedQueryAttestation(resolvedValue.query, {
      astPolicyRevision: query.astPolicyRevision,
      astNodeCount: query.astNodeCount + 1,
      sqlSha256: query.sqlSha256,
      parameterDeclarationDigest: query.parameterDeclarationDigest,
      cacheability: query.cacheability,
    }),
  );
  assert.equal(EXECUTION_LIMITS.maxQueuedBytes, 4 * 1024 * 1024);
  const descriptorBytes = queuedResolvedDescriptorBytes(resolvedValue);
  assert.ok(descriptorBytes > 0);
  assert.doesNotThrow(() => assertQueueAdmission(0, 0, resolvedValue));
  assert.throws(
    () =>
      assertQueueAdmission(
        EXECUTION_LIMITS.maxQueuedExecutions,
        0,
        resolvedValue,
      ),
    /queue-full/,
  );
  assert.throws(
    () =>
      assertQueueAdmission(
        0,
        EXECUTION_LIMITS.maxQueuedBytes - descriptorBytes + 1,
        resolvedValue,
      ),
    /queue-full/,
  );
  assert.throws(() =>
    executionLocatorSchema.parse({
      bundleId: "tool-reliability",
      queryId: "problem-tools",
      range,
      parameters,
      snapshot,
    }),
  );
  assert.throws(() =>
    createExecutionReferenceRequestSchema.parse({
      executionId: resolved.executionId,
      visualizationId: "failures",
      sql: "SELECT 1",
    }),
  );
  const first = canonicalPhysicalCacheKeyInput(resolvedValue);
  const reordered = canonicalPhysicalCacheKeyInput({
    ...resolvedValue,
    query: {
      ...resolvedValue.query,
      parameters: [
        { name: "z", logicalType: "integer", value: 2 },
        { name: "a", logicalType: "integer", value: 1 },
      ],
    },
  });
  const reorderedAgain = canonicalPhysicalCacheKeyInput({
    ...resolvedValue,
    query: {
      ...resolvedValue.query,
      parameters: [
        { name: "a", logicalType: "integer", value: 1 },
        { name: "z", logicalType: "integer", value: 2 },
      ],
    },
  });
  assert.notEqual(first, reordered);
  assert.equal(
    reordered,
    reorderedAgain,
    "parameter order cannot vary physical cache identity",
  );
  assert.notEqual(
    first,
    canonicalPhysicalCacheKeyInput({
      ...resolvedValue,
      snapshot: {
        ...resolvedValue.snapshot,
        frozenRange: { ...range, endExclusiveMs: range.endExclusiveMs + 1 },
      },
    }),
  );
  assert.equal(
    canonicalPhysicalCacheKeyInput({
      ...resolvedValue,
      query: { ...resolvedValue.query, cacheability: "volatile-uncacheable" },
    }),
    null,
  );
});

test("requires explicit host admission and refuses unavailable, mismatched, or invalidated identity", () => {
  const admitted = {
    kind: "admitted",
    model: "shared-high-trust-equal-information",
    sourceScope: scope,
  } as const;
  assert.doesNotThrow(() => hostAdmissionSchema.parse(admitted));
  assert.doesNotThrow(() =>
    hostAdmissionSchema.parse({
      kind: "rejected",
      error: {
        code: "identity-unavailable",
        retryable: true,
        message: "Configured bb-identity is unavailable.",
      },
    }),
  );
  assert.doesNotThrow(() =>
    hostAdmissionSchema.parse({
      kind: "rejected",
      error: {
        code: "identity-mismatch",
        retryable: false,
        message: "Request identity no longer matches host scope.",
      },
    }),
  );
  const workerInput = {
    resolved: resolvedValue,
    source: {
      kind: "node-sqlite-readonly",
      sourceScope: { ...scope },
      snapshotId: snapshot.snapshotId,
      sourceGeneration: 7,
      factProjectionVersion: 3,
      readonlyDatabasePath: "/trusted/analytics.sqlite",
      maxChunkBytes: 1,
      maxRowsPerChunk: 1,
    },
  } as const;
  assert.doesNotThrow(() =>
    assertAdmissionMatchesResolved(admitted, workerInput),
  );
  assert.throws(
    () =>
      assertTrustedSourceHandoff({
        ...workerInput.source,
        factProjectionVersion: 0,
      }),
    /positive factProjectionVersion/,
  );
  assert.throws(
    () =>
      assertAdmissionMatchesResolved(
        {
          ...admitted,
          sourceScope: {
            ...scope,
            scopeKey: "analytics-scope_zyxwvutsrqponmlk",
          },
        },
        workerInput,
      ),
    /identity-mismatch/,
  );
  assert.throws(() =>
    hostAdmissionSchema.parse({
      kind: "admitted",
      model: "private-tenant",
      sourceScope: scope,
    }),
  );
});

test("prepares references only from admitted, current retained execution authority", () => {
  const admission = {
    kind: "admitted",
    model: "shared-high-trust-equal-information",
    sourceScope: scope,
  } as const;
  const prepared = prepareExecutionReference({
    admission,
    lookup: {
      kind: "found",
      record: storedExecutionRecordSchema.parse(record),
    },
    locator: {
      executionId: resolved.executionId,
      visualizationId: "failures",
      targetDatumKey: result.datumKeys[0],
    },
    nowMs: record.createdAtMs + 1,
    issuedReferenceId: "analytics-ref_zyxwvutsrqponmlk",
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind === "prepared") {
    assert.deepEqual(prepared.capsule.capturedSelectedRow, result.rows[0]);
    assert.equal(prepared.capsule.token, "analytics-ref:v2:zyxwvutsrqponmlk");
  }
  const common = {
    admission,
    locator: {
      executionId: resolved.executionId,
      visualizationId: "failures",
      targetDatumKey: result.datumKeys[0],
    },
    nowMs: record.createdAtMs + 1,
    issuedReferenceId: "analytics-ref_zyxwvutsrqponmlk",
  } as const;
  assert.equal(
    prepareExecutionReference({ ...common, lookup: { kind: "missing" } }).kind,
    "error",
  );
  assert.equal(
    prepareExecutionReference({ ...common, lookup: { kind: "expired" } }).kind,
    "error",
  );
  assert.equal(
    prepareExecutionReference({
      ...common,
      lookup: {
        kind: "found",
        record: storedExecutionRecordSchema.parse(record),
      },
      locator: { ...common.locator, visualizationId: "unknown" },
    }).kind,
    "error",
  );
  const nearExpiry = storedExecutionRecordSchema.parse({
    ...record,
    expiresAtMs: record.createdAtMs + 2,
  });
  const justBeforeExpiry = prepareExecutionReference({
    ...common,
    lookup: { kind: "found", record: nearExpiry },
    nowMs: nearExpiry.expiresAtMs - 1,
  });
  assert.equal(justBeforeExpiry.kind, "prepared");
  if (justBeforeExpiry.kind === "prepared") {
    assert.ok(
      justBeforeExpiry.capsule.expiresAtMs > nearExpiry.expiresAtMs,
      "a valid capture owns its independent reference retention",
    );
  }
  assert.equal(
    prepareExecutionReference({
      ...common,
      lookup: {
        kind: "found",
        record: storedExecutionRecordSchema.parse(record),
      },
      nowMs: record.expiresAtMs,
    }).kind,
    "error",
  );
  assert.equal(
    prepareExecutionReference({
      ...common,
      lookup: {
        kind: "found",
        record: storedExecutionRecordSchema.parse(record),
      },
      locator: { ...common.locator, targetDatumKey: "analytics-datum_missing" },
    }).kind,
    "error",
  );
  assert.equal(
    prepareExecutionReference({
      ...common,
      admission: {
        ...admission,
        sourceScope: { ...scope, scopeKey: "analytics-scope_zyxwvutsrqponmlk" },
      },
      lookup: {
        kind: "found",
        record: storedExecutionRecordSchema.parse(record),
      },
    }).kind,
    "error",
  );
});

test("execution-scoped datum keys rebind physical reuse and preserve duplicate occurrence identity", () => {
  const duplicateRows = [
    { label: "same", rate: 0.5 },
    { label: "same", rate: 0.5 },
  ];
  const first = deriveExecutionDatumKeys(
    "analytics-exec_abcdefghijklmnop",
    duplicateRows,
  );
  const second = deriveExecutionDatumKeys(
    "analytics-exec_zyxwvutsrqponmlk",
    duplicateRows,
  );
  assert.equal(new Set(first).size, 2);
  assert.notDeepEqual(first, second);
  assert.deepEqual(
    first,
    deriveExecutionDatumKeys("analytics-exec_abcdefghijklmnop", duplicateRows),
  );
  assert.deepEqual(
    deriveExecutionDatumKeys("analytics-exec_abcdefghijklmnop", [
      { value: "bfx6mh" },
      { value: "1nm3te9" },
    ]),
    [
      "analytics-datum_abcdefghijklmnop_0",
      "analytics-datum_abcdefghijklmnop_1",
    ],
  );
});

test("decodes the real v1 stored capsule as explicitly unverified legacy lineage", () => {
  const legacy = {
    version: 1,
    id: "legacy/id:✓",
    token: "analytics-ref:v1:历史",
    createdAt: 1.5,
    bundleId: "Tool Reliability / old",
    bundleTitle: "Tool reliability 🧪",
    queryId: "problem tools",
    queryTitle: "Problem tools",
    querySql: "SELECT failures FROM tool_execution_fact_v1",
    visualizationId: "failure chart",
    visualizationTitle: "Failures",
    visualizationKind: "bar",
    resultGeneration: "legacy-result",
    snapshotGenerationId: 1,
    snapshotUpdatedAt: 2,
    rangeDays: 14,
    coverage: { kind: "exact", rows: 1 },
    selection: {
      datumKey: "legacy datum",
      label: "read_file 🧪",
      row: { failures: 3.25 },
      predicate: {
        field: "capability key",
        operator: "eq",
        value: "read_file",
      },
    },
  };
  assert.deepEqual(decodeLegacyStoredReferenceCapsule(legacy), {
    version: 1,
    token: legacy.token,
    lineage: "legacy-client-lineage",
    retroverified: false,
    capsule: legacy,
    message:
      "This historical reference preserves legacy client-supplied lineage and was not retroactively verified.",
  });
  assert.throws(() =>
    decodeLegacyStoredReferenceCapsule({
      ...legacy,
      token: "analytics-ref:v2:not-legacy",
    }),
  );
});

test("bounds additive execution responses and rejects caller-owned query context", () => {
  const pairedSuccess = { kind: "success", result: execution, definition } as const;
  assert.equal(
    executeQueryResponseSchema.parse(pairedSuccess).kind,
    "success",
  );
  assert.throws(() =>
    executeQueryResponseSchema.parse({ kind: "success", result: execution }),
  );
  assert.throws(() =>
    executeQueryResponseSchema.parse({
      ...pairedSuccess,
      definition: { ...definition, bundle: { ...definition.bundle, revision: "b".repeat(64) } },
    }),
  );
  assert.throws(() =>
    executeQueryResponseSchema.parse({
      ...pairedSuccess,
      definition: { ...definition, query: { ...definition.query, sql: "SELECT 1" } },
    }),
  );
  assert.throws(() =>
    executeQueryResponseSchema.parse({
      ...pairedSuccess,
      definition: {
        ...definition,
        figures: [
          {
            ...definition.figures[0],
            visualization: { ...definition.figures[0].visualization, y: "missing" },
          },
          definition.figures[1],
        ],
      },
    }),
  );
  assert.throws(() =>
    executeQueryResponseSchema.parse({
      ...pairedSuccess,
      definition: {
        ...definition,
        figures: [
          {
            ...definition.figures[0],
            plotted: { ...definition.figures[0].plotted, total: { kind: "exact", rows: 9 } },
          },
          definition.figures[1],
        ],
      },
    }),
  );
  assert.equal(
    executeQueryResponseSchema.parse({
      kind: "error",
      error: { code: "query-timeout", retryable: true, message: "Timed out." },
    }).kind,
    "error",
  );

  const referenceResponse = {
    id: "analytics-ref_zyxwvutsrqponmlk",
    token: "analytics-ref:v2:zyxwvutsrqponmlk",
    label: "Failure chart",
    expiresAtMs: record.expiresAtMs,
  } as const;
  assert.doesNotThrow(() => createExecutionReferenceResponseSchema.parse(referenceResponse));
  assert.throws(() =>
    createExecutionReferenceResponseSchema.parse({
      ...referenceResponse,
      token: "analytics-ref:v2:another-record",
    }),
  );
  assert.throws(() =>
    createExecutionReferenceResponseSchema.parse({
      ...referenceResponse,
      label: "é".repeat(61),
    }),
    /UTF-8/,
  );

  const locator = {
    bundleId: "tool-reliability",
    queryId: "problem-tools",
    range,
    parameters,
  } as const;
  for (const extra of [
    { sql: "SELECT 1" },
    { sourceScope: scope },
    { rows: [{ failures: 3 }] },
  ]) {
    assert.throws(() => executionLocatorSchema.parse({ ...locator, ...extra }));
    assert.throws(() =>
      createExecutionReferenceRequestSchema.parse({
        executionId: resolved.executionId,
        visualizationId: "failures",
        ...extra,
      }),
    );
  }
});
