import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type { AnalyticsBundle } from "./bundle-contract.ts";
import type { AnalyticsReferenceCapsule } from "./analytics-reference.ts";
import type { ToolExecutionFact } from "./fact-projection.ts";
import {
  canonicalizeRetainedProjectionCheckpoint,
  canonicalizeRetainedRefRelease,
  canonicalizeRetainedStageFact,
  canonicalizeRetainedTimestampRevision,
  retainedProjectionMinimumCheckpointBytes,
  RETAINED_STAGE_HARD_LIMITS,
  RETAINED_PROJECTION_ALGORITHM,
  RETAINED_TARGET_PROJECTION_VERSION,
  type CanonicalRetainedStageFact,
  type OpenRetainedStage,
  type OpenRetainedProjectionStage,
  type RetainedProjectionCheckpoint,
  type RetainedProjectionStageBudget,
  type RetainedProjectionStagePage,
  type RetainedProjectionStageProgress,
  type RetainedProjectionFailureReason,
  type RetainedRefRelease,
  type RetainedRevisitReason,
  type RetainedStageState,
  type RetainedTimestampRevision,
  type RetainedStagePage,
  type RetainedStageProgress,
} from "./extraction/staging.ts";
import {
  candidateCursor,
  candidateDigest,
  candidateError,
  candidateIdentifier,
  candidateObservationDigest,
  candidateOperationDigest,
  candidateRollingDigest,
  MANAGED_CANDIDATE_ALGORITHM,
  MANAGED_CANDIDATE_BASELINE_FRONTIER_UNAVAILABLE,
  MANAGED_CANDIDATE_MAX_CURSOR_BYTES,
  MANAGED_CANDIDATE_MAX_DIRECTIVE_BYTES,
  MANAGED_CANDIDATE_MAX_ERROR_BYTES,
  MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES,
  MANAGED_CANDIDATE_MAX_REASON_BYTES,
  MANAGED_CANDIDATE_RESTART,
  MANAGED_CANDIDATE_ROLLING_SEED,
  MANAGED_CANDIDATE_SEAL_ROW_LIMIT,
  MANAGED_CANDIDATE_SEAL_TARGET_BYTES,
  MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
  type AdvanceManagedCandidateEpoch,
  type BindManagedCandidateMember,
  type ManagedCandidateEpochProgress,
  type ManagedCandidateMemberProgress,
  type OpenManagedCandidateEpoch,
  type PinManagedCandidateMember,
} from "./extraction/candidate-epoch.ts";

const RETAINED_ACCOUNTING_V1_FORMAT = "retained-stage-accounting-v1" as const;
const RETAINED_ACCOUNTING_V1_FINGERPRINT = "retained-stage-columns-v1-r33-p18-f5-r9-binary" as const;
const RETAINED_ACCOUNTING_V1_TRIGGER_MARKER = "retained-stage-accounting-v1" as const;
const RETAINED_ACCOUNTING_V2_FORMAT = "retained-stage-accounting-v2" as const;
const RETAINED_ACCOUNTING_V2_FINGERPRINT = "retained-stage-columns-v2-r33-p18-f5-r9-e25-m25-binary" as const;
const RETAINED_ACCOUNTING_V2_TRIGGER_MARKER = "retained-stage-accounting-v2" as const;
const RETAINED_ACCOUNTING_SCAN_ROW_LIMIT = 256 as const;
const RETAINED_ACCOUNTING_SCAN_TARGET_BYTES = 1_048_576n;
const RETAINED_ACCOUNTING_MAX_KEY_BYTES = 512;
const RETAINED_ACCOUNTING_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const RETAINED_ACCOUNTING_MIN_INT64 = -(2n ** 63n);
const RETAINED_ACCOUNTING_MAX_INT64 = (2n ** 63n) - 1n;

type RetainedAccountingColumnSpec = Readonly<{
  name: string;
  type: "TEXT" | "INTEGER";
  notnull: 0 | 1;
  pk: 0 | 1 | 2;
}>;

type RetainedAccountingTableSpec = Readonly<{
  table:
    | "analytics_retained_stage_runs"
    | "analytics_retained_stage_pages"
    | "analytics_retained_stage_facts"
    | "analytics_retained_stage_revisions"
    | "analytics_retained_candidate_epochs"
    | "analytics_retained_candidate_members";
  counter: "run_rows" | "page_rows" | "fact_rows" | "revision_rows" | "candidate_epoch_rows" | "candidate_member_rows";
  primaryKey: readonly string[];
  columns: readonly RetainedAccountingColumnSpec[];
}>;

