export const FIXTURE_VERSION = "analytics-perf-facts-v1";
export const FIXED_AS_OF_MS = 1_700_086_400_000;
export const THREAD_COUNT = 80;
export const PERFORMANCE_QUERIES = Object.freeze({
  countSum: Object.freeze({
    id: "count-sum-v1",
    sql: "SELECT count(*) AS invocation_count, sum(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failure_count, sum(duration_ms) AS duration_sum_ms FROM tool_execution_fact_v1",
  }),
  duration: Object.freeze({
    id: "duration-sum-v1",
    sql: "SELECT sum(duration_ms) AS duration_sum_ms FROM tool_execution_fact_v1",
  }),
});

/** @returns {import('../../../../fact-projection.ts').ToolExecutionFact} */
function factAt(ordinal, appended = false, appendThread = 0) {
  const failed = !appended && ordinal % 2 === 0;
  const durationMs = appended ? 30 : failed ? 10 : 20;
  const thread = appended ? appendThread : ordinal % THREAD_COUNT;
  const createdAtMs = FIXED_AS_OF_MS - (appended ? 500 : 2_000);
  return {
    sourceEventId: `perf-event-${ordinal}`, threadId: `perf-thread-${thread}`,
    turnId: `perf-turn-${ordinal}`, sequence: ordinal + 1,
    projectId: "perf-project", providerId: "perf-provider",
    createdAtMs, turnStartedAtMs: createdAtMs - durationMs,
    turnCompletedAtMs: createdAtMs, capabilityKind: "tool", capabilityKey: "perf-tool",
    status: failed ? "failed" : "completed", durationMs, failed,
    errorClass: failed ? "tool-error" : null, errorSignature: failed ? "synthetic-error" : null,
    commandBinary: null, commandArgument1: null, commandArgument2: null,
    commandUsesHelp: false, commandShape: null, commandShellWrapped: false,
    commandAttributionEligible: false,
  };
}

/** Lazy actual ToolExecutionFact objects; no million-row allocation on import. */
export function makePerformanceDataset(factCount, changedThreads = 0) {
  if (!Number.isInteger(factCount) || factCount < 1 || factCount > 1_000_000)
    throw new Error("Performance fixture fact count is out of bounds.");
  if (!Number.isInteger(changedThreads) || changedThreads < 0 || changedThreads > THREAD_COUNT)
    throw new Error("Performance fixture changed-thread count is out of bounds.");
  const failures = Math.ceil(factCount / 2);
  const duration = failures * 10 + (factCount - failures) * 20 + changedThreads * 30;
  return Object.freeze({
    id: `perf-facts-${factCount}-append-${changedThreads}`, generator: FIXTURE_VERSION,
    seed: 7, factCount: factCount + changedThreads, baseFactCount: factCount,
    changedThreads, asOfMs: FIXED_AS_OF_MS,
    facts: function* () {
      for (let ordinal = 0; ordinal < factCount; ordinal++) yield factAt(ordinal);
      for (let thread = 0; thread < changedThreads; thread++) yield factAt(factCount + thread, true, thread);
    },
    appendedFacts: function* () {
      for (let thread = 0; thread < changedThreads; thread++) yield factAt(factCount + thread, true, thread);
    },
    // Closed-form expectations do not come from DuckDB or the binding's answer.
    expected: Object.freeze({
      countSum: [{ invocation_count: factCount + changedThreads, failure_count: failures, duration_sum_ms: duration }],
      duration: [{ duration_sum_ms: duration }],
    }),
  });
}
