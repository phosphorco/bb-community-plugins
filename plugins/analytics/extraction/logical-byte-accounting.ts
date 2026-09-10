/**
 * Exact logical-byte accounting for the currently persisted retained-stage
 * scalar columns. This module deliberately does not validate JSON, digests,
 * cursors, algorithms, counters, or stage semantics: persisted text is
 * opaque text and persisted integers are opaque SQLite integer values here.
 *
 * The accounting unit is the UTF-8 byte length of each non-null TEXT value,
 * plus the byte length of each non-null INTEGER's canonical signed decimal
 * representation. SQLite page, index, WAL, and file-size overhead are not
 * part of this model.
 */

import { Buffer } from "node:buffer";

export type RetainedStageLogicalTable = "runs" | "pages" | "facts" | "revisions";
export type RetainedStageLogicalColumnKind = "TEXT" | "INTEGER";
export type RetainedAccountingLogicalTable = RetainedStageLogicalTable | "candidate_epochs" | "candidate_members";

export interface RetainedStageLogicalColumn {
  readonly name: string;
  readonly kind: RetainedStageLogicalColumnKind;
  readonly nullable: boolean;
}

export type RetainedStageLogicalScalar = string | number | bigint | null;
export type RetainedStageLogicalRow = Readonly<Record<string, RetainedStageLogicalScalar>>;

type RetainedStageLogicalInventory = Readonly<{
  [K in RetainedStageLogicalTable]: readonly RetainedStageLogicalColumn[];
}>;

/**
 * The four current retained-stage tables, copied from the current migration
 * sequence in store.ts. Keep this inventory exact: a future persisted column
 * must be added here deliberately before it can be accounted.
 */
const retainedStageColumnInventory = {
  runs: [
    { name: "run_id", kind: "TEXT", nullable: false },
    { name: "epoch_id", kind: "TEXT", nullable: false },
    { name: "thread_id", kind: "TEXT", nullable: false },
    { name: "mode", kind: "TEXT", nullable: false },
    { name: "state", kind: "TEXT", nullable: false },
    { name: "target_projection_version", kind: "INTEGER", nullable: false },
    { name: "next_page", kind: "INTEGER", nullable: false },
    { name: "next_cursor", kind: "TEXT", nullable: true },
    { name: "rows_staged", kind: "INTEGER", nullable: false },
    { name: "bytes_staged", kind: "INTEGER", nullable: false },
    { name: "max_observed_seq", kind: "INTEGER", nullable: true },
    { name: "max_pages", kind: "INTEGER", nullable: false },
    { name: "max_rows", kind: "INTEGER", nullable: false },
    { name: "max_bytes", kind: "INTEGER", nullable: false },
    { name: "started_at", kind: "INTEGER", nullable: false },
    { name: "last_error", kind: "TEXT", nullable: true },
    { name: "algorithm_format", kind: "TEXT", nullable: false },
    { name: "checkpoint_json", kind: "TEXT", nullable: true },
    { name: "checkpoint_digest", kind: "TEXT", nullable: true },
    { name: "source_after_seq", kind: "TEXT", nullable: true },
    { name: "fact_max_seq", kind: "INTEGER", nullable: true },
    { name: "revision_count", kind: "INTEGER", nullable: false },
    { name: "revision_payload_bytes", kind: "INTEGER", nullable: false },
    { name: "metadata_bytes", kind: "INTEGER", nullable: false },
    { name: "last_operation_digest", kind: "TEXT", nullable: true },
    { name: "terminal_reason", kind: "TEXT", nullable: true },
    { name: "terminal_at", kind: "INTEGER", nullable: true },
    { name: "failure_reason", kind: "TEXT", nullable: true },
    { name: "max_checkpoint_bytes", kind: "INTEGER", nullable: false },
    { name: "max_metadata_bytes", kind: "INTEGER", nullable: false },
    { name: "max_turn_states", kind: "INTEGER", nullable: false },
    { name: "max_timing_refs", kind: "INTEGER", nullable: false },
    { name: "max_revisions", kind: "INTEGER", nullable: false },
  ],
  pages: [
    { name: "run_id", kind: "TEXT", nullable: false },
    { name: "page", kind: "INTEGER", nullable: false },
    { name: "cursor_in", kind: "TEXT", nullable: true },
    { name: "cursor_out", kind: "TEXT", nullable: true },
    { name: "rows_staged", kind: "INTEGER", nullable: false },
    { name: "bytes_staged", kind: "INTEGER", nullable: false },
    { name: "page_digest", kind: "TEXT", nullable: false },
    { name: "received_at", kind: "INTEGER", nullable: false },
    { name: "source_page_exhausted", kind: "INTEGER", nullable: false },
    { name: "source_page_digest", kind: "TEXT", nullable: false },
    { name: "request_digest", kind: "TEXT", nullable: false },
    { name: "checkpoint_digest", kind: "TEXT", nullable: false },
    { name: "operation_digest", kind: "TEXT", nullable: false },
    { name: "revision_count", kind: "INTEGER", nullable: false },
    { name: "revision_payload_bytes", kind: "INTEGER", nullable: false },
    { name: "revision_bytes_delta", kind: "INTEGER", nullable: false },
    { name: "metadata_bytes", kind: "INTEGER", nullable: false },
    { name: "ref_releases_json", kind: "TEXT", nullable: false },
  ],
  facts: [
    { name: "run_id", kind: "TEXT", nullable: false },
    { name: "source_event_id", kind: "TEXT", nullable: false },
    { name: "thread_id", kind: "TEXT", nullable: false },
    { name: "fact_json", kind: "TEXT", nullable: false },
    { name: "fact_digest", kind: "TEXT", nullable: false },
  ],
  revisions: [
    { name: "run_id", kind: "TEXT", nullable: false },
    { name: "revision_key", kind: "TEXT", nullable: false },
    { name: "source_event_id", kind: "TEXT", nullable: false },
    { name: "revision_json", kind: "TEXT", nullable: false },
    { name: "revision_digest", kind: "TEXT", nullable: false },
    { name: "expected_fact_digest", kind: "TEXT", nullable: false },
    { name: "resulting_fact_digest", kind: "TEXT", nullable: false },
    { name: "payload_bytes", kind: "INTEGER", nullable: false },
    { name: "bytes_delta", kind: "INTEGER", nullable: false },
  ],
} as const satisfies RetainedStageLogicalInventory;

