import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRetainedStageRowLogicalBytes,
  calculateRetainedStageRowLogicalDelta,
  calculateRetainedAccountingRowLogicalBytes,
  calculateRetainedAccountingRowLogicalDelta,
  RETAINED_STAGE_COLUMN_INVENTORY,
  RETAINED_ACCOUNTING_V2_COLUMN_INVENTORY,
  type RetainedStageLogicalRow,
  type RetainedStageLogicalScalar,
  type RetainedStageLogicalTable,
  type RetainedAccountingLogicalRow,
  type RetainedAccountingLogicalTable,
} from "../../../../extraction/logical-byte-accounting.ts";

const expectedShape = {
  runs: [
    "run_id:TEXT:required", "epoch_id:TEXT:required", "thread_id:TEXT:required", "mode:TEXT:required",
    "state:TEXT:required", "target_projection_version:INTEGER:required", "next_page:INTEGER:required",
    "next_cursor:TEXT:nullable", "rows_staged:INTEGER:required", "bytes_staged:INTEGER:required",
    "max_observed_seq:INTEGER:nullable", "max_pages:INTEGER:required", "max_rows:INTEGER:required",
    "max_bytes:INTEGER:required", "started_at:INTEGER:required", "last_error:TEXT:nullable",
    "algorithm_format:TEXT:required", "checkpoint_json:TEXT:nullable", "checkpoint_digest:TEXT:nullable",
    "source_after_seq:TEXT:nullable", "fact_max_seq:INTEGER:nullable", "revision_count:INTEGER:required",
    "revision_payload_bytes:INTEGER:required", "metadata_bytes:INTEGER:required",
    "last_operation_digest:TEXT:nullable", "terminal_reason:TEXT:nullable", "terminal_at:INTEGER:nullable",
    "failure_reason:TEXT:nullable", "max_checkpoint_bytes:INTEGER:required", "max_metadata_bytes:INTEGER:required",
    "max_turn_states:INTEGER:required", "max_timing_refs:INTEGER:required", "max_revisions:INTEGER:required",
  ],
  pages: [
    "run_id:TEXT:required", "page:INTEGER:required", "cursor_in:TEXT:nullable", "cursor_out:TEXT:nullable",
    "rows_staged:INTEGER:required", "bytes_staged:INTEGER:required", "page_digest:TEXT:required",
    "received_at:INTEGER:required", "source_page_exhausted:INTEGER:required", "source_page_digest:TEXT:required",
    "request_digest:TEXT:required", "checkpoint_digest:TEXT:required", "operation_digest:TEXT:required",
    "revision_count:INTEGER:required", "revision_payload_bytes:INTEGER:required",
    "revision_bytes_delta:INTEGER:required", "metadata_bytes:INTEGER:required", "ref_releases_json:TEXT:required",
  ],
  facts: [
    "run_id:TEXT:required", "source_event_id:TEXT:required", "thread_id:TEXT:required",
    "fact_json:TEXT:required", "fact_digest:TEXT:required",
  ],
  revisions: [
    "run_id:TEXT:required", "revision_key:TEXT:required", "source_event_id:TEXT:required",
    "revision_json:TEXT:required", "revision_digest:TEXT:required", "expected_fact_digest:TEXT:required",
    "resulting_fact_digest:TEXT:required", "payload_bytes:INTEGER:required", "bytes_delta:INTEGER:required",
  ],
} as const satisfies Record<RetainedStageLogicalTable, readonly string[]>;

const runs = {
  run_id: "r-🧪",
  epoch_id: "epoch-1",
  thread_id: "thread-1",
  mode: "delta",
  state: "collecting",
  target_projection_version: 5,
  next_page: 2,
  next_cursor: null,
  rows_staged: 2,
  bytes_staged: -17,
  max_observed_seq: null,
  max_pages: 512,
  max_rows: 50_000,
  max_bytes: 32 * 1024 * 1024,
  started_at: 1_700_000_000_000,
  last_error: null,
  algorithm_format: "opaque-unknown-algorithm",
  checkpoint_json: "{malformed:\"🧪\"",
  checkpoint_digest: "not-a-digest",
  source_after_seq: "0007",
  fact_max_seq: 7,
  revision_count: -1,
  revision_payload_bytes: 9,
  metadata_bytes: 10,
  last_operation_digest: "also-not-a-digest",
  terminal_reason: null,
  terminal_at: null,
  failure_reason: null,
  max_checkpoint_bytes: 256 * 1024,
  max_metadata_bytes: 4 * 1024 * 1024,
  max_turn_states: 512,
  max_timing_refs: 2_048,
  max_revisions: 50_000,
} satisfies RetainedStageLogicalRow;

