import assert from "node:assert/strict";
import test from "node:test";

import { TOOL_RELIABILITY_BUNDLE, TURN_EFFICIENCY_BUNDLE } from "../builtin-bundles.ts";
import { verifyAnalyticsBundle } from "../analytics-verifier.ts";

test("verifies the built-in reliability dashboard against the typed DuckDB fact contract", async () => {
  const result = await verifyAnalyticsBundle(TOOL_RELIABILITY_BUNDLE);
  assert.deepEqual(result, {
    bundleId: "tool-reliability",
    queryCount: TOOL_RELIABILITY_BUNDLE.queries.length,
    visualizationCount: TOOL_RELIABILITY_BUNDLE.visualizations.length,
  });
});

test("verifies the turn-efficiency dashboard against the typed DuckDB fact contract", async () => {
  const result = await verifyAnalyticsBundle(TURN_EFFICIENCY_BUNDLE);
  assert.deepEqual(result, {
    bundleId: "turn-efficiency",
    queryCount: TURN_EFFICIENCY_BUNDLE.queries.length,
    visualizationCount: TURN_EFFICIENCY_BUNDLE.visualizations.length,
  });
});

test("reports DuckDB binder failures before a dashboard is opened", async () => {
  const bundle = structuredClone(TOOL_RELIABILITY_BUNDLE);
  bundle.id = "invalid-count-if";
  bundle.queries = [{
    id: "broken",
    title: "Broken",
    maxRows: 1,
    sql: "SELECT count_if(command_uses_help::BIGINT)::DOUBLE AS calls FROM tool_execution_fact_v1",
  }];
  bundle.visualizations = [{
    id: "broken",
    queryId: "broken",
    kind: "metric",
    title: "Broken",
    value: "calls",
    format: "integer",
  }];
  bundle.layout = [{ visualizationId: "broken", width: "full" }];

  // The isolated runtime deliberately redacts DuckDB's raw diagnostics. Prove
  // the same query shape binds with a boolean argument before rejecting BIGINT.
  const valid = structuredClone(bundle);
  valid.queries[0]!.sql = "SELECT count_if(command_uses_help)::DOUBLE AS calls FROM tool_execution_fact_v1";
  await verifyAnalyticsBundle(valid);
  await assert.rejects(
    verifyAnalyticsBundle(bundle),
    /Query broken failed DuckDB verification: The request is outside the supported query contract\./,
  );
});