function deeplyFreezeInventory<T extends Record<string, readonly RetainedStageLogicalColumn[]>>(inventory: T): T {
  for (const table of Object.keys(inventory) as Array<keyof T>) {
    for (const column of inventory[table]) Object.freeze(column);
    Object.freeze(inventory[table]);
  }
  Object.freeze(inventory);
  return inventory;
}

export const RETAINED_STAGE_COLUMN_INVENTORY = deeplyFreezeInventory(retainedStageColumnInventory);

const retainedAccountingV2ColumnInventory = {
  ...retainedStageColumnInventory,
  candidate_epochs: [
    { name: "epoch_id", kind: "TEXT", nullable: false },
    { name: "mode", kind: "TEXT", nullable: false },
    { name: "target_projection_version", kind: "INTEGER", nullable: false },
    { name: "algorithm_format", kind: "TEXT", nullable: false },
    { name: "restart", kind: "TEXT", nullable: false },
    { name: "state", kind: "TEXT", nullable: false },
    { name: "manifest_revision", kind: "INTEGER", nullable: false },
    { name: "created_at", kind: "INTEGER", nullable: false },
    { name: "frozen_at", kind: "INTEGER", nullable: true },
    { name: "sealed_at", kind: "INTEGER", nullable: true },
    { name: "baseline_generation_id", kind: "INTEGER", nullable: false },
    { name: "baseline_projection_version", kind: "INTEGER", nullable: false },
    { name: "baseline_source_frontier_state", kind: "TEXT", nullable: false },
    { name: "membership_count", kind: "INTEGER", nullable: true },
    { name: "membership_cursor", kind: "TEXT", nullable: true },
    { name: "membership_rolling_digest", kind: "TEXT", nullable: true },
    { name: "membership_digest", kind: "TEXT", nullable: true },
    { name: "pin_cursor", kind: "TEXT", nullable: true },
    { name: "pinned_count", kind: "INTEGER", nullable: true },
    { name: "pinned_rolling_digest", kind: "TEXT", nullable: true },
    { name: "seal_membership_rolling_digest", kind: "TEXT", nullable: true },
    { name: "observation_digest", kind: "TEXT", nullable: true },
    { name: "observation_quality", kind: "TEXT", nullable: true },
    { name: "last_operation_digest", kind: "TEXT", nullable: true },
    { name: "error_text", kind: "TEXT", nullable: true },
  ],
  candidate_members: [
    { name: "epoch_id", kind: "TEXT", nullable: false },
    { name: "thread_id", kind: "TEXT", nullable: false },
    { name: "run_id", kind: "TEXT", nullable: false },
    { name: "member_revision", kind: "INTEGER", nullable: false },
    { name: "pin_operation_digest", kind: "TEXT", nullable: true },
    { name: "bound_stage_accounting_revision", kind: "INTEGER", nullable: false },
    { name: "bound_next_page", kind: "INTEGER", nullable: false },
    { name: "bound_checkpoint_digest", kind: "TEXT", nullable: false },
    { name: "pin_state", kind: "TEXT", nullable: false },
    { name: "outcome", kind: "TEXT", nullable: true },
    { name: "observed_next_page", kind: "INTEGER", nullable: true },
    { name: "observed_last_page_digest", kind: "TEXT", nullable: true },
    { name: "observed_checkpoint_digest", kind: "TEXT", nullable: true },
    { name: "observed_operation_digest", kind: "TEXT", nullable: true },
    { name: "observed_source_after_seq", kind: "TEXT", nullable: true },
    { name: "observed_fact_max_seq", kind: "INTEGER", nullable: true },
    { name: "observed_incomplete_reasons_json", kind: "TEXT", nullable: false },
    { name: "observed_rewrite_required", kind: "INTEGER", nullable: false },
    { name: "observed_rewrite_directive_json", kind: "TEXT", nullable: true },
    { name: "failure_reason", kind: "TEXT", nullable: true },
    { name: "terminal_reason", kind: "TEXT", nullable: true },
    { name: "error_text", kind: "TEXT", nullable: true },
    { name: "observation_digest", kind: "TEXT", nullable: true },
    { name: "observed_at", kind: "INTEGER", nullable: true },
    { name: "observed_stage_accounting_revision", kind: "INTEGER", nullable: true },
  ],
} as const satisfies Record<RetainedAccountingLogicalTable, readonly RetainedStageLogicalColumn[]>;

