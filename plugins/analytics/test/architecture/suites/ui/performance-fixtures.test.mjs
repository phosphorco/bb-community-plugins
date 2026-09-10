import test from "node:test";
import assert from "node:assert/strict";
import { makePerformanceDataset, PERFORMANCE_QUERIES } from "./performance-fixtures.mjs";

test("lazy full facts agree with independent integer aggregates on bounded fixture", () => {
  const fixture = makePerformanceDataset(25, 5);
  const rows = [...fixture.facts()];
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((x) => x.sourceEventId)).size, 30);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "sourceEventId", "threadId", "turnId", "sequence", "projectId", "providerId",
    "createdAtMs", "turnStartedAtMs", "turnCompletedAtMs", "capabilityKind",
    "capabilityKey", "status", "durationMs", "failed", "errorClass", "errorSignature",
    "commandBinary", "commandArgument1", "commandArgument2", "commandUsesHelp",
    "commandShape", "commandShellWrapped", "commandAttributionEligible",
  ].sort());
  assert.deepEqual(fixture.expected.countSum, [{
    invocation_count: rows.length,
    failure_count: rows.filter((x) => x.failed).length,
    duration_sum_ms: rows.reduce((sum, x) => sum + x.durationMs, 0),
  }]);
  assert.equal(new Set([...fixture.appendedFacts()].map((x) => x.threadId)).size, 5);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[1].status, "completed");
  assert.equal(rows[0].commandShape, null);
});

test("large fixtures are lazy and bounded; SQL uses actual projection columns", () => {
  const fixture = makePerformanceDataset(1_000_000);
  assert.equal(fixture.facts().next().value.sourceEventId, "perf-event-0");
  assert.deepEqual(fixture.expected.countSum, [{ invocation_count: 1_000_000, failure_count: 500_000, duration_sum_ms: 15_000_000 }]);
  assert.match(PERFORMANCE_QUERIES.countSum.sql, /failed = 1/);
  assert.doesNotMatch(PERFORMANCE_QUERIES.countSum.sql, /outcome|event_ordinal/);
  assert.throws(() => makePerformanceDataset(1_000_001));
  assert.throws(() => makePerformanceDataset(25, 81));
});
