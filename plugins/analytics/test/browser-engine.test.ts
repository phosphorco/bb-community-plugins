import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserQueryCache,
  normalizeQueryText,
  queryCacheKey,
  reusedQueryResult,
  type BrowserQueryResult,
} from "../browser-engine.ts";

function result(id: string, value: string): BrowserQueryResult {
  return {
    id,
    columns: ["value"],
    rows: [{ value }],
    elapsedMs: 1,
    truncated: false,
    cached: false,
  };
}

test("normalizes SQL outside quoted values without changing literal meaning", () => {
  assert.equal(
    normalizeQueryText("  SELECT  *\nFROM tool_execution_fact_v1 WHERE capability_key = 'A  B'  "),
    "select * from tool_execution_fact_v1 where capability_key = 'A  B'",
  );
  assert.notEqual(
    normalizeQueryText("SELECT * FROM tool_execution_fact_v1 WHERE capability_key = 'A B'"),
    normalizeQueryText("SELECT * FROM tool_execution_fact_v1 WHERE capability_key = 'A  B'"),
  );
  assert.equal(
    normalizeQueryText("SELECT * FROM tool_execution_fact_v1 WHERE capability_key = 'it''s  exact'"),
    "select * from tool_execution_fact_v1 where capability_key = 'it''s  exact'",
  );
});

test("cached SQL results retain the requesting bundle's local query id", () => {
  const cached = result("first-bundle-id", "42");
  const reused = reusedQueryResult(cached, "second-bundle-id");
  assert.equal(reused.id, "second-bundle-id");
  assert.equal(reused.cached, true);
  assert.deepEqual(reused.rows, cached.rows);
  assert.notEqual(reused, cached);
  assert.equal(cached.cached, false);
});

test("query keys include the generation, normalized SQL, and parameters", () => {
  const first = queryCacheKey(4, "SELECT * FROM tool_execution_fact_v1", { range_days: 14, max_rows: 100 });
  assert.equal(first, queryCacheKey(4, " select  *  from TOOL_EXECUTION_FACT_V1 ", { range_days: 14, max_rows: 100 }));
  assert.notEqual(first, queryCacheKey(5, "SELECT * FROM tool_execution_fact_v1", { range_days: 14, max_rows: 100 }));
  assert.notEqual(first, queryCacheKey(4, "SELECT * FROM tool_execution_fact_v1", { range_days: 7, max_rows: 100 }));
});

test("query cache is bounded LRU and generation invalidation is eager", () => {
  const cache = new BrowserQueryCache(2, 10_000);
  cache.setGeneration(8);
  cache.set("one", result("one", "1"));
  cache.set("two", result("two", "2"));
  assert.equal(cache.size, 2);
  assert.equal(cache.get("one")?.id, "one");
  cache.set("three", result("three", "3"));
  assert.equal(cache.get("two"), undefined);
  assert.equal(cache.get("one")?.id, "one");
  assert.equal(cache.get("three")?.id, "three");

  cache.setGeneration(9);
  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
});