export const RETAINED_ACCOUNTING_V2_COLUMN_INVENTORY = deeplyFreezeInventory(retainedAccountingV2ColumnInventory);

const MIN_SQLITE_INTEGER = -(2n ** 63n);
const MAX_SQLITE_INTEGER = (2n ** 63n) - 1n;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(table: string, message: string): never {
  throw new TypeError(`Invalid retained-stage ${table} row: ${message}`);
}

function assertStageTable(value: unknown): asserts value is RetainedStageLogicalTable {
  if (
    value !== "runs"
    && value !== "pages"
    && value !== "facts"
    && value !== "revisions"
  ) {
    throw new TypeError("Invalid retained-stage logical table.");
  }
}

function assertAccountingTable(value: unknown): asserts value is RetainedAccountingLogicalTable {
  if (
    value !== "runs"
    && value !== "pages"
    && value !== "facts"
    && value !== "revisions"
    && value !== "candidate_epochs"
    && value !== "candidate_members"
  ) {
    throw new TypeError("Invalid retained accounting logical table.");
  }
}

function stageInventoryFor(table: RetainedStageLogicalTable): readonly RetainedStageLogicalColumn[] {
  return RETAINED_STAGE_COLUMN_INVENTORY[table];
}

function accountingInventoryFor(table: RetainedAccountingLogicalTable): readonly RetainedStageLogicalColumn[] {
  return RETAINED_ACCOUNTING_V2_COLUMN_INVENTORY[table];
}

function assertSafeSum(value: number, table: RetainedAccountingLogicalTable): number {
  if (!Number.isSafeInteger(value)) fail(table, "logical-byte sum overflow");
  return value;
}

function addSafe(left: number, right: number, table: RetainedAccountingLogicalTable): number {
  return assertSafeSum(left + right, table);
}

function subtractSafe(left: number, right: number, table: RetainedAccountingLogicalTable): number {
  return assertSafeSum(left - right, table);
}

function scalarLogicalBytes(
  table: RetainedAccountingLogicalTable,
  column: RetainedStageLogicalColumn,
  value: RetainedStageLogicalScalar,
): number {
  if (value === null) {
    if (!column.nullable) fail(table, `${column.name} is not nullable`);
    return 0;
  }
  if (column.kind === "TEXT") {
    if (typeof value !== "string") fail(table, `${column.name} must be a persisted TEXT value or null`);
    return Buffer.byteLength(value, "utf8");
  }
  if (typeof value === "bigint") {
    if (value < MIN_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) {
      fail(table, `${column.name} is outside SQLite's signed 64-bit INTEGER range`);
    }
    return value.toString().length;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(table, `${column.name} must be a safe integer number, signed SQLite bigint, or null`);
  }
  return String(value).length;
}

