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
  description: "Find capabilities that fail, run slowly, or are repeatedly attempted, including native command help lookups.",
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
    {
      id: "command-execution-summary",
      title: "Native command execution summary",
      maxRows: 1,
      sql: `
        SELECT
          count(*)::DOUBLE AS native_command_calls,
          count_if(command_uses_help)::DOUBLE AS contains_help_calls,
          count_if(failed AND command_attribution_eligible)::DOUBLE AS attributed_actual_failures,
          count_if(failed AND NOT command_attribution_eligible)::DOUBLE AS ambiguous_nonzero_executions
        FROM tool_execution_fact_v1
        WHERE capability_key = 'native:command_execution'
      `,
    },
    {
      id: "attributed-command-failures",
      title: "Attributed native command failures",
      maxRows: 24,
      sql: `
        SELECT
          command_binary
            || CASE WHEN command_argument_1 IS NULL THEN '' ELSE ' ' || command_argument_1 END
            || CASE WHEN command_argument_2 IS NULL THEN '' ELSE ' ' || command_argument_2 END AS command_signature,
          count(*)::DOUBLE AS eligible_executions,
          count_if(failed)::DOUBLE AS attributed_actual_failures
        FROM tool_execution_fact_v1
        WHERE capability_key = 'native:command_execution'
          AND command_attribution_eligible
        GROUP BY command_binary, command_argument_1, command_argument_2
        ORDER BY attributed_actual_failures DESC, eligible_executions DESC, command_signature ASC
        LIMIT 24
      `,
    },
    {
      id: "command-execution-outcomes",
      title: "Native command execution outcomes",
      maxRows: 500,
      sql: `
        WITH command_calls AS (
          SELECT
            coalesce(command_binary, '(unparsed)')
              || CASE WHEN command_argument_1 IS NULL THEN '' ELSE ' ' || command_argument_1 END
              || CASE WHEN command_argument_2 IS NULL THEN '' ELSE ' ' || command_argument_2 END AS command_signature,
            coalesce(command_binary, '(unparsed)') AS command_binary,
            coalesce(command_argument_1, '—') AS command_argument_1,
            coalesce(command_argument_2, '—') AS command_argument_2,
            CASE WHEN command_shell_wrapped
              THEN 'shell wrapper: ' || coalesce(command_shape, 'unparsed')
              ELSE coalesce(command_shape, 'unparsed')
            END AS command_shape,
            command_shell_wrapped,
            command_uses_help,
            command_attribution_eligible,
            failed
          FROM tool_execution_fact_v1
          WHERE capability_key = 'native:command_execution'
        )
        SELECT
          command_signature,
          command_binary,
          command_argument_1,
          command_argument_2,
          command_shape,
          count(*)::DOUBLE AS calls,
          count_if(command_uses_help)::DOUBLE AS contains_help_calls,
          count_if(command_attribution_eligible)::DOUBLE AS eligible_executions,
          count_if(failed AND command_attribution_eligible)::DOUBLE AS attributed_actual_failures,
          count_if(failed)::DOUBLE AS observed_failed_or_nonzero_executions,
          count_if(failed AND NOT command_attribution_eligible)::DOUBLE AS observed_not_attributed_executions,
          count_if(command_shell_wrapped)::DOUBLE AS shell_wrapped_executions,
          count_if(command_shape <> 'simple')::DOUBLE AS composite_or_unparsed_executions,
          100.0 * count_if(failed AND command_attribution_eligible)::DOUBLE
            / greatest(count_if(command_attribution_eligible), 1) AS attributed_failure_rate
        FROM command_calls
        GROUP BY command_signature, command_binary, command_argument_1, command_argument_2, command_shape
        ORDER BY calls DESC, observed_failed_or_nonzero_executions DESC, command_signature ASC
      `,
    },
    {
      id: "command-binary-volume",
      title: "Observed native command executions by binary",
      maxRows: 24,
      sql: `
        SELECT
          coalesce(command_binary, '(unparsed)') AS command_binary,
          count(*)::DOUBLE AS calls,
          count_if(command_attribution_eligible)::DOUBLE AS eligible_executions,
          count_if(failed AND command_attribution_eligible)::DOUBLE AS attributed_actual_failures,
          count_if(failed AND NOT command_attribution_eligible)::DOUBLE AS observed_not_attributed_executions
        FROM tool_execution_fact_v1
        WHERE capability_key = 'native:command_execution'
        GROUP BY command_binary
        ORDER BY calls DESC, command_binary ASC
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
    { id: "native-command-calls", queryId: "command-execution-summary", kind: "metric", title: "Native command calls", value: "native_command_calls", format: "integer" },
    { id: "native-command-help", queryId: "command-execution-summary", kind: "metric", title: "Contains --help", value: "contains_help_calls", format: "integer" },
    { id: "native-command-failures", queryId: "command-execution-summary", kind: "metric", title: "Attributed actual failures", value: "attributed_actual_failures", format: "integer" },
    { id: "native-command-ambiguous", queryId: "command-execution-summary", kind: "metric", title: "Observed, not attributed", value: "ambiguous_nonzero_executions", format: "integer" },
    { id: "native-command-failure-chart", queryId: "attributed-command-failures", kind: "bar", title: "Attributed actual failures by command signature", x: "command_signature", y: "attributed_actual_failures", format: "integer" },
    { id: "native-command-volume-chart", queryId: "command-binary-volume", kind: "bar", title: "Observed executions by binary", x: "command_binary", y: "calls", format: "integer" },
    {
      id: "native-command-outcomes-table",
      queryId: "command-execution-outcomes",
      kind: "table",
      title: "Native command execution outcomes",
      columns: [
        { field: "command_binary", label: "Binary", format: "text" },
        { field: "command_argument_2", label: "Argument 2", format: "text" },
        { field: "command_shape", label: "Context", format: "text" },
        { field: "calls", label: "Calls", format: "integer" },
        { field: "eligible_executions", label: "Eligible direct", format: "integer" },
        { field: "attributed_actual_failures", label: "Attributed failures", format: "integer" },
        { field: "attributed_failure_rate", label: "Attributed rate", format: "percent" },
        { field: "contains_help_calls", label: "Help", format: "integer" },
        { field: "observed_failed_or_nonzero_executions", label: "Observed failed/nonzero", format: "integer" },
        { field: "observed_not_attributed_executions", label: "Observed, not attributed", format: "integer" }
      ],
    },
  ],
  layout: [
    { visualizationId: "invocations", width: "third" },
    { visualizationId: "failure-rate", width: "third" },
    { visualizationId: "p95", width: "third" },
    { visualizationId: "capabilities", width: "third" },
    { visualizationId: "failures", width: "half" },
    { visualizationId: "repeats", width: "half" },
    { visualizationId: "problem-table", width: "full" },
    { visualizationId: "native-command-calls", width: "third" },
    { visualizationId: "native-command-help", width: "third" },
    { visualizationId: "native-command-failures", width: "third" },
    { visualizationId: "native-command-ambiguous", width: "third" },
    { visualizationId: "native-command-failure-chart", width: "half" },
    { visualizationId: "native-command-volume-chart", width: "half" },
    { visualizationId: "native-command-outcomes-table", width: "full" },
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

export const TURN_EFFICIENCY_BUNDLE = analyticsBundleSchema.parse({
  version: 1,
  id: "turn-efficiency",
  title: "Turn efficiency",
  description: "Measure tool-call density and turn time per tool call for fully observed completed turns. Time per call is each turn's elapsed time divided by its recorded tool calls, with the upper 5% capped before averaging.",
  loader,
  queries: [
    {
      id: "turn-summary",
      title: "Turn efficiency summary",
      maxRows: 1,
      sql: `
        WITH tool_turns AS (
          SELECT
            thread_id,
            turn_id,
            count(*)::DOUBLE AS tool_calls,
            (max(turn_completed_at_ms) - min(turn_started_at_ms))::DOUBLE AS elapsed_ms
          FROM tool_execution_fact_v1
          WHERE turn_id IS NOT NULL
            AND turn_started_at_ms IS NOT NULL
            AND turn_completed_at_ms IS NOT NULL
            AND turn_completed_at_ms >= turn_started_at_ms
          GROUP BY thread_id, turn_id
        ), bounds AS (
          SELECT quantile_cont(elapsed_ms / tool_calls, 0.95)::DOUBLE AS p95_time_per_call_ms
          FROM tool_turns
        )
        SELECT
          avg(tool_calls)::DOUBLE AS average_tool_calls_per_turn,
          avg(least(elapsed_ms / tool_calls, p95_time_per_call_ms))::DOUBLE AS p95_capped_average_ms_per_tool_call,
          quantile_cont(elapsed_ms, 0.5)::DOUBLE AS p50_turn_elapsed_ms,
          count(*)::DOUBLE AS observed_turns
        FROM tool_turns
        CROSS JOIN bounds
      `,
    },
    {
      id: "cadence-by-turn-size",
      title: "Turn cadence by tool-call count",
      maxRows: 5,
      sql: `
        WITH tool_turns AS (
          SELECT
            thread_id,
            turn_id,
            count(*)::DOUBLE AS tool_calls,
            (max(turn_completed_at_ms) - min(turn_started_at_ms))::DOUBLE AS elapsed_ms
          FROM tool_execution_fact_v1
          WHERE turn_id IS NOT NULL
            AND turn_started_at_ms IS NOT NULL
            AND turn_completed_at_ms IS NOT NULL
            AND turn_completed_at_ms >= turn_started_at_ms
          GROUP BY thread_id, turn_id
        ), bounds AS (
          SELECT quantile_cont(elapsed_ms / tool_calls, 0.95)::DOUBLE AS p95_time_per_call_ms
          FROM tool_turns
        ), bucketed_turns AS (
          SELECT
            CASE
              WHEN tool_calls = 1 THEN '1 call'
              WHEN tool_calls = 2 THEN '2 calls'
              WHEN tool_calls <= 4 THEN '3–4 calls'
              WHEN tool_calls <= 8 THEN '5–8 calls'
              ELSE '9+ calls'
            END AS tool_call_bucket,
            CASE
              WHEN tool_calls = 1 THEN 1
              WHEN tool_calls = 2 THEN 2
              WHEN tool_calls <= 4 THEN 3
              WHEN tool_calls <= 8 THEN 4
              ELSE 5
            END AS bucket_order,
            tool_calls,
            least(elapsed_ms / tool_calls, p95_time_per_call_ms) AS capped_ms_per_tool_call
          FROM tool_turns
          CROSS JOIN bounds
        )
        SELECT
          tool_call_bucket,
          count(*)::DOUBLE AS observed_turns,
          avg(tool_calls)::DOUBLE AS average_tool_calls,
          avg(capped_ms_per_tool_call)::DOUBLE AS p95_capped_average_ms_per_tool_call
        FROM bucketed_turns
        GROUP BY tool_call_bucket, bucket_order
        ORDER BY bucket_order
      `,
    },
  ],
  visualizations: [
    { id: "average-tool-calls", queryId: "turn-summary", kind: "metric", title: "Average tool calls per turn", value: "average_tool_calls_per_turn", format: "decimal" },
    { id: "average-time-per-tool-call", queryId: "turn-summary", kind: "metric", title: "P95-capped average turn time / tool call", value: "p95_capped_average_ms_per_tool_call", format: "duration" },
    { id: "median-turn-time", queryId: "turn-summary", kind: "metric", title: "Median turn elapsed time", value: "p50_turn_elapsed_ms", format: "duration" },
    { id: "observed-turns", queryId: "turn-summary", kind: "metric", title: "Fully observed tool turns", value: "observed_turns", format: "integer" },
    { id: "cadence-chart", queryId: "cadence-by-turn-size", kind: "bar", title: "P95-capped turn time per tool call by turn size", x: "tool_call_bucket", y: "p95_capped_average_ms_per_tool_call", format: "duration" },
    {
      id: "cadence-table",
      queryId: "cadence-by-turn-size",
      kind: "table",
      title: "Turn cadence by tool-call count",
      columns: [
        { field: "tool_call_bucket", label: "Tool calls", format: "text" },
        { field: "observed_turns", label: "Observed turns", format: "integer" },
        { field: "average_tool_calls", label: "Average calls", format: "decimal" },
        { field: "p95_capped_average_ms_per_tool_call", label: "P95-capped time / call", format: "duration" },
      ],
    },
  ],
  layout: [
    { visualizationId: "average-tool-calls", width: "third" },
    { visualizationId: "average-time-per-tool-call", width: "third" },
    { visualizationId: "median-turn-time", width: "third" },
    { visualizationId: "observed-turns", width: "third" },
    { visualizationId: "cadence-chart", width: "half" },
    { visualizationId: "cadence-table", width: "full" },
  ],
});

export const BUILTIN_BUNDLES: readonly AnalyticsBundle[] = [
  TOOL_RELIABILITY_BUNDLE,
  PERFORMANCE_BUNDLE,
  TURN_EFFICIENCY_BUNDLE,
];

export function getBuiltinBundle(id: string): AnalyticsBundle | null {
  return BUILTIN_BUNDLES.find((bundle) => bundle.id === id) ?? null;
}