const RETAINED_ACCOUNTING_V1_CONTROL_COLUMNS: readonly RetainedAccountingColumnSpec[] = Object.freeze([
  { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "accounting_format", type: "TEXT", notnull: 1, pk: 0 },
  { name: "inventory_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
  { name: "state", type: "TEXT", notnull: 1, pk: 0 },
  { name: "accounting_revision", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "rebuild_generation", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "scan_table", type: "TEXT", notnull: 0, pk: 0 },
  { name: "scan_run_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "scan_page", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "scan_item_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "work_run_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "work_page_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "work_fact_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "work_revision_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "work_logical_bytes", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "run_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "page_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "fact_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "revision_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "logical_bytes", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "blocked_table", type: "TEXT", notnull: 0, pk: 0 },
  { name: "blocked_key", type: "TEXT", notnull: 0, pk: 0 },
  { name: "blocked_reason", type: "TEXT", notnull: 0, pk: 0 },
]);

const RETAINED_ACCOUNTING_V2_CONTROL_COLUMNS: readonly RetainedAccountingColumnSpec[] = Object.freeze([
  ...RETAINED_ACCOUNTING_V1_CONTROL_COLUMNS,
  { name: "work_candidate_epoch_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "work_candidate_member_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "candidate_epoch_rows", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "candidate_member_rows", type: "INTEGER", notnull: 0, pk: 0 },
]);

/** Immutable v1 SQL source. Future material belongs to a new version, never a rewrite of this spec. */
const RETAINED_ACCOUNTING_V1_TABLES: readonly RetainedAccountingTableSpec[] = Object.freeze([
  Object.freeze({
    table: "analytics_retained_stage_runs",
    counter: "run_rows",
    primaryKey: Object.freeze(["run_id"]),
    columns: Object.freeze([
      { name: "run_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "epoch_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "mode", type: "TEXT", notnull: 1, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "target_projection_version", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "next_page", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "next_cursor", type: "TEXT", notnull: 0, pk: 0 },
      { name: "rows_staged", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "bytes_staged", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_observed_seq", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "max_pages", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_rows", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "started_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "last_error", type: "TEXT", notnull: 0, pk: 0 },
      { name: "algorithm_format", type: "TEXT", notnull: 1, pk: 0 },
      { name: "checkpoint_json", type: "TEXT", notnull: 0, pk: 0 },
      { name: "checkpoint_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "source_after_seq", type: "TEXT", notnull: 0, pk: 0 },
      { name: "fact_max_seq", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "revision_count", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "revision_payload_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "metadata_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "last_operation_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "terminal_reason", type: "TEXT", notnull: 0, pk: 0 },
      { name: "terminal_at", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "failure_reason", type: "TEXT", notnull: 0, pk: 0 },
      { name: "max_checkpoint_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_metadata_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_turn_states", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_timing_refs", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "max_revisions", type: "INTEGER", notnull: 1, pk: 0 },
    ] as const),
  }),
  Object.freeze({
    table: "analytics_retained_stage_pages",
    counter: "page_rows",
    primaryKey: Object.freeze(["run_id", "page"]),
    columns: Object.freeze([
      { name: "run_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "page", type: "INTEGER", notnull: 1, pk: 2 },
      { name: "cursor_in", type: "TEXT", notnull: 0, pk: 0 },
      { name: "cursor_out", type: "TEXT", notnull: 0, pk: 0 },
      { name: "rows_staged", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "bytes_staged", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "page_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "received_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "source_page_exhausted", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "source_page_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "request_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "checkpoint_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "operation_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "revision_count", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "revision_payload_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "revision_bytes_delta", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "metadata_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "ref_releases_json", type: "TEXT", notnull: 1, pk: 0 },
    ] as const),
  }),
  Object.freeze({
    table: "analytics_retained_stage_facts",
    counter: "fact_rows",
    primaryKey: Object.freeze(["run_id", "source_event_id"]),
    columns: Object.freeze([
      { name: "run_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "source_event_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "fact_json", type: "TEXT", notnull: 1, pk: 0 },
      { name: "fact_digest", type: "TEXT", notnull: 1, pk: 0 },
    ] as const),
  }),
  Object.freeze({
    table: "analytics_retained_stage_revisions",
    counter: "revision_rows",
    primaryKey: Object.freeze(["run_id", "revision_key"]),
    columns: Object.freeze([
      { name: "run_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "revision_key", type: "TEXT", notnull: 1, pk: 2 },
      { name: "source_event_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "revision_json", type: "TEXT", notnull: 1, pk: 0 },
      { name: "revision_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "expected_fact_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "resulting_fact_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "payload_bytes", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "bytes_delta", type: "INTEGER", notnull: 1, pk: 0 },
    ] as const),
  }),
]);

const RETAINED_ACCOUNTING_V2_TABLES: readonly RetainedAccountingTableSpec[] = Object.freeze([
  ...RETAINED_ACCOUNTING_V1_TABLES,
  Object.freeze({
    table: "analytics_retained_candidate_epochs",
    counter: "candidate_epoch_rows",
    primaryKey: Object.freeze(["epoch_id"]),
    columns: Object.freeze([
      { name: "epoch_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "mode", type: "TEXT", notnull: 1, pk: 0 },
      { name: "target_projection_version", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "algorithm_format", type: "TEXT", notnull: 1, pk: 0 },
      { name: "restart", type: "TEXT", notnull: 1, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "manifest_revision", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "frozen_at", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "sealed_at", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "baseline_generation_id", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "baseline_projection_version", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "baseline_source_frontier_state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "membership_count", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "membership_cursor", type: "TEXT", notnull: 0, pk: 0 },
      { name: "membership_rolling_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "membership_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "pin_cursor", type: "TEXT", notnull: 0, pk: 0 },
      { name: "pinned_count", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "pinned_rolling_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "seal_membership_rolling_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observation_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observation_quality", type: "TEXT", notnull: 0, pk: 0 },
      { name: "last_operation_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "error_text", type: "TEXT", notnull: 0, pk: 0 },
    ] as const),
  }),
  Object.freeze({
    table: "analytics_retained_candidate_members",
    counter: "candidate_member_rows",
    primaryKey: Object.freeze(["epoch_id", "thread_id"]),
    columns: Object.freeze([
      { name: "epoch_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "thread_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "run_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "member_revision", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "pin_operation_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "bound_stage_accounting_revision", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "bound_next_page", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "bound_checkpoint_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "pin_state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "outcome", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observed_next_page", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "observed_last_page_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observed_checkpoint_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observed_operation_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observed_source_after_seq", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observed_fact_max_seq", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "observed_incomplete_reasons_json", type: "TEXT", notnull: 1, pk: 0 },
      { name: "observed_rewrite_required", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "observed_rewrite_directive_json", type: "TEXT", notnull: 0, pk: 0 },
      { name: "failure_reason", type: "TEXT", notnull: 0, pk: 0 },
      { name: "terminal_reason", type: "TEXT", notnull: 0, pk: 0 },
      { name: "error_text", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observation_digest", type: "TEXT", notnull: 0, pk: 0 },
      { name: "observed_at", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "observed_stage_accounting_revision", type: "INTEGER", notnull: 0, pk: 0 },
    ] as const),
  }),
]);

const RETAINED_CANDIDATE_MEMBER_SELECT_COLUMNS = Object.freeze([
  "epoch_id",
  "thread_id",
  "run_id",
  "member_revision",
  "pin_operation_digest",
  "bound_stage_accounting_revision",
  "bound_next_page",
  "bound_checkpoint_digest",
  "pin_state",
  "outcome",
  "observed_next_page",
  "observed_last_page_digest",
  "observed_checkpoint_digest",
  "observed_operation_digest",
  "observed_source_after_seq",
  "observed_fact_max_seq",
  "observed_incomplete_reasons_json",
  "observed_rewrite_required",
  "observed_rewrite_directive_json",
  "failure_reason",
  "terminal_reason",
  "error_text",
  "observation_digest",
  "observed_at",
  "observed_stage_accounting_revision",
] as const);

function retainedCandidateMemberSelect(logicalBytes: string): string {
  return `${RETAINED_CANDIDATE_MEMBER_SELECT_COLUMNS.map((column) => `m.${column}`).join(",")},(${logicalBytes}) AS logical_row_bytes`;
}

function retainedAccountingRowBytes(alias: string, table: RetainedAccountingTableSpec): string {
  const prefix = alias.length === 0 ? "" : `${alias}.`;
  return table.columns.map((column) => column.type === "TEXT"
    ? `COALESCE(length(CAST(${prefix}${column.name} AS BLOB)),0)`
    : `COALESCE(length(CAST(${prefix}${column.name} AS TEXT)),0)`).join(" + ");
}

function retainedAccountingReadyPredicate(): string {
  return `singleton=1 AND state='ready' AND accounting_format='${RETAINED_ACCOUNTING_V1_FORMAT}' AND inventory_fingerprint='${RETAINED_ACCOUNTING_V1_FINGERPRINT}' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL`;
}

function retainedAccountingSafeTotalPredicate(expression: string): string {
  return `typeof(${expression})='integer' AND ${expression} >= 0 AND ${expression} <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER.toString()}`;
}

function retainedAccountingTrigger(table: RetainedAccountingTableSpec, operation: "INSERT" | "UPDATE" | "DELETE"): string {
  const triggerName = `${table.table}_accounting_v1_${operation.toLowerCase()}`;
  const oldBytes = retainedAccountingRowBytes("OLD", table);
  const newBytes = retainedAccountingRowBytes("NEW", table);
  const rowBytes = operation === "INSERT" ? newBytes : operation === "DELETE" ? oldBytes : `(${newBytes})`;
  const delta = operation === "INSERT" ? `(${newBytes})` : operation === "DELETE" ? `-(${oldBytes})` : `((${newBytes})-(${oldBytes}))`;
  const countDelta = operation === "INSERT" ? "+1" : operation === "DELETE" ? "-1" : "";
  const nextCount = operation === "UPDATE" ? table.counter : `(${table.counter}${countDelta})`;
  const nextBytes = `(logical_bytes+${delta})`;
  return `CREATE TRIGGER ${triggerName}
AFTER ${operation} ON ${table.table}
BEGIN
  /* ${RETAINED_ACCOUNTING_V1_TRIGGER_MARKER} */
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM analytics_retained_stage_accounting WHERE ${retainedAccountingReadyPredicate()}) THEN RAISE(ABORT,'retained stage accounting is not ready') END;
  SELECT CASE WHEN NOT (${retainedAccountingSafeTotalPredicate(rowBytes)}) THEN RAISE(ABORT,'retained stage logical-byte arithmetic overflow') END;
  UPDATE analytics_retained_stage_accounting
    SET ${table.counter}=${nextCount}, logical_bytes=${nextBytes}, accounting_revision=accounting_revision+1
    WHERE ${retainedAccountingReadyPredicate()}
      AND ${retainedAccountingSafeTotalPredicate(nextCount)}
      AND ${retainedAccountingSafeTotalPredicate(nextBytes)}
      AND typeof(accounting_revision+1)='integer' AND accounting_revision+1 >= 0;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT,'retained stage accounting update lost') END;
END`;
}

function retainedAccountingV1Migrations(): readonly string[] {
  const triggerMigrations = RETAINED_ACCOUNTING_V1_TABLES.flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => retainedAccountingTrigger(table, operation)));
  return [
    `CREATE TABLE analytics_retained_stage_accounting (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      accounting_format TEXT NOT NULL,
      inventory_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('unreconciled','rebuilding','ready','blocked')),
      accounting_revision INTEGER NOT NULL CHECK (accounting_revision >= 0),
      rebuild_generation INTEGER NOT NULL CHECK (rebuild_generation >= 0),
      scan_table TEXT,
      scan_run_id TEXT,
      scan_page INTEGER,
      scan_item_id TEXT,
      work_run_rows INTEGER CHECK (work_run_rows IS NULL OR (work_run_rows >= 0 AND work_run_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      work_page_rows INTEGER CHECK (work_page_rows IS NULL OR (work_page_rows >= 0 AND work_page_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      work_fact_rows INTEGER CHECK (work_fact_rows IS NULL OR (work_fact_rows >= 0 AND work_fact_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      work_revision_rows INTEGER CHECK (work_revision_rows IS NULL OR (work_revision_rows >= 0 AND work_revision_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      work_logical_bytes INTEGER CHECK (work_logical_bytes IS NULL OR (work_logical_bytes >= 0 AND work_logical_bytes <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      run_rows INTEGER CHECK (run_rows IS NULL OR (run_rows >= 0 AND run_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      page_rows INTEGER CHECK (page_rows IS NULL OR (page_rows >= 0 AND page_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      fact_rows INTEGER CHECK (fact_rows IS NULL OR (fact_rows >= 0 AND fact_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      revision_rows INTEGER CHECK (revision_rows IS NULL OR (revision_rows >= 0 AND revision_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      logical_bytes INTEGER CHECK (logical_bytes IS NULL OR (logical_bytes >= 0 AND logical_bytes <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
      blocked_table TEXT,
      blocked_key TEXT,
      blocked_reason TEXT
    ) STRICT`,
    `INSERT INTO analytics_retained_stage_accounting (
      singleton,accounting_format,inventory_fingerprint,state,accounting_revision,rebuild_generation
    ) VALUES (1,'${RETAINED_ACCOUNTING_V1_FORMAT}','${RETAINED_ACCOUNTING_V1_FINGERPRINT}','unreconciled',0,0)`,
    ...triggerMigrations,
  ];
}

function retainedAccountingV2ReadyPredicate(): string {
  return `singleton=1 AND state='ready' AND accounting_format='${RETAINED_ACCOUNTING_V2_FORMAT}' AND inventory_fingerprint='${RETAINED_ACCOUNTING_V2_FINGERPRINT}' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND candidate_epoch_rows IS NOT NULL AND candidate_member_rows IS NOT NULL AND logical_bytes IS NOT NULL`;
}

function retainedAccountingV2Trigger(table: RetainedAccountingTableSpec, operation: "INSERT" | "UPDATE" | "DELETE"): string {
  const triggerName = `${table.table}_accounting_v2_${operation.toLowerCase()}`;
  const oldBytes = retainedAccountingRowBytes("OLD", table);
  const newBytes = retainedAccountingRowBytes("NEW", table);
  const rowBytes = operation === "INSERT" ? newBytes : operation === "DELETE" ? oldBytes : `(${newBytes})`;
  const delta = operation === "INSERT" ? `(${newBytes})` : operation === "DELETE" ? `-(${oldBytes})` : `((${newBytes})-(${oldBytes}))`;
  const countDelta = operation === "INSERT" ? "+1" : operation === "DELETE" ? "-1" : "";
  const nextCount = operation === "UPDATE" ? table.counter : `(${table.counter}${countDelta})`;
  const nextBytes = `(logical_bytes+${delta})`;
  return `CREATE TRIGGER ${triggerName}
AFTER ${operation} ON ${table.table}
BEGIN
  /* ${RETAINED_ACCOUNTING_V2_TRIGGER_MARKER} */
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM analytics_retained_stage_accounting WHERE ${retainedAccountingV2ReadyPredicate()}) THEN RAISE(ABORT,'retained stage accounting v2 is not ready') END;
  SELECT CASE WHEN NOT (${retainedAccountingSafeTotalPredicate(rowBytes)}) THEN RAISE(ABORT,'retained stage v2 logical-byte arithmetic overflow') END;
  UPDATE analytics_retained_stage_accounting
    SET ${table.counter}=${nextCount}, logical_bytes=${nextBytes}, accounting_revision=accounting_revision+1
    WHERE ${retainedAccountingV2ReadyPredicate()}
      AND ${retainedAccountingSafeTotalPredicate(nextCount)}
      AND ${retainedAccountingSafeTotalPredicate(nextBytes)}
      AND typeof(accounting_revision+1)='integer' AND accounting_revision+1 >= 0;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT,'retained stage v2 accounting update lost') END;
END`;
}

function retainedPinnedStageGuard(table: RetainedAccountingTableSpec, operation: "INSERT" | "UPDATE" | "DELETE"): string {
  const predicate = operation === "INSERT"
    ? "m.run_id=NEW.run_id"
    : operation === "DELETE"
      ? "m.run_id=OLD.run_id"
      : "m.run_id=OLD.run_id OR m.run_id=NEW.run_id";
  return `CREATE TRIGGER ${table.table}_accounting_v2_guard_${operation.toLowerCase()}
BEFORE ${operation} ON ${table.table}
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM analytics_retained_candidate_members m
    WHERE (${predicate}) AND m.pin_state='pinned'
  ) THEN RAISE(ABORT,'retained stage run is pinned in a managed candidate') END;
END`;
}

function retainedCandidateImmutabilityGuard(table: "analytics_retained_candidate_epochs" | "analytics_retained_candidate_members", operation: "UPDATE" | "DELETE"): string {
  const predicate = table === "analytics_retained_candidate_epochs"
    ? "OLD.state='sealed'"
    : "OLD.pin_state='pinned'";
  return `CREATE TRIGGER ${table}_immutability_guard_${operation.toLowerCase()}
BEFORE ${operation} ON ${table}
BEGIN
  SELECT CASE WHEN ${predicate} THEN RAISE(ABORT,'managed candidate observation is immutable') END;
END`;
}

function retainedCandidateEpochSchema(): string {
  return `CREATE TABLE analytics_retained_candidate_epochs (
    epoch_id TEXT PRIMARY KEY NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('rewrite','upgrade')),
    target_projection_version INTEGER NOT NULL CHECK (target_projection_version = ${MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION}),
    algorithm_format TEXT NOT NULL CHECK (algorithm_format = '${MANAGED_CANDIDATE_ALGORITHM}'),
    restart TEXT NOT NULL CHECK (restart = '${MANAGED_CANDIDATE_RESTART}'),
    state TEXT NOT NULL CHECK (state IN ('open','freezing','frozen','sealing','sealed')),
    manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 0),
    created_at INTEGER NOT NULL,
    frozen_at INTEGER,
    sealed_at INTEGER,
    baseline_generation_id INTEGER NOT NULL,
    baseline_projection_version INTEGER NOT NULL,
    baseline_source_frontier_state TEXT NOT NULL CHECK (baseline_source_frontier_state = '${MANAGED_CANDIDATE_BASELINE_FRONTIER_UNAVAILABLE}'),
    membership_count INTEGER,
    membership_cursor TEXT,
    membership_rolling_digest TEXT,
    membership_digest TEXT,
    pin_cursor TEXT,
    pinned_count INTEGER,
    pinned_rolling_digest TEXT,
    seal_membership_rolling_digest TEXT,
    observation_digest TEXT,
    observation_quality TEXT CHECK (observation_quality IS NULL OR observation_quality IN ('clean','degraded')),
    last_operation_digest TEXT,
    error_text TEXT,
    CHECK (membership_count IS NULL OR (membership_count >= 0 AND membership_count <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
    CHECK (pinned_count IS NULL OR (pinned_count >= 0 AND pinned_count <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER})),
    CHECK (length(CAST(epoch_id AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES}),
    CHECK (membership_cursor IS NULL OR length(CAST(membership_cursor AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES}),
    CHECK (pin_cursor IS NULL OR length(CAST(pin_cursor AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES}),
    CHECK (membership_rolling_digest IS NULL OR length(CAST(membership_rolling_digest AS BLOB)) = 64),
    CHECK (membership_digest IS NULL OR length(CAST(membership_digest AS BLOB)) = 64),
    CHECK (pinned_rolling_digest IS NULL OR length(CAST(pinned_rolling_digest AS BLOB)) = 64),
    CHECK (seal_membership_rolling_digest IS NULL OR length(CAST(seal_membership_rolling_digest AS BLOB)) = 64),
    CHECK (observation_digest IS NULL OR length(CAST(observation_digest AS BLOB)) = 64),
    CHECK (last_operation_digest IS NULL OR length(CAST(last_operation_digest AS BLOB)) = 64),
    CHECK (error_text IS NULL OR length(CAST(error_text AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_ERROR_BYTES})
  ) STRICT`;
}

function retainedCandidateMemberSchema(): string {
  return `CREATE TABLE analytics_retained_candidate_members (
    epoch_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    member_revision INTEGER NOT NULL CHECK (member_revision >= 0),
    pin_operation_digest TEXT,
    bound_stage_accounting_revision INTEGER NOT NULL CHECK (bound_stage_accounting_revision >= 0),
    bound_next_page INTEGER NOT NULL CHECK (bound_next_page >= 0),
    bound_checkpoint_digest TEXT NOT NULL,
    pin_state TEXT NOT NULL CHECK (pin_state IN ('bound','pinned')),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('source-exhausted','failed','terminal-capped')),
    observed_next_page INTEGER,
    observed_last_page_digest TEXT,
    observed_checkpoint_digest TEXT,
    observed_operation_digest TEXT,
    observed_source_after_seq TEXT,
    observed_fact_max_seq INTEGER,
    observed_incomplete_reasons_json TEXT NOT NULL DEFAULT '[]',
    observed_rewrite_required INTEGER NOT NULL DEFAULT 0 CHECK (observed_rewrite_required IN (0,1)),
    observed_rewrite_directive_json TEXT,
    failure_reason TEXT,
    terminal_reason TEXT,
    error_text TEXT,
    observation_digest TEXT,
    observed_at INTEGER,
    observed_stage_accounting_revision INTEGER,
    PRIMARY KEY (epoch_id, thread_id),
    UNIQUE (run_id),
    CHECK (length(CAST(epoch_id AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES}),
    CHECK (length(CAST(thread_id AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES}),
    CHECK (length(CAST(run_id AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES}),
    CHECK (length(CAST(bound_checkpoint_digest AS BLOB)) = 64),
    CHECK (pin_operation_digest IS NULL OR length(CAST(pin_operation_digest AS BLOB)) = 64),
    CHECK (observed_last_page_digest IS NULL OR length(CAST(observed_last_page_digest AS BLOB)) = 64),
    CHECK (observed_checkpoint_digest IS NULL OR length(CAST(observed_checkpoint_digest AS BLOB)) = 64),
    CHECK (observed_operation_digest IS NULL OR length(CAST(observed_operation_digest AS BLOB)) = 64),
    CHECK (observed_source_after_seq IS NULL OR length(CAST(observed_source_after_seq AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_CURSOR_BYTES}),
    CHECK (length(CAST(observed_incomplete_reasons_json AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_REASON_BYTES}),
    CHECK (observed_rewrite_directive_json IS NULL OR length(CAST(observed_rewrite_directive_json AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_DIRECTIVE_BYTES}),
    CHECK (failure_reason IS NULL OR length(CAST(failure_reason AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_ERROR_BYTES}),
    CHECK (terminal_reason IS NULL OR length(CAST(terminal_reason AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_ERROR_BYTES}),
    CHECK (observation_digest IS NULL OR length(CAST(observation_digest AS BLOB)) = 64),
    CHECK (error_text IS NULL OR length(CAST(error_text AS BLOB)) <= ${MANAGED_CANDIDATE_MAX_ERROR_BYTES})
  ) STRICT`;
}

function retainedAccountingV2Migrations(): readonly string[] {
  const oldTriggerDrops = RETAINED_ACCOUNTING_V1_TABLES.flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map((operation) =>
      `DROP TRIGGER ${table.table}_accounting_v1_${operation.toLowerCase()}`));
  const v2Triggers = RETAINED_ACCOUNTING_V2_TABLES.flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => retainedAccountingV2Trigger(table, operation)));
  const pinnedGuards = RETAINED_ACCOUNTING_V1_TABLES.flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => retainedPinnedStageGuard(table, operation)));
  const candidateImmutabilityGuards = [
    retainedCandidateImmutabilityGuard("analytics_retained_candidate_epochs", "UPDATE"),
    retainedCandidateImmutabilityGuard("analytics_retained_candidate_epochs", "DELETE"),
    retainedCandidateImmutabilityGuard("analytics_retained_candidate_members", "UPDATE"),
    retainedCandidateImmutabilityGuard("analytics_retained_candidate_members", "DELETE"),
  ];
  return [
    `ALTER TABLE analytics_retained_stage_accounting ADD COLUMN work_candidate_epoch_rows INTEGER CHECK (work_candidate_epoch_rows IS NULL OR (work_candidate_epoch_rows >= 0 AND work_candidate_epoch_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER}))`,
    `ALTER TABLE analytics_retained_stage_accounting ADD COLUMN work_candidate_member_rows INTEGER CHECK (work_candidate_member_rows IS NULL OR (work_candidate_member_rows >= 0 AND work_candidate_member_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER}))`,
    `ALTER TABLE analytics_retained_stage_accounting ADD COLUMN candidate_epoch_rows INTEGER CHECK (candidate_epoch_rows IS NULL OR (candidate_epoch_rows >= 0 AND candidate_epoch_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER}))`,
    `ALTER TABLE analytics_retained_stage_accounting ADD COLUMN candidate_member_rows INTEGER CHECK (candidate_member_rows IS NULL OR (candidate_member_rows >= 0 AND candidate_member_rows <= ${RETAINED_ACCOUNTING_MAX_SAFE_INTEGER}))`,
    retainedCandidateEpochSchema(),
    retainedCandidateMemberSchema(),
    `UPDATE analytics_retained_stage_accounting SET
      accounting_format='${RETAINED_ACCOUNTING_V2_FORMAT}',
      inventory_fingerprint='${RETAINED_ACCOUNTING_V2_FINGERPRINT}',
      state=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN 'ready' ELSE 'unreconciled' END,
      scan_table=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN 'done' ELSE NULL END,
      scan_run_id=NULL,scan_page=NULL,scan_item_id=NULL,
      work_run_rows=NULL,work_page_rows=NULL,work_fact_rows=NULL,work_revision_rows=NULL,work_logical_bytes=NULL,
      work_candidate_epoch_rows=NULL,work_candidate_member_rows=NULL,
      run_rows=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN run_rows ELSE NULL END,
      page_rows=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN page_rows ELSE NULL END,
      fact_rows=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN fact_rows ELSE NULL END,
      revision_rows=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN revision_rows ELSE NULL END,
      candidate_epoch_rows=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN 0 ELSE NULL END,
      candidate_member_rows=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN 0 ELSE NULL END,
      blocked_table=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN NULL ELSE 'analytics_retained_stage_accounting' END,
      blocked_key=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN NULL ELSE 'v2-rebuild-required' END,
      blocked_reason=CASE WHEN state='ready' AND run_rows IS NOT NULL AND page_rows IS NOT NULL AND fact_rows IS NOT NULL AND revision_rows IS NOT NULL AND logical_bytes IS NOT NULL THEN NULL ELSE 'retained accounting v2 requires an explicit full rebuild' END,
      accounting_revision=accounting_revision+1
    WHERE singleton=1`,
    [...oldTriggerDrops, ...pinnedGuards, ...candidateImmutabilityGuards, ...v2Triggers].join(";\n"),
  ];
}

export const analyticsMigrations = [
  `CREATE TABLE analytics_bundles (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    source_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE analytics_index_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    status TEXT NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    loaded_threads INTEGER NOT NULL DEFAULT 0,
    fact_count INTEGER NOT NULL DEFAULT 0,
    truncated_threads INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error TEXT
  ) STRICT`,
  `INSERT INTO analytics_index_state (singleton, status) VALUES (1, 'empty')`,
  `CREATE TABLE tool_execution_facts_v1 (
    source_event_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    sequence INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    capability_kind TEXT NOT NULL,
    capability_key TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
    error_class TEXT,
    error_signature TEXT
  ) STRICT`,
  `CREATE INDEX tool_execution_facts_created_at ON tool_execution_facts_v1 (created_at_ms DESC)`,
  `CREATE INDEX tool_execution_facts_capability_created_at ON tool_execution_facts_v1 (capability_key, created_at_ms DESC)`,
  `ALTER TABLE analytics_index_state ADD COLUMN generation_id INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_index_state ADD COLUMN snapshot_updated_at INTEGER`,
  `ALTER TABLE analytics_index_state ADD COLUMN last_full_reconciliation_at INTEGER`,
  `ALTER TABLE analytics_index_state ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1))`,
  `CREATE TABLE analytics_thread_state (
    thread_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    membership INTEGER NOT NULL DEFAULT 1 CHECK (membership IN (0, 1)),
    updated_at INTEGER NOT NULL,
    max_observed_seq INTEGER,
    fact_count INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
    last_reconciled_at INTEGER NOT NULL,
    last_error TEXT
  ) STRICT`,
  `CREATE INDEX analytics_thread_state_membership_updated ON analytics_thread_state (membership, updated_at DESC)`,
  `CREATE TABLE analytics_references (
    id TEXT PRIMARY KEY NOT NULL,
    capsule_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX analytics_references_created_at ON analytics_references (created_at DESC)`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_binary TEXT`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_argument_1 TEXT`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_argument_2 TEXT`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_uses_help INTEGER NOT NULL DEFAULT 0 CHECK (command_uses_help IN (0, 1))`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_shape TEXT`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_shell_wrapped INTEGER NOT NULL DEFAULT 0 CHECK (command_shell_wrapped IN (0, 1))`,
  `ALTER TABLE analytics_index_state ADD COLUMN fact_projection_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN command_attribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK (command_attribution_eligible IN (0, 1))`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN turn_started_at_ms INTEGER`,
  `ALTER TABLE tool_execution_facts_v1 ADD COLUMN turn_completed_at_ms INTEGER`,
  `CREATE TABLE analytics_retained_stage_runs (
    run_id TEXT PRIMARY KEY NOT NULL, epoch_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('delta', 'rewrite', 'upgrade')),
    state TEXT NOT NULL CHECK (state IN ('collecting', 'failed')),
    target_projection_version INTEGER NOT NULL, next_page INTEGER NOT NULL DEFAULT 0,
    next_cursor TEXT, rows_staged INTEGER NOT NULL DEFAULT 0, bytes_staged INTEGER NOT NULL DEFAULT 0,
    max_observed_seq INTEGER, max_pages INTEGER NOT NULL, max_rows INTEGER NOT NULL,
    max_bytes INTEGER NOT NULL, started_at INTEGER NOT NULL, last_error TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX analytics_retained_stage_epoch_thread ON analytics_retained_stage_runs (epoch_id, thread_id)`,
  `CREATE TABLE analytics_retained_stage_pages (
    run_id TEXT NOT NULL, page INTEGER NOT NULL, cursor_in TEXT, cursor_out TEXT,
    rows_staged INTEGER NOT NULL, bytes_staged INTEGER NOT NULL, page_digest TEXT NOT NULL,
    received_at INTEGER NOT NULL, PRIMARY KEY (run_id, page)
  ) STRICT`,
  `CREATE TABLE analytics_retained_stage_facts (
    run_id TEXT NOT NULL, source_event_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    fact_json TEXT NOT NULL, fact_digest TEXT NOT NULL,
    PRIMARY KEY (run_id, source_event_id)
  ) STRICT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN algorithm_format TEXT NOT NULL DEFAULT 'legacy-retained-stage-v1'`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN checkpoint_json TEXT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN checkpoint_digest TEXT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN source_after_seq TEXT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN fact_max_seq INTEGER`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN revision_payload_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN metadata_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN last_operation_digest TEXT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN terminal_reason TEXT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN terminal_at INTEGER`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN failure_reason TEXT`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN source_page_exhausted INTEGER NOT NULL DEFAULT 0 CHECK (source_page_exhausted IN (0, 1))`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN source_page_digest TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN request_digest TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN checkpoint_digest TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN operation_digest TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN revision_payload_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN revision_bytes_delta INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN metadata_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_pages ADD COLUMN ref_releases_json TEXT NOT NULL DEFAULT '[]'`,
  `CREATE TABLE analytics_retained_stage_revisions (
    run_id TEXT NOT NULL, revision_key TEXT NOT NULL, source_event_id TEXT NOT NULL,
    revision_json TEXT NOT NULL, revision_digest TEXT NOT NULL,
    expected_fact_digest TEXT NOT NULL, resulting_fact_digest TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL, bytes_delta INTEGER NOT NULL,
    PRIMARY KEY (run_id, revision_key)
  ) STRICT`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_checkpoint_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_metadata_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_turn_states INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_timing_refs INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_revisions INTEGER NOT NULL DEFAULT 0`,
];

export const RETAINED_ACCOUNTING_V1_MIGRATION_START = analyticsMigrations.length;
analyticsMigrations.push(...retainedAccountingV1Migrations());
export const RETAINED_ACCOUNTING_V2_MIGRATION_START = analyticsMigrations.length;
analyticsMigrations.push(...retainedAccountingV2Migrations());

export interface AnalyticsIndexState {
  status: "empty" | "indexing" | "ready" | "error";
  startedAt: number | null;
  completedAt: number | null;
  generationId: number;
  snapshotUpdatedAt: number | null;
  lastFullReconciliationAt: number | null;
  degraded: boolean;
  lastError: string | null;
  loadedThreads: number;
  factCount: number;
  truncatedThreads: number;
  durationMs: number | null;
  error: string | null;
  factProjectionVersion: number;
}

interface IndexStateRow {
  status: AnalyticsIndexState["status"];
  started_at: number | null;
  completed_at: number | null;
  generation_id: number;
  snapshot_updated_at: number | null;
  last_full_reconciliation_at: number | null;
  degraded: number;
  loaded_threads: number;
  fact_count: number;
  truncated_threads: number;
  duration_ms: number | null;
  error: string | null;
  fact_projection_version: number;
}

export interface AnalyticsThreadState {
  threadId: string;
  projectId: string;
  providerId: string;
  membership: boolean;
  updatedAt: number;
  maxObservedSeq: number | null;
  factCount: number;
  truncated: boolean;
  lastReconciledAt: number;
  lastError: string | null;
}

interface ThreadStateRow {
  thread_id: string;
  project_id: string;
  provider_id: string;
  membership: number;
  updated_at: number;
  max_observed_seq: number | null;
  fact_count: number;
  truncated: number;
  last_reconciled_at: number;
  last_error: string | null;
}

export interface AnalyticsThreadReconciliation {
  threadId: string;
  projectId: string;
  providerId: string;
  updatedAt: number;
  outcome: "loaded" | "unchanged" | "failed";
  facts?: readonly ToolExecutionFact[];
  maxObservedSeq?: number | null;
  truncated?: boolean;
  error?: string | null;
}

export interface AnalyticsSnapshotCommit {
  completedAt: number;
  durationMs: number;
  selectedThreadIds: readonly string[];
  threads: readonly AnalyticsThreadReconciliation[];
  loadedThreads: number;
  factCount: number;
  truncatedThreads: number;
  degraded: boolean;
  lastError: string | null;
  factsChanged: boolean;
  lastFullReconciliationAt?: number | null;
  factProjectionVersion?: number;
}

export interface SnapshotFreshnessState {
  snapshotUpdatedAt: number | null;
}

const LEGACY_RETAINED_STAGE_ALGORITHM = "legacy-retained-stage-v1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectionDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid retained projection digest.");
  return value;
}

function validStageIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= RETAINED_STAGE_HARD_LIMITS.maxIdentifierBytes;
}

function validStageMode(value: unknown): value is OpenRetainedStage["mode"] {
  return value === "delta" || value === "rewrite" || value === "upgrade";
}

function readRetainedStageRow(
  db: Database.Database,
  runId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM analytics_retained_stage_runs WHERE run_id=?")
    .get(runId) as Record<string, unknown> | undefined;
}

function requireRetainedStageAlgorithm(
  row: Record<string, unknown> | undefined,
  expected: string,
): void {
  if (row != null && row.algorithm_format !== expected) {
    throw new Error(`Retained stage algorithm domain mismatch; expected ${expected}.`);
  }
}

function requireRetainedProjectionDomain(row: Record<string, unknown> | undefined): void {
  if (
    row != null
    && (
      row.algorithm_format !== RETAINED_PROJECTION_ALGORITHM
      || row.target_projection_version !== RETAINED_TARGET_PROJECTION_VERSION
    )
  ) {
    throw new Error("Retained projection stage algorithm/version domain mismatch.");
  }
}

const RETAINED_PROJECTION_FAILURE_REASONS: ReadonlySet<RetainedProjectionFailureReason> = new Set([
  "source-error",
  "aborted",
  "invalid-source",
  "degraded",
]);

function validProjectionCursor(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > RETAINED_STAGE_HARD_LIMITS.maxCursorBytes
    || !/^\d+$/.test(value)
    || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
    || BigInt(value).toString() !== value
  ) throw new Error(`Invalid retained projection ${name}.`);
  return value;
}

function projectionBudget(input: RetainedProjectionStageBudget): RetainedProjectionStageBudget {
  const values: Array<[keyof RetainedProjectionStageBudget, number, number]> = [
    ["maxPages", input.maxPages, RETAINED_STAGE_HARD_LIMITS.maxPages],
    ["maxRows", input.maxRows, RETAINED_STAGE_HARD_LIMITS.maxRows],
    ["maxBytes", input.maxBytes, RETAINED_STAGE_HARD_LIMITS.maxBytes],
    ["maxCheckpointBytes", input.maxCheckpointBytes, RETAINED_STAGE_HARD_LIMITS.maxCheckpointBytes],
    ["maxMetadataBytes", input.maxMetadataBytes, RETAINED_STAGE_HARD_LIMITS.maxMetadataBytes],
    ["maxTurnStates", input.maxTurnStates, RETAINED_STAGE_HARD_LIMITS.maxTurnStates],
    ["maxTimingRefs", input.maxTimingRefs, RETAINED_STAGE_HARD_LIMITS.maxTimingRefs],
    ["maxRevisions", input.maxRevisions, RETAINED_STAGE_HARD_LIMITS.maxRevisions],
  ];
  for (const [name, value, maximum] of values) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`Invalid retained projection budget ${name}.`);
    }
  }
  return { ...input };
}

function checkpointWithoutDigestMetadata(
  checkpoint: RetainedProjectionCheckpoint & { json?: string; bytes?: number },
): RetainedProjectionCheckpoint {
  const { json: _json, bytes: _bytes, ...plain } = checkpoint;
  return plain;
}

function initialRetainedProjectionCheckpoint(input: OpenRetainedProjectionStage): RetainedProjectionCheckpoint {
  return {
    format: "retained-fact-projection-checkpoint-v1",
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    mode: input.mode,
    runId: input.runId,
    threadId: input.threadId,
    nextStagePage: 0,
    sourceAfterSeq: null,
    maxFactSeq: null,
    turns: [],
    timingRefs: [],
    revisitReasons: [],
    rewriteRequired: false,
    rewriteDirective: null,
  };
}

function parseStoredCheckpoint(
  json: string,
  budget: RetainedProjectionStageBudget,
): { checkpoint: RetainedProjectionCheckpoint; digest: string; bytes: number } {
  const canonical = canonicalizeRetainedProjectionCheckpoint(JSON.parse(json), budget);
  const checkpoint = checkpointWithoutDigestMetadata(canonical);
  const computedDigest = sha256(canonical.json);
  return { checkpoint, digest: computedDigest, bytes: canonical.bytes };
}

interface StoredProjectionFact {
  sourceEventId: string;
  json: string;
  digest: string;
  canonical: CanonicalRetainedStageFact;
  value: ToolExecutionFact;
}

function readProjectionFacts(db: Database.Database, runId: string): Map<string, StoredProjectionFact> {
  const facts = new Map<string, StoredProjectionFact>();
  const rows = db
    .prepare("SELECT source_event_id,fact_json,fact_digest FROM analytics_retained_stage_facts WHERE run_id=?")
    .all(runId) as Array<{ source_event_id: string; fact_json: string; fact_digest: string }>;
  for (const row of rows) {
    const canonical = canonicalizeRetainedStageFact(JSON.parse(row.fact_json));
    const computedDigest = sha256(canonical.json);
    if (computedDigest !== row.fact_digest || row.source_event_id !== canonical.sourceEventId) {
      throw new Error("Corrupt retained projection fact digest.");
    }
    facts.set(row.source_event_id, {
      sourceEventId: row.source_event_id,
      json: canonical.json,
      digest: computedDigest,
      canonical,
      value: JSON.parse(canonical.json) as ToolExecutionFact,
    });
  }
  return facts;
}

function checkpointDigest(checkpoint: RetainedProjectionCheckpoint): { json: string; digest: string; bytes: number } {
  const json = JSON.stringify(checkpoint);
  return { json, digest: sha256(json), bytes: Buffer.byteLength(json, "utf8") };
}

function reasonsSuperset(
  prior: readonly RetainedRevisitReason[],
  next: readonly RetainedRevisitReason[],
): boolean {
  return prior.every((reason) => next.includes(reason));
}

function revisionPayload(
  revision: RetainedTimestampRevision,
): { json: string; digest: string; bytes: number } {
  const canonical = canonicalizeRetainedTimestampRevision(revision);
  return { json: canonical.json, digest: sha256(canonical.json), bytes: canonical.bytes };
}

export class RetainedProjectionTerminalError extends Error {
  readonly code = "retained_projection_terminal";

  constructor(readonly reason: RetainedProjectionStageProgress["terminalReason"]) {
    super(`Retained projection stage is terminally capped by ${reason}.`);
    this.name = "RetainedProjectionTerminalError";
  }
}

class RetainedProjectionBudgetError extends Error {
  readonly code = "retained_projection_budget_exceeded";

  constructor(readonly reason: NonNullable<RetainedProjectionStageProgress["terminalReason"]>) {
    super(`Retained projection ${reason} budget exhausted.`);
    this.name = "RetainedProjectionBudgetError";
  }
}

interface RetainedProjectionBudgetFence {
  page: number;
  cursor: string | null;
  checkpointDigest: string;
  threadId: string;
  mode: OpenRetainedStage["mode"];
}

export type RetainedStageAccountingState = "unreconciled" | "rebuilding" | "ready" | "blocked";
export type RetainedStageAccountingScanTable = "runs" | "pages" | "facts" | "revisions" | "candidate_epochs" | "candidate_members" | "done";

export interface RetainedStageAccountingProgress {
  state: RetainedStageAccountingState;
  accountingFormat: string;
  inventoryFingerprint: string;
  accountingRevision: bigint;
  rebuildGeneration: bigint;
  scanTable: RetainedStageAccountingScanTable | null;
  scanRunId: string | null;
  scanPage: bigint | null;
  scanItemId: string | null;
  workRunRows: bigint | null;
  workPageRows: bigint | null;
  workFactRows: bigint | null;
  workRevisionRows: bigint | null;
  workCandidateEpochRows: bigint | null;
  workCandidateMemberRows: bigint | null;
  workLogicalBytes: bigint | null;
  runRows: bigint | null;
  pageRows: bigint | null;
  factRows: bigint | null;
  revisionRows: bigint | null;
  candidateEpochRows: bigint | null;
  candidateMemberRows: bigint | null;
  logicalBytes: bigint | null;
  blockedTable: string | null;
  blockedKey: string | null;
  blockedReason: string | null;
}

export interface RetainedStageAccountingAdvanceInput {
  generation: bigint;
  expectedAccountingRevision: bigint;
}

export class AccountingNotReady extends Error {
  readonly code = "retained_stage_accounting_not_ready";

  constructor(readonly progress: RetainedStageAccountingProgress) {
    super(`Retained-stage accounting is ${progress.state}; explicit bootstrap/advance is required.`);
    this.name = "AccountingNotReady";
  }
}

export class AccountingRevisionConflict extends Error {
  readonly code = "retained_stage_accounting_revision_conflict";

  constructor() {
    super("Retained-stage accounting generation or revision is stale.");
    this.name = "AccountingRevisionConflict";
  }
}

function accountingBigInt(value: unknown, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < RETAINED_ACCOUNTING_MIN_INT64 || value > RETAINED_ACCOUNTING_MAX_INT64) {
      throw new Error(`Invalid retained-stage accounting ${name}.`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`Invalid retained-stage accounting ${name}.`);
}

function nonNegativeAccountingBigInt(value: unknown, name: string): bigint {
  const result = accountingBigInt(value, name);
  if (result < 0n) throw new Error(`Invalid retained-stage accounting ${name}.`);
  return result;
}

function safeAccountingBigInt(value: unknown, name: string): bigint {
  const result = nonNegativeAccountingBigInt(value, name);
  if (result > RETAINED_ACCOUNTING_MAX_SAFE_INTEGER) throw new Error(`Invalid retained-stage accounting ${name}.`);
  return result;
}

function nullableAccountingBigInt(value: unknown, name: string): bigint | null {
  return value == null ? null : accountingBigInt(value, name);
}

function nullableSafeAccountingBigInt(value: unknown, name: string): bigint | null {
  return value == null ? null : safeAccountingBigInt(value, name);
}

function boundedAccountingText(value: unknown, name: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > RETAINED_ACCOUNTING_MAX_KEY_BYTES) {
    throw new Error(`Invalid retained-stage accounting ${name}.`);
  }
  return value;
}

function truncateAccountingText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function decodeAccountingKeyBlob(value: unknown, name: string): string {
  if (!Buffer.isBuffer(value) || value.byteLength > RETAINED_ACCOUNTING_MAX_KEY_BYTES) {
    throw new Error(`Invalid retained-stage accounting ${name} key bytes.`);
  }
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new Error(`Invalid UTF-8 retained-stage accounting ${name} key.`);
  }
  return decoded;
}

function nextAccountingBigInt(value: bigint, name: string): bigint {
  const next = value + 1n;
  if (next < RETAINED_ACCOUNTING_MIN_INT64 || next > RETAINED_ACCOUNTING_MAX_INT64) {
    throw new Error(`Retained-stage accounting ${name} overflow.`);
  }
  return next;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function primaryIndexName(db: Database.Database, table: string): string | null {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; origin?: string }>;
  const primary = rows.find((row) => row.origin === "pk");
  return primary?.name ?? null;
}

function quotePragmaIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function candidateSafeNumber(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new Error(`Invalid managed candidate ${name}.`);
}

function candidateNullableSafeNumber(value: unknown, name: string): number | null {
  return value == null ? null : candidateSafeNumber(value, name);
}

function candidateDigestOrNull(value: unknown, name: string): string | null {
  return value == null ? null : candidateDigest(value as string, name);
}

/** Pull-based, single-flight coordination shared by all request paths. */
export class AnalyticsRefreshCoordinator<TState extends SnapshotFreshnessState> {
  private inFlight: Promise<void> | null = null;
  private readonly readState: () => TState;
  private readonly refresh: (force: boolean) => Promise<void>;
  private readonly clock: () => number;

  constructor(
    readState: () => TState,
    refresh: (force: boolean) => Promise<void>,
    clock: () => number = Date.now,
  ) {
    this.readState = readState;
    this.refresh = refresh;
    this.clock = clock;
  }

  getOrRefresh(maxAgeMs: number, force = false): TState {
    const state = this.readState();
    const stale = state.snapshotUpdatedAt == null || this.clock() - state.snapshotUpdatedAt >= maxAgeMs;
    if (force || stale) this.start(force);
    return this.readState();
  }

  async waitForRefresh(maxAgeMs: number, force = false): Promise<TState> {
    const state = this.readState();
    const stale = state.snapshotUpdatedAt == null || this.clock() - state.snapshotUpdatedAt >= maxAgeMs;
    if (force || stale) await this.start(force);
    return this.readState();
  }

  isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  private start(force: boolean): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.refresh(force);
    const tracked = run.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    void tracked.catch(() => {
      // The refresh callback owns error publication.
    });
    return tracked;
  }
}

export class AnalyticsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private rawRetainedStageAccountingRow(): Record<string, unknown> {
    const row = this.db
      .prepare("SELECT * FROM analytics_retained_stage_accounting WHERE singleton=1")
      .safeIntegers()
      .get() as Record<string, unknown> | undefined;
    if (row == null) throw new Error("Retained-stage accounting control row is missing.");
    return row;
  }

  private accountingProgress(row = this.rawRetainedStageAccountingRow()): RetainedStageAccountingProgress {
    const state = row.state;
    if (state !== "unreconciled" && state !== "rebuilding" && state !== "ready" && state !== "blocked") {
      throw new Error("Invalid retained-stage accounting state.");
    }
    const scanTable = row.scan_table;
    if (scanTable !== null && scanTable !== "runs" && scanTable !== "pages" && scanTable !== "facts" && scanTable !== "revisions" && scanTable !== "candidate_epochs" && scanTable !== "candidate_members" && scanTable !== "done") {
      throw new Error("Invalid retained-stage accounting scan table.");
    }
    const scanRunId = boundedAccountingText(row.scan_run_id, "scanRunId");
    const scanItemId = boundedAccountingText(row.scan_item_id, "scanItemId");
    const scanPage = nullableAccountingBigInt(row.scan_page, "scanPage");
    if (state === "rebuilding" && (scanTable === null || scanTable === "done")) {
      throw new Error("Invalid retained-stage accounting rebuild cursor.");
    }
    if (scanTable === "runs" && (scanPage !== null || scanItemId !== null)) {
      throw new Error("Invalid retained-stage accounting runs cursor.");
    }
    if (scanTable === "pages" && (scanPage === null ? scanRunId !== null : scanRunId === null || scanItemId !== null)) {
      throw new Error("Invalid retained-stage accounting pages cursor.");
    }
    if ((scanTable === "facts" || scanTable === "revisions" || scanTable === "candidate_epochs" || scanTable === "candidate_members") && (scanPage !== null || (scanItemId === null) !== (scanRunId === null))) {
      throw new Error("Invalid retained-stage accounting keyed cursor.");
    }
    if (scanTable === "done" && (scanRunId !== null || scanPage !== null || scanItemId !== null)) {
      throw new Error("Invalid retained-stage accounting terminal cursor.");
    }
    const publishedValues = [row.run_rows, row.page_rows, row.fact_rows, row.revision_rows, row.candidate_epoch_rows, row.candidate_member_rows, row.logical_bytes];
    const workValues = [row.work_run_rows, row.work_page_rows, row.work_fact_rows, row.work_revision_rows, row.work_candidate_epoch_rows, row.work_candidate_member_rows, row.work_logical_bytes];
    if (state === "unreconciled" && (scanTable !== null || publishedValues.some((value) => value !== null) || workValues.some((value) => value !== null))) {
      throw new Error("Invalid unreconciled retained-stage accounting progress.");
    }
    if ((state === "rebuilding" || state === "blocked") && (scanTable === null || scanTable === "done" || publishedValues.some((value) => value !== null) || workValues.some((value) => value === null))) {
      throw new Error("Invalid in-progress retained-stage accounting progress.");
    }
    if (state === "ready" && (scanTable !== "done" || publishedValues.some((value) => value === null))) {
      throw new Error("Invalid ready retained-stage accounting progress.");
    }
    return {
      state,
      accountingFormat: row.accounting_format as string,
      inventoryFingerprint: row.inventory_fingerprint as string,
      accountingRevision: nonNegativeAccountingBigInt(row.accounting_revision, "accountingRevision"),
      rebuildGeneration: nonNegativeAccountingBigInt(row.rebuild_generation, "rebuildGeneration"),
      scanTable: scanTable as RetainedStageAccountingScanTable | null,
      scanRunId,
      scanPage,
      scanItemId,
      workRunRows: nullableSafeAccountingBigInt(row.work_run_rows, "workRunRows"),
      workPageRows: nullableSafeAccountingBigInt(row.work_page_rows, "workPageRows"),
      workFactRows: nullableSafeAccountingBigInt(row.work_fact_rows, "workFactRows"),
      workRevisionRows: nullableSafeAccountingBigInt(row.work_revision_rows, "workRevisionRows"),
      workCandidateEpochRows: nullableSafeAccountingBigInt(row.work_candidate_epoch_rows, "workCandidateEpochRows"),
      workCandidateMemberRows: nullableSafeAccountingBigInt(row.work_candidate_member_rows, "workCandidateMemberRows"),
      workLogicalBytes: nullableSafeAccountingBigInt(row.work_logical_bytes, "workLogicalBytes"),
      runRows: nullableSafeAccountingBigInt(row.run_rows, "runRows"),
      pageRows: nullableSafeAccountingBigInt(row.page_rows, "pageRows"),
      factRows: nullableSafeAccountingBigInt(row.fact_rows, "factRows"),
      revisionRows: nullableSafeAccountingBigInt(row.revision_rows, "revisionRows"),
      candidateEpochRows: nullableSafeAccountingBigInt(row.candidate_epoch_rows, "candidateEpochRows"),
      candidateMemberRows: nullableSafeAccountingBigInt(row.candidate_member_rows, "candidateMemberRows"),
      logicalBytes: nullableSafeAccountingBigInt(row.logical_bytes, "logicalBytes"),
      blockedTable: boundedAccountingText(row.blocked_table, "blockedTable"),
      blockedKey: boundedAccountingText(row.blocked_key, "blockedKey"),
      blockedReason: boundedAccountingText(row.blocked_reason, "blockedReason"),
    };
  }

  private validateRetainedStageAccountingInstallation(): void {
    const nativeTables = this.db.prepare("PRAGMA main.table_list").all() as Array<{
      schema: string;
      name: string;
      type: string;
      strict: number;
    }>;
    const isStrictTable = (name: string): boolean => nativeTables.some(
      (table) => table.schema === "main" && table.name === name && table.type === "table" && table.strict === 1,
    );
    if (!isStrictTable("analytics_retained_stage_accounting")) {
      throw new Error("Retained-stage accounting control schema is missing or not STRICT.");
    }
    const controlColumns = this.db.prepare("PRAGMA table_xinfo(analytics_retained_stage_accounting)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      hidden: number;
    }>;
    if (controlColumns.length !== RETAINED_ACCOUNTING_V2_CONTROL_COLUMNS.length) {
      throw new Error("Retained-stage accounting control columns mismatch.");
    }
    for (let index = 0; index < RETAINED_ACCOUNTING_V2_CONTROL_COLUMNS.length; index += 1) {
      const actual = controlColumns[index]!;
      const expected = RETAINED_ACCOUNTING_V2_CONTROL_COLUMNS[index]!;
      if (
        actual.name !== expected.name
        || actual.type.toUpperCase() !== expected.type
        || actual.notnull !== expected.notnull
        || actual.pk !== expected.pk
        || actual.hidden !== 0
      ) throw new Error(`Retained-stage accounting control column mismatch for ${expected.name}.`);
    }
    const knownTables = new Set([
      "analytics_retained_stage_accounting",
      ...RETAINED_ACCOUNTING_V2_TABLES.map((table) => table.table),
    ]);
    const retainedTables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_retained_%'")
      .all() as Array<{ name: string }>;
    if (retainedTables.some((table) => !knownTables.has(table.name))) {
      throw new Error("Unknown retained-stage material table is not supported by accounting v2.");
    }
    for (const table of RETAINED_ACCOUNTING_V2_TABLES) {
      if (!isStrictTable(table.table)) {
        throw new Error(`Retained-stage accounting schema mismatch for ${table.table}.`);
      }
      const columns = this.db.prepare(`PRAGMA table_xinfo(${table.table})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        hidden: number;
      }>;
      if (columns.length !== table.columns.length) throw new Error(`Retained-stage accounting column mismatch for ${table.table}.`);
      for (let index = 0; index < table.columns.length; index += 1) {
        const actual = columns[index]!;
        const expected = table.columns[index]!;
        if (
          actual.name !== expected.name
          || actual.type.toUpperCase() !== expected.type
          || actual.notnull !== expected.notnull
          || actual.pk !== expected.pk
          || actual.hidden !== 0
        ) throw new Error(`Retained-stage accounting column mismatch for ${table.table}.${expected.name}.`);
      }
      const primaryIndex = primaryIndexName(this.db, table.table);
      if (primaryIndex == null) throw new Error(`Retained-stage accounting primary key is missing for ${table.table}.`);
      const indexColumns = this.db
        .prepare(`PRAGMA index_xinfo(${quotePragmaIdentifier(primaryIndex)})`)
        .all() as Array<{ seqno: number; name: string | null; coll: string | null; key: number }>;
      const actualPrimary = indexColumns
        .filter((column) => column.key === 1)
        .sort((left, right) => left.seqno - right.seqno);
      if (
        actualPrimary.length !== table.primaryKey.length
        || actualPrimary.some((column, index) => column.name !== table.primaryKey[index] || column.coll !== "BINARY")
      ) throw new Error(`Retained-stage accounting primary-key ordering mismatch for ${table.table}.`);
    }
    const epochThreadIndexes = this.db.prepare("PRAGMA index_list(analytics_retained_stage_runs)").all() as Array<{
      name: string;
      unique: number;
      origin?: string;
      partial: number;
    }>;
    const epochThreadIndex = epochThreadIndexes.find((index) => index.name === "analytics_retained_stage_epoch_thread");
    if (epochThreadIndex?.unique !== 1 || epochThreadIndex.origin !== "c" || epochThreadIndex.partial !== 0) {
      throw new Error("Retained-stage epoch/thread unique index mismatch.");
    }
    const epochThreadColumns = this.db
      .prepare(`PRAGMA index_xinfo(${quotePragmaIdentifier("analytics_retained_stage_epoch_thread")})`)
      .all() as Array<{ seqno: number; name: string | null; coll: string | null; key: number }>;
    const actualEpochThread = epochThreadColumns
      .filter((column) => column.key === 1)
      .sort((left, right) => left.seqno - right.seqno);
    if (
      actualEpochThread.length !== 2
      || actualEpochThread[0]?.name !== "epoch_id"
      || actualEpochThread[1]?.name !== "thread_id"
      || actualEpochThread.some((column) => column.coll !== "BINARY")
    ) throw new Error("Retained-stage epoch/thread unique index columns mismatch.");
    const memberRunIndexes = this.db.prepare("PRAGMA index_list(analytics_retained_candidate_members)").all() as Array<{ name: string; unique: number; origin?: string; partial: number }>;
    const memberRunIndex = memberRunIndexes.find((index) => index.unique === 1 && index.origin === "u" && index.partial === 0);
    if (memberRunIndex == null) throw new Error("Retained candidate run uniqueness index is missing.");
    const memberRunColumns = this.db
      .prepare(`PRAGMA index_xinfo(${quotePragmaIdentifier(memberRunIndex.name)})`)
      .all() as Array<{ seqno: number; name: string | null; coll: string | null; key: number }>;
    const actualMemberRun = memberRunColumns.filter((column) => column.key === 1).sort((left, right) => left.seqno - right.seqno);
    if (actualMemberRun.length !== 1 || actualMemberRun[0]?.name !== "run_id" || actualMemberRun[0]?.coll !== "BINARY") {
      throw new Error("Retained candidate run uniqueness index mismatch.");
    }
    const expectedTriggers = [
      ...RETAINED_ACCOUNTING_V1_TABLES.flatMap((table) =>
        (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => retainedPinnedStageGuard(table, operation))),
      retainedCandidateImmutabilityGuard("analytics_retained_candidate_epochs", "UPDATE"),
      retainedCandidateImmutabilityGuard("analytics_retained_candidate_epochs", "DELETE"),
      retainedCandidateImmutabilityGuard("analytics_retained_candidate_members", "UPDATE"),
      retainedCandidateImmutabilityGuard("analytics_retained_candidate_members", "DELETE"),
      ...RETAINED_ACCOUNTING_V2_TABLES.flatMap((table) =>
        (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => retainedAccountingV2Trigger(table, operation))),
    ];
    const materialTableNames = RETAINED_ACCOUNTING_V2_TABLES.map((table) => `'${table.table}'`).join(",");
    const actualTriggers = this.db
      .prepare(`SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${materialTableNames}) ORDER BY name`)
      .all() as Array<{ name: string; tbl_name: string; sql: string }>;
    const expectedByName = new Map(expectedTriggers.map((sql) => [sql.match(/^CREATE TRIGGER (\S+)/)?.[1] ?? "", sql]));
    if (actualTriggers.length !== expectedByName.size) throw new Error("Retained-stage accounting trigger count mismatch.");
    for (const actual of actualTriggers) {
      const expected = expectedByName.get(actual.name);
      if (expected == null || normalizeSql(actual.sql) !== normalizeSql(expected)) {
        throw new Error(`Retained-stage accounting trigger mismatch for ${actual.name}.`);
      }
    }
    const row = this.rawRetainedStageAccountingRow();
    if (row.accounting_format !== RETAINED_ACCOUNTING_V2_FORMAT || row.inventory_fingerprint !== RETAINED_ACCOUNTING_V2_FINGERPRINT) {
      throw new Error("Retained-stage accounting v2 format or inventory fingerprint mismatch.");
    }
  }

  readRetainedStageAccounting(): RetainedStageAccountingProgress {
    this.validateRetainedStageAccountingInstallation();
    return this.accountingProgress();
  }

  private ensureRetainedStageAccountingReady(): void {
    this.validateRetainedStageAccountingInstallation();
    const row = this.rawRetainedStageAccountingRow();
    if (row.state === "ready") return;
    throw new AccountingNotReady(this.accountingProgress(row));
  }

  private prepareRetainedStageAccountingOnce(): void {
    this.validateRetainedStageAccountingInstallation();
    const row = this.rawRetainedStageAccountingRow();
    if (row.state === "ready") return;
    if (row.state !== "unreconciled") throw new AccountingNotReady(this.accountingProgress(row));
    const populated = RETAINED_ACCOUNTING_V2_TABLES.some((table) => {
      const result = this.db.prepare(`SELECT 1 AS present FROM ${table.table} LIMIT 1`).get() as { present: number } | undefined;
      return result != null;
    });
    if (populated) throw new AccountingNotReady(this.accountingProgress(row));
    const revision = nonNegativeAccountingBigInt(row.accounting_revision, "accountingRevision");
    const result = this.db
      .prepare(`UPDATE analytics_retained_stage_accounting SET state='ready',scan_table='done',run_rows=0,page_rows=0,fact_rows=0,revision_rows=0,candidate_epoch_rows=0,candidate_member_rows=0,logical_bytes=0,blocked_table=NULL,blocked_key=NULL,blocked_reason=NULL,accounting_revision=? WHERE singleton=1 AND state='unreconciled' AND accounting_revision=?`)
      .run(nextAccountingBigInt(revision, "accountingRevision"), revision);
    if (result.changes !== 1) throw new AccountingRevisionConflict();
  }

  bootstrapRetainedStageAccounting(): RetainedStageAccountingProgress {
    this.validateRetainedStageAccountingInstallation();
    this.db.transaction(() => {
      const row = this.rawRetainedStageAccountingRow();
      const state = row.state;
      if (state === "ready" || state === "rebuilding" || state === "blocked") return;
      const revision = nonNegativeAccountingBigInt(row.accounting_revision, "accountingRevision");
      const generation = nonNegativeAccountingBigInt(row.rebuild_generation, "rebuildGeneration");
      const populated = RETAINED_ACCOUNTING_V2_TABLES.some((table) => this.db.prepare(`SELECT 1 AS present FROM ${table.table} LIMIT 1`).get() != null);
      const nextState = populated ? "rebuilding" : "ready";
      const result = this.db.prepare(`UPDATE analytics_retained_stage_accounting SET
        state=?,scan_table=?,scan_run_id=NULL,scan_page=NULL,scan_item_id=NULL,blocked_table=NULL,blocked_key=NULL,blocked_reason=NULL,
        work_run_rows=?,work_page_rows=?,work_fact_rows=?,work_revision_rows=?,work_candidate_epoch_rows=?,work_candidate_member_rows=?,work_logical_bytes=?,
        run_rows=?,page_rows=?,fact_rows=?,revision_rows=?,candidate_epoch_rows=?,candidate_member_rows=?,logical_bytes=?,
        accounting_revision=?,rebuild_generation=?
        WHERE singleton=1 AND state='unreconciled' AND accounting_revision=?`)
        .run(
          nextState,
          populated ? "runs" : "done",
          populated ? 0n : null,
          populated ? 0n : null,
          populated ? 0n : null,
          populated ? 0n : null,
          populated ? 0n : null,
          populated ? 0n : null,
          populated ? 0n : null,
          populated ? null : 0n,
          populated ? null : 0n,
          populated ? null : 0n,
          populated ? null : 0n,
          populated ? null : 0n,
          populated ? null : 0n,
          populated ? null : 0n,
          nextAccountingBigInt(revision, "accountingRevision"),
          populated ? nextAccountingBigInt(generation, "rebuildGeneration") : generation,
          revision,
        );
      if (result.changes !== 1) throw new AccountingRevisionConflict();
    })();
    return this.readRetainedStageAccounting();
  }

  private accountingScanWhere(progress: RetainedStageAccountingProgress, table: RetainedAccountingTableSpec): { sql: string; params: unknown[] } {
    if (progress.scanTable === "runs") {
      if (progress.scanRunId == null) return { sql: "", params: [] };
      return { sql: " WHERE run_id COLLATE BINARY > ?", params: [progress.scanRunId] };
    }
    if (progress.scanTable === "pages" || progress.scanTable === "facts" || progress.scanTable === "revisions" || progress.scanTable === "candidate_epochs" || progress.scanTable === "candidate_members") {
      if (progress.scanRunId == null) return { sql: "", params: [] };
      const firstKey = table.primaryKey[0]!;
      if (table.primaryKey.length === 2 && table.primaryKey[1] === "page") {
        return {
          sql: ` WHERE ${firstKey} COLLATE BINARY > ? OR (${firstKey} COLLATE BINARY = ? AND page > ?)`,
          params: [progress.scanRunId, progress.scanRunId, progress.scanPage],
        };
      }
      if (table.primaryKey.length === 1) {
        return { sql: ` WHERE ${firstKey} COLLATE BINARY > ?`, params: [progress.scanRunId] };
      }
      const item = table.primaryKey[1]!;
      return {
        sql: ` WHERE ${firstKey} COLLATE BINARY > ? OR (${firstKey} COLLATE BINARY = ? AND ${item} COLLATE BINARY > ?)`,
        params: [progress.scanRunId, progress.scanRunId, progress.scanItemId],
      };
    }
    return { sql: "", params: [] };
  }

  private accountingScanCandidates(table: RetainedAccountingTableSpec, progress: RetainedStageAccountingProgress): Array<Record<string, unknown>> {
    const where = this.accountingScanWhere(progress, table);
    const keySelection = table.primaryKey.flatMap((key, index) => [
      `typeof(${key}) AS key_${index}_type`,
      `typeof(COALESCE(length(CAST(${key} AS BLOB)),0)) AS key_${index}_bytes_type`,
      `COALESCE(length(CAST(${key} AS BLOB)),0) AS key_${index}_bytes`,
    ]).join(",");
    const order = table.primaryKey.map((key) => `${key} COLLATE BINARY`).join(",");
    const rowBytes = retainedAccountingRowBytes("", table);
    const statement = this.db.prepare(`SELECT rowid AS scan_rowid,${keySelection},typeof(${rowBytes}) AS row_bytes_type,(${rowBytes}) AS row_bytes FROM ${table.table}${where.sql} ORDER BY ${order} LIMIT ${RETAINED_ACCOUNTING_SCAN_ROW_LIMIT}`).safeIntegers();
    return statement.all(...where.params) as Array<Record<string, unknown>>;
  }

  private accountingBlock(
    row: Record<string, unknown>,
    table: RetainedAccountingTableSpec,
    rowId: bigint,
    reason: string,
  ): void {
    const generation = accountingBigInt(row.rebuild_generation, "rebuildGeneration");
    const revision = accountingBigInt(row.accounting_revision, "accountingRevision");
    const result = this.db.prepare(`UPDATE analytics_retained_stage_accounting
      SET state='blocked',blocked_table=?,blocked_key=?,blocked_reason=?,accounting_revision=?
      WHERE singleton=1 AND state='rebuilding' AND rebuild_generation=? AND accounting_revision=?`)
      .run(
        table.table,
        `rowid:${rowId.toString()}`,
        truncateAccountingText(reason, RETAINED_ACCOUNTING_MAX_KEY_BYTES),
        nextAccountingBigInt(revision, "accountingRevision"),
        generation,
        revision,
      );
    if (result.changes !== 1) throw new AccountingRevisionConflict();
  }

  private accountingKeyForRow(table: RetainedAccountingTableSpec, rowId: bigint): {
    runId: string;
    page: bigint | null;
    itemId: string | null;
  } | { invalidReason: string } {
    const firstKey = table.primaryKey[0]!;
    const keySelections = [
      `length(CAST(${firstKey} AS BLOB)) AS run_id_key_length`,
      `substr(CAST(${firstKey} AS BLOB),1,${RETAINED_ACCOUNTING_MAX_KEY_BYTES + 1}) AS run_id_key_blob`,
    ];
    if (table.primaryKey[1] === "page") keySelections.push("page");
    else if (table.primaryKey[1] != null) {
      const itemName = table.primaryKey[1];
      keySelections.push(
        `length(CAST(${itemName} AS BLOB)) AS item_key_length`,
        `substr(CAST(${itemName} AS BLOB),1,${RETAINED_ACCOUNTING_MAX_KEY_BYTES + 1}) AS item_key_blob`,
      );
    }
    const row = this.db
      .prepare(`SELECT ${keySelections.join(",")} FROM ${table.table} WHERE rowid=?`)
      .safeIntegers()
      .get(rowId) as Record<string, unknown> | undefined;
    if (row == null) throw new Error("Retained-stage accounting scan row disappeared.");
    const runLength = accountingBigInt(row.run_id_key_length, "runIdKeyLength");
    if (runLength > BigInt(RETAINED_ACCOUNTING_MAX_KEY_BYTES)) return { invalidReason: "primary-key run_id exceeds bounded UTF-8 bytes after preflight" };
    let runId: string;
    try {
      runId = decodeAccountingKeyBlob(row.run_id_key_blob, "run_id");
    } catch (error) {
      return { invalidReason: error instanceof Error ? error.message : "primary-key run_id has invalid UTF-8" };
    }
    if (BigInt(Buffer.byteLength(runId, "utf8")) !== runLength) return { invalidReason: "primary-key run_id changed after byte preflight" };
    if (table.primaryKey[1] === "page") {
      const page = row.page;
      if (typeof page !== "bigint" || page < RETAINED_ACCOUNTING_MIN_INT64 || page > RETAINED_ACCOUNTING_MAX_INT64) {
        return { invalidReason: "primary-key page is outside signed SQLite integer range" };
      }
      return { runId, page, itemId: null };
    }
    const itemName = table.primaryKey[1];
    if (itemName == null) return { runId, page: null, itemId: null };
    const itemLength = accountingBigInt(row.item_key_length, "itemKeyLength");
    if (itemLength > BigInt(RETAINED_ACCOUNTING_MAX_KEY_BYTES)) return { invalidReason: `primary-key ${itemName} exceeds bounded UTF-8 bytes after preflight` };
    let itemId: string;
    try {
      itemId = decodeAccountingKeyBlob(row.item_key_blob, itemName);
    } catch (error) {
      return { invalidReason: error instanceof Error ? error.message : `primary-key ${itemName} has invalid UTF-8` };
    }
    if (BigInt(Buffer.byteLength(itemId, "utf8")) !== itemLength) return { invalidReason: `primary-key ${itemName} changed after byte preflight` };
    return { runId, page: null, itemId };
  }

  private accountingAdvanceCursor(table: RetainedAccountingTableSpec, key: {
    runId: string;
    page: bigint | null;
    itemId: string | null;
  }): { scanRunId: string; scanPage: bigint | null; scanItemId: string | null } {
    return { scanRunId: key.runId, scanPage: table.primaryKey[1] === "page" ? key.page : null, scanItemId: table.primaryKey[1] === "page" ? null : key.itemId };
  }

  advanceRetainedStageAccounting(input: RetainedStageAccountingAdvanceInput): RetainedStageAccountingProgress {
    this.validateRetainedStageAccountingInstallation();
    const generation = accountingBigInt(input.generation, "generation");
    const expectedRevision = accountingBigInt(input.expectedAccountingRevision, "expectedAccountingRevision");
    this.db.transaction(() => {
      const row = this.rawRetainedStageAccountingRow();
      const currentGeneration = nonNegativeAccountingBigInt(row.rebuild_generation, "rebuildGeneration");
      const currentRevision = nonNegativeAccountingBigInt(row.accounting_revision, "accountingRevision");
      if (currentGeneration !== generation || currentRevision !== expectedRevision || row.state !== "rebuilding") {
        throw new AccountingRevisionConflict();
      }
      const progress = this.accountingProgress(row);
      const tableName = progress.scanTable;
      if (tableName === "done" || tableName == null) throw new AccountingRevisionConflict();
      const table = RETAINED_ACCOUNTING_V2_TABLES.find((candidate) => candidate.table.endsWith(`_${tableName}`));
      if (table == null) throw new Error("Retained-stage accounting scan table is invalid.");
      const candidates = this.accountingScanCandidates(table, progress);
      if (candidates.length === 0) {
        const nextTable: RetainedStageAccountingScanTable = tableName === "runs"
          ? "pages"
          : tableName === "pages"
            ? "facts"
            : tableName === "facts"
              ? "revisions"
              : tableName === "revisions"
                ? "candidate_epochs"
                : tableName === "candidate_epochs"
                  ? "candidate_members"
                  : "done";
        const nextRevision = nextAccountingBigInt(currentRevision, "accountingRevision");
        if (nextTable === "done") {
          const work = [progress.workRunRows, progress.workPageRows, progress.workFactRows, progress.workRevisionRows, progress.workCandidateEpochRows, progress.workCandidateMemberRows, progress.workLogicalBytes];
          if (work.some((value) => value == null)) throw new Error("Retained-stage accounting work totals are incomplete.");
          const result = this.db.prepare(`UPDATE analytics_retained_stage_accounting SET
            state='ready',scan_table='done',scan_run_id=NULL,scan_page=NULL,scan_item_id=NULL,
            run_rows=?,page_rows=?,fact_rows=?,revision_rows=?,candidate_epoch_rows=?,candidate_member_rows=?,logical_bytes=?,accounting_revision=?
            WHERE singleton=1 AND state='rebuilding' AND rebuild_generation=? AND accounting_revision=?`)
            .run(...work, nextRevision, generation, currentRevision);
          if (result.changes !== 1) throw new AccountingRevisionConflict();
          return;
        }
        const result = this.db.prepare(`UPDATE analytics_retained_stage_accounting SET
          scan_table=?,scan_run_id=NULL,scan_page=NULL,scan_item_id=NULL,accounting_revision=?
          WHERE singleton=1 AND state='rebuilding' AND rebuild_generation=? AND accounting_revision=?`)
          .run(nextTable, nextRevision, generation, currentRevision);
        if (result.changes !== 1) throw new AccountingRevisionConflict();
        return;
      }

      const selected: Array<{ rowId: bigint; rowBytes: bigint }> = [];
      let selectedBytes = 0n;
      for (const candidate of candidates) {
        const rowId = accountingBigInt(candidate.scan_rowid, "scanRowId");
        if (candidate.row_bytes_type !== "integer") {
          this.accountingBlock(row, table, rowId, "logical-byte row is outside signed SQLite integer range");
          return;
        }
        const rowBytes = accountingBigInt(candidate.row_bytes, "rowBytes");
        if (rowBytes < 0n || rowBytes > RETAINED_ACCOUNTING_MAX_SAFE_INTEGER) {
          this.accountingBlock(row, table, rowId, "logical-byte row exceeds safe accounting range");
          return;
        }
        for (let index = 0; index < table.primaryKey.length; index += 1) {
          const column = table.columns.find((candidateColumn) => candidateColumn.name === table.primaryKey[index]);
          const keyType = candidate[`key_${index}_type`];
          if (candidate[`key_${index}_bytes_type`] !== "integer") {
            this.accountingBlock(row, table, rowId, `primary-key ${table.primaryKey[index]} byte length is not an integer`);
            return;
          }
          const keyBytes = accountingBigInt(candidate[`key_${index}_bytes`], "keyBytes");
          if (column == null || keyType !== column.type.toLowerCase()) {
            this.accountingBlock(row, table, rowId, `primary-key ${table.primaryKey[index]} has an invalid SQLite storage type`);
            return;
          }
          if (column.type === "TEXT" && keyBytes > BigInt(RETAINED_ACCOUNTING_MAX_KEY_BYTES)) {
            this.accountingBlock(row, table, rowId, `primary-key ${table.primaryKey[index]} exceeds ${RETAINED_ACCOUNTING_MAX_KEY_BYTES} UTF-8 bytes`);
            return;
          }
        }
        if (selected.length > 0 && selectedBytes + rowBytes > RETAINED_ACCOUNTING_SCAN_TARGET_BYTES) break;
        selected.push({ rowId, rowBytes });
        selectedBytes += rowBytes;
        if (selectedBytes >= RETAINED_ACCOUNTING_SCAN_TARGET_BYTES || selected.length >= RETAINED_ACCOUNTING_SCAN_ROW_LIMIT) break;
      }
      if (selected.length === 0) throw new Error("Retained-stage accounting scan made no progress.");
      const last = selected[selected.length - 1]!;
      const key = this.accountingKeyForRow(table, last.rowId);
      if ("invalidReason" in key) {
        this.accountingBlock(row, table, last.rowId, key.invalidReason);
        return;
      }
      const cursor = this.accountingAdvanceCursor(table, key);
      const workRows = {
        run_rows: progress.workRunRows ?? 0n,
        page_rows: progress.workPageRows ?? 0n,
        fact_rows: progress.workFactRows ?? 0n,
        revision_rows: progress.workRevisionRows ?? 0n,
        candidate_epoch_rows: progress.workCandidateEpochRows ?? 0n,
        candidate_member_rows: progress.workCandidateMemberRows ?? 0n,
      };
      const nextWorkRows = { ...workRows };
      nextWorkRows[table.counter] += BigInt(selected.length);
      const nextWorkBytes = (progress.workLogicalBytes ?? 0n) + selectedBytes;
      if (Object.values(nextWorkRows).some((value) => value > RETAINED_ACCOUNTING_MAX_SAFE_INTEGER) || nextWorkBytes > RETAINED_ACCOUNTING_MAX_SAFE_INTEGER) {
        this.accountingBlock(row, table, last.rowId, "retained-stage logical-byte total exceeds safe accounting range");
        return;
      }
      const nextRevision = nextAccountingBigInt(currentRevision, "accountingRevision");
      const result = this.db.prepare(`UPDATE analytics_retained_stage_accounting SET
        scan_run_id=?,scan_page=?,scan_item_id=?,
        work_run_rows=?,work_page_rows=?,work_fact_rows=?,work_revision_rows=?,work_candidate_epoch_rows=?,work_candidate_member_rows=?,work_logical_bytes=?,
        accounting_revision=?
        WHERE singleton=1 AND state='rebuilding' AND rebuild_generation=? AND accounting_revision=?
          AND scan_table=? AND scan_run_id IS ? AND scan_page IS ? AND scan_item_id IS ?`)
        .run(
          cursor.scanRunId,
          cursor.scanPage,
          cursor.scanItemId,
          nextWorkRows.run_rows,
          nextWorkRows.page_rows,
          nextWorkRows.fact_rows,
          nextWorkRows.revision_rows,
          nextWorkRows.candidate_epoch_rows,
          nextWorkRows.candidate_member_rows,
          nextWorkBytes,
          nextRevision,
          generation,
          currentRevision,
          tableName,
          progress.scanRunId,
          progress.scanPage,
          progress.scanItemId,
        );
      if (result.changes !== 1) throw new AccountingRevisionConflict();
    })();
    return this.readRetainedStageAccounting();
  }

  private candidateEpochProgressFromRow(row: Record<string, unknown>): ManagedCandidateEpochProgress {
    const mode = row.mode;
    const state = row.state;
    if (mode !== "rewrite" && mode !== "upgrade") throw new Error("Invalid managed candidate epoch mode.");
    if (state !== "open" && state !== "freezing" && state !== "frozen" && state !== "sealing" && state !== "sealed") {
      throw new Error("Invalid managed candidate epoch state.");
    }
    if (candidateSafeNumber(row.target_projection_version, "targetProjectionVersion") !== MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION || row.algorithm_format !== MANAGED_CANDIDATE_ALGORITHM || row.restart !== MANAGED_CANDIDATE_RESTART) {
      throw new Error("Invalid managed candidate epoch identity.");
    }
    const observationQuality = row.observation_quality;
    if (observationQuality !== null && observationQuality !== "clean" && observationQuality !== "degraded") {
      throw new Error("Invalid managed candidate observation quality.");
    }
    return {
      epochId: candidateIdentifier(row.epoch_id as string, "epochId"),
      mode,
      targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
      algorithm: MANAGED_CANDIDATE_ALGORITHM,
      restart: MANAGED_CANDIDATE_RESTART,
      state,
      manifestRevision: nonNegativeAccountingBigInt(row.manifest_revision, "manifestRevision"),
      createdAt: candidateSafeNumber(row.created_at, "createdAt"),
      frozenAt: candidateNullableSafeNumber(row.frozen_at, "frozenAt"),
      sealedAt: candidateNullableSafeNumber(row.sealed_at, "sealedAt"),
      baselineGenerationId: nonNegativeAccountingBigInt(row.baseline_generation_id, "baselineGenerationId"),
      baselineProjectionVersion: nonNegativeAccountingBigInt(row.baseline_projection_version, "baselineProjectionVersion"),
      baselineSourceFrontierState: MANAGED_CANDIDATE_BASELINE_FRONTIER_UNAVAILABLE,
      membershipCount: nullableSafeAccountingBigInt(row.membership_count, "membershipCount"),
      membershipCursor: candidateCursor(row.membership_cursor as string | null, "membershipCursor"),
      membershipRollingDigest: candidateDigestOrNull(row.membership_rolling_digest, "membershipRollingDigest"),
      membershipDigest: candidateDigestOrNull(row.membership_digest, "membershipDigest"),
      pinCursor: candidateCursor(row.pin_cursor as string | null, "pinCursor"),
      pinnedCount: nullableSafeAccountingBigInt(row.pinned_count, "pinnedCount"),
      pinnedRollingDigest: candidateDigestOrNull(row.pinned_rolling_digest, "pinnedRollingDigest"),
      sealMembershipRollingDigest: candidateDigestOrNull(row.seal_membership_rolling_digest, "sealMembershipRollingDigest"),
      observationDigest: candidateDigestOrNull(row.observation_digest, "observationDigest"),
      observationQuality,
      lastOperationDigest: candidateDigestOrNull(row.last_operation_digest, "lastOperationDigest"),
      error: candidateError(row.error_text as string | null),
    };
  }

  private candidateMemberProgressFromRow(row: Record<string, unknown>): ManagedCandidateMemberProgress {
    const pinState = row.pin_state;
    const outcome = row.outcome;
    if (pinState !== "bound" && pinState !== "pinned") throw new Error("Invalid managed candidate member pin state.");
    if (outcome !== null && outcome !== "source-exhausted" && outcome !== "failed" && outcome !== "terminal-capped") {
      throw new Error("Invalid managed candidate member outcome.");
    }
    return {
      epochId: candidateIdentifier(row.epoch_id as string, "epochId"),
      threadId: candidateIdentifier(row.thread_id as string, "threadId"),
      runId: candidateIdentifier(row.run_id as string, "runId"),
      memberRevision: nonNegativeAccountingBigInt(row.member_revision, "memberRevision"),
      pinOperationDigest: candidateDigestOrNull(row.pin_operation_digest, "pinOperationDigest"),
      boundStageAccountingRevision: nonNegativeAccountingBigInt(row.bound_stage_accounting_revision, "boundStageAccountingRevision"),
      boundNextPage: candidateSafeNumber(row.bound_next_page, "boundNextPage"),
      boundCheckpointDigest: candidateDigest(row.bound_checkpoint_digest as string, "boundCheckpointDigest"),
      pinState,
      outcome,
      observedNextPage: candidateNullableSafeNumber(row.observed_next_page, "observedNextPage"),
      observedLastPageDigest: candidateDigestOrNull(row.observed_last_page_digest, "observedLastPageDigest"),
      observedCheckpointDigest: candidateDigestOrNull(row.observed_checkpoint_digest, "observedCheckpointDigest"),
      observedOperationDigest: candidateDigestOrNull(row.observed_operation_digest, "observedOperationDigest"),
      observedSourceAfterSeq: candidateCursor(row.observed_source_after_seq as string | null, "observedSourceAfterSeq"),
      observedFactMaxSeq: candidateNullableSafeNumber(row.observed_fact_max_seq, "observedFactMaxSeq"),
      observedIncompleteReasonsJson: row.observed_incomplete_reasons_json as string,
      observedRewriteRequired: candidateSafeNumber(row.observed_rewrite_required, "observedRewriteRequired") === 1,
      observedRewriteDirectiveJson: row.observed_rewrite_directive_json as string | null,
      failureReason: row.failure_reason as string | null,
      terminalReason: row.terminal_reason as string | null,
      error: candidateError(row.error_text as string | null),
      observationDigest: candidateDigestOrNull(row.observation_digest, "observationDigest"),
      observedAt: candidateNullableSafeNumber(row.observed_at, "observedAt"),
      observedStageAccountingRevision: nullableSafeAccountingBigInt(row.observed_stage_accounting_revision, "observedStageAccountingRevision"),
    };
  }

  private candidateEpochRow(epochId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM analytics_retained_candidate_epochs WHERE epoch_id=?").safeIntegers().get(epochId) as Record<string, unknown> | undefined;
  }

  private candidateMemberRow(epochId: string, threadId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM analytics_retained_candidate_members WHERE epoch_id=? AND thread_id=?").safeIntegers().get(epochId, threadId) as Record<string, unknown> | undefined;
  }

  private candidateStageRow(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM analytics_retained_stage_runs WHERE run_id=?").safeIntegers().get(runId) as Record<string, unknown> | undefined;
  }

  private candidateObservationTuple(row: Record<string, unknown>): Record<string, unknown> {
    const integer = (value: unknown, name: string): string | null => value == null ? null : accountingBigInt(value, name).toString();
    return {
      epochId: row.epoch_id,
      threadId: row.thread_id,
      runId: row.run_id,
      memberRevision: integer(row.member_revision, "memberRevision"),
      pinOperationDigest: row.pin_operation_digest,
      outcome: row.outcome,
      observedNextPage: integer(row.observed_next_page, "observedNextPage"),
      observedLastPageDigest: row.observed_last_page_digest,
      observedCheckpointDigest: row.observed_checkpoint_digest,
      observedOperationDigest: row.observed_operation_digest,
      observedSourceAfterSeq: row.observed_source_after_seq,
      observedFactMaxSeq: integer(row.observed_fact_max_seq, "observedFactMaxSeq"),
      observedIncompleteReasonsJson: row.observed_incomplete_reasons_json,
      observedRewriteRequired: integer(row.observed_rewrite_required, "observedRewriteRequired"),
      observedRewriteDirectiveJson: row.observed_rewrite_directive_json,
      failureReason: row.failure_reason,
      terminalReason: row.terminal_reason,
      errorText: row.error_text,
      observationDigest: row.observation_digest,
      observedAt: integer(row.observed_at, "observedAt"),
      observedStageAccountingRevision: integer(row.observed_stage_accounting_revision, "observedStageAccountingRevision"),
    };
  }

  private ensureManagedCandidateAccountingReady(): void {
    this.prepareRetainedStageAccountingOnce();
    this.ensureRetainedStageAccountingReady();
  }

  getRetainedCandidateEpoch(epochId: string): ManagedCandidateEpochProgress | null {
    this.validateRetainedStageAccountingInstallation();
    candidateIdentifier(epochId, "epochId");
    const row = this.candidateEpochRow(epochId);
    return row == null ? null : this.candidateEpochProgressFromRow(row);
  }

  getRetainedCandidateMember(epochId: string, threadId: string): ManagedCandidateMemberProgress | null {
    this.validateRetainedStageAccountingInstallation();
    candidateIdentifier(epochId, "epochId");
    candidateIdentifier(threadId, "threadId");
    const row = this.candidateMemberRow(epochId, threadId);
    return row == null ? null : this.candidateMemberProgressFromRow(row);
  }

  openRetainedCandidateEpoch(input: OpenManagedCandidateEpoch): ManagedCandidateEpochProgress {
    candidateIdentifier(input.epochId, "epochId");
    candidateIdentifier(input.mode, "mode");
    if (input.mode !== "rewrite" && input.mode !== "upgrade") throw new Error("Managed candidate delta mode is not supported.");
    if (input.targetProjectionVersion !== MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION || input.algorithm !== MANAGED_CANDIDATE_ALGORITHM || input.restart !== MANAGED_CANDIDATE_RESTART || !Number.isSafeInteger(input.observedAt)) {
      throw new Error("Invalid managed candidate epoch identity.");
    }
    this.ensureManagedCandidateAccountingReady();
    this.db.transaction(() => {
      const existing = this.candidateEpochRow(input.epochId);
      if (existing != null) {
        if (
          existing.mode !== input.mode
          || candidateSafeNumber(existing.target_projection_version, "targetProjectionVersion") !== input.targetProjectionVersion
          || existing.algorithm_format !== input.algorithm
          || existing.restart !== input.restart
          || candidateSafeNumber(existing.created_at, "createdAt") !== input.observedAt
        ) {
          throw new Error("Conflicting managed candidate epoch replay.");
        }
        return;
      }
      const active = this.getIndexState();
      const identityDigest = candidateOperationDigest("managed-candidate-manifest", {
        epochId: input.epochId,
        mode: input.mode,
        targetProjectionVersion: input.targetProjectionVersion,
        algorithm: input.algorithm,
        restart: input.restart,
        observedAt: input.observedAt,
        baselineGenerationId: String(active.generationId),
        baselineProjectionVersion: String(active.factProjectionVersion),
      });
      this.db.prepare(`INSERT INTO analytics_retained_candidate_epochs (
        epoch_id,mode,target_projection_version,algorithm_format,restart,state,manifest_revision,created_at,
        frozen_at,sealed_at,baseline_generation_id,baseline_projection_version,baseline_source_frontier_state,
        membership_count,membership_cursor,membership_rolling_digest,membership_digest,pin_cursor,pinned_count,
        pinned_rolling_digest,seal_membership_rolling_digest,observation_digest,observation_quality,last_operation_digest,error_text
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.epochId,
        input.mode,
        MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
        MANAGED_CANDIDATE_ALGORITHM,
        MANAGED_CANDIDATE_RESTART,
        "open",
        0,
        input.observedAt,
        null,
        null,
        active.generationId,
        active.factProjectionVersion,
        MANAGED_CANDIDATE_BASELINE_FRONTIER_UNAVAILABLE,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        identityDigest,
        null,
      );
    })();
    return this.getRetainedCandidateEpoch(input.epochId)!;
  }

  bindRetainedCandidateMember(input: BindManagedCandidateMember): ManagedCandidateMemberProgress {
    candidateIdentifier(input.epochId, "epochId");
    candidateIdentifier(input.threadId, "threadId");
    candidateIdentifier(input.runId, "runId");
    this.ensureManagedCandidateAccountingReady();
    this.db.transaction(() => {
      const epoch = this.candidateEpochRow(input.epochId);
      if (epoch == null) throw new Error("Unknown managed candidate epoch.");
      if (epoch.state !== "open") throw new Error("Managed candidate membership is already frozen.");
      const existing = this.candidateMemberRow(input.epochId, input.threadId);
      if (existing != null) {
        if (existing.run_id !== input.runId) throw new Error("Conflicting managed candidate member replay.");
        return;
      }
      const stage = this.candidateStageRow(input.runId);
      if (stage == null || stage.epoch_id !== input.epochId || stage.thread_id !== input.threadId || stage.mode !== epoch.mode || candidateSafeNumber(stage.target_projection_version, "targetProjectionVersion") !== MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION || stage.algorithm_format !== MANAGED_CANDIDATE_ALGORITHM) {
        throw new Error("Managed candidate member does not match a v5 stage domain.");
      }
      if (typeof stage.checkpoint_digest !== "string" || !/^[0-9a-f]{64}$/.test(stage.checkpoint_digest)) throw new Error("Managed candidate member checkpoint digest is missing.");
      const accounting = this.accountingProgress();
      const revision = nonNegativeAccountingBigInt(epoch.manifest_revision, "manifestRevision");
      const memberDigest = candidateOperationDigest("managed-candidate-member", { epochId: input.epochId, threadId: input.threadId, runId: input.runId });
      this.db.prepare(`INSERT INTO analytics_retained_candidate_members (
        epoch_id,thread_id,run_id,member_revision,pin_operation_digest,bound_stage_accounting_revision,bound_next_page,
        bound_checkpoint_digest,pin_state,outcome,observed_next_page,observed_last_page_digest,observed_checkpoint_digest,
        observed_operation_digest,observed_source_after_seq,observed_fact_max_seq,observed_incomplete_reasons_json,
        observed_rewrite_required,observed_rewrite_directive_json,failure_reason,terminal_reason,error_text,observation_digest,
        observed_at,observed_stage_accounting_revision
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.epochId,
        input.threadId,
        input.runId,
        0,
        null,
        accounting.accountingRevision,
        candidateSafeNumber(stage.next_page, "nextPage"),
        stage.checkpoint_digest,
        "bound",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "[]",
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
      const update = this.db.prepare("UPDATE analytics_retained_candidate_epochs SET manifest_revision=manifest_revision+1,last_operation_digest=? WHERE epoch_id=? AND state='open' AND manifest_revision=?").run(memberDigest, input.epochId, revision);
      if (update.changes !== 1) throw new AccountingRevisionConflict();
    })();
    return this.getRetainedCandidateMember(input.epochId, input.threadId)!;
  }

  advanceRetainedCandidateEpoch(input: AdvanceManagedCandidateEpoch): ManagedCandidateEpochProgress {
    candidateIdentifier(input.epochId, "epochId");
    const expected = nonNegativeAccountingBigInt(input.expectedManifestRevision, "expectedManifestRevision");
    if (input.operation !== "freeze" && input.operation !== "seal") throw new Error("Invalid managed candidate epoch operation.");
    this.ensureManagedCandidateAccountingReady();
    this.db.transaction(() => {
      const epoch = this.candidateEpochRow(input.epochId);
      if (epoch == null) throw new Error("Unknown managed candidate epoch.");
      const operationDigest = candidateOperationDigest("managed-candidate-advance", { epochId: input.epochId, operation: input.operation, expectedManifestRevision: expected.toString() });
      if (epoch.last_operation_digest === operationDigest) return;
      const currentRevision = nonNegativeAccountingBigInt(epoch.manifest_revision, "manifestRevision");
      if (currentRevision !== expected) throw new AccountingRevisionConflict();
      if (input.operation === "freeze") {
        if (epoch.state !== "open" && epoch.state !== "freezing") throw new Error("Managed candidate membership is not freezeable.");
        const cursor = candidateCursor(epoch.membership_cursor as string | null, "membershipCursor");
        const table = RETAINED_ACCOUNTING_V2_TABLES.find((candidate) => candidate.table === "analytics_retained_candidate_members")!;
        const logicalBytes = retainedAccountingRowBytes("m", table);
        const rows = this.db.prepare(`SELECT ${retainedCandidateMemberSelect(logicalBytes)} FROM analytics_retained_candidate_members m WHERE m.epoch_id=?${cursor == null ? "" : " AND m.thread_id COLLATE BINARY > ?"} ORDER BY m.thread_id COLLATE BINARY LIMIT ${MANAGED_CANDIDATE_SEAL_ROW_LIMIT}`).safeIntegers().all(...(cursor == null ? [input.epochId] : [input.epochId, cursor])) as Array<Record<string, unknown>>;
        let count = epoch.membership_count == null ? 0n : nonNegativeAccountingBigInt(epoch.membership_count, "membershipCount");
        let rolling = candidateDigestOrNull(epoch.membership_rolling_digest, "membershipRollingDigest") ?? MANAGED_CANDIDATE_ROLLING_SEED;
        let bytes = 0n;
        const selected: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const rowBytes = accountingBigInt(row.logical_row_bytes, "candidateMemberLogicalBytes");
          if (rowBytes < 0n) throw new Error("Managed candidate member logical bytes are negative.");
          if (selected.length > 0 && bytes + rowBytes > MANAGED_CANDIDATE_SEAL_TARGET_BYTES) break;
          selected.push(row);
          bytes += rowBytes;
          if (bytes >= MANAGED_CANDIDATE_SEAL_TARGET_BYTES) break;
        }
        if (selected.length === 0) {
          const membershipDigest = candidateObservationDigest({ kind: "membership-binding", epochId: input.epochId, mode: epoch.mode, count: count.toString(), rolling });
          const result = this.db.prepare(`UPDATE analytics_retained_candidate_epochs SET state='frozen',manifest_revision=manifest_revision+1,frozen_at=?,membership_count=?,membership_cursor=NULL,membership_rolling_digest=?,membership_digest=?,pin_cursor=NULL,pinned_count=0,pinned_rolling_digest=?,seal_membership_rolling_digest=?,observation_digest=NULL,observation_quality=NULL,last_operation_digest=? WHERE epoch_id=? AND state IN ('open','freezing') AND manifest_revision=?`).run(Date.now(), count, rolling, membershipDigest, MANAGED_CANDIDATE_ROLLING_SEED, MANAGED_CANDIDATE_ROLLING_SEED, operationDigest, input.epochId, currentRevision);
          if (result.changes !== 1) throw new AccountingRevisionConflict();
          return;
        }
        for (const row of selected) {
          count += 1n;
          rolling = candidateRollingDigest(rolling, ["membership", input.epochId, row.thread_id, row.run_id]);
        }
        const lastThread = selected[selected.length - 1]!.thread_id as string;
        const result = this.db.prepare(`UPDATE analytics_retained_candidate_epochs SET state='freezing',manifest_revision=manifest_revision+1,membership_count=?,membership_cursor=?,membership_rolling_digest=?,last_operation_digest=? WHERE epoch_id=? AND state IN ('open','freezing') AND manifest_revision=?`).run(count, lastThread, rolling, operationDigest, input.epochId, currentRevision);
        if (result.changes !== 1) throw new AccountingRevisionConflict();
        return;
      }

      if (epoch.state === "frozen") {
        const result = this.db.prepare(`UPDATE analytics_retained_candidate_epochs SET state='sealing',manifest_revision=manifest_revision+1,pin_cursor=NULL,pinned_count=0,pinned_rolling_digest=?,seal_membership_rolling_digest=?,observation_quality='degraded',last_operation_digest=? WHERE epoch_id=? AND state='frozen' AND manifest_revision=?`).run(MANAGED_CANDIDATE_ROLLING_SEED, MANAGED_CANDIDATE_ROLLING_SEED, operationDigest, input.epochId, currentRevision);
        if (result.changes !== 1) throw new AccountingRevisionConflict();
        return;
      }
      if (epoch.state !== "sealing") throw new Error("Managed candidate is not ready to seal.");
      const cursor = candidateCursor(epoch.pin_cursor as string | null, "pinCursor");
      const table = RETAINED_ACCOUNTING_V2_TABLES.find((candidate) => candidate.table === "analytics_retained_candidate_members")!;
      const logicalBytes = retainedAccountingRowBytes("m", table);
      const rows = this.db.prepare(`SELECT ${retainedCandidateMemberSelect(logicalBytes)} FROM analytics_retained_candidate_members m WHERE m.epoch_id=?${cursor == null ? "" : " AND m.thread_id COLLATE BINARY > ?"} ORDER BY m.thread_id COLLATE BINARY LIMIT ${MANAGED_CANDIDATE_SEAL_ROW_LIMIT}`).safeIntegers().all(...(cursor == null ? [input.epochId] : [input.epochId, cursor])) as Array<Record<string, unknown>>;
      let pinnedCount = epoch.pinned_count == null ? 0n : nonNegativeAccountingBigInt(epoch.pinned_count, "pinnedCount");
      let membershipRolling = candidateDigestOrNull(epoch.seal_membership_rolling_digest, "sealMembershipRollingDigest") ?? MANAGED_CANDIDATE_ROLLING_SEED;
      let observationRolling = candidateDigestOrNull(epoch.pinned_rolling_digest, "pinnedRollingDigest") ?? MANAGED_CANDIDATE_ROLLING_SEED;
      let bytes = 0n;
      const selected: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        if (row.pin_state !== "pinned") throw new Error("Managed candidate seal encountered an unpinned member.");
        const rowBytes = accountingBigInt(row.logical_row_bytes, "candidateMemberLogicalBytes");
        if (selected.length > 0 && bytes + rowBytes > MANAGED_CANDIDATE_SEAL_TARGET_BYTES) break;
        selected.push(row);
        bytes += rowBytes;
        if (bytes >= MANAGED_CANDIDATE_SEAL_TARGET_BYTES) break;
      }
      if (selected.length === 0) {
        const membershipCount = nonNegativeAccountingBigInt(epoch.membership_count, "membershipCount");
        if (pinnedCount !== membershipCount) throw new Error("Managed candidate seal reached an empty keyset before every member was pinned.");
        const membershipDigest = candidateObservationDigest({ kind: "membership-binding", epochId: input.epochId, mode: epoch.mode, count: membershipCount.toString(), rolling: membershipRolling });
        if (membershipDigest !== epoch.membership_digest) throw new Error("Managed candidate membership digest changed during seal.");
        const observationDigest = candidateObservationDigest({ kind: "pinned-observations", epochId: input.epochId, mode: epoch.mode, count: pinnedCount.toString(), rolling: observationRolling });
        const result = this.db.prepare(`UPDATE analytics_retained_candidate_epochs SET state='sealed',manifest_revision=manifest_revision+1,sealed_at=?,pin_cursor=NULL,pinned_count=?,pinned_rolling_digest=?,seal_membership_rolling_digest=?,observation_digest=?,observation_quality=?,last_operation_digest=? WHERE epoch_id=? AND state='sealing' AND manifest_revision=?`).run(Date.now(), pinnedCount, observationRolling, membershipRolling, observationDigest, "degraded", operationDigest, input.epochId, currentRevision);
        if (result.changes !== 1) throw new AccountingRevisionConflict();
        return;
      }
      for (const row of selected) {
        pinnedCount += 1n;
        membershipRolling = candidateRollingDigest(membershipRolling, ["membership", input.epochId, row.thread_id, row.run_id]);
        observationRolling = candidateRollingDigest(observationRolling, ["observation", this.candidateObservationTuple(row)]);
      }
      const lastThread = selected[selected.length - 1]!.thread_id as string;
      const result = this.db.prepare(`UPDATE analytics_retained_candidate_epochs SET manifest_revision=manifest_revision+1,pin_cursor=?,pinned_count=?,pinned_rolling_digest=?,seal_membership_rolling_digest=?,last_operation_digest=? WHERE epoch_id=? AND state='sealing' AND manifest_revision=?`).run(lastThread, pinnedCount, observationRolling, membershipRolling, operationDigest, input.epochId, currentRevision);
      if (result.changes !== 1) throw new AccountingRevisionConflict();
    })();
    return this.getRetainedCandidateEpoch(input.epochId)!;
  }

  pinRetainedCandidateMember(input: PinManagedCandidateMember): ManagedCandidateMemberProgress {
    candidateIdentifier(input.epochId, "epochId");
    candidateIdentifier(input.threadId, "threadId");
    const expected = nonNegativeAccountingBigInt(input.expectedMemberRevision, "expectedMemberRevision");
    this.ensureManagedCandidateAccountingReady();
    this.db.transaction(() => {
      const epoch = this.candidateEpochRow(input.epochId);
      const member = this.candidateMemberRow(input.epochId, input.threadId);
      if (epoch == null || member == null) throw new Error("Unknown managed candidate member.");
      const operationDigest = candidateOperationDigest("managed-candidate-pin", { epochId: input.epochId, threadId: input.threadId, expectedMemberRevision: expected.toString() });
      if (member.pin_operation_digest === operationDigest && member.pin_state === "pinned") return;
      if (epoch.state !== "frozen" && epoch.state !== "sealing") throw new Error("Managed candidate member is not pinnable.");
      const memberRevision = nonNegativeAccountingBigInt(member.member_revision, "memberRevision");
      if (memberRevision !== expected || member.pin_state !== "bound") throw new AccountingRevisionConflict();
      const stage = this.candidateStageRow(member.run_id as string);
      if (stage == null || stage.algorithm_format !== MANAGED_CANDIDATE_ALGORITHM || candidateSafeNumber(stage.target_projection_version, "targetProjectionVersion") !== MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION || stage.epoch_id !== input.epochId || stage.thread_id !== input.threadId || stage.mode !== epoch.mode) {
        throw new Error("Managed candidate member stage identity changed.");
      }
      if (typeof stage.checkpoint_json !== "string" || typeof stage.checkpoint_digest !== "string") throw new Error("Managed candidate member checkpoint is missing.");
      const budget: RetainedProjectionStageBudget = {
        maxPages: candidateSafeNumber(stage.max_pages, "maxPages"),
        maxRows: candidateSafeNumber(stage.max_rows, "maxRows"),
        maxBytes: candidateSafeNumber(stage.max_bytes, "maxBytes"),
        maxCheckpointBytes: candidateSafeNumber(stage.max_checkpoint_bytes, "maxCheckpointBytes"),
        maxMetadataBytes: candidateSafeNumber(stage.max_metadata_bytes, "maxMetadataBytes"),
        maxTurnStates: candidateSafeNumber(stage.max_turn_states, "maxTurnStates"),
        maxTimingRefs: candidateSafeNumber(stage.max_timing_refs, "maxTimingRefs"),
        maxRevisions: candidateSafeNumber(stage.max_revisions, "maxRevisions"),
      };
      const stored = parseStoredCheckpoint(stage.checkpoint_json, budget);
      if (stored.digest !== stage.checkpoint_digest) throw new Error("Managed candidate member checkpoint digest changed.");
      const nextPage = candidateSafeNumber(stage.next_page, "nextPage");
      const latestPageRow = this.db.prepare(`SELECT page,page_digest,cursor_out,checkpoint_digest,operation_digest,source_page_digest,source_page_exhausted
        FROM analytics_retained_stage_pages WHERE run_id=? ORDER BY page DESC LIMIT 1`).safeIntegers().get(member.run_id) as {
        page: bigint;
        page_digest: string;
        cursor_out: string | null;
        checkpoint_digest: string;
        operation_digest: string;
        source_page_digest: string;
        source_page_exhausted: bigint;
      } | undefined;
      const latestPage = latestPageRow == null ? undefined : {
        ...latestPageRow,
        page: candidateSafeNumber(latestPageRow.page, "latestPage"),
        source_page_exhausted: candidateSafeNumber(latestPageRow.source_page_exhausted, "sourcePageExhausted"),
      };
      if (nextPage === 0) {
        if (
          latestPage != null
          || stored.checkpoint.nextStagePage !== 0
          || stored.checkpoint.sourceAfterSeq !== null
          || stored.checkpoint.maxFactSeq !== null
          || stage.source_after_seq !== null
          || stage.fact_max_seq !== null
          || stage.last_operation_digest !== null
        ) {
          throw new Error("Managed candidate member has an impossible initial stage proof.");
        }
      } else {
        if (latestPage == null || latestPage.page !== nextPage - 1) {
          throw new Error("Managed candidate member latest page does not prove the durable stage head.");
        }
        if (
          latestPage.checkpoint_digest !== stage.checkpoint_digest
          || latestPage.checkpoint_digest !== stored.digest
          || latestPage.cursor_out !== stage.source_after_seq
          || latestPage.operation_digest !== stage.last_operation_digest
          || latestPage.source_page_digest !== latestPage.page_digest
        ) throw new Error("Managed candidate member page/checkpoint linkage is inconsistent.");
      }
      const terminalReason = stage.terminal_reason as string | null;
      const failureReason = stage.failure_reason as string | null;
      let outcome: "source-exhausted" | "failed" | "terminal-capped";
      if (terminalReason != null) outcome = "terminal-capped";
      else if (stage.state === "failed" && failureReason != null) outcome = "failed";
      else if (stage.state === "collecting" && latestPage != null && latestPage.source_page_exhausted === 1) outcome = "source-exhausted";
      else throw new Error("Managed candidate member stage has no durable terminal observation.");
      const incompleteReasonsJson = JSON.stringify(stored.checkpoint.revisitReasons);
      const rewriteDirectiveJson = stored.checkpoint.rewriteDirective == null ? null : JSON.stringify(stored.checkpoint.rewriteDirective);
      const observation = {
        epochId: input.epochId,
        threadId: input.threadId,
        runId: member.run_id,
        outcome,
        nextPage,
        lastPageDigest: latestPage?.page_digest ?? null,
        checkpointDigest: stage.checkpoint_digest,
        operationDigest: stage.last_operation_digest ?? null,
        sourceAfterSeq: stage.source_after_seq ?? null,
        factMaxSeq: stage.fact_max_seq == null ? null : candidateSafeNumber(stage.fact_max_seq, "factMaxSeq"),
        incompleteReasonsJson,
        rewriteRequired: stored.checkpoint.rewriteRequired,
        rewriteDirectiveJson,
        failureReason,
        terminalReason,
        error: stage.last_error ?? null,
        observedStageAccountingRevision: this.accountingProgress().accountingRevision.toString(),
      };
      const observationDigest = candidateObservationDigest(observation);
      const update = this.db.prepare(`UPDATE analytics_retained_candidate_members SET member_revision=member_revision+1,pin_operation_digest=?,pin_state='pinned',outcome=?,observed_next_page=?,observed_last_page_digest=?,observed_checkpoint_digest=?,observed_operation_digest=?,observed_source_after_seq=?,observed_fact_max_seq=?,observed_incomplete_reasons_json=?,observed_rewrite_required=?,observed_rewrite_directive_json=?,failure_reason=?,terminal_reason=?,error_text=?,observation_digest=?,observed_at=?,observed_stage_accounting_revision=? WHERE epoch_id=? AND thread_id=? AND member_revision=? AND pin_state='bound'`).run(operationDigest, outcome, observation.nextPage, observation.lastPageDigest, observation.checkpointDigest, observation.operationDigest, observation.sourceAfterSeq, observation.factMaxSeq, incompleteReasonsJson, observation.rewriteRequired ? 1 : 0, rewriteDirectiveJson, failureReason, terminalReason, observation.error, observationDigest, Date.now(), this.accountingProgress().accountingRevision, input.epochId, input.threadId, memberRevision);
      if (update.changes !== 1) throw new AccountingRevisionConflict();
      const manifestRevision = nonNegativeAccountingBigInt(epoch.manifest_revision, "manifestRevision");
      const epochUpdate = this.db.prepare(`UPDATE analytics_retained_candidate_epochs SET state=CASE WHEN state='frozen' THEN 'sealing' ELSE state END,manifest_revision=manifest_revision+1,pinned_count=COALESCE(pinned_count,0),pinned_rolling_digest=COALESCE(pinned_rolling_digest,?),seal_membership_rolling_digest=COALESCE(seal_membership_rolling_digest,?),last_operation_digest=? WHERE epoch_id=? AND state IN ('frozen','sealing') AND manifest_revision=?`).run(MANAGED_CANDIDATE_ROLLING_SEED, MANAGED_CANDIDATE_ROLLING_SEED, operationDigest, input.epochId, manifestRevision);
      if (epochUpdate.changes !== 1) throw new AccountingRevisionConflict();
    })();
    return this.getRetainedCandidateMember(input.epochId, input.threadId)!;
  }

  dataDirectory(): string {
    const separator = this.db.name.lastIndexOf("/");
    return separator < 0 ? "." : this.db.name.slice(0, separator);
  }

  private openRetainedProjectionStageInTransaction(
    input: OpenRetainedProjectionStage,
    budget: RetainedProjectionStageBudget,
  ): void {
    this.prepareRetainedStageAccountingOnce();
    const existing = this.db
      .prepare("SELECT run_id,target_projection_version,algorithm_format,epoch_id,thread_id,mode,started_at,max_pages,max_rows,max_bytes,max_checkpoint_bytes,max_metadata_bytes,max_turn_states,max_timing_refs,max_revisions FROM analytics_retained_stage_runs WHERE run_id=?")
      .get(input.runId) as Record<string, unknown> | undefined;
    if (existing != null) {
      if (
        existing.target_projection_version !== RETAINED_TARGET_PROJECTION_VERSION
        || existing.algorithm_format !== RETAINED_PROJECTION_ALGORITHM
        || existing.epoch_id !== input.epochId
        || existing.thread_id !== input.threadId
        || existing.mode !== input.mode
        || existing.started_at !== input.startedAt
        || existing.max_pages !== budget.maxPages
        || existing.max_rows !== budget.maxRows
        || existing.max_bytes !== budget.maxBytes
        || existing.max_checkpoint_bytes !== budget.maxCheckpointBytes
        || existing.max_metadata_bytes !== budget.maxMetadataBytes
        || existing.max_turn_states !== budget.maxTurnStates
        || existing.max_timing_refs !== budget.maxTimingRefs
        || existing.max_revisions !== budget.maxRevisions
      ) throw new Error("Conflicting retained projection stage replay.");
      return;
    }
    const epochThread = this.db
      .prepare("SELECT run_id FROM analytics_retained_stage_runs WHERE epoch_id=? AND thread_id=?")
      .get(input.epochId, input.threadId) as { run_id: string } | undefined;
    if (epochThread != null) throw new Error("Conflicting retained stage epoch/thread.");

    const initialValue = initialRetainedProjectionCheckpoint(input);
    const initialBytes = Buffer.byteLength(JSON.stringify(initialValue), "utf8");
    if (initialBytes > budget.maxCheckpointBytes) {
      throw new Error("Retained projection checkpoint minimum exceeds its configured byte cap.");
    }
    const initial = canonicalizeRetainedProjectionCheckpoint(initialValue, budget);
    const initialCheckpoint = checkpointWithoutDigestMetadata(initial);
    const initialDigest = sha256(initial.json);
    this.db
      .prepare(`INSERT INTO analytics_retained_stage_runs (
        run_id,epoch_id,thread_id,mode,state,target_projection_version,algorithm_format,
        next_page,next_cursor,rows_staged,bytes_staged,max_observed_seq,max_pages,max_rows,max_bytes,
        max_checkpoint_bytes,max_metadata_bytes,max_turn_states,max_timing_refs,max_revisions,
        checkpoint_json,checkpoint_digest,source_after_seq,fact_max_seq,revision_count,
        revision_payload_bytes,metadata_bytes,last_operation_digest,started_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.runId,
        input.epochId,
        input.threadId,
        input.mode,
        "collecting",
        RETAINED_TARGET_PROJECTION_VERSION,
        RETAINED_PROJECTION_ALGORITHM,
        0,
        null,
        0,
        0,
        null,
        budget.maxPages,
        budget.maxRows,
        budget.maxBytes,
        budget.maxCheckpointBytes,
        budget.maxMetadataBytes,
        budget.maxTurnStates,
        budget.maxTimingRefs,
        budget.maxRevisions,
        JSON.stringify(initialCheckpoint),
        initialDigest,
        null,
        null,
        0,
        0,
        initial.bytes,
        null,
        input.startedAt,
      );
  }

  /** Opens the additive version-5 retained stage; it never touches active facts or index state. */
  openRetainedProjectionStage(input: OpenRetainedProjectionStage): RetainedProjectionStageProgress {
    if (![input.runId, input.epochId, input.threadId].every(validStageIdentifier)) {
      throw new Error("Invalid retained projection stage identifier.");
    }
    if (
      input.targetProjectionVersion !== RETAINED_TARGET_PROJECTION_VERSION
      || input.algorithm !== RETAINED_PROJECTION_ALGORITHM
      || !validStageMode(input.mode)
      || !Number.isSafeInteger(input.startedAt)
    ) throw new Error("Invalid retained projection stage identity.");
    const budget = projectionBudget(input.budget);
    if (budget.maxCheckpointBytes < retainedProjectionMinimumCheckpointBytes(input.runId, input.threadId, input.mode)) {
      throw new Error("Retained projection checkpoint budget cannot preserve bounded progress metadata.");
    }
    requireRetainedProjectionDomain(readRetainedStageRow(this.db, input.runId));
    this.db.transaction(() => this.openRetainedProjectionStageInTransaction(input, budget))();
    return this.getRetainedProjectionStage(input.runId)!;
  }

  resumeRetainedProjectionStage(input: OpenRetainedProjectionStage): RetainedProjectionStageProgress {
    if (![input.runId, input.epochId, input.threadId].every(validStageIdentifier)) {
      throw new Error("Invalid retained projection stage identifier.");
    }
    if (
      input.targetProjectionVersion !== RETAINED_TARGET_PROJECTION_VERSION
      || input.algorithm !== RETAINED_PROJECTION_ALGORITHM
      || !validStageMode(input.mode)
      || !Number.isSafeInteger(input.startedAt)
    ) throw new Error("Invalid retained projection stage identity.");
    const budget = projectionBudget(input.budget);
    if (budget.maxCheckpointBytes < retainedProjectionMinimumCheckpointBytes(input.runId, input.threadId, input.mode)) {
      throw new Error("Retained projection checkpoint budget cannot preserve bounded progress metadata.");
    }
    requireRetainedProjectionDomain(readRetainedStageRow(this.db, input.runId));
    this.db.transaction(() => {
      this.openRetainedProjectionStageInTransaction(input, budget);
      const current = this.db
        .prepare("SELECT * FROM analytics_retained_stage_runs WHERE run_id=?")
        .get(input.runId) as Record<string, unknown> | undefined;
      if (current == null) throw new Error("Unknown retained projection stage after atomic open.");
      if (current.terminal_reason != null) {
        throw new RetainedProjectionTerminalError(current.terminal_reason as RetainedProjectionStageProgress["terminalReason"]);
      }
      if (current.state === "collecting") return;
      if (current.state !== "failed" || current.failure_reason == null) {
        throw new Error("Retained projection stage is unavailable for resume.");
      }
      const result = this.db.prepare(`UPDATE analytics_retained_stage_runs SET state='collecting',failure_reason=NULL,last_error=NULL
        WHERE run_id=? AND epoch_id=? AND thread_id=? AND mode=? AND target_projection_version=?
          AND algorithm_format=? AND started_at=? AND state='failed' AND terminal_reason IS NULL
          AND next_page=? AND next_cursor IS ? AND rows_staged=? AND bytes_staged=?
          AND max_observed_seq IS ? AND checkpoint_json=? AND checkpoint_digest=?
          AND source_after_seq IS ? AND fact_max_seq IS ? AND revision_count=?
          AND revision_payload_bytes=? AND metadata_bytes=? AND last_operation_digest IS ?
          AND failure_reason=? AND last_error IS ?`)
        .run(
          input.runId,
          current.epoch_id,
          current.thread_id,
          current.mode,
          current.target_projection_version,
          current.algorithm_format,
          current.started_at,
          current.next_page,
          current.next_cursor,
          current.rows_staged,
          current.bytes_staged,
          current.max_observed_seq,
          current.checkpoint_json,
          current.checkpoint_digest,
          current.source_after_seq,
          current.fact_max_seq,
          current.revision_count,
          current.revision_payload_bytes,
          current.metadata_bytes,
          current.last_operation_digest,
          current.failure_reason,
          current.last_error,
        );
      if (result.changes !== 1) throw new Error("Retained projection resume compare-and-swap failed.");
    })();
    return this.getRetainedProjectionStage(input.runId)!;
  }

  /** Records a bounded, recoverable v5 source failure without changing the checkpoint. */
  failRetainedProjectionStage(
    input: OpenRetainedProjectionStage & {
      reason: RetainedProjectionFailureReason;
      error: string;
    },
  ): RetainedProjectionStageProgress {
    if (!RETAINED_PROJECTION_FAILURE_REASONS.has(input.reason)) {
      throw new Error("Invalid retained projection recoverable failure reason.");
    }
    if (typeof input.error !== "string" || input.error.length === 0) {
      throw new Error("Invalid retained projection recoverable failure detail.");
    }
    requireRetainedProjectionDomain(readRetainedStageRow(this.db, input.runId));
    const existing = this.getRetainedProjectionStage(input.runId);
    if (existing == null) throw new Error("Unknown retained projection stage.");
    const stage = this.openRetainedProjectionStage(input);
    if (stage.terminal) throw new RetainedProjectionTerminalError(stage.terminalReason);
    if (stage.state === "failed") {
      if (stage.failureReason !== input.reason) throw new Error("Conflicting retained projection failure replay.");
      return stage;
    }
    const result = this.db
      .prepare(`UPDATE analytics_retained_stage_runs SET state='failed',failure_reason=?,last_error=?
        WHERE run_id=? AND state='collecting' AND terminal_reason IS NULL
          AND epoch_id=? AND thread_id=? AND mode=? AND target_projection_version=?
          AND algorithm_format=? AND started_at=? AND next_page=?
          AND checkpoint_digest=? AND source_after_seq IS ?`)
      .run(
        input.reason,
        input.error.slice(0, 2_000),
        input.runId,
        input.epochId,
        input.threadId,
        input.mode,
        RETAINED_TARGET_PROJECTION_VERSION,
        RETAINED_PROJECTION_ALGORITHM,
        input.startedAt,
        stage.nextPage,
        stage.checkpointDigest,
        stage.sourceAfterSeq,
      );
    if (result.changes !== 1) {
      const current = this.getRetainedProjectionStage(input.runId);
      if (current?.terminal) throw new RetainedProjectionTerminalError(current.terminalReason);
      if (current?.state === "failed" && current.failureReason === input.reason) return current;
      throw new Error("Retained projection recoverable failure compare-and-swap failed.");
    }
    return this.getRetainedProjectionStage(input.runId)!;
  }

  /**
   * Closes a stage after its last committed page without inventing another
   * source page. This is the owner-side preflight for reduced or hard limits.
   */
  closeRetainedProjectionStageAtPageLimit(input: OpenRetainedProjectionStage): RetainedProjectionStageProgress {
    const stage = this.openRetainedProjectionStage(input);
    if (stage.terminal) {
      if (stage.terminalReason === "pages") return stage;
      throw new RetainedProjectionTerminalError(stage.terminalReason);
    }
    if (stage.state !== "collecting") throw new Error("Retained projection stage is not collecting.");
    if (stage.nextPage !== input.budget.maxPages) {
      throw new Error("Retained projection page limit is not yet committed.");
    }
    const result = this.db
      .prepare(`UPDATE analytics_retained_stage_runs
        SET state='failed',terminal_reason='pages',terminal_at=?,last_error=?
        WHERE run_id=? AND state='collecting' AND terminal_reason IS NULL
          AND epoch_id=? AND thread_id=? AND mode=?
          AND target_projection_version=? AND algorithm_format=? AND started_at=?
          AND next_page=? AND checkpoint_digest=? AND source_after_seq IS ?`)
      .run(
        Date.now(),
        "Retained projection page limit reached after the last committed page.",
        input.runId,
        input.epochId,
        input.threadId,
        input.mode,
        RETAINED_TARGET_PROJECTION_VERSION,
        RETAINED_PROJECTION_ALGORITHM,
        input.startedAt,
        stage.nextPage,
        stage.checkpointDigest,
        stage.sourceAfterSeq,
      );
    if (result.changes !== 1) {
      const current = this.getRetainedProjectionStage(input.runId);
      if (
        current?.terminal
        && current.terminalReason === "pages"
        && current.nextPage === stage.nextPage
        && current.checkpointDigest === stage.checkpointDigest
        && current.sourceAfterSeq === stage.sourceAfterSeq
      ) return current;
      throw new Error("Retained projection page-limit close lost its compare-and-swap.");
    }
    return this.getRetainedProjectionStage(input.runId)!;
  }

  getRetainedProjectionStage(runId: string): RetainedProjectionStageProgress | null {
    const row = this.db
      .prepare("SELECT * FROM analytics_retained_stage_runs WHERE run_id=?")
      .get(runId) as Record<string, unknown> | undefined;
    if (
      row == null
      || row.target_projection_version !== RETAINED_TARGET_PROJECTION_VERSION
      || row.algorithm_format !== RETAINED_PROJECTION_ALGORITHM
    ) return null;
    const budget: RetainedProjectionStageBudget = {
      maxPages: row.max_pages as number,
      maxRows: row.max_rows as number,
      maxBytes: row.max_bytes as number,
      maxCheckpointBytes: row.max_checkpoint_bytes as number,
      maxMetadataBytes: row.max_metadata_bytes as number,
      maxTurnStates: row.max_turn_states as number,
      maxTimingRefs: row.max_timing_refs as number,
      maxRevisions: row.max_revisions as number,
    };
    projectionBudget(budget);
    if (typeof row.checkpoint_json !== "string" || typeof row.checkpoint_digest !== "string") {
      throw new Error("Retained projection checkpoint is missing.");
    }
    const stored = parseStoredCheckpoint(row.checkpoint_json, budget);
    if (stored.digest !== row.checkpoint_digest) throw new Error("Retained projection checkpoint digest mismatch.");
    return {
      runId: row.run_id as string,
      threadId: row.thread_id as string,
      epochId: row.epoch_id as string,
      mode: row.mode as RetainedStageProgress["mode"],
      state: row.state as RetainedStageState,
      targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
      algorithm: RETAINED_PROJECTION_ALGORITHM,
      maxPages: budget.maxPages,
      maxRows: budget.maxRows,
      maxBytes: budget.maxBytes,
      maxCheckpointBytes: budget.maxCheckpointBytes,
      maxMetadataBytes: budget.maxMetadataBytes,
      maxTurnStates: budget.maxTurnStates,
      maxTimingRefs: budget.maxTimingRefs,
      maxRevisions: budget.maxRevisions,
      nextPage: row.next_page as number,
      sourceAfterSeq: row.source_after_seq as string | null,
      maxFactSeq: row.fact_max_seq as number | null,
      rows: row.rows_staged as number,
      bytes: row.bytes_staged as number,
      revisionCount: row.revision_count as number,
      revisionPayloadBytes: row.revision_payload_bytes as number,
      metadataBytes: row.metadata_bytes as number,
      checkpoint: stored.checkpoint,
      checkpointDigest: stored.digest,
      lastOperationDigest: row.last_operation_digest as string | null,
      revisitReasons: stored.checkpoint.revisitReasons,
      rewriteRequired: stored.checkpoint.rewriteRequired,
      rewriteDirective: stored.checkpoint.rewriteDirective,
      terminalReason: row.terminal_reason as RetainedProjectionStageProgress["terminalReason"],
      terminal: row.terminal_reason != null,
      failureReason: row.failure_reason as RetainedProjectionFailureReason | null,
      error: row.last_error as string | null,
    };
  }

  private validateLegacyRetainedStageOpenInput(input: OpenRetainedStage): void {
    if (
      ![input.runId, input.epochId, input.threadId].every(
        (value) => value.length > 0
          && Buffer.byteLength(value, "utf8") <= RETAINED_STAGE_HARD_LIMITS.maxIdentifierBytes,
      )
    ) throw new Error("Invalid retained stage identifier.");
    if (
      !Number.isSafeInteger(input.targetProjectionVersion)
      || input.targetProjectionVersion <= 0
      || !Number.isSafeInteger(input.startedAt)
      || ![input.budget.maxPages, input.budget.maxRows, input.budget.maxBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
      || input.budget.maxPages > RETAINED_STAGE_HARD_LIMITS.maxPages
      || input.budget.maxRows > RETAINED_STAGE_HARD_LIMITS.maxRows
      || input.budget.maxBytes > RETAINED_STAGE_HARD_LIMITS.maxBytes
      || !["delta", "rewrite", "upgrade"].includes(input.mode)
    ) throw new Error("Invalid retained stage budget/version.");
  }

  /** Persistent projected-fact staging only; it never changes active facts/index state. */
  openRetainedStage(input: OpenRetainedStage): RetainedStageProgress {
    this.validateLegacyRetainedStageOpenInput(input);
    requireRetainedStageAlgorithm(readRetainedStageRow(this.db, input.runId), LEGACY_RETAINED_STAGE_ALGORITHM);
    this.db.transaction(() => {
      this.prepareRetainedStageAccountingOnce();
      const existing = this.getRetainedStage(input.runId);
      if (existing != null) {
        if (
          existing.threadId !== input.threadId
          || existing.epochId !== input.epochId
          || existing.mode !== input.mode
          || existing.targetProjectionVersion !== input.targetProjectionVersion
          || existing.maxPages !== input.budget.maxPages
          || existing.maxRows !== input.budget.maxRows
          || existing.maxBytes !== input.budget.maxBytes
        ) throw new Error("Conflicting retained stage replay.");
        return;
      }
      const epochThread = this.db
        .prepare("SELECT run_id FROM analytics_retained_stage_runs WHERE epoch_id = ? AND thread_id = ?")
        .get(input.epochId, input.threadId) as { run_id: string } | undefined;
      if (epochThread != null) throw new Error("Conflicting retained stage epoch/thread.");
      this.db
        .prepare(`INSERT INTO analytics_retained_stage_runs (run_id,epoch_id,thread_id,mode,state,target_projection_version,algorithm_format,max_pages,max_rows,max_bytes,started_at) VALUES (?,?,?,?,'collecting',?,?,?,?,?,?)`)
        .run(
          input.runId,
          input.epochId,
          input.threadId,
          input.mode,
          input.targetProjectionVersion,
          LEGACY_RETAINED_STAGE_ALGORITHM,
          input.budget.maxPages,
          input.budget.maxRows,
          input.budget.maxBytes,
          input.startedAt,
        );
    })();
    return this.getRetainedStage(input.runId)!;
  }

  /** Reopen only the same persisted stage; callers cannot substitute its identity or limits. */
  resumeRetainedStage(input: OpenRetainedStage): RetainedStageProgress {
    this.validateLegacyRetainedStageOpenInput(input);
    requireRetainedStageAlgorithm(readRetainedStageRow(this.db, input.runId), LEGACY_RETAINED_STAGE_ALGORITHM);
    this.db.transaction(() => {
      this.prepareRetainedStageAccountingOnce();
      const existing = readRetainedStageRow(this.db, input.runId) as Record<string, unknown> | null;
      if (existing == null) {
        const epochThread = this.db
          .prepare("SELECT run_id FROM analytics_retained_stage_runs WHERE epoch_id=? AND thread_id=?")
          .get(input.epochId, input.threadId) as { run_id: string } | undefined;
        if (epochThread != null) throw new Error("Conflicting retained stage epoch/thread.");
        this.db.prepare(`INSERT INTO analytics_retained_stage_runs
          (run_id,epoch_id,thread_id,mode,state,target_projection_version,algorithm_format,max_pages,max_rows,max_bytes,started_at)
          VALUES (?,?,?,?,'collecting',?,?,?,?,?,?)`).run(
          input.runId,
          input.epochId,
          input.threadId,
          input.mode,
          input.targetProjectionVersion,
          LEGACY_RETAINED_STAGE_ALGORITHM,
          input.budget.maxPages,
          input.budget.maxRows,
          input.budget.maxBytes,
          input.startedAt,
        );
        return;
      }
      if (
        existing.algorithm_format !== LEGACY_RETAINED_STAGE_ALGORITHM
        || existing.epoch_id !== input.epochId
        || existing.thread_id !== input.threadId
        || existing.mode !== input.mode
        || existing.target_projection_version !== input.targetProjectionVersion
        || existing.max_pages !== input.budget.maxPages
        || existing.max_rows !== input.budget.maxRows
        || existing.max_bytes !== input.budget.maxBytes
        || existing.started_at !== input.startedAt
      ) throw new Error("Conflicting retained stage replay.");
      if (existing.state === "collecting") return;
      if (existing.state !== "failed") throw new Error("Retained stage is unavailable for resume.");
      const result = this.db.prepare(`UPDATE analytics_retained_stage_runs SET state='collecting',last_error=NULL
        WHERE run_id=? AND epoch_id=? AND thread_id=? AND mode=? AND target_projection_version=?
          AND algorithm_format=? AND started_at=? AND state='failed'
          AND next_page=? AND next_cursor IS ? AND rows_staged=? AND bytes_staged=?
          AND max_observed_seq IS ? AND last_error IS ?`)
        .run(
          input.runId,
          existing.epoch_id,
          existing.thread_id,
          existing.mode,
          existing.target_projection_version,
          existing.algorithm_format,
          existing.started_at,
          existing.next_page,
          existing.next_cursor,
          existing.rows_staged,
          existing.bytes_staged,
          existing.max_observed_seq,
          existing.last_error,
        );
      if (result.changes !== 1) throw new Error("Retained stage resume compare-and-swap failed.");
    })();
    return this.getRetainedStage(input.runId)!;
  }

  appendRetainedStagePage(input: RetainedStagePage): RetainedStageProgress {
    requireRetainedStageAlgorithm(readRetainedStageRow(this.db, input.runId), LEGACY_RETAINED_STAGE_ALGORITHM);
    this.prepareRetainedStageAccountingOnce();
    const stage = this.getRetainedStage(input.runId);
    if (stage == null || stage.threadId !== input.threadId || stage.state !== "collecting") {
      throw new Error("Retained stage is unavailable for append.");
    }
    if (input.page < 0 || !Number.isSafeInteger(input.page)) throw new Error("Out-of-order retained stage page.");
    if (input.facts.length > RETAINED_STAGE_HARD_LIMITS.maxPageRows) {
      throw new Error("Retained stage page exceeds the configured row limit.");
    }
    if (
      !Number.isSafeInteger(input.receivedAt)
      || ![input.cursorIn, input.cursorOut].every(
        (cursor) => cursor == null
          || (typeof cursor === "string"
            && Buffer.byteLength(cursor, "utf8") <= RETAINED_STAGE_HARD_LIMITS.maxCursorBytes),
      )
    ) throw new Error("Invalid retained stage page metadata.");

    const pageHasher = createHash("sha256");
    pageHasher.update(`{"cursorIn":${JSON.stringify(input.cursorIn)},"cursorOut":${JSON.stringify(input.cursorOut)},"facts":[`);
    const pageFacts = new Map<string, CanonicalRetainedStageFact>();
    let processedBytes = 0;
    let factIndex = 0;
    for (const fact of input.facts) {
      const canonical = canonicalizeRetainedStageFact(fact);
      if (canonical.threadId !== input.threadId) throw new Error("Retained stage fact-thread mismatch.");
      pageHasher.update(factIndex === 0 ? "" : ",");
      pageHasher.update(canonical.json);
      factIndex += 1;
      processedBytes += canonical.bytes;
      if (processedBytes > RETAINED_STAGE_HARD_LIMITS.maxPageBytes) {
        throw new Error("Retained stage page exceeds the configured byte limit.");
      }
      const duplicate = pageFacts.get(canonical.sourceEventId);
      if (duplicate != null && duplicate.json !== canonical.json) throw new Error("Conflicting retained stage fact replay.");
      if (duplicate == null) pageFacts.set(canonical.sourceEventId, canonical);
    }
    pageHasher.update("]}");
    const pageDigest = pageHasher.digest("hex");
    const prior = this.db
      .prepare("SELECT page_digest FROM analytics_retained_stage_pages WHERE run_id = ? AND page = ?")
      .get(input.runId, input.page) as { page_digest: string } | undefined;
    if (prior != null) {
      if (prior.page_digest !== pageDigest) throw new Error("Conflicting retained stage page replay.");
      return this.getRetainedStage(input.runId)!;
    }
    if (input.cursorIn !== stage.nextCursor || input.page !== stage.nextPage) throw new Error("Out-of-order retained stage page.");
    if (stage.nextPage >= stage.maxPages) throw new Error("Retained stage page budget exceeded.");

    const publish = this.db.transaction(() => {
      const owned = this.db
        .prepare(`SELECT run_id,epoch_id,thread_id,mode,target_projection_version,algorithm_format,state,
            next_page,next_cursor,rows_staged,bytes_staged,max_observed_seq,max_pages,max_rows,max_bytes
          FROM analytics_retained_stage_runs WHERE run_id=?`)
        .get(input.runId) as {
          run_id: string;
          epoch_id: string;
          thread_id: string;
          mode: string;
          target_projection_version: number;
          algorithm_format: string;
          state: string;
          next_page: number;
          next_cursor: string | null;
          rows_staged: number;
          bytes_staged: number;
          max_observed_seq: number | null;
          max_pages: number;
          max_rows: number;
          max_bytes: number;
        } | undefined;
      if (
        owned == null
        || owned.algorithm_format !== LEGACY_RETAINED_STAGE_ALGORITHM
        || owned.epoch_id !== stage.epochId
        || owned.thread_id !== input.threadId
        || owned.mode !== stage.mode
        || owned.target_projection_version !== stage.targetProjectionVersion
        || owned.state !== "collecting"
        || owned.next_page !== input.page
        || owned.next_cursor !== input.cursorIn
        || owned.max_pages !== stage.maxPages
        || owned.max_rows !== stage.maxRows
        || owned.max_bytes !== stage.maxBytes
      ) {
        throw new Error("Retained stage algorithm domain mismatch; expected legacy-retained-stage-v1.");
      }
      const current = owned;
      const replayPage = this.db
        .prepare("SELECT page_digest FROM analytics_retained_stage_pages WHERE run_id=? AND page=?")
        .get(input.runId, input.page) as { page_digest: string } | undefined;
      if (replayPage != null) {
        if (replayPage.page_digest !== pageDigest) throw new Error("Conflicting retained stage page replay.");
        return;
      }
      const fact = this.db.prepare(
        "INSERT INTO analytics_retained_stage_facts (run_id,source_event_id,thread_id,fact_json,fact_digest) VALUES (?,?,?,?,?)",
      );
      const existingFact = this.db.prepare(
        "SELECT fact_digest FROM analytics_retained_stage_facts WHERE run_id = ? AND source_event_id = ?",
      );
      let insertedRows = 0;
      let insertedBytes = 0;
      let maxSequence = current.max_observed_seq;
      for (const canonical of pageFacts.values()) {
        const digest = createHash("sha256").update(canonical.json).digest("hex");
        const existing = existingFact.get(input.runId, canonical.sourceEventId) as { fact_digest: string } | undefined;
        if (existing != null) {
          if (existing.fact_digest !== digest) throw new Error("Conflicting retained stage fact replay.");
          continue;
        }
        if (
          current.rows_staged + insertedRows + 1 > current.max_rows
          || current.bytes_staged + insertedBytes + canonical.bytes > current.max_bytes
        ) throw new Error("Retained stage row/byte budget exceeded.");
        fact.run(input.runId, canonical.sourceEventId, input.threadId, canonical.json, digest);
        insertedRows += 1;
        insertedBytes += canonical.bytes;
        maxSequence = maxSequence == null ? canonical.sequence : Math.max(maxSequence, canonical.sequence);
      }
      this.db
        .prepare("INSERT INTO analytics_retained_stage_pages (run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(input.runId, input.page, input.cursorIn, input.cursorOut, insertedRows, insertedBytes, pageDigest, input.receivedAt);
      const update = this.db
        .prepare(`UPDATE analytics_retained_stage_runs SET
            next_page=?,next_cursor=?,rows_staged=rows_staged+?,bytes_staged=bytes_staged+?,max_observed_seq=?
          WHERE run_id=? AND epoch_id=? AND thread_id=? AND mode=? AND target_projection_version=?
            AND algorithm_format=? AND state='collecting' AND next_page=? AND next_cursor IS ?
            AND rows_staged=? AND bytes_staged=? AND max_observed_seq IS ?
            AND max_pages=? AND max_rows=? AND max_bytes=?`)
        .run(
          input.page + 1,
          input.cursorOut,
          insertedRows,
          insertedBytes,
          maxSequence,
          input.runId,
          current.epoch_id,
          current.thread_id,
          current.mode,
          current.target_projection_version,
          current.algorithm_format,
          current.next_page,
          current.next_cursor,
          current.rows_staged,
          current.bytes_staged,
          current.max_observed_seq,
          current.max_pages,
          current.max_rows,
          current.max_bytes,
        );
      if (update.changes !== 1) throw new Error("Retained stage compare-and-swap failed.");
    });
    publish();
    return this.getRetainedStage(input.runId)!;
  }

  /**
   * Atomically appends one version-5 projected page. The submitted request
   * digest is checked before any current-fact or revision-digest lookup, so a
   * byte-identical retry is a no-op even though its expected digests are now
   * stale. The returned checkpoint is a new durable value; input is never
   * mutated in place.
   */
  private closeRetainedProjectionBudget(
    runId: string,
    reason: NonNullable<RetainedProjectionStageProgress["terminalReason"]>,
    message: string,
    fence: RetainedProjectionBudgetFence,
  ): void {
    const result = this.db
      .prepare(`UPDATE analytics_retained_stage_runs
        SET state='failed',terminal_reason=?,terminal_at=?,last_error=?
        WHERE run_id=? AND state='collecting' AND terminal_reason IS NULL
          AND target_projection_version=? AND algorithm_format=?
          AND thread_id=? AND mode=? AND next_page=?
          AND checkpoint_digest=? AND source_after_seq IS ?`)
      .run(
        reason,
        Date.now(),
        message.slice(0, 2_000),
        runId,
        RETAINED_TARGET_PROJECTION_VERSION,
        RETAINED_PROJECTION_ALGORITHM,
        fence.threadId,
        fence.mode,
        fence.page,
        fence.checkpointDigest,
        fence.cursor,
      );
    if (result.changes !== 1) {
      const row = this.db
        .prepare("SELECT terminal_reason,state,next_page,checkpoint_digest,source_after_seq,target_projection_version,algorithm_format,thread_id,mode FROM analytics_retained_stage_runs WHERE run_id=?")
        .get(runId) as {
          terminal_reason: string | null;
          state: string;
          next_page: number;
          checkpoint_digest: string;
          source_after_seq: string | null;
          target_projection_version: number;
          algorithm_format: string;
          thread_id: string;
          mode: string;
        } | undefined;
      if (
        row?.state !== "failed"
        || row.terminal_reason !== reason
        || row.next_page !== fence.page
        || row.checkpoint_digest !== fence.checkpointDigest
        || row.source_after_seq !== fence.cursor
        || row.target_projection_version !== RETAINED_TARGET_PROJECTION_VERSION
        || row.algorithm_format !== RETAINED_PROJECTION_ALGORITHM
        || row.thread_id !== fence.threadId
        || row.mode !== fence.mode
      ) throw new Error("Retained projection terminal close lost its compare-and-swap.");
    }
  }

  appendRetainedProjectionStagePage(input: RetainedProjectionStagePage): RetainedProjectionStageProgress {
    if (
      input == null
      || input.targetProjectionVersion !== RETAINED_TARGET_PROJECTION_VERSION
      || input.algorithm !== RETAINED_PROJECTION_ALGORITHM
      || !validStageMode(input.mode)
      || !validStageIdentifier(input.runId)
      || !validStageIdentifier(input.threadId)
      || !Number.isSafeInteger(input.page)
      || input.page < 0
      || !Number.isSafeInteger(input.receivedAt)
      || input.source == null
      || typeof input.source !== "object"
      || !Array.isArray(input.facts)
      || !Array.isArray(input.timestampRevisions)
      || !Array.isArray(input.refReleases)
    ) throw new Error("Invalid retained projection page identity.");
    if (input.facts.length > RETAINED_STAGE_HARD_LIMITS.maxPageRows) {
      throw new Error("Retained projection page exceeds the configured row limit.");
    }
    if (input.timestampRevisions.length > RETAINED_STAGE_HARD_LIMITS.maxRevisions) {
      throw new Error("Retained projection page exceeds the configured revision limit.");
    }
    if (input.refReleases.length > RETAINED_STAGE_HARD_LIMITS.maxTimingRefs) {
      throw new Error("Retained projection page exceeds the configured ref-release limit.");
    }
    projectionDigest(input.checkpointDigestIn);
    projectionDigest(input.source.pageDigest);
    const cursorIn = validProjectionCursor(input.source.cursorIn, "input cursor");
    const cursorOut = validProjectionCursor(input.source.cursorOut, "output cursor");
    if (cursorIn !== input.source.cursorIn || cursorOut !== input.source.cursorOut) {
      throw new Error("Retained projection cursors are not canonical.");
    }
    if (typeof input.source.pageExhausted !== "boolean") throw new Error("Invalid retained projection page exhaustion flag.");

    const rawStage = readRetainedStageRow(this.db, input.runId);
    requireRetainedProjectionDomain(rawStage);
    if (rawStage == null) throw new Error("Retained projection stage is unavailable for append.");
    this.prepareRetainedStageAccountingOnce();
    if (rawStage.terminal_reason != null) {
      throw new RetainedProjectionTerminalError(rawStage.terminal_reason as RetainedProjectionStageProgress["terminalReason"]);
    }
    const budget: RetainedProjectionStageBudget = {
      maxPages: rawStage.max_pages as number,
      maxRows: rawStage.max_rows as number,
      maxBytes: rawStage.max_bytes as number,
      maxCheckpointBytes: rawStage.max_checkpoint_bytes as number,
      maxMetadataBytes: rawStage.max_metadata_bytes as number,
      maxTurnStates: rawStage.max_turn_states as number,
      maxTimingRefs: rawStage.max_timing_refs as number,
      maxRevisions: rawStage.max_revisions as number,
    };
    projectionBudget(budget);
    const candidateWithMetadata = canonicalizeRetainedProjectionCheckpoint(input.checkpoint, budget);
    const candidate = checkpointWithoutDigestMetadata(candidateWithMetadata);
    const canonicalFacts = input.facts.map((fact) => canonicalizeRetainedStageFact(fact));
    const factIds = new Set<string>();
    for (const fact of canonicalFacts) {
      if (fact.threadId !== input.threadId) throw new Error("Retained projection fact-thread mismatch.");
      if (factIds.has(fact.sourceEventId)) throw new Error("Duplicate retained projection fact.");
      factIds.add(fact.sourceEventId);
    }
    const canonicalRevisions = input.timestampRevisions.map((revision) => canonicalizeRetainedTimestampRevision(revision));
    const revisionKeys = new Set<string>();
    const revisionSources = new Set<string>();
    for (const revision of canonicalRevisions) {
      if (revisionKeys.has(revision.revision.revisionKey)) throw new Error("Duplicate retained projection revision key.");
      if (revisionSources.has(revision.revision.sourceEventId)) throw new Error("Multiple retained revisions target one fact in a page.");
      revisionKeys.add(revision.revision.revisionKey);
      revisionSources.add(revision.revision.sourceEventId);
      if (
        revision.revision.turnStartedAtMs != null
        && revision.revision.turnCompletedAtMs != null
        && revision.revision.turnCompletedAtMs < revision.revision.turnStartedAtMs
      ) throw new Error("Retained projection revision contains inverted timing.");
    }
    const canonicalRefReleases = input.refReleases.map((release) => canonicalizeRetainedRefRelease(release));
    const releaseSources = new Set<string>();
    for (const release of canonicalRefReleases) {
      if (releaseSources.has(release.sourceEventId)) throw new Error("Duplicate retained projection ref release.");
      releaseSources.add(release.sourceEventId);
    }

    const requestPayload = {
      runId: input.runId,
      threadId: input.threadId,
      mode: input.mode,
      targetProjectionVersion: input.targetProjectionVersion,
      algorithm: input.algorithm,
      page: input.page,
      checkpointDigestIn: input.checkpointDigestIn,
      source: { ...input.source, cursorIn, cursorOut },
      facts: canonicalFacts.map((fact) => fact.json),
      timestampRevisions: canonicalRevisions.map((revision) => revision.json),
      refReleases: canonicalRefReleases,
      checkpoint: candidateWithMetadata.json,
      receivedAt: input.receivedAt,
    };
    const requestDigest = sha256(JSON.stringify(requestPayload));
    const priorPage = this.db
      .prepare("SELECT request_digest FROM analytics_retained_stage_pages WHERE run_id=? AND page=?")
      .get(input.runId, input.page) as { request_digest: string } | undefined;
    if (priorPage != null) {
      if (priorPage.request_digest !== requestDigest) throw new Error("Conflicting retained projection page replay.");
      return this.getRetainedProjectionStage(input.runId)!;
    }

    const validateRefs = (
      checkpoint: RetainedProjectionCheckpoint,
      facts: Map<string, StoredProjectionFact>,
      allowDigestMismatch: ReadonlySet<string> = new Set(),
    ): void => {
      const turns = new Map(checkpoint.turns.map((turn) => [turn.turnId, turn]));
      for (const ref of checkpoint.timingRefs) {
        const fact = facts.get(ref.sourceEventId);
        const turn = turns.get(ref.turnId);
        const timingMatches = turn != null
          && (turn.status === "degraded"
            ? ref.turnStartedAtMs === null && ref.turnCompletedAtMs === null
            : ref.turnStartedAtMs === turn.startedAtMs && ref.turnCompletedAtMs === turn.completedAtMs);
        if (
          fact == null
          || fact.value.threadId !== input.threadId
          || fact.value.turnId !== ref.turnId
          || fact.canonical.sequence !== ref.sequence
          || (fact.digest !== ref.factDigest && !allowDigestMismatch.has(ref.sourceEventId))
          || fact.value.turnStartedAtMs !== ref.turnStartedAtMs
          || fact.value.turnCompletedAtMs !== ref.turnCompletedAtMs
          || turn == null
          || turn.status === "complete"
          || ref.sequence > turn.lastSeenSeq
          || !timingMatches
        ) throw new Error("Retained projection timing ref does not match staged fact and turn state.");
      }
    };

    let terminalBudget: RetainedProjectionBudgetError | null = null;
    let terminalFence: RetainedProjectionBudgetFence | null = null;
    try {
      const publish = this.db.transaction(() => {
        const currentRow = this.db
          .prepare("SELECT * FROM analytics_retained_stage_runs WHERE run_id=?")
          .get(input.runId) as Record<string, unknown> | undefined;
        if (
          currentRow == null
          || currentRow.state !== "collecting"
          || currentRow.terminal_reason != null
          || currentRow.thread_id !== input.threadId
          || currentRow.mode !== input.mode
          || currentRow.target_projection_version !== RETAINED_TARGET_PROJECTION_VERSION
          || currentRow.algorithm_format !== RETAINED_PROJECTION_ALGORITHM
        ) throw new Error("Retained projection stage is unavailable for append.");
        const currentBudget: RetainedProjectionStageBudget = {
          maxPages: currentRow.max_pages as number,
          maxRows: currentRow.max_rows as number,
          maxBytes: currentRow.max_bytes as number,
          maxCheckpointBytes: currentRow.max_checkpoint_bytes as number,
          maxMetadataBytes: currentRow.max_metadata_bytes as number,
          maxTurnStates: currentRow.max_turn_states as number,
          maxTimingRefs: currentRow.max_timing_refs as number,
          maxRevisions: currentRow.max_revisions as number,
        };
        projectionBudget(currentBudget);
        if (
          input.page !== currentRow.next_page
          || (currentRow.source_after_seq as string | null) !== cursorIn
          || (currentRow.checkpoint_digest as string) !== input.checkpointDigestIn
        ) throw new Error("Out-of-order or stale retained projection checkpoint.");
        terminalFence = {
          page: input.page,
          cursor: cursorIn,
          checkpointDigest: input.checkpointDigestIn,
          threadId: input.threadId,
          mode: input.mode,
        };
        if (input.page >= currentBudget.maxPages) throw new RetainedProjectionBudgetError("pages");
        const priorStored = parseStoredCheckpoint(currentRow.checkpoint_json as string, currentBudget);
        if (
          priorStored.checkpoint.runId !== input.runId
          || priorStored.checkpoint.threadId !== input.threadId
          || priorStored.checkpoint.mode !== input.mode
          || !reasonsSuperset(priorStored.checkpoint.revisitReasons, candidate.revisitReasons)
        ) throw new Error("Retained projection checkpoint identity or sticky reason mismatch.");
        if (
          candidate.nextStagePage !== input.page + 1
          || candidate.sourceAfterSeq !== cursorOut
          || candidate.runId !== input.runId
          || candidate.threadId !== input.threadId
          || candidate.mode !== input.mode
        ) throw new Error("Retained projection checkpoint does not own this page.");

        const facts = readProjectionFacts(this.db, input.runId);
        const priorRows = facts.size;
        const priorBytes = [...facts.values()].reduce((sum, fact) => sum + fact.canonical.bytes, 0);
        const priorMaxFactSeq = [...facts.values()].reduce<number | null>(
          (max, fact) => max == null ? fact.canonical.sequence : Math.max(max, fact.canonical.sequence),
          null,
        );
        if (
          priorRows !== currentRow.rows_staged
          || priorBytes !== currentRow.bytes_staged
          || priorMaxFactSeq !== currentRow.max_observed_seq
          || priorMaxFactSeq !== currentRow.fact_max_seq
        ) throw new Error("Retained projection stage counters are inconsistent.");

        validateRefs(priorStored.checkpoint, facts);
        const priorRefs = new Map(priorStored.checkpoint.timingRefs.map((ref) => [ref.sourceEventId, ref]));
        const candidateRefs = new Map(candidate.timingRefs.map((ref) => [ref.sourceEventId, ref]));
        const candidateTurns = new Map(candidate.turns.map((turn) => [turn.turnId, turn]));
        const releases = new Map(canonicalRefReleases.map((release) => [release.sourceEventId, release]));
        const pageFacts = new Map(canonicalFacts.map((fact) => [fact.sourceEventId, JSON.parse(fact.json) as ToolExecutionFact]));
        const revisionsBySource = new Map<string, RetainedTimestampRevision>();
        for (const revision of canonicalRevisions) revisionsBySource.set(revision.revision.sourceEventId, revision.revision);

        for (const release of canonicalRefReleases) {
          const priorRef = priorRefs.get(release.sourceEventId);
          if (candidateRefs.has(release.sourceEventId)) {
            throw new Error("Retained projection ref release does not target exactly one prior ref.");
          }
          if (priorRef == null) {
            const pageFact = pageFacts.get(release.sourceEventId);
            const pageTurn = pageFact?.turnId == null ? undefined : candidateTurns.get(pageFact.turnId);
            const capWithoutTurnState = pageTurn == null
              && pageFact?.turnId != null
              && release.reason !== "completed"
              && candidate.rewriteRequired
              && candidate.rewriteDirective != null
              && candidate.rewriteDirective.reasons.includes(release.reason)
              && !revisionsBySource.has(release.sourceEventId);
            const pageTiming = pageTurn?.status === "degraded"
              ? { startedAtMs: null, completedAtMs: null }
              : { startedAtMs: pageTurn?.startedAtMs ?? null, completedAtMs: pageTurn?.completedAtMs ?? null };
            if (
              release.reason === "completed"
              || pageFact == null
              || pageTurn?.status === "complete"
              || !candidate.rewriteRequired
              || candidate.rewriteDirective == null
              || !candidate.rewriteDirective.reasons.includes(release.reason)
              || revisionsBySource.has(release.sourceEventId)
              || (!capWithoutTurnState && pageTurn == null)
              || (!capWithoutTurnState && pageFact.turnStartedAtMs !== pageTiming.startedAtMs)
              || (!capWithoutTurnState && pageFact.turnCompletedAtMs !== pageTiming.completedAtMs)
            ) throw new Error("Retained projection ref release does not target a prior or same-page capped ref.");
            continue;
          }
          const turn = candidateTurns.get(priorRef.turnId);
          const revision = revisionsBySource.get(release.sourceEventId);
          if (release.reason === "completed") {
            if (
              turn == null
              || turn.status !== "complete"
              || turn.degraded
              || revision == null
              || revision.turnId !== priorRef.turnId
              || revision.sequence !== priorRef.sequence
              || revision.expectedFactDigest !== priorRef.factDigest
              || revision.turnStartedAtMs !== turn.startedAtMs
              || revision.turnCompletedAtMs !== turn.completedAtMs
              || turn.revisionSeq == null
              || revision.timingRevisionSeq !== turn.revisionSeq
            ) throw new Error("Completed retained ref release is not linked to its candidate turn revision.");
          } else if (
            !candidate.rewriteRequired
            || candidate.rewriteDirective == null
            || !candidate.rewriteDirective.reasons.includes(release.reason)
            || revision != null
          ) throw new Error("Capped retained ref release lacks an exact rewrite directive.");
        }
        for (const [sourceEventId, priorRef] of priorRefs) {
          const candidateRef = candidateRefs.get(sourceEventId);
          const release = releases.get(sourceEventId);
          if (candidateRef == null && release == null) {
            throw new Error("Retained projection checkpoint dropped a ref without release evidence.");
          }
          if (candidateRef != null && release != null) {
            throw new Error("Retained projection ref cannot be both retained and released.");
          }
          if (candidateRef != null && candidateRef.turnId !== priorRef.turnId) {
            throw new Error("Retained projection ref changed turn identity.");
          }
        }
        for (const revision of canonicalRevisions) {
          const value = revision.revision;
          const priorRef = priorRefs.get(value.sourceEventId);
          const turn = candidateTurns.get(value.turnId);
          const candidateRef = candidateRefs.get(value.sourceEventId);
          if (
            priorRef == null
            || priorRef.factDigest !== value.expectedFactDigest
            || priorRef.turnId !== value.turnId
            || priorRef.sequence !== value.sequence
            || factIds.has(value.sourceEventId)
            || turn == null
            || turn.revisionSeq == null
            || value.timingRevisionSeq !== turn.revisionSeq
            || value.sequence > turn.lastSeenSeq
            || value.turnStartedAtMs !== (turn.status === "degraded" ? null : turn.startedAtMs)
            || value.turnCompletedAtMs !== (turn.status === "degraded" ? null : turn.completedAtMs)
            || (turn.status === "complete" ? candidateRef != null : candidateRef == null)
          ) throw new Error("Retained projection revision is not linked to candidate turn state.");
        }
        const insertFact = this.db.prepare(
          "INSERT INTO analytics_retained_stage_facts (run_id,source_event_id,thread_id,fact_json,fact_digest) VALUES (?,?,?,?,?)",
        );
        let insertedRows = 0;
        let insertedBytes = 0;
        for (const fact of canonicalFacts) {
          const digest = sha256(fact.json);
          const existing = facts.get(fact.sourceEventId);
          if (existing != null) {
            if (existing.digest !== digest) throw new Error("Conflicting retained projection fact replay.");
            continue;
          }
          insertFact.run(input.runId, fact.sourceEventId, input.threadId, fact.json, digest);
          facts.set(fact.sourceEventId, {
            sourceEventId: fact.sourceEventId,
            json: fact.json,
            digest,
            canonical: fact,
            value: JSON.parse(fact.json) as ToolExecutionFact,
          });
          insertedRows += 1;
          insertedBytes += fact.bytes;
        }

        const updateFact = this.db.prepare(
          "UPDATE analytics_retained_stage_facts SET fact_json=?,fact_digest=? WHERE run_id=? AND source_event_id=?",
        );
        const insertRevision = this.db.prepare(
          `INSERT INTO analytics_retained_stage_revisions (
            run_id,revision_key,source_event_id,revision_json,revision_digest,
            expected_fact_digest,resulting_fact_digest,payload_bytes,bytes_delta
          ) VALUES (?,?,?,?,?,?,?,?,?)`,
        );
        const revisionResults = new Map<string, string>();
        let newRevisionCount = 0;
        let newRevisionPayloadBytes = 0;
        let revisionBytesDelta = 0;
        for (const canonicalRevision of canonicalRevisions) {
          const value = canonicalRevision.revision;
          const payload = revisionPayload(value);
          const priorRevision = this.db
            .prepare("SELECT revision_json,revision_digest,resulting_fact_digest FROM analytics_retained_stage_revisions WHERE run_id=? AND revision_key=?")
            .get(input.runId, value.revisionKey) as { revision_json: string; revision_digest: string; resulting_fact_digest: string } | undefined;
          if (priorRevision != null) {
            if (priorRevision.revision_digest !== payload.digest || priorRevision.revision_json !== payload.json) {
              throw new Error("Conflicting retained projection revision replay.");
            }
            revisionResults.set(value.sourceEventId, priorRevision.resulting_fact_digest);
            continue;
          }
          const current = facts.get(value.sourceEventId);
          if (current == null || current.digest !== value.expectedFactDigest) {
            throw new Error("Stale retained projection revision fact digest.");
          }
          if (
            current.canonical.threadId !== input.threadId
            || current.canonical.sourceEventId !== value.sourceEventId
            || current.value.turnId !== value.turnId
            || current.canonical.sequence !== value.sequence
          ) throw new Error("Retained projection revision fact identity mismatch.");
          const revisedFactValue: ToolExecutionFact = {
            ...current.value,
            turnStartedAtMs: value.turnStartedAtMs,
            turnCompletedAtMs: value.turnCompletedAtMs,
          };
          const revised = canonicalizeRetainedStageFact(revisedFactValue);
          const resultingDigest = sha256(revised.json);
          const bytesDelta = revised.bytes - current.canonical.bytes;
          updateFact.run(revised.json, resultingDigest, input.runId, value.sourceEventId);
          facts.set(value.sourceEventId, {
            sourceEventId: value.sourceEventId,
            json: revised.json,
            digest: resultingDigest,
            canonical: revised,
            value: JSON.parse(revised.json) as ToolExecutionFact,
          });
          insertRevision.run(
            input.runId,
            value.revisionKey,
            value.sourceEventId,
            payload.json,
            payload.digest,
            value.expectedFactDigest,
            resultingDigest,
            payload.bytes,
            bytesDelta,
          );
          revisionResults.set(value.sourceEventId, resultingDigest);
          newRevisionCount += 1;
          newRevisionPayloadBytes += payload.bytes;
          revisionBytesDelta += bytesDelta;
        }

        const normalizedRefs = candidate.timingRefs.map((ref) => {
          const resultingDigest = revisionResults.get(ref.sourceEventId);
          return resultingDigest == null ? ref : { ...ref, factDigest: resultingDigest };
        });
        const normalizedCheckpointCandidate = canonicalizeRetainedProjectionCheckpoint({
          ...candidate,
          timingRefs: normalizedRefs,
        }, currentBudget);
        const normalizedCheckpoint = checkpointWithoutDigestMetadata(normalizedCheckpointCandidate);
        const normalizedCheckpointInfo = checkpointDigest(normalizedCheckpoint);
        validateRefs(normalizedCheckpoint, facts);

        const rows = facts.size;
        const bytes = [...facts.values()].reduce((sum, fact) => sum + fact.canonical.bytes, 0);
        const maxFactSeq = [...facts.values()].reduce<number | null>(
          (max, fact) => max == null ? fact.canonical.sequence : Math.max(max, fact.canonical.sequence),
          null,
        );
        if (normalizedCheckpoint.maxFactSeq !== maxFactSeq) throw new Error("Retained projection checkpoint maxFactSeq mismatch.");
        if (rows > currentBudget.maxRows) throw new RetainedProjectionBudgetError("rows");
        if (bytes > currentBudget.maxBytes) throw new RetainedProjectionBudgetError("bytes");
        if (currentRow.revision_count as number + newRevisionCount > currentBudget.maxRevisions) {
          throw new RetainedProjectionBudgetError("revisions");
        }
        const pageFactBytes = canonicalFacts.reduce((sum, fact) => sum + fact.bytes, 0);
        if (pageFactBytes > RETAINED_STAGE_HARD_LIMITS.maxPageBytes) throw new RetainedProjectionBudgetError("bytes");
        if (newRevisionPayloadBytes > RETAINED_STAGE_HARD_LIMITS.maxPageBytes) throw new RetainedProjectionBudgetError("revisions");
        const metadataBytes = (currentRow.metadata_bytes as number) + normalizedCheckpointInfo.bytes + newRevisionPayloadBytes;
        if (metadataBytes > currentBudget.maxMetadataBytes) throw new RetainedProjectionBudgetError("metadata");

        const operationPayload = {
          requestDigest,
          runId: input.runId,
          threadId: input.threadId,
          mode: input.mode,
          targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
          algorithm: RETAINED_PROJECTION_ALGORITHM,
          page: input.page,
          source: { ...input.source, cursorIn, cursorOut },
          facts: canonicalFacts.map((fact) => fact.json),
          timestampRevisions: canonicalRevisions.map((revision) => revision.json),
          refReleases: canonicalRefReleases,
          checkpoint: normalizedCheckpointInfo.json,
          rows,
          bytes,
          maxFactSeq,
          revisionCount: (currentRow.revision_count as number) + newRevisionCount,
          metadataBytes,
        };
        const operationDigest = sha256(JSON.stringify(operationPayload));
        this.db
          .prepare(`INSERT INTO analytics_retained_stage_pages (
            run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at,
            source_page_exhausted,source_page_digest,request_digest,checkpoint_digest,operation_digest,
            revision_count,revision_payload_bytes,revision_bytes_delta,metadata_bytes,ref_releases_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            input.runId,
            input.page,
            cursorIn,
            cursorOut,
            insertedRows,
            insertedBytes,
            input.source.pageDigest,
            input.receivedAt,
            input.source.pageExhausted ? 1 : 0,
            input.source.pageDigest,
            requestDigest,
            normalizedCheckpointInfo.digest,
            operationDigest,
            newRevisionCount,
            newRevisionPayloadBytes,
            revisionBytesDelta,
            normalizedCheckpointInfo.bytes + newRevisionPayloadBytes,
            JSON.stringify(canonicalRefReleases),
          );
        const update = this.db
          .prepare(`UPDATE analytics_retained_stage_runs SET
            next_page=?,next_cursor=?,rows_staged=?,bytes_staged=?,
            checkpoint_json=?,checkpoint_digest=?,source_after_seq=?,fact_max_seq=?,max_observed_seq=?,
            revision_count=?,revision_payload_bytes=?,metadata_bytes=?,last_operation_digest=?
            WHERE run_id=? AND state='collecting' AND terminal_reason IS NULL
              AND target_projection_version=? AND algorithm_format=?
              AND thread_id=? AND mode=? AND next_page=? AND checkpoint_digest=?
              AND source_after_seq IS ?`)
          .run(
            input.page + 1,
            cursorOut,
            rows,
            bytes,
            normalizedCheckpointInfo.json,
            normalizedCheckpointInfo.digest,
            normalizedCheckpoint.sourceAfterSeq,
            maxFactSeq,
            maxFactSeq,
            (currentRow.revision_count as number) + newRevisionCount,
            (currentRow.revision_payload_bytes as number) + newRevisionPayloadBytes,
            metadataBytes,
            operationDigest,
            input.runId,
            RETAINED_TARGET_PROJECTION_VERSION,
            RETAINED_PROJECTION_ALGORITHM,
            input.threadId,
            input.mode,
            input.page,
            input.checkpointDigestIn,
            cursorIn,
          );
        if (update.changes !== 1) throw new Error("Retained projection stage compare-and-swap failed.");
      });
      publish();
    } catch (error) {
      if (error instanceof RetainedProjectionBudgetError) {
        terminalBudget = error;
      } else {
        throw error;
      }
    }
    if (terminalBudget != null) {
      if (terminalFence == null) throw new Error("Retained projection budget failure lacked a compare-and-swap fence.");
      this.closeRetainedProjectionBudget(input.runId, terminalBudget.reason, terminalBudget.message, terminalFence);
      throw new RetainedProjectionTerminalError(terminalBudget.reason);
    }
    return this.getRetainedProjectionStage(input.runId)!;
  }

  failRetainedStage(runId: string, error: string): RetainedStageProgress {
    requireRetainedStageAlgorithm(readRetainedStageRow(this.db, runId), LEGACY_RETAINED_STAGE_ALGORITHM);
    this.prepareRetainedStageAccountingOnce();
    this.db.prepare("UPDATE analytics_retained_stage_runs SET state='failed',last_error=? WHERE run_id=? AND state='collecting' AND algorithm_format=?").run(error.slice(0, 2000), runId, LEGACY_RETAINED_STAGE_ALGORITHM);
    const stage = this.getRetainedStage(runId); if (stage == null) throw new Error("Unknown retained stage."); return stage;
  }

  getRetainedStage(runId: string): RetainedStageProgress | null {
    const row = readRetainedStageRow(this.db, runId);
    if (row != null && row.algorithm_format !== LEGACY_RETAINED_STAGE_ALGORITHM) return null;
    return row == null ? null : { runId: row.run_id as string, epochId: row.epoch_id as string, threadId: row.thread_id as string, mode: row.mode as RetainedStageProgress["mode"], state: row.state as RetainedStageProgress["state"], targetProjectionVersion: row.target_projection_version as number, nextPage: row.next_page as number, nextCursor: row.next_cursor as string | null, rows: row.rows_staged as number, bytes: row.bytes_staged as number, maxObservedSeq: row.max_observed_seq as number | null, maxPages: row.max_pages as number, maxRows: row.max_rows as number, maxBytes: row.max_bytes as number, error: row.last_error as string | null };
  }

  getIndexState(): AnalyticsIndexState {
    const row = this.db.prepare("SELECT * FROM analytics_index_state WHERE singleton = 1").get() as IndexStateRow;
    return {
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      generationId: row.generation_id,
      snapshotUpdatedAt: row.snapshot_updated_at,
      lastFullReconciliationAt: row.last_full_reconciliation_at,
      degraded: row.degraded === 1,
      lastError: row.error,
      loadedThreads: row.loaded_threads,
      factCount: row.fact_count,
      truncatedThreads: row.truncated_threads,
      durationMs: row.duration_ms,
      error: row.error,
      factProjectionVersion: row.fact_projection_version,
    };
  }

  markIndexing(startedAt: number): void {
    this.db.prepare(`UPDATE analytics_index_state SET status = 'indexing', started_at = ? WHERE singleton = 1`).run(startedAt);
  }

  markReady(input: Omit<AnalyticsIndexState, "status" | "startedAt" | "error">): void {
    this.db.prepare(`
      UPDATE analytics_index_state
      SET status = 'ready', completed_at = ?, loaded_threads = ?, fact_count = ?,
          truncated_threads = ?, duration_ms = ?, error = NULL
      WHERE singleton = 1
    `).run(input.completedAt, input.loadedThreads, input.factCount, input.truncatedThreads, input.durationMs);
  }

  markError(error: string): void {
    this.db.prepare(`UPDATE analytics_index_state SET status = 'error', error = ?, degraded = 1 WHERE singleton = 1`).run(error.slice(0, 2_000));
  }

  listThreadStates(): AnalyticsThreadState[] {
    const rows = this.db.prepare(`
      SELECT thread_id, project_id, provider_id, membership, updated_at,
        max_observed_seq, fact_count, truncated, last_reconciled_at, last_error
      FROM analytics_thread_state
      WHERE membership = 1
      ORDER BY updated_at DESC, thread_id
    `).all() as ThreadStateRow[];
    return rows.map((row) => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      providerId: row.provider_id,
      membership: row.membership === 1,
      updatedAt: row.updated_at,
      maxObservedSeq: row.max_observed_seq,
      factCount: row.fact_count,
      truncated: row.truncated === 1,
      lastReconciledAt: row.last_reconciled_at,
      lastError: row.last_error,
    }));
  }

  /** Publish facts and snapshot metadata in one SQLite transaction. */
  commitSnapshot(input: AnalyticsSnapshotCommit): void {
    const insert = this.db.prepare(`
      INSERT INTO tool_execution_facts_v1 (
        source_event_id, thread_id, turn_id, sequence, project_id, provider_id,
        created_at_ms, capability_kind, capability_key, status, duration_ms,
        failed, error_class, error_signature, command_binary, command_argument_1,
        command_argument_2, command_uses_help, command_shape, command_shell_wrapped,
        command_attribution_eligible, turn_started_at_ms, turn_completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const commit = this.db.transaction(() => {
      const selected = new Set(input.selectedThreadIds);
      const existing = this.listThreadStates();
      const removeFacts = this.db.prepare("DELETE FROM tool_execution_facts_v1 WHERE thread_id = ?");
      const removeThread = this.db.prepare("DELETE FROM analytics_thread_state WHERE thread_id = ?");
      if (input.selectedThreadIds.length === 0) {
        this.db.prepare("DELETE FROM tool_execution_facts_v1").run();
      } else {
        const placeholders = input.selectedThreadIds.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM tool_execution_facts_v1 WHERE thread_id NOT IN (${placeholders})`).run(...input.selectedThreadIds);
      }
      for (const thread of existing) {
        if (!selected.has(thread.threadId)) {
          removeFacts.run(thread.threadId);
          removeThread.run(thread.threadId);
        }
      }

      const existingById = new Map(existing.map((thread) => [thread.threadId, thread]));
      const upsert = this.db.prepare(`
        INSERT INTO analytics_thread_state (
          thread_id, project_id, provider_id, membership, updated_at,
          max_observed_seq, fact_count, truncated, last_reconciled_at, last_error
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          project_id = excluded.project_id,
          provider_id = excluded.provider_id,
          membership = 1,
          updated_at = excluded.updated_at,
          max_observed_seq = excluded.max_observed_seq,
          fact_count = excluded.fact_count,
          truncated = excluded.truncated,
          last_reconciled_at = excluded.last_reconciled_at,
          last_error = excluded.last_error
      `);
      for (const thread of input.threads) {
        const prior = existingById.get(thread.threadId);
        if (thread.outcome === "loaded") {
          const nextFacts = thread.facts ?? [];
          removeFacts.run(thread.threadId);
          for (const fact of nextFacts) insert.run(
            fact.sourceEventId,
            fact.threadId,
            fact.turnId,
            fact.sequence,
            fact.projectId,
            fact.providerId,
            fact.createdAtMs,
            fact.capabilityKind,
            fact.capabilityKey,
            fact.status,
            fact.durationMs,
            fact.failed ? 1 : 0,
            fact.errorClass,
            fact.errorSignature,
            fact.commandBinary,
            fact.commandArgument1,
            fact.commandArgument2,
            fact.commandUsesHelp ? 1 : 0,
            fact.commandShape,
            fact.commandShellWrapped ? 1 : 0,
            fact.commandAttributionEligible ? 1 : 0,
            fact.turnStartedAtMs,
            fact.turnCompletedAtMs,
          );
          upsert.run(
            thread.threadId,
            thread.projectId,
            thread.providerId,
            thread.updatedAt,
            thread.maxObservedSeq ?? null,
            nextFacts.length,
            thread.truncated ? 1 : 0,
            input.completedAt,
            null,
          );
          continue;
        }
        if (thread.outcome === "failed" && prior != null) {
          // Failed reads preserve the previous facts and coverage metadata.
          upsert.run(
            thread.threadId,
            thread.projectId,
            thread.providerId,
            // Keep the prior source revision so the next pull retries this
            // thread instead of treating the failed revision as reconciled.
            prior.updatedAt,
            prior.maxObservedSeq,
            prior.factCount,
            prior.truncated ? 1 : 0,
            input.completedAt,
            (thread.error ?? "Analytics could not read this thread.").slice(0, 2_000),
          );
          continue;
        }
        upsert.run(
          thread.threadId,
          thread.projectId,
          thread.providerId,
          // A new failed thread has no successfully observed revision yet.
          thread.outcome === "failed" ? 0 : thread.updatedAt,
          prior?.maxObservedSeq ?? thread.maxObservedSeq ?? null,
          prior?.factCount ?? 0,
          prior?.truncated ? 1 : thread.truncated ? 1 : 0,
          input.completedAt,
          thread.outcome === "failed"
            ? (thread.error ?? "Analytics could not read this thread.").slice(0, 2_000)
            : prior?.lastError ?? null,
        );
      }

      const previous = this.db.prepare("SELECT last_full_reconciliation_at, fact_projection_version FROM analytics_index_state WHERE singleton = 1").get() as {
        last_full_reconciliation_at: number | null;
        fact_projection_version: number;
      };
      this.db.prepare(`
        UPDATE analytics_index_state
        SET status = 'ready', completed_at = ?, generation_id = generation_id + ?,
            snapshot_updated_at = ?, last_full_reconciliation_at = ?,
            loaded_threads = ?, fact_count = ?, truncated_threads = ?,
            duration_ms = ?, degraded = ?, error = ?, fact_projection_version = ?
        WHERE singleton = 1
      `).run(
        input.completedAt,
        input.factsChanged ? 1 : 0,
        input.completedAt,
        input.lastFullReconciliationAt === undefined ? previous.last_full_reconciliation_at : input.lastFullReconciliationAt,
        input.loadedThreads,
        input.factCount,
        input.truncatedThreads,
        input.durationMs,
        input.degraded ? 1 : 0,
        input.lastError?.slice(0, 2_000) ?? null,
        input.factProjectionVersion ?? previous.fact_projection_version,
      );
    });
    commit();
  }

  listBundles(): AnalyticsBundle[] {
    const rows = this.db.prepare("SELECT source_json FROM analytics_bundles ORDER BY title").all() as Array<{ source_json: string }>;
    return rows.map((row) => JSON.parse(row.source_json) as AnalyticsBundle);
  }

  getBundle(id: string): AnalyticsBundle | null {
    const row = this.db.prepare("SELECT source_json FROM analytics_bundles WHERE id = ?").get(id) as { source_json: string } | undefined;
    return row === undefined ? null : JSON.parse(row.source_json) as AnalyticsBundle;
  }

  saveBundle(bundle: AnalyticsBundle): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO analytics_bundles (id, version, title, source_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, title = excluded.title,
        source_json = excluded.source_json, updated_at = excluded.updated_at
    `).run(bundle.id, bundle.version, bundle.title, JSON.stringify(bundle), now, now);
  }

  deleteBundle(id: string): boolean {
    return this.db.prepare("DELETE FROM analytics_bundles WHERE id = ?").run(id).changes > 0;
  }

  saveReference(capsule: AnalyticsReferenceCapsule): void {
    this.db.prepare(`
      INSERT INTO analytics_references (id, capsule_json, created_at)
      VALUES (?, ?, ?)
    `).run(capsule.id, JSON.stringify(capsule), capsule.createdAt);
  }

  getReference(id: string): AnalyticsReferenceCapsule | null {
    const row = this.db.prepare("SELECT capsule_json FROM analytics_references WHERE id = ?").get(id) as { capsule_json: string } | undefined;
    return row == null ? null : JSON.parse(row.capsule_json) as AnalyticsReferenceCapsule;
  }

  replaceFacts(facts: readonly ToolExecutionFact[]): void {
    const insert = this.db.prepare(`
      INSERT INTO tool_execution_facts_v1 (
        source_event_id, thread_id, turn_id, sequence, project_id, provider_id,
        created_at_ms, capability_kind, capability_key, status, duration_ms,
        failed, error_class, error_signature, command_binary, command_argument_1,
        command_argument_2, command_uses_help, command_shape, command_shell_wrapped,
        command_attribution_eligible, turn_started_at_ms, turn_completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const replace = this.db.transaction((nextFacts: readonly ToolExecutionFact[]) => {
      this.db.prepare("DELETE FROM tool_execution_facts_v1").run();
      for (const fact of nextFacts) {
        insert.run(
          fact.sourceEventId,
          fact.threadId,
          fact.turnId,
          fact.sequence,
          fact.projectId,
          fact.providerId,
          fact.createdAtMs,
          fact.capabilityKind,
          fact.capabilityKey,
          fact.status,
          fact.durationMs,
          fact.failed ? 1 : 0,
          fact.errorClass,
          fact.errorSignature,
          fact.commandBinary,
          fact.commandArgument1,
          fact.commandArgument2,
          fact.commandUsesHelp ? 1 : 0,
          fact.commandShape,
          fact.commandShellWrapped ? 1 : 0,
          fact.commandAttributionEligible ? 1 : 0,
          fact.turnStartedAtMs,
          fact.turnCompletedAtMs,
        );
      }
    });
    replace(facts);
  }

  factsAsNdjson(rangeDays: number, now = Date.now()): string {
    const cutoff = now - rangeDays * 86_400_000;
    const rows = this.db.prepare(`
      SELECT source_event_id, thread_id, turn_id, sequence, project_id,
        provider_id, created_at_ms, capability_kind, capability_key, status,
        duration_ms, failed, error_class, error_signature, command_binary,
        command_argument_1, command_argument_2, command_uses_help,
        command_shape, command_shell_wrapped, command_attribution_eligible,
        turn_started_at_ms, turn_completed_at_ms
      FROM tool_execution_facts_v1
      WHERE created_at_ms >= ?
      ORDER BY created_at_ms, thread_id, sequence
    `).iterate(cutoff) as Iterable<Record<string, unknown>>;
    let output = "";
    for (const row of rows) {
      output += `${JSON.stringify({
        ...row,
        failed: row.failed === 1,
        command_uses_help: row.command_uses_help === 1,
        command_shell_wrapped: row.command_shell_wrapped === 1,
        command_attribution_eligible: row.command_attribution_eligible === 1,
      })}\n`;
    }
    return output;
  }

  snapshotFactsAsNdjson(rangeDays: number, now = Date.now()): { state: AnalyticsIndexState; ndjson: string } {
    const read = this.db.transaction(() => ({
      state: this.getIndexState(),
      ndjson: this.factsAsNdjson(rangeDays, now),
    }));
    return read();
  }
}