const pages = {
  run_id: "r-🧪",
  page: 2,
  cursor_in: null,
  cursor_out: "0009",
  rows_staged: 1,
  bytes_staged: 123,
  page_digest: "malformed page digest",
  received_at: 1_700_000_000_123,
  source_page_exhausted: 1,
  source_page_digest: "source/page/digest",
  request_digest: "request digest",
  checkpoint_digest: "checkpoint digest",
  operation_digest: "operation digest",
  revision_count: 1,
  revision_payload_bytes: 29,
  revision_bytes_delta: -37,
  metadata_bytes: -3,
  ref_releases_json: "not-json-🧪",
} satisfies RetainedStageLogicalRow;

const facts = {
  run_id: "r-🧪",
  source_event_id: "event-1",
  thread_id: "thread-1",
  fact_json: "{not valid JSON: 🧪",
  fact_digest: "unknown digest",
} satisfies RetainedStageLogicalRow;

const revisions = {
  run_id: "r-🧪",
  revision_key: "event-1:timing",
  source_event_id: "event-1",
  revision_json: "{also not JSON}",
  revision_digest: "opaque revision digest",
  expected_fact_digest: "opaque expected digest",
  resulting_fact_digest: "opaque resulting digest",
  payload_bytes: 31,
  bytes_delta: -8,
} satisfies RetainedStageLogicalRow;

