import assert from "node:assert/strict";
import test from "node:test";

import { createAnalyticsReferenceSchema, renderAnalyticsReference, type AnalyticsReferenceCapsule } from "../analytics-reference.ts";

test("analytics references preserve query, snapshot, coverage, and selected row context", () => {
  const capsule: AnalyticsReferenceCapsule = {
    version: 1,
    id: "id",
    token: "analytics-ref:v1:id",
    createdAt: 1,
    bundleId: "tool-reliability",
    bundleTitle: "Tool reliability",
    queryId: "problem-tools",
    queryTitle: "Problem tools",
    querySql: "SELECT capability_key, count(*) AS failures FROM tool_execution_fact_v1 GROUP BY capability_key",
    visualizationId: "failures",
    visualizationTitle: "Failures",
    visualizationKind: "bar",
    resultGeneration: "result-generation",
    snapshotGenerationId: 4,
    snapshotUpdatedAt: 1_000,
    rangeDays: 14,
    coverage: { kind: "lower-bound", rows: 51 },
    selection: {
      datumKey: "datum",
      label: "read_file",
      row: { capability_key: "read_file", failures: 3 },
      predicate: { field: "capability_key", operator: "eq", value: "read_file" },
    },
  };
  const text = renderAnalyticsReference(capsule);
  assert.match(text, /DuckDB SQL:/);
  assert.match(text, /range_days=14/);
  assert.match(text, /at least 51 result rows/);
  assert.match(text, /read_file/);
  assert.match(text, /not raw tool arguments/);
});

test("reference creation input is closed and bounded", () => {
  const valid = {
    bundleId: "bundle",
    queryId: "query",
    visualizationId: "chart",
    resultGeneration: "generation",
    snapshotGenerationId: 1,
    snapshotUpdatedAt: 2,
    rangeDays: 14,
    coverage: { kind: "exact", rows: 1 },
    selection: null,
  };
  assert.doesNotThrow(() => createAnalyticsReferenceSchema.parse(valid));
  assert.throws(() => createAnalyticsReferenceSchema.parse({ ...valid, unexpected: true }), /unrecognized|Unrecognized/);
});
