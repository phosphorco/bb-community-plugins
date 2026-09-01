import {
  analyticsBundleSchema,
  DEFAULT_LOADER_MAX_AGE_MS,
  type AnalyticsBundle,
} from "./bundle-contract.ts";

const loader = {
  id: "recent-capability-facts-v1" as const,
  label: "Bounded recent BB capability activity",
  maxAgeMs: DEFAULT_LOADER_MAX_AGE_MS,
  staleWhileRefresh: true,
};

export const TOOL_RELIABILITY_BUNDLE = analyticsBundleSchema.parse({
  version: 1,
  id: "tool-reliability",
  title: "Tool reliability",
  description: "Find capabilities that fail, run slowly, or are repeatedly attempted.",
  loader,
  queries: [
    {
      id: "summary",
      title: "Reliability summary",
      maxRows: 1,
      sql: `
        SELECT
          count(*)::DOUBLE AS invocations,
          100.0 * count_if(failed)::DOUBLE / greatest(count(*), 1) AS failure_rate,
          quantile_cont(duration_ms, 0.95)::DOUBLE AS p95_ms,
          count(DISTINCT capability_key)::DOUBLE AS capabilities
        FROM tool_execution_fact_v1
      `,
    },
    {
      id: "problem-tools",
      title: "Problem capabilities",
      maxRows: 50,
      sql: `
        SELECT
          capability_key,
          count(*)::DOUBLE AS invocations,
          count_if(failed)::DOUBLE AS failures,
          100.0 * count_if(failed)::DOUBLE / greatest(count(*), 1) AS failure_rate,
          quantile_cont(duration_ms, 0.95)::DOUBLE AS p95_ms,
          count(DISTINCT thread_id)::DOUBLE AS affected_threads
        FROM tool_execution_fact_v1
        GROUP BY capability_key
        ORDER BY failures DESC, p95_ms DESC
      `,
    },
    {
      id: "repeat-tools",
      title: "Repeated use",
      maxRows: 50,
      sql: `
        WITH ordered AS (
          SELECT
            capability_key,
            lag(capability_key, 1) OVER turn_order AS previous_1,
            lag(capability_key, 2) OVER turn_order AS previous_2
          FROM tool_execution_fact_v1
          WINDOW turn_order AS (PARTITION BY thread_id, turn_id ORDER BY sequence)
        )
        SELECT capability_key, count(*)::DOUBLE AS repeated_three_plus
        FROM ordered
        WHERE capability_key = previous_1 AND capability_key = previous_2
        GROUP BY capability_key
        ORDER BY repeated_three_plus DESC
      `,
    },
  ],
  visualizations: [
    { id: "invocations", queryId: "summary", kind: "metric", title: "Invocations", value: "invocations", format: "integer" },
    { id: "failure-rate", queryId: "summary", kind: "metric", title: "Failure rate", value: "failure_rate", format: "percent" },
    { id: "p95", queryId: "summary", kind: "metric", title: "p95 duration", value: "p95_ms", format: "duration" },
    { id: "capabilities", queryId: "summary", kind: "metric", title: "Capabilities seen", value: "capabilities", format: "integer" },
    { id: "failures", queryId: "problem-tools", kind: "bar", title: "Failures by capability", x: "capability_key", y: "failures", format: "integer" },
    {
      id: "problem-table",
      queryId: "problem-tools",
      kind: "table",
      title: "Problem capabilities",
      columns: [
        { field: "capability_key", label: "Capability", format: "text" },
        { field: "invocations", label: "Calls", format: "integer" },
        { field: "failures", label: "Failures", format: "integer" },
        { field: "failure_rate", label: "Rate", format: "percent" },
        { field: "p95_ms", label: "p95", format: "duration" },
        { field: "affected_threads", label: "Threads", format: "integer" }
      ],
    },
    { id: "repeats", queryId: "repeat-tools", kind: "bar", title: "Third-or-later adjacent use", x: "capability_key", y: "repeated_three_plus", format: "integer" },
  ],
  layout: [
    { visualizationId: "invocations", width: "third" },
    { visualizationId: "failure-rate", width: "third" },
    { visualizationId: "p95", width: "third" },
    { visualizationId: "capabilities", width: "third" },
    { visualizationId: "failures", width: "half" },
    { visualizationId: "repeats", width: "half" },
    { visualizationId: "problem-table", width: "full" },
  ],
});

export const PERFORMANCE_BUNDLE = analyticsBundleSchema.parse({
  version: 1,
  id: "capability-performance",
  title: "Capability performance",
  description: "Compare volume and tail latency across capability kinds over time.",
  loader,
  queries: [
    {
      id: "latency-by-kind",
      title: "Latency by kind",
      maxRows: 20,
      sql: `
        SELECT
          capability_kind,
          count(*)::DOUBLE AS invocations,
          quantile_cont(duration_ms, 0.5)::DOUBLE AS p50_ms,
          quantile_cont(duration_ms, 0.95)::DOUBLE AS p95_ms,
          quantile_cont(duration_ms, 0.99)::DOUBLE AS p99_ms
        FROM tool_execution_fact_v1
        GROUP BY capability_kind
        ORDER BY invocations DESC
      `,
    },
    {
      id: "daily-volume",
      title: "Daily volume",
      maxRows: 120,
      sql: `
        SELECT
          strftime(epoch_ms(created_at_ms), '%Y-%m-%d') AS day,
          count(*)::DOUBLE AS invocations
        FROM tool_execution_fact_v1
        GROUP BY day
        ORDER BY day
      `,
    },
  ],
  visualizations: [
    { id: "volume", queryId: "latency-by-kind", kind: "bar", title: "Invocation volume", x: "capability_kind", y: "invocations", format: "integer" },
    { id: "tail", queryId: "latency-by-kind", kind: "bar", title: "p95 duration", x: "capability_kind", y: "p95_ms", format: "duration" },
    { id: "trend", queryId: "daily-volume", kind: "line", title: "Daily capability activity", x: "day", y: "invocations", format: "integer" },
    {
      id: "latency-table",
      queryId: "latency-by-kind",
      kind: "table",
      title: "Latency distribution",
      columns: [
        { field: "capability_kind", label: "Kind", format: "text" },
        { field: "invocations", label: "Calls", format: "integer" },
        { field: "p50_ms", label: "p50", format: "duration" },
        { field: "p95_ms", label: "p95", format: "duration" },
        { field: "p99_ms", label: "p99", format: "duration" }
      ],
    },
  ],
  layout: [
    { visualizationId: "volume", width: "half" },
    { visualizationId: "tail", width: "half" },
    { visualizationId: "trend", width: "full" },
    { visualizationId: "latency-table", width: "full" },
  ],
});

export const BUILTIN_BUNDLES: readonly AnalyticsBundle[] = [
  TOOL_RELIABILITY_BUNDLE,
  PERFORMANCE_BUNDLE,
];

export function getBuiltinBundle(id: string): AnalyticsBundle | null {
  return BUILTIN_BUNDLES.find((bundle) => bundle.id === id) ?? null;
}