function validatedValues(
  table: RetainedAccountingLogicalTable,
  row: RetainedAccountingLogicalRow,
  columns: readonly RetainedStageLogicalColumn[],
): ReadonlyMap<string, RetainedStageLogicalScalar> {
  if (!isPlainObject(row)) fail(table, "row must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(row);
  const ownKeys = Reflect.ownKeys(row);
  if (ownKeys.length !== columns.length) fail(table, "row must have exactly the current persisted fields");
  const values = new Map<string, RetainedStageLogicalScalar>();
  for (const key of ownKeys) {
    if (typeof key !== "string") fail(table, "symbol fields are not persisted columns");
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(table, `${key} must be an enumerable data field`);
    }
  }
  for (const column of columns) {
    const descriptor = descriptors[column.name];
    if (descriptor === undefined) fail(table, `missing ${column.name}`);
    if (descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(table, `${column.name} must be an enumerable data field`);
    }
    const value = descriptor.value as unknown;
    if (value === null) {
      if (!column.nullable) fail(table, `${column.name} is not nullable`);
    } else if (column.kind === "TEXT") {
      if (typeof value !== "string") fail(table, `${column.name} must be TEXT or null`);
    } else if (
      (typeof value !== "number" || !Number.isSafeInteger(value))
      && typeof value !== "bigint"
    ) {
      fail(table, `${column.name} must be a safe integer number, signed SQLite bigint, or null`);
    }
    values.set(column.name, value as RetainedStageLogicalScalar);
  }
  return values;
}

function rowBytes(
  table: RetainedAccountingLogicalTable,
  row: RetainedAccountingLogicalRow,
  columns: readonly RetainedStageLogicalColumn[],
): number {
  const values = validatedValues(table, row, columns);
  let total = 0;
  for (const column of columns) {
    total = addSafe(total, scalarLogicalBytes(table, column, values.get(column.name)!), table);
  }
  return total;
}

/** Returns the logical bytes represented by one exact persisted retained-stage row. */
export function calculateRetainedStageRowLogicalBytes(
  table: RetainedStageLogicalTable,
  row: RetainedStageLogicalRow,
): number {
  assertStageTable(table);
  return rowBytes(table, row, stageInventoryFor(table));
}

/**
 * Returns the signed logical-byte change from before to after. Null means
 * that the row is absent, so (null, row) is insertion and (row, null) is
 * deletion. Equal rows, including replay, return zero.
 */
export function calculateRetainedStageRowLogicalDelta(
  table: RetainedStageLogicalTable,
  before: RetainedStageLogicalRow | null,
  after: RetainedStageLogicalRow | null,
): number {
  assertStageTable(table);
  if (before === null && after === null) return 0;
  if (before === null) return calculateRetainedStageRowLogicalBytes(table, after!);
  if (after === null) return -calculateRetainedStageRowLogicalBytes(table, before);

  const beforeValues = validatedValues(table, before, stageInventoryFor(table));
  const afterValues = validatedValues(table, after, stageInventoryFor(table));
  let delta = 0;
  for (const column of stageInventoryFor(table)) {
    const beforeBytes = scalarLogicalBytes(table, column, beforeValues.get(column.name)!);
    const afterBytes = scalarLogicalBytes(table, column, afterValues.get(column.name)!);
    delta = addSafe(delta, subtractSafe(afterBytes, beforeBytes, table), table);
  }
  return delta;
}

export type RetainedAccountingLogicalRow = Readonly<Record<string, RetainedStageLogicalScalar>>;

/** Accounts all six current retained material tables with the same scalar formula. */
export function calculateRetainedAccountingRowLogicalBytes(
  table: RetainedAccountingLogicalTable,
  row: RetainedAccountingLogicalRow,
): number {
  assertAccountingTable(table);
  return rowBytes(table, row, accountingInventoryFor(table));
}

export function calculateRetainedAccountingRowLogicalDelta(
  table: RetainedAccountingLogicalTable,
  before: RetainedAccountingLogicalRow | null,
  after: RetainedAccountingLogicalRow | null,
): number {
  assertAccountingTable(table);
  if (before === null && after === null) return 0;
  if (before === null) return calculateRetainedAccountingRowLogicalBytes(table, after!);
  if (after === null) return -calculateRetainedAccountingRowLogicalBytes(table, before);
  const columns = accountingInventoryFor(table);
  const beforeValues = validatedValues(table, before, columns);
  const afterValues = validatedValues(table, after, columns);
  let delta = 0;
  for (const column of columns) {
    delta = addSafe(
      delta,
      subtractSafe(
        scalarLogicalBytes(table, column, afterValues.get(column.name)!),
        scalarLogicalBytes(table, column, beforeValues.get(column.name)!),
        table,
      ),
      table,
    );
  }
  return delta;
}