const rows: Record<RetainedStageLogicalTable, RetainedStageLogicalRow> = {
  runs,
  pages,
  facts,
  revisions,
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const scalarBytes = (value: RetainedStageLogicalScalar): number => {
  if (value === null) return 0;
  if (typeof value === "string") return utf8Bytes(value);
  return utf8Bytes(String(value));
};

function independentlyExpectedBytes(table: RetainedStageLogicalTable, row: RetainedStageLogicalRow): number {
  return expectedShape[table].reduce((sum, descriptor) => {
    const field = descriptor.slice(0, descriptor.indexOf(":"));
    return sum + scalarBytes(row[field]);
  }, 0);
}

test("exports the exact current four-table scalar inventory", () => {
  for (const table of ["runs", "pages", "facts", "revisions"] as const) {
    assert.deepEqual(
      RETAINED_STAGE_COLUMN_INVENTORY[table].map((column) =>
        `${column.name}:${column.kind}:${column.nullable ? "nullable" : "required"}`),
      expectedShape[table],
    );
  }
});

test("deep-freezes the inventory and rejects invalid table values without coercion", () => {
  assert.equal(Object.isFrozen(RETAINED_STAGE_COLUMN_INVENTORY), true);
  assert.equal(Object.isFrozen(RETAINED_STAGE_COLUMN_INVENTORY.runs), true);
  assert.equal(Object.isFrozen(RETAINED_STAGE_COLUMN_INVENTORY.runs[0]), true);

  const originalName = RETAINED_STAGE_COLUMN_INVENTORY.runs[0]!.name;
  const mutableInventory = RETAINED_STAGE_COLUMN_INVENTORY as unknown as {
    runs: Array<{ name: string; kind: string; nullable: boolean }>;
  };
  assert.throws(() => mutableInventory.runs.push({ name: "future", kind: "TEXT", nullable: true }), TypeError);
  assert.throws(() => {
    mutableInventory.runs[0]!.name = "mutated";
  }, TypeError);
  assert.equal(RETAINED_STAGE_COLUMN_INVENTORY.runs[0]!.name, originalName);

  const invalidTable = (value: unknown): RetainedStageLogicalTable => value as RetainedStageLogicalTable;
  const throwingToString = {
    toString() {
      throw new Error("table toString was invoked");
    },
  };
  const boxedConstructor = new String("runs");
  for (const value of ["unknown", null, boxedConstructor, throwingToString, { constructor: "runs" }]) {
    assert.throws(
      () => calculateRetainedStageRowLogicalBytes(invalidTable(value), runs),
      TypeError,
    );
    assert.throws(
      () => calculateRetainedStageRowLogicalDelta(invalidTable(value), null, null),
      TypeError,
    );
  }
});

test("counts every literal field as UTF-8 text or canonical decimal integer bytes", () => {
  for (const table of ["runs", "pages", "facts", "revisions"] as const) {
    assert.equal(
      calculateRetainedStageRowLogicalBytes(table, rows[table]),
      independentlyExpectedBytes(table, rows[table]),
    );
  }
  assert.ok(calculateRetainedStageRowLogicalBytes("pages", pages) > 0);
  assert.ok(calculateRetainedStageRowLogicalBytes("revisions", revisions) > 0);
});

test("supports insertion, deletion, updates, replay zero, and inverse deltas", () => {
  for (const table of ["runs", "pages", "facts", "revisions"] as const) {
    const bytes = calculateRetainedStageRowLogicalBytes(table, rows[table]);
    assert.equal(calculateRetainedStageRowLogicalDelta(table, null, rows[table]), bytes);
    assert.equal(calculateRetainedStageRowLogicalDelta(table, rows[table], null), -bytes);
    assert.equal(calculateRetainedStageRowLogicalDelta(table, rows[table], rows[table]), 0);
    assert.equal(
      calculateRetainedStageRowLogicalDelta(table, null, rows[table])
        + calculateRetainedStageRowLogicalDelta(table, rows[table], null),
      0,
    );
  }

  const updatedPage = { ...pages, revision_bytes_delta: 11 } satisfies RetainedStageLogicalRow;
  assert.equal(
    calculateRetainedStageRowLogicalDelta("pages", pages, updatedPage),
    scalarBytes(11) - scalarBytes(-37),
  );
  const updatedRevision = { ...revisions, bytes_delta: 12 } satisfies RetainedStageLogicalRow;
  assert.equal(
    calculateRetainedStageRowLogicalDelta("revisions", revisions, updatedRevision),
    scalarBytes(12) - scalarBytes(-8),
  );
});

test("counts nulls as zero and preserves opaque malformed or semantically negative values", () => {
  const changed = {
    ...runs,
    checkpoint_json: "not JSON at all 🧪",
    algorithm_format: "unknown-future-algorithm",
    bytes_staged: -9_000,
    revision_count: -99,
  } satisfies RetainedStageLogicalRow;
  assert.equal(
    calculateRetainedStageRowLogicalDelta("runs", runs, changed),
    scalarBytes("not JSON at all 🧪") - scalarBytes("{malformed:\"🧪\"")
      + scalarBytes("unknown-future-algorithm") - scalarBytes("opaque-unknown-algorithm")
      + scalarBytes(-9_000) - scalarBytes(-17)
      + scalarBytes(-99) - scalarBytes(-1),
  );
  assert.equal(
    calculateRetainedStageRowLogicalDelta("pages", pages, { ...pages, cursor_in: "🧭" }),
    scalarBytes("🧭") - scalarBytes(null),
  );
});

test("accepts safe integers, -0, and signed SQLite 64-bit bigints", () => {
  const min = -(2n ** 63n);
  const max = (2n ** 63n) - 1n;
  const bigintRow = {
    ...revisions,
    payload_bytes: min,
    bytes_delta: max,
  } satisfies RetainedStageLogicalRow;
  assert.equal(
    calculateRetainedStageRowLogicalDelta("revisions", revisions, bigintRow),
    scalarBytes(min) - scalarBytes(31) + scalarBytes(max) - scalarBytes(-8),
  );
  const negativeZero = { ...pages, revision_bytes_delta: -0 } satisfies RetainedStageLogicalRow;
  const positiveZero = { ...pages, revision_bytes_delta: 0 } satisfies RetainedStageLogicalRow;
  assert.equal(
    calculateRetainedStageRowLogicalBytes("pages", negativeZero),
    calculateRetainedStageRowLogicalBytes("pages", positiveZero),
  );
});

test("does not mutate caller rows", () => {
  const copy = { ...pages };
  const frozen = Object.freeze(copy);
  const before = { ...frozen };
  calculateRetainedStageRowLogicalBytes("pages", frozen);
  assert.deepEqual(frozen, before);
});

test("rejects missing, extra, symbol, non-enumerable, accessor, prototype, and scalar-shape fields", () => {
  const { run_id: _runId, ...missing } = runs;
  assert.throws(() => calculateRetainedStageRowLogicalBytes("runs", missing), TypeError);

  const extra = { ...runs, future_column: "not yet accounted" };
  assert.throws(() => calculateRetainedStageRowLogicalBytes("runs", extra), TypeError);

  const symbol = Object.assign({}, runs, { [Symbol("future")]: "not persisted" });
  assert.throws(() => calculateRetainedStageRowLogicalBytes("runs", symbol), TypeError);

  const nonEnumerable = { ...runs };
  Object.defineProperty(nonEnumerable, "run_id", { value: runs.run_id, enumerable: false });
  assert.throws(() => calculateRetainedStageRowLogicalBytes("runs", nonEnumerable), TypeError);

  const accessor = { ...runs };
  Object.defineProperty(accessor, "run_id", {
    enumerable: true,
    get() {
      throw new Error("accessor was invoked");
    },
  });
  assert.throws(() => calculateRetainedStageRowLogicalBytes("runs", accessor), TypeError);

  const inherited = Object.assign(Object.create({ run_id: "inherited" }), runs);
  assert.throws(() => calculateRetainedStageRowLogicalBytes("runs", inherited), TypeError);

  assert.throws(
    () => calculateRetainedStageRowLogicalBytes("runs", { ...runs, started_at: Number.NaN }),
    TypeError,
  );
  assert.throws(
    () => calculateRetainedStageRowLogicalBytes("runs", { ...runs, started_at: 1.5 }),
    TypeError,
  );
  assert.throws(
    () => calculateRetainedStageRowLogicalBytes("runs", { ...runs, started_at: Number.MAX_SAFE_INTEGER + 1 }),
    TypeError,
  );
  assert.throws(
    () => calculateRetainedStageRowLogicalBytes("runs", { ...runs, started_at: 2n ** 63n }),
    TypeError,
  );
  assert.throws(
    () => calculateRetainedStageRowLogicalBytes("runs", { ...runs, started_at: null }),
    TypeError,
  );
  assert.throws(
    () => calculateRetainedStageRowLogicalBytes("runs", { ...runs, algorithm_format: 5 }),
    TypeError,
  );
});

test("does not parse JSON or normalize text and includes signed revision fields", () => {
  assert.equal(
    calculateRetainedStageRowLogicalBytes("pages", pages),
    independentlyExpectedBytes("pages", pages),
  );
  assert.equal(
    calculateRetainedStageRowLogicalBytes("revisions", revisions),
    independentlyExpectedBytes("revisions", revisions),
  );
  assert.equal(calculateRetainedStageRowLogicalDelta("runs", null, null), 0);
});

const candidateEpoch = {
  epoch_id: "candidate-epoch-🧪",
  mode: "rewrite",
  target_projection_version: 5,
  algorithm_format: "retained-fact-projection-v1",
  restart: "beginning",
  state: "sealed",
  manifest_revision: 9n,
  created_at: 1_700_000_000_000,
  frozen_at: 1_700_000_000_100,
  sealed_at: 1_700_000_000_200,
  baseline_generation_id: 3n,
  baseline_projection_version: 4n,
  baseline_source_frontier_state: "unavailable",
  membership_count: 2,
  membership_cursor: null,
  membership_rolling_digest: "a".repeat(64),
  membership_digest: "b".repeat(64),
  pin_cursor: null,
  pinned_count: 2,
  pinned_rolling_digest: "c".repeat(64),
  seal_membership_rolling_digest: "d".repeat(64),
  observation_digest: "e".repeat(64),
  observation_quality: "degraded",
  last_operation_digest: "f".repeat(64),
  error_text: "opaque malformed candidate error\u0000μ",
} satisfies RetainedAccountingLogicalRow;

const candidateMember = {
  epoch_id: "candidate-epoch-🧪",
  thread_id: "thread-🧪\u0000",
  run_id: "run-candidate-1",
  member_revision: 1n,
  pin_operation_digest: "1".repeat(64),
  bound_stage_accounting_revision: 44n,
  bound_next_page: 2,
  bound_checkpoint_digest: "2".repeat(64),
  pin_state: "pinned",
  outcome: "source-exhausted",
  observed_next_page: 3,
  observed_last_page_digest: "3".repeat(64),
  observed_checkpoint_digest: "4".repeat(64),
  observed_operation_digest: "5".repeat(64),
  observed_source_after_seq: "9223372036854775807",
  observed_fact_max_seq: 922337,
  observed_incomplete_reasons_json: "[\"incomplete\"]",
  observed_rewrite_required: 1,
  observed_rewrite_directive_json: "{\"restart\":\"beginning\"}",
  failure_reason: null,
  terminal_reason: null,
  error_text: "not-json opaque error",
  observation_digest: "6".repeat(64),
  observed_at: 1_700_000_000_300,
  observed_stage_accounting_revision: 45n,
} satisfies RetainedAccountingLogicalRow;

const candidateTables: readonly RetainedAccountingLogicalTable[] = ["candidate_epochs", "candidate_members"];

test("accounts the immutable v2 candidate inventory independently and freezes it", () => {
  assert.equal(Object.isFrozen(RETAINED_ACCOUNTING_V2_COLUMN_INVENTORY), true);
  for (const table of candidateTables) {
    assert.equal(Object.isFrozen(RETAINED_ACCOUNTING_V2_COLUMN_INVENTORY[table]), true);
    for (const column of RETAINED_ACCOUNTING_V2_COLUMN_INVENTORY[table]) assert.equal(Object.isFrozen(column), true);
  }
  const epochs = calculateRetainedAccountingRowLogicalBytes("candidate_epochs", candidateEpoch);
  const members = calculateRetainedAccountingRowLogicalBytes("candidate_members", candidateMember);
  assert.ok(epochs > 0);
  assert.ok(members > 0);
  assert.equal(calculateRetainedAccountingRowLogicalDelta("candidate_epochs", candidateEpoch, candidateEpoch), 0);
  assert.equal(calculateRetainedAccountingRowLogicalDelta("candidate_members", null, candidateMember), members);
  assert.equal(calculateRetainedAccountingRowLogicalDelta("candidate_members", candidateMember, null), -members);
  assert.equal(
    calculateRetainedAccountingRowLogicalDelta("candidate_epochs", candidateEpoch, { ...candidateEpoch, error_text: "changed🧪" }),
    scalarBytes("changed🧪") - scalarBytes(candidateEpoch.error_text),
  );
});

test("candidate accounting keeps opaque malformed text and rejects invalid table controls", () => {
  assert.equal(
    calculateRetainedAccountingRowLogicalBytes("candidate_members", { ...candidateMember, observed_incomplete_reasons_json: "not-json\u0000🧪" }),
    calculateRetainedAccountingRowLogicalBytes("candidate_members", candidateMember)
      + scalarBytes("not-json\u0000🧪") - scalarBytes(candidateMember.observed_incomplete_reasons_json),
  );
  const invalid = (value: unknown): RetainedAccountingLogicalTable => value as RetainedAccountingLogicalTable;
  for (const value of ["candidate_unknown", null, new String("candidate_members"), { toString() { throw new Error("coercion"); } }]) {
    assert.throws(() => calculateRetainedAccountingRowLogicalBytes(invalid(value), candidateMember), TypeError);
    assert.throws(() => calculateRetainedAccountingRowLogicalDelta(invalid(value), null, null), TypeError);
  }
});
