import assert from "node:assert/strict";
import test from "node:test";

import { bindAnalyticsQuery, parseAnalyticsQuery } from "../sql-policy.ts";

test("query policy traverses CTEs and nested subqueries and binds named values", () => {
  const policy = parseAnalyticsQuery(`
    WITH recent AS (
      SELECT capability_key, created_at_ms
      FROM tool_execution_fact_v1
      WHERE created_at_ms > $range_days
    )
    SELECT * FROM (SELECT * FROM recent) nested
  `);
  assert.deepEqual(policy.relations, ["tool_execution_fact_v1"]);
  assert.deepEqual(policy.parameters, ["range_days"]);
  const bound = bindAnalyticsQuery(policy);
  assert.match(bound.sql, /created_at_ms > \?/);
  assert.doesNotMatch(bound.sql, /\$range_days/);
});

test("query policy denies hidden relation paths", () => {
  assert.throws(() => parseAnalyticsQuery("SELECT * FROM tool_execution_fact_v1, secret"), /secret/);
  assert.throws(() => parseAnalyticsQuery("SELECT * FROM tool_execution_fact_v1 JOIN read_csv_auto('x') r ON true"), /curated capability|table functions/);
  assert.throws(() => parseAnalyticsQuery("SELECT * FROM main.tool_execution_fact_v1"), /qualified relation/);
  assert.throws(() => parseAnalyticsQuery("SELECT * FROM (VALUES (1)) x JOIN tool_execution_fact_v1 ON true"), /subquery/);
  assert.throws(() => parseAnalyticsQuery("SELECT * FROM tool_execution_fact_v1 WHERE x = $unknown"), /Unknown Analytics query parameter/);
});
