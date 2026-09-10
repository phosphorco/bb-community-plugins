import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import type { ToolExecutionFact } from "../fact-projection.ts";
import type { AnalyticsReferenceCapsule } from "../analytics-reference.ts";
import {
  projectRetainedEventPage,
} from "../extraction/event-projector.ts";
import {
  candidateObservationDigest,
  MANAGED_CANDIDATE_ALGORITHM,
  MANAGED_CANDIDATE_RESTART,
  MANAGED_CANDIDATE_ROLLING_SEED,
  MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
} from "../extraction/candidate-epoch.ts";
import {
  createRetainedSourceAdapter,
  type RetainedSourceEvent,
  type RetainedSourceLimits,
  type RetainedSourceSdk,
} from "../extraction/source-adapter.ts";
import {
  canonicalizeRetainedStageFact,
  RETAINED_CHECKPOINT_FORMAT,
  RETAINED_PROJECTION_ALGORITHM,
  RETAINED_STAGE_HARD_LIMITS,
  RETAINED_TARGET_PROJECTION_VERSION,
  type RetainedProjectionCheckpoint,
  type RetainedProjectionStagePage,
} from "../extraction/staging.ts";
import {
  AnalyticsRefreshCoordinator,
  AnalyticsStore,
  AccountingNotReady,
  AccountingRevisionConflict,
  analyticsMigrations,
  RETAINED_ACCOUNTING_V1_MIGRATION_START,
  RETAINED_ACCOUNTING_V2_MIGRATION_START,
  RetainedProjectionTerminalError,
} from "../store.ts";
import {
  calculateRetainedAccountingRowLogicalBytes,
  calculateRetainedStageRowLogicalBytes,
  type RetainedStageLogicalRow,
  type RetainedStageLogicalTable,
  type RetainedAccountingLogicalRow,
  type RetainedAccountingLogicalTable,
} from "../extraction/logical-byte-accounting.ts";

function facts(count: number): ToolExecutionFact[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    sourceEventId: `event-${index}`,
    threadId: `thread-${index % 80}`,
    turnId: `turn-${index % 400}`,
    sequence: index,
    projectId: `project-${index % 4}`,
    providerId: `provider-${index % 3}`,
    createdAtMs: now - (index % 14) * 3_600_000,
    turnStartedAtMs: now - (index % 14) * 3_600_000 - 1_000,
    turnCompletedAtMs: now - (index % 14) * 3_600_000 + 1_000,
    capabilityKind: "tool" as const,
    capabilityKey: `bb:tool_${index % 24}`,
    status: index % 17 === 0 ? "failed" as const : "completed" as const,
    durationMs: index % 10_000,
    failed: index % 17 === 0,
    errorClass: index % 17 === 0 ? "network" : null,
    errorSignature: index % 17 === 0 ? "0123456789abcdef" : null,
    commandBinary: null,
    commandArgument1: null,
    commandArgument2: null,
    commandUsesHelp: false,
    commandShape: null,
    commandShellWrapped: false,
    commandAttributionEligible: false,
  }));
}

function migrateStore(): { db: Database.Database; store: AnalyticsStore } {
  const db = new Database(":memory:");
  for (const migration of analyticsMigrations) db.exec(migration);
  return { db, store: new AnalyticsStore(db) };
}

function reconcileRetainedAccounting(store: AnalyticsStore): ReturnType<AnalyticsStore["readRetainedStageAccounting"]> {
  let progress = store.bootstrapRetainedStageAccounting();
  for (let step = 0; progress.state === "rebuilding" && step < 20; step += 1) {
    progress = store.advanceRetainedStageAccounting({
      generation: progress.rebuildGeneration,
      expectedAccountingRevision: progress.accountingRevision,
    });
  }
  assert.notEqual(progress.state, "rebuilding");
  return progress;
}

const independentlyAuthoredAccountingSqlColumns = {
  runs: {
    text: ["run_id", "epoch_id", "thread_id", "mode", "state", "next_cursor", "last_error", "algorithm_format", "checkpoint_json", "checkpoint_digest", "source_after_seq", "last_operation_digest", "terminal_reason", "failure_reason"],
    integer: ["target_projection_version", "next_page", "rows_staged", "bytes_staged", "max_observed_seq", "max_pages", "max_rows", "max_bytes", "started_at", "fact_max_seq", "revision_count", "revision_payload_bytes", "metadata_bytes", "terminal_at", "max_checkpoint_bytes", "max_metadata_bytes", "max_turn_states", "max_timing_refs", "max_revisions"],
  },
  pages: {
    text: ["run_id", "cursor_in", "cursor_out", "page_digest", "source_page_digest", "request_digest", "checkpoint_digest", "operation_digest", "ref_releases_json"],
    integer: ["page", "rows_staged", "bytes_staged", "received_at", "source_page_exhausted", "revision_count", "revision_payload_bytes", "revision_bytes_delta", "metadata_bytes"],
  },
  facts: {
    text: ["run_id", "source_event_id", "thread_id", "fact_json", "fact_digest"],
    integer: [],
  },
  revisions: {
    text: ["run_id", "revision_key", "source_event_id", "revision_json", "revision_digest", "expected_fact_digest", "resulting_fact_digest"],
    integer: ["payload_bytes", "bytes_delta"],
  },
} as const satisfies Record<RetainedStageLogicalTable, { text: readonly string[]; integer: readonly string[] }>;

const independentlyAuthoredCandidateSqlColumns = {
  candidate_epochs: {
    text: ["epoch_id", "mode", "algorithm_format", "restart", "state", "baseline_source_frontier_state", "membership_cursor", "membership_rolling_digest", "membership_digest", "pin_cursor", "pinned_rolling_digest", "seal_membership_rolling_digest", "observation_digest", "observation_quality", "last_operation_digest", "error_text"],
    integer: ["target_projection_version", "manifest_revision", "created_at", "frozen_at", "sealed_at", "baseline_generation_id", "baseline_projection_version", "membership_count", "pinned_count"],
  },
  candidate_members: {
    text: ["epoch_id", "thread_id", "run_id", "pin_operation_digest", "bound_checkpoint_digest", "pin_state", "outcome", "observed_last_page_digest", "observed_checkpoint_digest", "observed_operation_digest", "observed_source_after_seq", "observed_incomplete_reasons_json", "observed_rewrite_directive_json", "failure_reason", "terminal_reason", "error_text", "observation_digest"],
    integer: ["member_revision", "bound_stage_accounting_revision", "bound_next_page", "observed_next_page", "observed_fact_max_seq", "observed_rewrite_required", "observed_at", "observed_stage_accounting_revision"],
  },
} as const satisfies Record<Exclude<RetainedAccountingLogicalTable, RetainedStageLogicalTable>, { text: readonly string[]; integer: readonly string[] }>;

function independentlyAuthoredSqlLogicalTotal(
  db: Database.Database,
  table: RetainedStageLogicalTable,
): bigint {
  const terms = [
    ...independentlyAuthoredAccountingSqlColumns[table].text.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`),
    ...independentlyAuthoredAccountingSqlColumns[table].integer.map((column) => `COALESCE(length(CAST(${column} AS TEXT)),0)`),
  ];
  const row = db.prepare(`SELECT COALESCE(SUM(${terms.join("+")}),0) AS total FROM analytics_retained_stage_${table}`).safeIntegers().get() as { total: bigint };
  return row.total;
}

function independentlyAuthoredCandidateSqlLogicalTotal(
  db: Database.Database,
  table: Exclude<RetainedAccountingLogicalTable, RetainedStageLogicalTable>,
): bigint {
  const terms = [
    ...independentlyAuthoredCandidateSqlColumns[table].text.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`),
    ...independentlyAuthoredCandidateSqlColumns[table].integer.map((column) => `COALESCE(length(CAST(${column} AS TEXT)),0)`),
  ];
  const row = db.prepare(`SELECT COALESCE(SUM(${terms.join("+")}),0) AS total FROM analytics_retained_${table}`).safeIntegers().get() as { total: bigint };
  return row.total;
}

const INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT = 256;
const INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET = 1_048_576n;

function independentlyAuthoredCandidateMemberBatch(
  db: Database.Database,
  epochId: string,
  cursor: string | null,
  pinState: "bound" | "pinned",
): {
  rows: number;
  logicalBytes: bigint;
  firstThreadId: string | null;
  lastThreadId: string | null;
  excludedThreadId: string | null;
  excludedLogicalBytes: bigint | null;
} {
  const terms = [
    ...independentlyAuthoredCandidateSqlColumns.candidate_members.text.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`),
    ...independentlyAuthoredCandidateSqlColumns.candidate_members.integer.map((column) => `COALESCE(length(CAST(${column} AS TEXT)),0)`),
  ];
  const rows = db.prepare(`SELECT thread_id,${terms.join("+")} AS logical_row_bytes
    FROM analytics_retained_candidate_members
    WHERE epoch_id=? AND pin_state=?${cursor == null ? "" : " AND thread_id COLLATE BINARY > ?"}
    ORDER BY thread_id COLLATE BINARY LIMIT ${INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT + 1}`).safeIntegers().all(...(cursor == null ? [epochId, pinState] : [epochId, pinState, cursor])) as Array<{ thread_id: string; logical_row_bytes: bigint }>;
  let logicalBytes = 0n;
  const selected: Array<{ thread_id: string; logical_row_bytes: bigint }> = [];
  let excluded: { thread_id: string; logical_row_bytes: bigint } | null = null;
  for (const row of rows) {
    if (selected.length >= INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT || (selected.length > 0 && logicalBytes + row.logical_row_bytes > INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET)) {
      excluded = row;
      break;
    }
    selected.push(row);
    logicalBytes += row.logical_row_bytes;
    if (logicalBytes >= INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET) break;
  }
  return {
    rows: selected.length,
    logicalBytes,
    firstThreadId: selected.length === 0 ? null : selected[0]!.thread_id,
    lastThreadId: selected.length === 0 ? null : selected[selected.length - 1]!.thread_id,
    excludedThreadId: excluded?.thread_id ?? null,
    excludedLogicalBytes: excluded?.logical_row_bytes ?? null,
  };
}

function retainedAccountingMaterialTotals(db: Database.Database): { helper: number; sql: bigint; rows: Record<RetainedStageLogicalTable, number> } {
  const tables: readonly RetainedStageLogicalTable[] = ["runs", "pages", "facts", "revisions"];
  let helper = 0;
  let sql = 0n;
  const rows = {} as Record<RetainedStageLogicalTable, number>;
  for (const table of tables) {
    const persisted = db.prepare(`SELECT * FROM analytics_retained_stage_${table}`).safeIntegers().all() as RetainedStageLogicalRow[];
    rows[table] = persisted.length;
    helper += persisted.reduce((sum, row) => sum + calculateRetainedStageRowLogicalBytes(table, row), 0);
    sql += independentlyAuthoredSqlLogicalTotal(db, table);
  }
  return { helper, sql, rows };
}

function retainedAccountingCandidateTotals(db: Database.Database): { helper: number; sql: bigint; rows: Record<Exclude<RetainedAccountingLogicalTable, RetainedStageLogicalTable>, number> } {
  const tables = ["candidate_epochs", "candidate_members"] as const;
  let helper = 0;
  let sql = 0n;
  const rows = {} as Record<typeof tables[number], number>;
  for (const table of tables) {
    const persisted = db.prepare(`SELECT * FROM analytics_retained_${table}`).safeIntegers().all() as RetainedAccountingLogicalRow[];
    rows[table] = persisted.length;
    helper += persisted.reduce((sum, row) => sum + calculateRetainedAccountingRowLogicalBytes(table, row), 0);
    sql += independentlyAuthoredCandidateSqlLogicalTotal(db, table);
  }
  return { helper, sql, rows };
}

function assertRetainedAccountingTotals(db: Database.Database, store: AnalyticsStore): ReturnType<AnalyticsStore["readRetainedStageAccounting"]> {
  const actual = store.readRetainedStageAccounting();
  const expected = retainedAccountingMaterialTotals(db);
  assert.equal(actual.state, "ready");
  assert.ok(Number.isSafeInteger(expected.helper));
  assert.equal(BigInt(expected.helper), expected.sql, "independent SQL and logical-byte helper agree");
  assert.equal(actual.runRows, BigInt(expected.rows.runs));
  assert.equal(actual.pageRows, BigInt(expected.rows.pages));
  assert.equal(actual.factRows, BigInt(expected.rows.facts));
  assert.equal(actual.revisionRows, BigInt(expected.rows.revisions));
  const candidates = retainedAccountingCandidateTotals(db);
  assert.equal(candidates.helper, Number(candidates.sql));
  assert.equal(actual.candidateEpochRows, BigInt(candidates.rows.candidate_epochs));
  assert.equal(actual.candidateMemberRows, BigInt(candidates.rows.candidate_members));
  assert.equal(actual.logicalBytes, expected.sql + candidates.sql, "published accounting measures all six retained tables");
  return actual;
}

function retainedCandidateIsolationSnapshot(db: Database.Database, store: AnalyticsStore): unknown {
  return {
    runs: db.prepare("SELECT * FROM analytics_retained_stage_runs ORDER BY run_id").all(),
    pages: db.prepare("SELECT * FROM analytics_retained_stage_pages ORDER BY run_id,page").all(),
    facts: db.prepare("SELECT * FROM analytics_retained_stage_facts ORDER BY run_id,source_event_id").all(),
    revisions: db.prepare("SELECT * FROM analytics_retained_stage_revisions ORDER BY run_id,revision_key").all(),
    candidateEpochs: db.prepare("SELECT * FROM analytics_retained_candidate_epochs ORDER BY epoch_id").all(),
    candidateMembers: db.prepare("SELECT * FROM analytics_retained_candidate_members ORDER BY epoch_id,thread_id").all(),
    accounting: db.prepare("SELECT * FROM analytics_retained_stage_accounting").all(),
    activeFacts: db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(),
    activeIndex: store.getIndexState(),
    threadState: db.prepare("SELECT * FROM analytics_thread_state ORDER BY thread_id").all(),
  };
}

const EXPECTED_HISTORIC_RETAINED_MIGRATION_PREFIX_SHA256 = "f4144c6e6557e27a3fa630a89bcf89daaf86383a1ebd91c85adefc072c92187d";
const EXPECTED_RETAINED_ACCOUNTING_V1_SUFFIX_SHA256 = [
  "5198194888754630f1f59fa632959623860986b418f73601783e41893fa682d6",
  "466797f4e2d376e8f8f682bac6996aed4d7e19f7ad3acac5ab73136eca8c43de",
  "0d8567390bcab005732770e6dd1dd48d14b3053a6e651ffe7e97443fde9b6c60",
  "6a003523f9f228f39bd4fd987f56eb96f85dd938a3a2bf46b18ac8684772d3a1",
  "73a441a3ca72ca251e4937ba04ede270d4e390fa9275c3c1bf4ae25c5c51ebf9",
  "637b8d4a1f19da7cb1f8c4a9e32265ea281a097ff7c4548192402f40e6f65c18",
  "ce675f42f2e727540f53b4ce45a8f25efcb9cd1cee29099b0e53c9b2647f28dc",
  "1d6c77ad784cd061d037e358a935b0d879c7e5b82f06ebc3c9ef1cab4d3a3c68",
  "6d266c8f4251b0e138ca02ebe57af4e73632115ee5435377d38c788561940165",
  "1b529a0af7cbffa8b2953835c2a2236b7c93841beedfc4336103c42c2b1ea34b",
  "2c53a928863dab2e2f2421962edcef7357b35ef5376fc747813e370a3bfda6ac",
  "97ed24a897036249120d36c4d614cfe339a4fe0542177b09a09094fc486ed5d0",
  "b48d9d9ec47ba1089c5b78a9a83fbefa93db0dc6fce0b4190cfe6468bf747adf",
  "9e5e8e0618bbf43b0299f94b43f9e096db0bd2d194dcce3a29b69e608d7dbbf6",
] as const;
const EXPECTED_RETAINED_ACCOUNTING_V2_SUFFIX_SHA256 = [
  "f83d2857f4549617781dd6497a996eecb2300e70f96c6bafac66a31669c25253",
  "759b31e82c51985a16a3c92e205acef0f0aa856e9a669d10c9efc6633f395fab",
  "e9f1fd063c767efe3d7388f951481865933053a67797f26d3f3881c9b2158ac4",
  "8128fbdbb8fefe5d0b0915f24554a1722bf762ac8feaac5407cd135b5bedf149",
  "e9ece15e110a46aeeb4aff077fcadbd05a077b128e100bc0b82780637c15145d",
  "18a1241fc3ea97f610f5041fbbcb19278523006899bbe5c5c2a3df3899291c8f",
  "52244c3a52b8c8f7f4a2c38424e0a5503a9603729985f6f90ee93796e11bce93",
  "c61f4609ba1e3f2017041298af5218fdfdec3467bd3727ac8daf0037a4bec73b",
] as const;

test("pins the historical migration prefix and immutable v1 accounting SQL suffix", () => {
  const digest = (sql: string): string => createHash("sha256").update(sql).digest("hex");
  assert.equal(digest(analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START).join("\n")), EXPECTED_HISTORIC_RETAINED_MIGRATION_PREFIX_SHA256);
  assert.deepEqual(analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START, RETAINED_ACCOUNTING_V2_MIGRATION_START).map(digest), EXPECTED_RETAINED_ACCOUNTING_V1_SUFFIX_SHA256);
  assert.deepEqual(analyticsMigrations.slice(RETAINED_ACCOUNTING_V2_MIGRATION_START).map(digest), EXPECTED_RETAINED_ACCOUNTING_V2_SUFFIX_SHA256);
  assert.equal(RETAINED_ACCOUNTING_V2_MIGRATION_START, 70, "all historical migration strings remain before the v2 suffix");
  assert.equal(analyticsMigrations.length, 78, "v2 appends exactly eight migration strings");
});

function retainedStageInput(runId = "retained-run"): Parameters<AnalyticsStore["openRetainedStage"]>[0] {
  return {
    runId,
    epochId: "membership-epoch-1",
    threadId: "thread-retained",
    mode: "rewrite",
    targetProjectionVersion: 4,
    budget: { maxPages: 3, maxRows: 3, maxBytes: 20_000 },
    startedAt: 10_000,
  };
}

function retainedFact(sourceEventId: string, sequence: number): ToolExecutionFact {
  return { ...facts(1)[0]!, sourceEventId, threadId: "thread-retained", sequence };
}

function explicitProjectionFact(
  sourceEventId: string,
  sequence: number,
  turnId: string | null,
  turnStartedAtMs: number | null,
  turnCompletedAtMs: number | null,
  threadId = "thread-projection",
): ToolExecutionFact {
  return {
    sourceEventId,
    threadId,
    turnId,
    sequence,
    projectId: "project-1",
    providerId: "provider-1",
    createdAtMs: 10_000 + sequence,
    turnStartedAtMs,
    turnCompletedAtMs,
    capabilityKind: "tool",
    capabilityKey: "bb:read_slack",
    status: "completed",
    durationMs: 120,
    failed: false,
    errorClass: null,
    errorSignature: null,
    commandBinary: null,
    commandArgument1: null,
    commandArgument2: null,
    commandUsesHelp: false,
    commandShape: null,
    commandShellWrapped: false,
    commandAttributionEligible: false,
  };
}

function projectionStageInput(
  runId = "projection-run",
  overrides: Partial<Parameters<AnalyticsStore["openRetainedProjectionStage"]>[0]> = {},
): Parameters<AnalyticsStore["openRetainedProjectionStage"]>[0] {
  return {
    runId,
    epochId: `${runId}-epoch`,
    threadId: "thread-projection",
    mode: "rewrite",
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    budget: {
      maxPages: 4,
      maxRows: 8,
      maxBytes: 20_000,
      maxCheckpointBytes: 16_000,
      maxMetadataBytes: 100_000,
      maxTurnStates: 8,
      maxTimingRefs: 8,
      maxRevisions: 8,
    },
    startedAt: 10_000,
    ...overrides,
  };
}

function factDigest(fact: ToolExecutionFact): string {
  return createHash("sha256").update(canonicalizeRetainedStageFact(fact).json).digest("hex");
}

function independentlyAuthoredRefCapCheckpoint(
  runId: string,
  threadId: string,
  firstFact: ToolExecutionFact,
  secondFact: ToolExecutionFact,
): RetainedProjectionCheckpoint {
  return {
    format: RETAINED_CHECKPOINT_FORMAT,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    mode: "rewrite",
    runId,
    threadId,
    nextStagePage: 1,
    sourceAfterSeq: "2",
    maxFactSeq: 2,
    turns: [
      {
        turnId: firstFact.turnId!,
        startedAtMs: null,
        completedAtMs: null,
        startedSeq: null,
        completedSeq: null,
        revisionSeq: null,
        lastSeenSeq: 1,
        degraded: false,
        status: "partial",
      },
      {
        turnId: secondFact.turnId!,
        startedAtMs: null,
        completedAtMs: null,
        startedSeq: null,
        completedSeq: null,
        revisionSeq: null,
        lastSeenSeq: 2,
        degraded: false,
        status: "partial",
      },
    ],
    timingRefs: [
      {
        sourceEventId: secondFact.sourceEventId,
        turnId: secondFact.turnId!,
        sequence: 2,
        factDigest: factDigest(secondFact),
        turnStartedAtMs: null,
        turnCompletedAtMs: null,
      },
    ],
    revisitReasons: ["incomplete", "partial-turn-timing", "timing-ref-evicted"],
    rewriteRequired: true,
    rewriteDirective: { threadId, restart: "beginning", reasons: ["ref-cap"] },
  };
}

function projectionCheckpoint(
  base: RetainedProjectionCheckpoint,
  overrides: Partial<RetainedProjectionCheckpoint>,
): RetainedProjectionCheckpoint {
  return { ...base, ...overrides };
}

function projectionPage(
  input: Parameters<AnalyticsStore["openRetainedProjectionStage"]>[0],
  progress: ReturnType<AnalyticsStore["openRetainedProjectionStage"]>,
  page: number,
  checkpoint: RetainedProjectionCheckpoint,
  facts: readonly ToolExecutionFact[],
  timestampRevisions: RetainedProjectionStagePage["timestampRevisions"],
  cursorOut: string | null,
  pageDigest: string,
  refReleases: RetainedProjectionStagePage["refReleases"] = [],
  pageExhausted = false,
): RetainedProjectionStagePage {
  return {
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    page,
    checkpointDigestIn: progress.checkpointDigest,
    source: {
      cursorIn: progress.sourceAfterSeq,
      cursorOut,
      pageExhausted,
      pageDigest,
    },
    facts,
    timestampRevisions,
    refReleases,
    checkpoint,
    receivedAt: 10_100 + page,
  };
}

const roundtripSourceLimits = (overrides: Partial<RetainedSourceLimits> = {}): RetainedSourceLimits => ({
  listPageSize: 2,
  eventPageSize: 3,
  maxCalls: 12,
  maxListPages: 4,
  maxEventPages: 8,
  maxRows: 20,
  maxResponseBytes: 100_000,
  ...overrides,
});

function roundtripEvent(
  threadId: string,
  seq: number,
  type: "turn/started" | "turn/completed" | "item/completed",
  turnId: string,
  id: string,
  createdAt: number,
): RetainedSourceEvent {
  const common = {
    id,
    threadId,
    seq,
    createdAt,
    scope: { kind: "turn" as const, turnId },
    p6rActorHandle: null,
  };
  if (type === "turn/started") {
    return { ...common, type: "turn/started", data: { providerThreadId: "provider-thread" } } satisfies RetainedSourceEvent;
  }
  if (type === "turn/completed") {
    return { ...common, type: "turn/completed", data: { providerThreadId: "provider-thread", status: "completed" } } satisfies RetainedSourceEvent;
  }
  return {
    ...common,
    type: "item/completed",
    data: {
      providerThreadId: "provider-thread",
      item: {
        id: `${id}-item`,
        type: "toolCall",
        server: "bb",
        tool: "read_slack",
        status: "completed",
        durationMs: 120,
      },
    },
  } satisfies RetainedSourceEvent;
}

function roundtripSdk(pages: readonly (readonly RetainedSourceEvent[])[]): RetainedSourceSdk {
  const remaining = [...pages];
  return {
    threads: {
      async list() { return []; },
      async get() { throw new Error("unexpected thread get"); },
      events: {
        async list() { return [...(remaining.shift() ?? [])]; },
      },
    },
  };
}

test("binds and seals a v5 candidate from actual adapter/projector pages without active publication", async (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const activeBefore = store.getIndexState();
  const activeFactsBefore = db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all();
  const stageInput = projectionStageInput("candidate-roundtrip", { epochId: "candidate-epoch-1", mode: "rewrite" });
  const opened = store.openRetainedProjectionStage(stageInput);
  const epoch = store.openRetainedCandidateEpoch({
    epochId: "candidate-epoch-1",
    mode: "rewrite",
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 20_000,
  });
  const sdk = roundtripSdk([
    [
      roundtripEvent("thread-projection", 1, "turn/started", "candidate-turn", "candidate-start", 10_001),
      roundtripEvent("thread-projection", 2, "item/completed", "candidate-turn", "candidate-item", 10_002),
    ],
    [roundtripEvent("thread-projection", 3, "turn/completed", "candidate-turn", "candidate-complete", 10_003)],
  ]);
  const adapter = createRetainedSourceAdapter(sdk, roundtripSourceLimits({ eventPageSize: 3 }));
  const source1 = await adapter.eventPage({ threadId: "thread-projection" });
  const projected1 = projectRetainedEventPage({
    runId: stageInput.runId,
    threadId: stageInput.threadId,
    mode: stageInput.mode,
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    stagePage: 0,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source1,
    checkpoint: null,
    limits: { maxTurnStates: 8, maxTimingRefs: 8, maxCheckpointBytes: 16_000 },
    receivedAt: 20_001,
  });
  const expectedFact = explicitProjectionFact("candidate-item", 2, "candidate-turn", 10_001, null);
  assert.deepEqual(projected1.facts, [expectedFact], "expected fact is independently authored");
  const staged1 = store.appendRetainedProjectionStagePage({
    ...projected1,
    runId: stageInput.runId,
    threadId: stageInput.threadId,
    mode: stageInput.mode,
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    page: 0,
    receivedAt: 20_001,
  });
  const bound = store.bindRetainedCandidateMember({ epochId: epoch.epochId, threadId: stageInput.threadId, runId: stageInput.runId });
  const boundEpoch = store.getRetainedCandidateEpoch(epoch.epochId)!;
  const source2 = await adapter.eventPage({ threadId: "thread-projection", afterSeq: source1.metadata.sourceAfterSeq });
  const projected2 = projectRetainedEventPage({
    runId: stageInput.runId,
    threadId: stageInput.threadId,
    mode: stageInput.mode,
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    stagePage: 1,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source2,
    checkpoint: staged1.checkpoint,
    limits: { maxTurnStates: 8, maxTimingRefs: 8, maxCheckpointBytes: 16_000 },
    receivedAt: 20_002,
  });
  assert.equal(projected2.timestampRevisions.length, 1);
  assert.equal(projected2.refReleases[0]?.reason, "completed");
  const staged2 = store.appendRetainedProjectionStagePage({
    ...projected2,
    runId: stageInput.runId,
    threadId: stageInput.threadId,
    mode: stageInput.mode,
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    page: 1,
    receivedAt: 20_002,
    checkpointDigestIn: staged1.checkpointDigest,
  });
  assert.equal(staged2.checkpoint.sourceAfterSeq, "3");
  let frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: boundEpoch.manifestRevision });
  assert.deepEqual(store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: boundEpoch.manifestRevision }), frozen, "latest exact freeze replay is a no-op");
  frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: frozen.manifestRevision });
  assert.equal(frozen.state, "frozen");
  const pinned = store.pinRetainedCandidateMember({ epochId: epoch.epochId, threadId: stageInput.threadId, expectedMemberRevision: bound.memberRevision });
  assert.equal(pinned.pinState, "pinned");
  assert.deepEqual(store.pinRetainedCandidateMember({ epochId: epoch.epochId, threadId: stageInput.threadId, expectedMemberRevision: bound.memberRevision }), pinned, "latest exact pin replay is a no-op");
  const beforePinnedAppend = retainedCandidateIsolationSnapshot(db, store);
  assert.throws(() => store.appendRetainedProjectionStagePage({
    runId: stageInput.runId,
    threadId: stageInput.threadId,
    mode: stageInput.mode,
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    page: 2,
    checkpointDigestIn: staged2.checkpointDigest,
    source: { cursorIn: "3", cursorOut: "3", pageExhausted: true, pageDigest: "d".repeat(64) },
    facts: [],
    timestampRevisions: [],
    refReleases: [],
    checkpoint: projectionCheckpoint(staged2.checkpoint, { nextStagePage: 3, sourceAfterSeq: "3" }),
    receivedAt: 20_003,
  }), /pinned/);
  assert.deepEqual(retainedCandidateIsolationSnapshot(db, store), beforePinnedAppend);
  let sealed = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: store.getRetainedCandidateEpoch(epoch.epochId)!.manifestRevision });
  sealed = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: sealed.manifestRevision });
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.baselineSourceFrontierState, "unavailable");
  assert.equal(sealed.observationQuality, "degraded");
  assert.equal(store.getIndexState().generationId, activeBefore.generationId);
  assert.deepEqual(store.getIndexState(), activeBefore);
  assert.deepEqual(db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(), activeFactsBefore);
  const pinnedSnapshot = retainedCandidateIsolationSnapshot(db, store);
  assert.throws(() => store.failRetainedProjectionStage({ ...stageInput, reason: "source-error", error: "late pinned failure" }), /pinned/);
  for (const statement of [
    "UPDATE analytics_retained_stage_runs SET last_error='direct' WHERE run_id=?",
    "UPDATE analytics_retained_stage_pages SET received_at=received_at WHERE run_id=? AND page=0",
    "UPDATE analytics_retained_stage_facts SET fact_digest=fact_digest WHERE run_id=?",
    "UPDATE analytics_retained_stage_revisions SET bytes_delta=bytes_delta WHERE run_id=?",
  ]) {
    assert.throws(() => db.prepare(statement).run(stageInput.runId), /pinned/);
    assert.deepEqual(retainedCandidateIsolationSnapshot(db, store), pinnedSnapshot, statement);
  }
  const accounted = assertRetainedAccountingTotals(db, store);
  assert.equal(accounted.candidateEpochRows, 1n);
  assert.equal(accounted.candidateMemberRows, 1n);
  assert.throws(() => db.prepare("UPDATE analytics_retained_candidate_epochs SET error_text=? WHERE epoch_id=?").run("opaque direct candidate update", epoch.epochId), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM analytics_retained_candidate_members WHERE epoch_id=? AND thread_id=?").run(epoch.epochId, stageInput.threadId), /immutable/);
  assertRetainedAccountingTotals(db, store);
  assert.deepEqual(db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(), activeFactsBefore);
});

test("pins failed and terminal-capped members without inventing a source page", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const epoch = store.openRetainedCandidateEpoch({
    epochId: "candidate-outcomes-epoch",
    mode: "upgrade",
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 21_000,
  });
  const failedInput = projectionStageInput("candidate-failed", { epochId: epoch.epochId, threadId: "thread-failed", mode: "upgrade" });
  const failed = store.openRetainedProjectionStage(failedInput);
  store.failRetainedProjectionStage({ ...failedInput, reason: "source-error", error: "failed before first page" });
  const cappedInput = projectionStageInput("candidate-capped", { epochId: epoch.epochId, threadId: "thread-capped", mode: "upgrade", budget: { ...projectionStageInput().budget, maxPages: 1 } });
  const capped = store.openRetainedProjectionStage(cappedInput);
  const cappedCheckpoint = projectionCheckpoint(capped.checkpoint, { nextStagePage: 1, sourceAfterSeq: null, maxFactSeq: null });
  store.appendRetainedProjectionStagePage(projectionPage(cappedInput, capped, 0, cappedCheckpoint, [], [], null, "e".repeat(64)));
  store.closeRetainedProjectionStageAtPageLimit(cappedInput);
  store.bindRetainedCandidateMember({ epochId: epoch.epochId, threadId: failedInput.threadId, runId: failedInput.runId });
  store.bindRetainedCandidateMember({ epochId: epoch.epochId, threadId: cappedInput.threadId, runId: cappedInput.runId });
  let frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: 2n });
  frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: frozen.manifestRevision });
  assert.equal(frozen.state, "frozen");
  const failedMember = store.pinRetainedCandidateMember({ epochId: epoch.epochId, threadId: failedInput.threadId, expectedMemberRevision: 0n });
  const cappedMember = store.pinRetainedCandidateMember({ epochId: epoch.epochId, threadId: cappedInput.threadId, expectedMemberRevision: 0n });
  assert.equal(failedMember.outcome, "failed");
  assert.equal(failedMember.observedNextPage, 0);
  assert.equal(failedMember.observedLastPageDigest, null);
  assert.equal(cappedMember.outcome, "terminal-capped");
  assert.equal(cappedMember.observedNextPage, 1);
  assert.ok(cappedMember.observedLastPageDigest != null);
  assert.equal(store.getRetainedCandidateEpoch(epoch.epochId)?.state, "sealing");
  let sealed = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: store.getRetainedCandidateEpoch(epoch.epochId)!.manifestRevision });
  sealed = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: sealed.manifestRevision });
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.observationQuality, "degraded");
});

test("freezes and seals an empty managed candidate as a degraded observation", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const epoch = store.openRetainedCandidateEpoch({
    epochId: "candidate-empty-epoch",
    mode: "rewrite",
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 22_000,
  });
  const frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: epoch.manifestRevision });
  assert.equal(frozen.state, "frozen");
  assert.equal(frozen.membershipCount, 0n);
  assert.equal(frozen.membershipDigest, candidateObservationDigest({ kind: "membership-binding", epochId: epoch.epochId, mode: epoch.mode, count: "0", rolling: MANAGED_CANDIDATE_ROLLING_SEED }));
  assert.deepEqual(store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: epoch.manifestRevision }), frozen, "latest exact freeze replay is a no-op");
  const sealing = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: frozen.manifestRevision });
  assert.equal(sealing.state, "sealing");
  assert.equal(sealing.observationQuality, "degraded");
  assert.deepEqual(store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: frozen.manifestRevision }), sealing, "latest exact seal transition replay is a no-op");
  const sealed = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: sealing.manifestRevision });
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.membershipCount, 0n);
  assert.equal(sealed.pinnedCount, 0n);
  assert.equal(sealed.sealMembershipRollingDigest, MANAGED_CANDIDATE_ROLLING_SEED);
  assert.equal(sealed.observationDigest, candidateObservationDigest({ kind: "pinned-observations", epochId: epoch.epochId, mode: epoch.mode, count: "0", rolling: MANAGED_CANDIDATE_ROLLING_SEED }));
  assertRetainedAccountingTotals(db, store);
});

test("replays a managed manifest against its captured baseline and rejects altered observedAt", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = {
    epochId: "candidate-replay-epoch",
    mode: "upgrade" as const,
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 23_000,
  };
  const first = store.openRetainedCandidateEpoch(input);
  db.prepare("UPDATE analytics_index_state SET generation_id=99,fact_projection_version=6 WHERE singleton=1").run();
  const snapshot = retainedCandidateIsolationSnapshot(db, store);
  const replay = store.openRetainedCandidateEpoch(input);
  assert.deepEqual(replay, first);
  assert.deepEqual(retainedCandidateIsolationSnapshot(db, store), snapshot);
  assert.throws(() => store.openRetainedCandidateEpoch({ ...input, observedAt: 23_001 }), /Conflicting managed candidate epoch replay/);
  assert.deepEqual(retainedCandidateIsolationSnapshot(db, store), snapshot);
});

test("rejects a pinned candidate when the latest page/checkpoint proof is corrupted", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const epoch = store.openRetainedCandidateEpoch({
    epochId: "candidate-proof-epoch",
    mode: "rewrite",
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 24_000,
  });
  const stageInput = projectionStageInput("candidate-proof-run", { epochId: epoch.epochId, threadId: "candidate-proof-thread", mode: "rewrite" });
  const opened = store.openRetainedProjectionStage(stageInput);
  const checkpoint = projectionCheckpoint(opened.checkpoint, { nextStagePage: 1, sourceAfterSeq: null, maxFactSeq: null });
  store.appendRetainedProjectionStagePage(projectionPage(stageInput, opened, 0, checkpoint, [], [], null, "a".repeat(64), [], true));
  store.bindRetainedCandidateMember({ epochId: epoch.epochId, threadId: stageInput.threadId, runId: stageInput.runId });
  let frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: 1n });
  frozen = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: frozen.manifestRevision });
  db.prepare("UPDATE analytics_retained_stage_pages SET checkpoint_digest=? WHERE run_id=? AND page=0").run("0".repeat(64), stageInput.runId);
  const before = retainedCandidateIsolationSnapshot(db, store);
  assert.throws(() => store.pinRetainedCandidateMember({ epochId: epoch.epochId, threadId: stageInput.threadId, expectedMemberRevision: 0n }), /linkage/);
  assert.deepEqual(retainedCandidateIsolationSnapshot(db, store), before);
});

test("freezes and seals 257 managed members with independently measured bounded batches", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const epoch = store.openRetainedCandidateEpoch({
    epochId: `candidate-batch-epoch-${"e".repeat(490)}`,
    mode: "rewrite",
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 25_000,
  });
  const members: Array<{ threadId: string; runId: string }> = [];
  for (let index = 0; index < 257; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const threadId = `candidate-thread-${suffix}-${"t".repeat(490)}`;
    const runId = `candidate-run-${suffix}-${"r".repeat(490)}`;
    const input = projectionStageInput(runId, { epochId: epoch.epochId, threadId, mode: "rewrite", startedAt: 25_100 + index });
    store.openRetainedProjectionStage(input);
    store.failRetainedProjectionStage({ ...input, reason: "source-error", error: "e".repeat(2_000) });
    store.bindRetainedCandidateMember({ epochId: epoch.epochId, threadId, runId });
    members.push({ threadId, runId });
  }

  const firstFreezeBatch = independentlyAuthoredCandidateMemberBatch(db, epoch.epochId, null, "bound");
  assert.equal(firstFreezeBatch.rows, INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT);
  assert.ok(firstFreezeBatch.logicalBytes < INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET, "this fixture fits the byte target and does not claim a byte-cutoff witness");
  let progress = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: BigInt(members.length) });
  assert.equal(progress.state, "freezing");
  assert.equal(progress.membershipCount, BigInt(firstFreezeBatch.rows));
  assert.equal(progress.membershipCursor, firstFreezeBatch.lastThreadId);
  const secondFreezeBatch = independentlyAuthoredCandidateMemberBatch(db, epoch.epochId, progress.membershipCursor, "bound");
  assert.equal(secondFreezeBatch.rows, 1);
  assert.ok(secondFreezeBatch.logicalBytes < INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET);
  progress = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "freezing");
  assert.equal(progress.membershipCount, 257n);
  assert.equal(progress.membershipCursor, secondFreezeBatch.lastThreadId);
  const finalFreezeBatch = independentlyAuthoredCandidateMemberBatch(db, epoch.epochId, progress.membershipCursor, "bound");
  assert.equal(finalFreezeBatch.rows, 0, "the final empty freeze batch is independently observed");
  assert.equal(finalFreezeBatch.logicalBytes, 0n);
  progress = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "freeze", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "frozen");

  for (const member of members) {
    store.pinRetainedCandidateMember({ epochId: epoch.epochId, threadId: member.threadId, expectedMemberRevision: 0n });
  }
  progress = store.getRetainedCandidateEpoch(epoch.epochId)!;
  const firstSealBatch = independentlyAuthoredCandidateMemberBatch(db, epoch.epochId, null, "pinned");
  assert.equal(firstSealBatch.rows, INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT);
  assert.ok(firstSealBatch.logicalBytes < INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET, "the pinned fixture remains below the byte target");
  progress = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "sealing");
  assert.equal(progress.pinnedCount, BigInt(firstSealBatch.rows));
  assert.equal(progress.pinCursor, firstSealBatch.lastThreadId);
  const secondSealBatch = independentlyAuthoredCandidateMemberBatch(db, epoch.epochId, progress.pinCursor, "pinned");
  assert.equal(secondSealBatch.rows, 1);
  assert.ok(secondSealBatch.logicalBytes < INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET);
  progress = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "sealing");
  assert.equal(progress.pinnedCount, 257n);
  assert.equal(progress.pinCursor, secondSealBatch.lastThreadId);
  const finalSealBatch = independentlyAuthoredCandidateMemberBatch(db, epoch.epochId, progress.pinCursor, "pinned");
  assert.equal(finalSealBatch.rows, 0, "the final empty seal batch is independently observed");
  assert.equal(finalSealBatch.logicalBytes, 0n);
  progress = store.advanceRetainedCandidateEpoch({ epochId: epoch.epochId, operation: "seal", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "sealed");
  assert.equal(progress.membershipCount, 257n);
  assert.equal(progress.pinnedCount, 257n);
  assert.equal(progress.observationQuality, "degraded");
  assertRetainedAccountingTotals(db, store);
});

test("reaches the seal byte cutoff through ordinary ref-cap projector pages", async (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const activeBefore = store.getIndexState();
  const activeFactsBefore = db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all();
  const fillIdentifier = (prefix: string, fill: string): string => `${prefix}${fill.repeat(512 - prefix.length)}`;
  const epochId = fillIdentifier("candidate-byte-cutoff-epoch-", "e");
  store.openRetainedCandidateEpoch({
    epochId,
    mode: "rewrite",
    targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
    algorithm: MANAGED_CANDIDATE_ALGORITHM,
    restart: MANAGED_CANDIDATE_RESTART,
    observedAt: 26_000,
  });
  const members: Array<{ threadId: string; runId: string }> = [];
  const stageBudget = { ...projectionStageInput().budget, maxTimingRefs: 1 };
  for (let index = 0; index < 257; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const threadId = fillIdentifier(`candidate-byte-thread-${suffix}-`, "t");
    const runId = fillIdentifier(`candidate-byte-run-${suffix}-`, "r");
    const stageInput = projectionStageInput(runId, {
      epochId,
      threadId,
      mode: "rewrite",
      budget: stageBudget,
      startedAt: 26_100 + index,
    });
    store.openRetainedProjectionStage(stageInput);
    const firstEventId = `candidate-byte-item-a-${suffix}`;
    const secondEventId = `candidate-byte-item-b-${suffix}`;
    const sourceRows = [
      roundtripEvent(threadId, 1, "item/completed", "candidate-byte-turn-a", firstEventId, 10_001),
      roundtripEvent(threadId, 2, "item/completed", "candidate-byte-turn-b", secondEventId, 10_002),
    ] satisfies readonly RetainedSourceEvent[];
    const adapter = createRetainedSourceAdapter(
      roundtripSdk([sourceRows]),
      roundtripSourceLimits({ eventPageSize: 2, maxCalls: 1, maxEventPages: 1, maxRows: 2 }),
    );
    const source = await adapter.eventPage({ threadId });
    const projected = projectRetainedEventPage({
      runId,
      threadId,
      mode: "rewrite",
      targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
      algorithm: MANAGED_CANDIDATE_ALGORITHM,
      stagePage: 0,
      dimensions: { projectId: "project-1", providerId: "provider-1" },
      source,
      checkpoint: null,
      limits: { maxTurnStates: 8, maxTimingRefs: 1, maxCheckpointBytes: 16_000 },
      receivedAt: 26_200 + index,
    });
    const firstFact = explicitProjectionFact(firstEventId, 1, "candidate-byte-turn-a", null, null, threadId);
    const secondFact = explicitProjectionFact(secondEventId, 2, "candidate-byte-turn-b", null, null, threadId);
    if (index === 0) {
      assert.deepEqual(source.rows, sourceRows, "representative page uses the independently authored adapter rows");
      assert.equal(source.metadata.requestedAfterSeq, null);
      assert.equal(source.metadata.returnedMaxSeq, "2");
      assert.equal(source.metadata.sourceAfterSeq, "2");
      assert.equal(source.metadata.returnedRows, 2);
      assert.equal(source.metadata.pageExhausted, false);
      assert.deepEqual(projected.facts, [firstFact, secondFact], "representative facts are independently authored");
      assert.deepEqual(projected.timestampRevisions, []);
      assert.deepEqual(projected.refReleases, [{ sourceEventId: firstEventId, reason: "ref-cap" }]);
      assert.deepEqual(projected.checkpoint, independentlyAuthoredRefCapCheckpoint(runId, threadId, firstFact, secondFact));
      assert.equal(projected.checkpoint.rewriteRequired, true);
      assert.deepEqual(projected.checkpoint.revisitReasons, ["incomplete", "partial-turn-timing", "timing-ref-evicted"]);
      assert.deepEqual(projected.checkpoint.rewriteDirective, { threadId, restart: "beginning", reasons: ["ref-cap"] });
    }
    const staged = store.appendRetainedProjectionStagePage({
      runId,
      threadId,
      mode: stageInput.mode,
      targetProjectionVersion: stageInput.targetProjectionVersion,
      algorithm: stageInput.algorithm,
      ...projected,
      page: 0,
      receivedAt: 26_200 + index,
    });
    assert.deepEqual(staged.checkpoint, projected.checkpoint);
    store.failRetainedProjectionStage({ ...stageInput, reason: "source-error", error: "x".repeat(2_000) });
    store.bindRetainedCandidateMember({ epochId, threadId, runId });
    members.push({ threadId, runId });
  }

  const firstFreezeBatch = independentlyAuthoredCandidateMemberBatch(db, epochId, null, "bound");
  assert.equal(firstFreezeBatch.rows, INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT);
  assert.ok(firstFreezeBatch.logicalBytes < INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET, "bound rows do not claim a freeze byte-cutoff witness");
  let progress = store.advanceRetainedCandidateEpoch({ epochId, operation: "freeze", expectedManifestRevision: BigInt(members.length) });
  assert.equal(progress.membershipCount, 256n);
  assert.equal(progress.membershipCursor, firstFreezeBatch.lastThreadId);
  progress = store.advanceRetainedCandidateEpoch({ epochId, operation: "freeze", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.membershipCount, 257n);
  progress = store.advanceRetainedCandidateEpoch({ epochId, operation: "freeze", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "frozen");

  for (const member of members) {
    store.pinRetainedCandidateMember({ epochId, threadId: member.threadId, expectedMemberRevision: 0n });
  }
  progress = store.getRetainedCandidateEpoch(epochId)!;
  const firstSealBatch = independentlyAuthoredCandidateMemberBatch(db, epochId, null, "pinned");
  assert.ok(firstSealBatch.rows < INDEPENDENT_CANDIDATE_BATCH_ROW_LIMIT, "sticky post-page fields reach the byte cutoff before the row limit");
  assert.ok(firstSealBatch.excludedThreadId != null);
  assert.ok(firstSealBatch.logicalBytes <= INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET);
  assert.ok(firstSealBatch.excludedLogicalBytes != null);
  assert.ok(firstSealBatch.logicalBytes + firstSealBatch.excludedLogicalBytes > INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET);
  context.diagnostic(JSON.stringify({
    sealByteCutoff: {
      selectedRows: firstSealBatch.rows,
      selectedBytes: firstSealBatch.logicalBytes.toString(),
      excludedRowBytes: firstSealBatch.excludedLogicalBytes.toString(),
      targetBytes: INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET.toString(),
    },
  }));
  progress = store.advanceRetainedCandidateEpoch({ epochId, operation: "seal", expectedManifestRevision: progress.manifestRevision });
  assert.equal(progress.state, "sealing");
  assert.equal(progress.pinnedCount, BigInt(firstSealBatch.rows));
  assert.equal(progress.pinCursor, firstSealBatch.lastThreadId);

  let expectedFirstThread: string | null = firstSealBatch.excludedThreadId;
  let finalEmptyObserved = false;
  for (let step = 0; step < 4; step += 1) {
    const batch = independentlyAuthoredCandidateMemberBatch(db, epochId, progress.pinCursor, "pinned");
    if (batch.rows === 0) {
      assert.equal(batch.firstThreadId, null);
      assert.equal(batch.logicalBytes, 0n);
      progress = store.advanceRetainedCandidateEpoch({ epochId, operation: "seal", expectedManifestRevision: progress.manifestRevision });
      finalEmptyObserved = true;
      break;
    }
    assert.equal(batch.firstThreadId, expectedFirstThread, "the next seal call begins at the independently excluded row");
    assert.ok(batch.logicalBytes <= INDEPENDENT_CANDIDATE_BATCH_BYTE_TARGET);
    const priorPinnedCount: bigint = progress.pinnedCount!;
    progress = store.advanceRetainedCandidateEpoch({ epochId, operation: "seal", expectedManifestRevision: progress.manifestRevision });
    assert.equal(progress.pinnedCount, priorPinnedCount + BigInt(batch.rows));
    expectedFirstThread = batch.excludedThreadId;
  }
  assert.equal(finalEmptyObserved, true, "seal reaches an explicit final empty transition");
  assert.equal(progress.state, "sealed");
  assert.equal(progress.membershipCount, 257n);
  assert.equal(progress.pinnedCount, 257n);
  assert.equal(progress.observationQuality, "degraded");
  assertRetainedAccountingTotals(db, store);
  assert.deepEqual(store.getIndexState(), activeBefore);
  assert.deepEqual(db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(), activeFactsBefore);
});

test("upgrades retained staging budgets without changing legacy staged facts or active publication", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  const budgetMigrationStart = analyticsMigrations.findIndex((migration) =>
    migration.startsWith("ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_checkpoint_bytes "),
  );
  assert.ok(budgetMigrationStart > 0);
  for (const migration of analyticsMigrations.slice(0, budgetMigrationStart)) db.exec(migration);
  const store = new AnalyticsStore(db);
  const input = retainedStageInput("pre-budget-migration");
  const fact = retainedFact("pre-budget-fact", 11);
  const canonicalFact = canonicalizeRetainedStageFact(fact);
  db.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,next_page,next_cursor,
     rows_staged,bytes_staged,max_observed_seq,max_pages,max_rows,max_bytes,started_at,last_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.runId, input.epochId, input.threadId, input.mode, "collecting", input.targetProjectionVersion,
    1, "cursor-1", 1, canonicalFact.bytes, 11, input.budget.maxPages, input.budget.maxRows,
    input.budget.maxBytes, input.startedAt, null,
  );
  db.prepare(`INSERT INTO analytics_retained_stage_pages
    (run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(input.runId, 0, null, "cursor-1", 1, canonicalFact.bytes, "historical-page", 10_001);
  db.prepare(`INSERT INTO analytics_retained_stage_facts
    (run_id,source_event_id,thread_id,fact_json,fact_digest) VALUES (?,?,?,?,?)`).run(
    input.runId, fact.sourceEventId, fact.threadId, canonicalFact.json, factDigest(fact),
  );
  const activeBefore = store.getIndexState();
  const stagedBefore = {
    run: db.prepare("SELECT run_id,epoch_id,thread_id,mode,state,target_projection_version,next_page,next_cursor,rows_staged,bytes_staged,max_observed_seq,max_pages,max_rows,max_bytes,started_at,last_error FROM analytics_retained_stage_runs WHERE run_id=?").get(input.runId),
    page: db.prepare("SELECT run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at FROM analytics_retained_stage_pages WHERE run_id=?").get(input.runId),
    fact: db.prepare("SELECT * FROM analytics_retained_stage_facts WHERE run_id=?").get(input.runId),
  };
  for (const migration of analyticsMigrations.slice(budgetMigrationStart)) db.exec(migration);
  const migratedRun = db.prepare("SELECT run_id,epoch_id,thread_id,mode,state,target_projection_version,next_page,next_cursor,rows_staged,bytes_staged,max_observed_seq,max_pages,max_rows,max_bytes,started_at,last_error FROM analytics_retained_stage_runs WHERE run_id=?").get(input.runId);
  const migratedPage = db.prepare("SELECT run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at FROM analytics_retained_stage_pages WHERE run_id=?").get(input.runId);
  assert.deepEqual({ run: migratedRun, page: migratedPage, fact: db.prepare("SELECT * FROM analytics_retained_stage_facts WHERE run_id=?").get(input.runId) }, stagedBefore);
  assert.deepEqual(store.getIndexState(), activeBefore);
  assert.equal(reconcileRetainedAccounting(store).state, "ready");
  assert.deepEqual(db.prepare(`SELECT max_checkpoint_bytes,max_metadata_bytes,max_turn_states,max_timing_refs,max_revisions
    FROM analytics_retained_stage_runs WHERE run_id=?`).get(input.runId), {
    max_checkpoint_bytes: 0, max_metadata_bytes: 0, max_turn_states: 0, max_timing_refs: 0, max_revisions: 0,
  });
  const v5 = store.openRetainedProjectionStage(projectionStageInput("post-budget-migration"));
  assert.equal(v5.targetProjectionVersion, 5);
  assert.equal(v5.nextPage, 0);
  assert.equal(v5.rows, 0);
  assert.equal(v5.state, "collecting");
  assert.deepEqual(store.getIndexState(), activeBefore);
});

test("transfers a ready v1 accounting row into the sole v2 authority without losing material totals", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START, RETAINED_ACCOUNTING_V2_MIGRATION_START)) db.exec(migration);
  const input = retainedStageInput("v1-ready-transfer");
  const fact = retainedFact("v1-ready-fact", 41);
  const canonical = canonicalizeRetainedStageFact(fact);
  db.prepare(`UPDATE analytics_retained_stage_accounting SET state='ready',scan_table='done',run_rows=0,page_rows=0,fact_rows=0,revision_rows=0,logical_bytes=0 WHERE singleton=1`).run();
  db.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,max_pages,max_rows,max_bytes,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.runId, input.epochId, input.threadId, input.mode, "collecting", input.targetProjectionVersion, input.budget.maxPages, input.budget.maxRows, input.budget.maxBytes, input.startedAt);
  db.prepare(`INSERT INTO analytics_retained_stage_facts
    (run_id,source_event_id,thread_id,fact_json,fact_digest) VALUES (?,?,?,?,?)`).run(input.runId, fact.sourceEventId, fact.threadId, canonical.json, factDigest(fact));
  const before = db.prepare("SELECT run_rows,page_rows,fact_rows,revision_rows,logical_bytes FROM analytics_retained_stage_accounting").get();
  for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V2_MIGRATION_START)) db.exec(migration);
  const store = new AnalyticsStore(db);
  const after = store.readRetainedStageAccounting();
  assert.equal(after.state, "ready");
  assert.deepEqual({ run_rows: after.runRows, page_rows: after.pageRows, fact_rows: after.factRows, revision_rows: after.revisionRows, logical_bytes: after.logicalBytes }, {
    run_rows: BigInt((before as { run_rows: number }).run_rows),
    page_rows: BigInt((before as { page_rows: number }).page_rows),
    fact_rows: BigInt((before as { fact_rows: number }).fact_rows),
    revision_rows: BigInt((before as { revision_rows: number }).revision_rows),
    logical_bytes: BigInt((before as { logical_bytes: number }).logical_bytes),
  });
  assert.equal(after.candidateEpochRows, 0n);
  assert.equal(after.candidateMemberRows, 0n);
  assertRetainedAccountingTotals(db, store);
});

test("keeps v1 accounting authoritative across legacy and v5 writers, replay, and rollback", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const initial = store.readRetainedStageAccounting();
  assert.equal(initial.state, "unreconciled");
  assert.equal(initial.logicalBytes, null);
  const activeBefore = store.getIndexState();

  const legacy = retainedStageInput("accounting-legacy");
  store.openRetainedStage(legacy);
  const legacyFact = retainedFact("accounting-legacy-fact", 11);
  store.appendRetainedStagePage({
    runId: legacy.runId,
    threadId: legacy.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: "legacy-cursor",
    facts: [legacyFact],
    receivedAt: 10_001,
  });

  const v5 = projectionStageInput("accounting-v5", { epochId: "accounting-v5-epoch" });
  const opened = store.openRetainedProjectionStage(v5);
  const v5Fact = explicitProjectionFact("accounting-v5-fact", 2, "accounting-turn", 100, null);
  const v5Digest = factDigest(v5Fact);
  const checkpoint = projectionCheckpoint(opened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "2",
    maxFactSeq: 2,
    turns: [{
      turnId: "accounting-turn",
      startedAtMs: 100,
      completedAtMs: null,
      startedSeq: 1,
      completedSeq: null,
      revisionSeq: null,
      lastSeenSeq: 2,
      degraded: false,
      status: "partial",
    }],
    timingRefs: [{
      sourceEventId: v5Fact.sourceEventId,
      turnId: "accounting-turn",
      sequence: v5Fact.sequence,
      factDigest: v5Digest,
      turnStartedAtMs: 100,
      turnCompletedAtMs: null,
    }],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const v5Page = projectionPage(v5, opened, 0, checkpoint, [v5Fact], [], "2", "a".repeat(64));
  const afterV5 = store.appendRetainedProjectionStagePage(v5Page);
  const progress = store.readRetainedStageAccounting();
  const totals = retainedAccountingMaterialTotals(db);
  assert.equal(totals.helper, Number(totals.sql));
  assert.deepEqual({
    runRows: progress.runRows,
    pageRows: progress.pageRows,
    factRows: progress.factRows,
    revisionRows: progress.revisionRows,
    logicalBytes: progress.logicalBytes,
  }, {
    runRows: BigInt(totals.rows.runs),
    pageRows: BigInt(totals.rows.pages),
    factRows: BigInt(totals.rows.facts),
    revisionRows: BigInt(totals.rows.revisions),
    logicalBytes: BigInt(totals.helper),
  });
  assert.equal(afterV5.revisionCount, 0);
  const replayProgress = store.readRetainedStageAccounting();
  assert.deepEqual(store.appendRetainedProjectionStagePage(v5Page), afterV5);
  assert.deepEqual(store.readRetainedStageAccounting(), replayProgress, "exact page replay must not change accounting");

  const beforeRollback = store.readRetainedStageAccounting();
  const alteredLegacyFact = { ...legacyFact, sequence: legacyFact.sequence + 1 };
  assert.throws(() => store.appendRetainedStagePage({
    runId: legacy.runId,
    threadId: legacy.threadId,
    page: 1,
    cursorIn: "legacy-cursor",
    cursorOut: null,
    facts: [retainedFact("accounting-new-fact", 12), alteredLegacyFact],
    receivedAt: 10_002,
  }), /Conflicting retained stage fact replay/);
  assert.deepEqual(store.readRetainedStageAccounting(), beforeRollback, "late page failure must roll back trigger accounting");
  assert.deepEqual(store.getIndexState(), activeBefore, "retained accounting must not publish active facts");
});

test("accounts direct supported material INSERT/UPDATE/DELETE with opaque and signed scalar values", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = retainedStageInput("accounting-direct-base");
  store.openRetainedStage(input);
  const before = store.readRetainedStageAccounting();
  const activeBefore = store.getIndexState();
  db.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,max_pages,max_rows,max_bytes,started_at,last_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    "accounting-direct-run", "accounting-direct-epoch", "accounting-direct-thread", "rewrite", "collecting", 4, 2, 2, 20_000, 1, "malformed\u0000μ",
  );
  db.prepare(`INSERT INTO analytics_retained_stage_pages
    (run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at,revision_bytes_delta)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "accounting-direct-run", -9223372036854775807n, "\u0000in", "\u0000out", 0, 0, "not-a-digest", -9223372036854775807n, -7n,
  );
  db.prepare(`INSERT INTO analytics_retained_stage_facts
    (run_id,source_event_id,thread_id,fact_json,fact_digest) VALUES (?,?,?,?,?)`).run(
    "accounting-direct-run", "direct-event", "accounting-direct-thread", "not-json\u0000μ", "opaque-digest",
  );
  db.prepare(`INSERT INTO analytics_retained_stage_revisions
    (run_id,revision_key,source_event_id,revision_json,revision_digest,expected_fact_digest,resulting_fact_digest,payload_bytes,bytes_delta)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "accounting-direct-run", "direct-revision", "direct-event", "not-json", "bad-revision", "bad-before", "bad-after", 5n, -9n,
  );
  const inserted = assertRetainedAccountingTotals(db, store);
  const insertedTotals = retainedAccountingMaterialTotals(db);
  assert.equal(insertedTotals.helper, Number(insertedTotals.sql));
  assert.equal(inserted.runRows, (before.runRows ?? 0n) + 1n);
  assert.equal(inserted.pageRows, (before.pageRows ?? 0n) + 1n);
  assert.equal(inserted.factRows, (before.factRows ?? 0n) + 1n);
  assert.equal(inserted.revisionRows, (before.revisionRows ?? 0n) + 1n);
  db.prepare("UPDATE analytics_retained_stage_pages SET revision_bytes_delta=? WHERE run_id=? AND page=?").run(7n, "accounting-direct-run", -9223372036854775807n);
  db.prepare("UPDATE analytics_retained_stage_facts SET fact_json=? WHERE run_id=? AND source_event_id=?").run("changed\u0000🙂", "accounting-direct-run", "direct-event");
  const changed = assertRetainedAccountingTotals(db, store);
  // The new fact text adds one UTF-8 byte; -7 -> 7 removes one decimal byte.
  // Equal total size is still two real, independently accounted mutations.
  assert.equal(changed.logicalBytes, inserted.logicalBytes);
  assert.equal(changed.accountingRevision, inserted.accountingRevision + 2n);
  const changedTotals = retainedAccountingMaterialTotals(db);
  assert.equal(changedTotals.helper, Number(changedTotals.sql));
  db.prepare("DELETE FROM analytics_retained_stage_revisions WHERE run_id=? AND revision_key=?").run("accounting-direct-run", "direct-revision");
  db.prepare("DELETE FROM analytics_retained_stage_facts WHERE run_id=? AND source_event_id=?").run("accounting-direct-run", "direct-event");
  db.prepare("DELETE FROM analytics_retained_stage_pages WHERE run_id=? AND page=?").run("accounting-direct-run", -9223372036854775807n);
  db.prepare("DELETE FROM analytics_retained_stage_runs WHERE run_id=?").run("accounting-direct-run");
  const restored = assertRetainedAccountingTotals(db, store);
  assert.deepEqual({ runRows: restored.runRows, pageRows: restored.pageRows, factRows: restored.factRows, revisionRows: restored.revisionRows }, {
    runRows: before.runRows,
    pageRows: before.pageRows,
    factRows: before.factRows,
    revisionRows: before.revisionRows,
  });
  assert.equal(restored.logicalBytes, before.logicalBytes);
  assert.deepEqual(store.getIndexState(), activeBefore);
});

test("requires explicit bounded bootstrap, fences advances, and preserves the historical migration prefix", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  assert.equal(RETAINED_ACCOUNTING_V2_MIGRATION_START, analyticsMigrations.length - 8);
  for (const migration of analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  const input = retainedStageInput("accounting-bootstrap");
  const fact = retainedFact("accounting-bootstrap-fact", 7);
  const canonical = canonicalizeRetainedStageFact(fact);
  db.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,next_page,next_cursor,rows_staged,bytes_staged,max_observed_seq,max_pages,max_rows,max_bytes,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.runId, input.epochId, input.threadId, input.mode, "collecting", input.targetProjectionVersion,
    1, "bootstrap-cursor", 1, canonical.bytes, 7, input.budget.maxPages, input.budget.maxRows, input.budget.maxBytes, input.startedAt,
  );
  db.prepare(`INSERT INTO analytics_retained_stage_pages
    (run_id,page,cursor_in,cursor_out,rows_staged,bytes_staged,page_digest,received_at,revision_bytes_delta)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(input.runId, -9223372036854775807n, "\u0000in", "bootstrap-cursor🙂", 1, canonical.bytes, "malformed-page-digest", -9223372036854775807n, -7n);
  db.prepare(`INSERT INTO analytics_retained_stage_facts
    (run_id,source_event_id,thread_id,fact_json,fact_digest) VALUES (?,?,?,?,?)`).run(
    input.runId, fact.sourceEventId, fact.threadId, "not-json\u0000μ", "opaque-fact-digest",
  );
  db.prepare(`INSERT INTO analytics_retained_stage_revisions
    (run_id,revision_key,source_event_id,revision_json,revision_digest,expected_fact_digest,resulting_fact_digest,payload_bytes,bytes_delta)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    input.runId, "bootstrap-revision", fact.sourceEventId, "not-json", "opaque-revision", "bad-before", "bad-after", 5n, -9n,
  );
  for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  const store = new AnalyticsStore(db);
  const notReady = store.readRetainedStageAccounting();
  assert.equal(notReady.state, "unreconciled");
  assert.equal(notReady.runRows, null);
  assert.throws(() => store.openRetainedStage(input), AccountingNotReady);
  const rebuilding = store.bootstrapRetainedStageAccounting();
  assert.equal(rebuilding.state, "rebuilding");
  assert.throws(() => store.advanceRetainedStageAccounting({
    generation: rebuilding.rebuildGeneration,
    expectedAccountingRevision: rebuilding.accountingRevision - 1n,
  }), AccountingRevisionConflict);
  const ready = reconcileRetainedAccounting(store);
  assert.equal(ready.state, "ready");
  assert.equal(ready.factRows, 1n);
  assert.equal(ready.pageRows, 1n);
  assert.equal(ready.revisionRows, 1n);
  assertRetainedAccountingTotals(db, store);
  assert.equal(store.openRetainedStage(input).nextPage, 1);
  assert.equal(analyticsMigrations[RETAINED_ACCOUNTING_V1_MIGRATION_START - 1]?.startsWith("ALTER TABLE analytics_retained_stage_runs ADD COLUMN max_revisions "), true);
});

test("bounds rebuild work, treats oversized non-key rows as one unit, and blocks oversized primary keys", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  const insertRun = db.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,max_pages,max_rows,max_bytes,started_at,last_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 257; index += 1) {
    insertRun.run(`bound-run-${String(index).padStart(3, "0")}`, `bound-epoch-${index}`, `bound-thread-${index}`, "rewrite", "collecting", 4, 3, 3, 20_000, 10_000 + index, null);
  }
  insertRun.run("oversized-non-key", "oversized-epoch", "oversized-thread", "rewrite", "collecting", 4, 3, 3, 20_000, 20_000, "🙂".repeat(600_000));
  for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  const store = new AnalyticsStore(db);
  let progress = store.bootstrapRetainedStageAccounting();
  assert.equal(progress.state, "rebuilding");
  const first = store.advanceRetainedStageAccounting({ generation: progress.rebuildGeneration, expectedAccountingRevision: progress.accountingRevision });
  assert.equal(first.scanRunId, "bound-run-255");
  progress = store.advanceRetainedStageAccounting({ generation: first.rebuildGeneration, expectedAccountingRevision: first.accountingRevision });
  assert.equal(progress.scanRunId, "bound-run-256");
  const overTarget = store.advanceRetainedStageAccounting({ generation: progress.rebuildGeneration, expectedAccountingRevision: progress.accountingRevision });
  assert.equal(overTarget.state, "rebuilding");
  assert.ok((overTarget.workLogicalBytes ?? 0n) > 1_048_576n);

  const keyDb = new Database(":memory:");
  context.after(() => keyDb.close());
  for (const migration of analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START)) keyDb.exec(migration);
  keyDb.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,max_pages,max_rows,max_bytes,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("x".repeat(513), "key-epoch", "key-thread", "rewrite", "collecting", 4, 3, 3, 20_000, 1);
  for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START)) keyDb.exec(migration);
  const keyStore = new AnalyticsStore(keyDb);
  let blocked = keyStore.bootstrapRetainedStageAccounting();
  blocked = keyStore.advanceRetainedStageAccounting({ generation: blocked.rebuildGeneration, expectedAccountingRevision: blocked.accountingRevision });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.runRows, null);
  assert.match(blocked.blockedKey ?? "", /^rowid:/);
  assert.ok((blocked.blockedReason ?? "").includes("UTF-8 bytes"));
});

test("reopens a partial accounting rebuild and rejects a stale advance token", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "analytics-accounting-rebuild-"));
  const path = join(directory, "accounting.sqlite");
  let db: Database.Database | null = new Database(path);
  context.after(() => {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const migration of analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  db.prepare(`INSERT INTO analytics_retained_stage_runs
    (run_id,epoch_id,thread_id,mode,state,target_projection_version,max_pages,max_rows,max_bytes,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("reopen-accounting-run", "reopen-accounting-epoch", "reopen-accounting-thread", "rewrite", "collecting", 4, 2, 2, 20_000, 1);
  for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
  let store = new AnalyticsStore(db);
  const rebuilding = store.bootstrapRetainedStageAccounting();
  const partial = store.advanceRetainedStageAccounting({ generation: rebuilding.rebuildGeneration, expectedAccountingRevision: rebuilding.accountingRevision });
  assert.equal(partial.state, "rebuilding");
  db.close();
  db = null;
  db = new Database(path);
  store = new AnalyticsStore(db);
  assert.deepEqual(store.readRetainedStageAccounting(), partial);
  assert.throws(() => store.advanceRetainedStageAccounting({
    generation: partial.rebuildGeneration,
    expectedAccountingRevision: partial.accountingRevision - 1n,
  }), AccountingRevisionConflict);
  const ready = reconcileRetainedAccounting(store);
  assert.equal(ready.state, "ready");
  assert.equal(ready.runRows, 1n);
  assertRetainedAccountingTotals(db, store);
});

test("rejects retained schema drift before a supported writer can mutate material", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  db.exec("ALTER TABLE analytics_retained_stage_runs ADD COLUMN unsupported_future_material TEXT");
  const activeBefore = store.getIndexState();
  assert.throws(() => store.openRetainedStage(retainedStageInput("schema-drift")), /schema mismatch|column mismatch/);
  assert.equal((db.prepare("SELECT count(*) AS count FROM analytics_retained_stage_runs").get() as { count: number }).count, 0);
  assert.deepEqual(store.getIndexState(), activeBefore);

  const unknownDb = new Database(":memory:");
  context.after(() => unknownDb.close());
  for (const migration of analyticsMigrations) unknownDb.exec(migration);
  unknownDb.exec("CREATE TABLE analytics_retained_stage_future_material (id TEXT) STRICT");
  const unknownStore = new AnalyticsStore(unknownDb);
  assert.throws(() => unknownStore.openRetainedStage(retainedStageInput("unknown-table")), /Unknown retained-stage material table/);
  assert.equal((unknownDb.prepare("SELECT count(*) AS count FROM analytics_retained_stage_runs").get() as { count: number }).count, 0);

  const triggerDb = new Database(":memory:");
  context.after(() => triggerDb.close());
  for (const migration of analyticsMigrations) triggerDb.exec(migration);
  triggerDb.exec("DROP TRIGGER analytics_retained_stage_runs_accounting_v2_insert");
  assert.throws(() => new AnalyticsStore(triggerDb).openRetainedStage(retainedStageInput("trigger-drift")), /trigger count mismatch/);

  const indexDb = new Database(":memory:");
  context.after(() => indexDb.close());
  for (const migration of analyticsMigrations) indexDb.exec(migration);
  indexDb.exec("DROP INDEX analytics_retained_stage_epoch_thread");
  assert.throws(() => new AnalyticsStore(indexDb).openRetainedStage(retainedStageInput("index-drift")), /epoch\/thread unique index mismatch/);
});

test("rejects candidate schema, trigger, and unknown-material drift before candidate mutation", (context) => {
  const variants = ["column", "trigger", "index", "unknown"] as const;
  for (const variant of variants) {
    const db = new Database(":memory:");
    context.after(() => db.close());
    for (const migration of analyticsMigrations) {
      const sql = variant === "index" ? migration.replace("    UNIQUE (run_id),\n", "") : migration;
      db.exec(sql);
    }
    if (variant === "column") {
      db.exec("ALTER TABLE analytics_retained_candidate_members ADD COLUMN unsupported_future_material TEXT");
    } else if (variant === "trigger") {
      db.exec("DROP TRIGGER analytics_retained_candidate_members_accounting_v2_insert");
    } else if (variant === "index") {
      // The test-owned migration omits the required candidate run uniqueness index.
    } else {
      db.exec("CREATE TABLE analytics_retained_future_material (id TEXT) STRICT");
    }
    const store = new AnalyticsStore(db);
    const before = retainedCandidateIsolationSnapshot(db, store);
    assert.throws(() => store.openRetainedCandidateEpoch({
      epochId: `candidate-drift-${variant}`,
      mode: "rewrite",
      targetProjectionVersion: MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION,
      algorithm: MANAGED_CANDIDATE_ALGORITHM,
      restart: MANAGED_CANDIDATE_RESTART,
      observedAt: 26_000,
    }), /schema|column|trigger|uniqueness|Unknown retained-stage material/i);
    assert.deepEqual(retainedCandidateIsolationSnapshot(db, store), before, variant);
  }
});

test("rejects generated columns, partial indexes, and non-STRICT lookalikes before accounting mutation", (context) => {
  for (const variant of ["generated", "partial-index", "non-strict-facts", "non-strict-control"] as const) {
    const db = new Database(":memory:");
    context.after(() => db.close());
    const nonStrictTable = variant === "non-strict-facts" ? "analytics_retained_stage_facts"
      : variant === "non-strict-control" ? "analytics_retained_stage_accounting" : null;
    for (const migration of analyticsMigrations) {
      // Test-owned old/drifted schema: a comment deliberately contains STRICT,
      // while SQLite's own table metadata reports that the table is not strict.
      const sql = nonStrictTable != null && migration.startsWith(`CREATE TABLE ${nonStrictTable} (`)
        ? migration.replace("(\n", "( /* STRICT */\n").replace(/\)\s+STRICT$/, ")")
        : migration;
      db.exec(sql);
    }
    if (variant === "generated") {
      db.exec("ALTER TABLE analytics_retained_stage_runs ADD COLUMN extra_generated TEXT GENERATED ALWAYS AS (run_id) VIRTUAL");
    } else if (variant === "partial-index") {
      db.exec("DROP INDEX analytics_retained_stage_epoch_thread");
      db.exec("CREATE UNIQUE INDEX analytics_retained_stage_epoch_thread ON analytics_retained_stage_runs(epoch_id,thread_id) WHERE epoch_id <> 'excluded'");
    } else {
      const native = db.prepare("PRAGMA main.table_list").all() as Array<{ name: string; strict: number }>;
      assert.equal(native.find((table) => table.name === nonStrictTable)?.strict, 0);
      const source = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(nonStrictTable) as { sql: string };
      assert.match(source.sql, /STRICT/);
    }
    const store = new AnalyticsStore(db);
    const snapshot = () => ["runs", "pages", "facts", "revisions", "accounting"].map(
      (table) => db.prepare(`SELECT * FROM analytics_retained_stage_${table}`).safeIntegers().all(),
    );
    const before = snapshot();
    const activeBefore = store.getIndexState();
    assert.throws(() => store.openRetainedStage(retainedStageInput(`schema-${variant}`)), /schema|column|unique index/i);
    assert.deepEqual(snapshot(), before, variant);
    assert.deepEqual(store.getIndexState(), activeBefore);
  }
});

test("blocks malformed UTF-8 cursor keys and preserves bounded BOM and NUL keys during rebuild", (context) => {
  for (const invalid of [true, false]) {
    const db = new Database(":memory:");
    context.after(() => db.close());
    for (const migration of analyticsMigrations.slice(0, RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
    const runId = "key-byte-run";
    db.prepare(`INSERT INTO analytics_retained_stage_runs
      (run_id,epoch_id,thread_id,mode,state,target_projection_version,max_pages,max_rows,max_bytes,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runId, "key-byte-epoch", "key-byte-thread", "rewrite", "collecting", 4, 3, 3, 20_000, 1);
    const key = invalid ? Buffer.from([0x80]) : Buffer.from("\ufeffkey\u0000🙂", "utf8");
    // STRICT checks SQLite storage classes, not UTF-8 well-formedness. Explicit
    // CAST keeps these bytes in TEXT, exactly the historical-row input at issue.
    db.prepare(`INSERT INTO analytics_retained_stage_facts
      (run_id,source_event_id,thread_id,fact_json,fact_digest)
      VALUES (?,CAST(? AS TEXT),?,'opaque-json','opaque-digest')`).run(runId, key, "key-byte-thread");
    const rawBefore = db.prepare("SELECT rowid,typeof(source_event_id) AS kind,hex(CAST(source_event_id AS BLOB)) AS key_hex FROM analytics_retained_stage_facts").get();
    assert.equal((rawBefore as { kind: string }).kind, "text");
    for (const migration of analyticsMigrations.slice(RETAINED_ACCOUNTING_V1_MIGRATION_START)) db.exec(migration);
    const store = new AnalyticsStore(db);
    const activeBefore = store.getIndexState();
    let progress = store.bootstrapRetainedStageAccounting();
    for (let step = 0; progress.scanTable !== "facts" && step < 5; step += 1) {
      progress = store.advanceRetainedStageAccounting({ generation: progress.rebuildGeneration, expectedAccountingRevision: progress.accountingRevision });
    }
    assert.equal(progress.scanTable, "facts");
    const prior = progress;
    const next = store.advanceRetainedStageAccounting({ generation: progress.rebuildGeneration, expectedAccountingRevision: progress.accountingRevision });
    if (invalid) {
      assert.equal(next.state, "blocked");
      assert.match(next.blockedReason ?? "", /UTF-8/);
      assert.match(next.blockedKey ?? "", /^rowid:/);
      assert.equal(next.logicalBytes, null);
      assert.equal(next.scanRunId, prior.scanRunId);
      assert.equal(next.scanItemId, prior.scanItemId);
      assert.equal(next.workLogicalBytes, prior.workLogicalBytes);
    } else {
      assert.equal(next.state, "rebuilding");
      assert.equal(next.scanItemId, "\ufeffkey\u0000🙂");
      assert.equal(reconcileRetainedAccounting(store).state, "ready");
      assertRetainedAccountingTotals(db, store);
    }
    assert.deepEqual(db.prepare("SELECT rowid,typeof(source_event_id) AS kind,hex(CAST(source_event_id AS BLOB)) AS key_hex FROM analytics_retained_stage_facts").get(), rawBefore);
    assert.deepEqual(store.getIndexState(), activeBefore);
  }
});

test("rejects cross-domain, unknown-algorithm, and same-run retained operations without mutation", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());

  const snapshot = () => ({
    runs: db.prepare("SELECT * FROM analytics_retained_stage_runs ORDER BY run_id").all(),
    pages: db.prepare("SELECT * FROM analytics_retained_stage_pages ORDER BY run_id,page").all(),
    facts: db.prepare("SELECT * FROM analytics_retained_stage_facts ORDER BY run_id,source_event_id").all(),
    revisions: db.prepare("SELECT * FROM analytics_retained_stage_revisions ORDER BY run_id,revision_key").all(),
    accounting: db.prepare("SELECT * FROM analytics_retained_stage_accounting WHERE singleton=1").all(),
    activeFacts: db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(),
    index: store.getIndexState(),
  });
  const reject = (operation: () => unknown) => {
    const before = snapshot();
    assert.throws(operation, /algorithm domain|algorithm\/version domain|unavailable/);
    assert.deepEqual(snapshot(), before, "every rejected operation must preserve all staged and active state");
  };

  const v5Input = projectionStageInput("domain-v5", { epochId: "domain-v5-epoch" });
  const v5Opened = store.openRetainedProjectionStage(v5Input);
  const v5Fact = explicitProjectionFact("domain-v5-fact", 2, "domain-v5-turn", 100, null);
  const v5FactDigest = factDigest(v5Fact);
  const v5PartialCheckpoint = projectionCheckpoint(v5Opened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "2",
    maxFactSeq: 2,
    turns: [{
      turnId: "domain-v5-turn",
      startedAtMs: 100,
      completedAtMs: null,
      startedSeq: 1,
      completedSeq: null,
      revisionSeq: null,
      lastSeenSeq: 2,
      degraded: false,
      status: "partial",
    }],
    timingRefs: [{
      sourceEventId: v5Fact.sourceEventId,
      turnId: "domain-v5-turn",
      sequence: 2,
      factDigest: v5FactDigest,
      turnStartedAtMs: 100,
      turnCompletedAtMs: null,
    }],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const v5AfterFirst = store.appendRetainedProjectionStagePage(projectionPage(
    v5Input,
    v5Opened,
    0,
    v5PartialCheckpoint,
    [v5Fact],
    [],
    "2",
    "a".repeat(64),
  ));
  const v5CompleteCheckpoint = projectionCheckpoint(v5AfterFirst.checkpoint, {
    nextStagePage: 2,
    sourceAfterSeq: "3",
    maxFactSeq: 2,
    turns: [{
      turnId: "domain-v5-turn",
      startedAtMs: 100,
      completedAtMs: 500,
      startedSeq: 1,
      completedSeq: 3,
      revisionSeq: 3,
      lastSeenSeq: 3,
      degraded: false,
      status: "complete",
    }],
    timingRefs: [],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const v5AfterRevision = store.appendRetainedProjectionStagePage(projectionPage(
    v5Input,
    v5AfterFirst,
    1,
    v5CompleteCheckpoint,
    [],
    [{
      revisionKey: "domain-v5-fact:3",
      sourceEventId: v5Fact.sourceEventId,
      turnId: "domain-v5-turn",
      sequence: 2,
      timingRevisionSeq: 3,
      expectedFactDigest: v5FactDigest,
      turnStartedAtMs: 100,
      turnCompletedAtMs: 500,
    }],
    "3",
    "b".repeat(64),
    [{ sourceEventId: v5Fact.sourceEventId, reason: "completed" }],
  ));
  const v5Failed = store.failRetainedProjectionStage({ ...v5Input, reason: "source-error", error: "domain fixture failure" });
  assert.equal(v5Failed.state, "failed");
  assert.equal(v5Failed.revisionCount, v5AfterRevision.revisionCount);

  const legacyAgainstV5: Parameters<AnalyticsStore["openRetainedStage"]>[0] = {
    runId: v5Input.runId,
    epochId: v5Input.epochId,
    threadId: v5Input.threadId,
    mode: v5Input.mode,
    targetProjectionVersion: 5,
    budget: { maxPages: 4, maxRows: 8, maxBytes: 20_000 },
    startedAt: v5Input.startedAt,
  };
  assert.equal(store.getRetainedStage(v5Input.runId), null);
  const beforeV5LegacyRejects = snapshot();
  reject(() => store.openRetainedStage(legacyAgainstV5));
  reject(() => store.resumeRetainedStage(legacyAgainstV5));
  reject(() => store.appendRetainedStagePage({
    runId: v5Input.runId,
    threadId: v5Input.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: null,
    facts: [],
    receivedAt: 40_001,
  }));
  reject(() => store.failRetainedStage(v5Input.runId, "wrong legacy domain"));
  assert.deepEqual(snapshot(), beforeV5LegacyRejects, "legacy rejection must preserve v5 row/page/fact/revision state and active index");

  const collectingV5Input = projectionStageInput("domain-v5-collecting", { epochId: "domain-v5-collecting-epoch" });
  const collectingV5Opened = store.openRetainedProjectionStage(collectingV5Input);
  assert.equal(collectingV5Opened.state, "collecting");
  const legacyAgainstCollectingV5: Parameters<AnalyticsStore["openRetainedStage"]>[0] = {
    runId: collectingV5Input.runId,
    epochId: collectingV5Input.epochId,
    threadId: collectingV5Input.threadId,
    mode: collectingV5Input.mode,
    targetProjectionVersion: 5,
    budget: { maxPages: 4, maxRows: 8, maxBytes: 20_000 },
    startedAt: collectingV5Input.startedAt,
  };
  const beforeCollectingV5Rejects = snapshot();
  assert.equal(store.getRetainedStage(collectingV5Input.runId), null);
  reject(() => store.openRetainedStage(legacyAgainstCollectingV5));
  reject(() => store.resumeRetainedStage(legacyAgainstCollectingV5));
  reject(() => store.appendRetainedStagePage({
    runId: collectingV5Input.runId,
    threadId: collectingV5Input.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: null,
    facts: [],
    receivedAt: 40_005,
  }));
  reject(() => store.failRetainedStage(collectingV5Input.runId, "wrong legacy domain"));
  assert.deepEqual(snapshot(), beforeCollectingV5Rejects, "legacy rejection must preserve a collecting v5 row");

  const legacyInput = {
    ...retainedStageInput("domain-legacy"),
    epochId: "domain-legacy-epoch",
    targetProjectionVersion: 5,
  };
  const legacyOpened = store.openRetainedStage(legacyInput);
  assert.equal(legacyOpened.targetProjectionVersion, 5, "legacy positive version 5 remains legacy by algorithm");
  const legacyFact = retainedFact("domain-legacy-fact", 21);
  store.appendRetainedStagePage({
    runId: legacyInput.runId,
    threadId: legacyInput.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: "cursor-legacy",
    facts: [legacyFact],
    receivedAt: 40_002,
  });
  const probeInput = projectionStageInput("domain-probe", { epochId: "domain-probe-epoch" });
  const probeOpened = store.openRetainedProjectionStage(probeInput);
  const v5AgainstLegacy: Parameters<AnalyticsStore["openRetainedProjectionStage"]>[0] = {
    ...projectionStageInput("domain-legacy"),
    epochId: legacyInput.epochId,
    threadId: legacyInput.threadId,
    mode: legacyInput.mode,
    startedAt: legacyInput.startedAt,
  };
  assert.equal(store.getRetainedProjectionStage(legacyInput.runId), null);
  const beforeLegacyRejects = snapshot();
  reject(() => store.openRetainedProjectionStage(v5AgainstLegacy));
  reject(() => store.resumeRetainedProjectionStage(v5AgainstLegacy));
  reject(() => store.failRetainedProjectionStage({ ...v5AgainstLegacy, reason: "source-error", error: "wrong v5 domain" }));
  reject(() => store.closeRetainedProjectionStageAtPageLimit(v5AgainstLegacy));
  reject(() => store.appendRetainedProjectionStagePage(projectionPage(
    v5AgainstLegacy,
    probeOpened,
    0,
    probeOpened.checkpoint,
    [],
    [],
    null,
    "c".repeat(64),
  )));
  assert.deepEqual(snapshot(), beforeLegacyRejects, "v5 rejection must preserve legacy row/page/fact state and active index");

  const unknownInput = {
    ...retainedStageInput("domain-unknown"),
    epochId: "domain-unknown-epoch",
    targetProjectionVersion: 5,
  };
  store.openRetainedStage(unknownInput);
  store.appendRetainedStagePage({
    runId: unknownInput.runId,
    threadId: unknownInput.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: "cursor-unknown",
    facts: [retainedFact("domain-unknown-fact", 31)],
    receivedAt: 40_003,
  });
  db.prepare("UPDATE analytics_retained_stage_runs SET algorithm_format=? WHERE run_id=?").run("unknown-retained-algorithm", unknownInput.runId);
  const unknownV5Input: Parameters<AnalyticsStore["openRetainedProjectionStage"]>[0] = {
    ...projectionStageInput("domain-unknown"),
    epochId: unknownInput.epochId,
    threadId: unknownInput.threadId,
    mode: unknownInput.mode,
    startedAt: unknownInput.startedAt,
  };
  const beforeUnknownRejects = snapshot();
  assert.equal(store.getRetainedStage(unknownInput.runId), null);
  assert.equal(store.getRetainedProjectionStage(unknownInput.runId), null);
  reject(() => store.openRetainedStage(unknownInput));
  reject(() => store.resumeRetainedStage(unknownInput));
  reject(() => store.appendRetainedStagePage({
    runId: unknownInput.runId,
    threadId: unknownInput.threadId,
    page: 1,
    cursorIn: "cursor-unknown",
    cursorOut: null,
    facts: [],
    receivedAt: 40_004,
  }));
  reject(() => store.failRetainedStage(unknownInput.runId, "unknown algorithm"));
  reject(() => store.openRetainedProjectionStage(unknownV5Input));
  reject(() => store.resumeRetainedProjectionStage(unknownV5Input));
  reject(() => store.failRetainedProjectionStage({ ...unknownV5Input, reason: "source-error", error: "unknown algorithm" }));
  reject(() => store.closeRetainedProjectionStageAtPageLimit(unknownV5Input));
  reject(() => store.appendRetainedProjectionStagePage(projectionPage(
    unknownV5Input,
    probeOpened,
    0,
    probeOpened.checkpoint,
    [],
    [],
    null,
    "d".repeat(64),
  )));
  assert.deepEqual(snapshot(), beforeUnknownRejects, "unknown algorithm rejection must preserve all staged and active state");
});

test("persists and resumes retained-stage pages after a real file close/reopen without active publication", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "analytics-retained-stage-"));
  const path = join(directory, "stage.sqlite");
  let db: Database.Database | null = new Database(path);
  context.after(() => {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const input = retainedStageInput();
  assert.equal(store.openRetainedStage(input).state, "collecting");
  const page = {
    runId: input.runId,
    threadId: input.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: "cursor-1",
    facts: [retainedFact("source-1", 11)],
    receivedAt: 10_001,
  };

  const appended = store.appendRetainedStagePage(page);
  assert.deepEqual(
    { nextPage: appended.nextPage, nextCursor: appended.nextCursor, rows: appended.rows, maxObservedSeq: appended.maxObservedSeq },
    { nextPage: 1, nextCursor: "cursor-1", rows: 1, maxObservedSeq: 11 },
  );
  assert.deepEqual(store.appendRetainedStagePage(page), appended, "an exact page replay must not advance durable counters");
  store.failRetainedStage(input.runId, "controlled source interruption");
  const accountingBeforeClose = assertRetainedAccountingTotals(db, store);
  db.close();
  db = null;
  db = new Database(path);
  const reopened = new AnalyticsStore(db);
  const reopenedAccounting = assertRetainedAccountingTotals(db, reopened);
  assert.deepEqual({
    state: reopenedAccounting.state,
    runRows: reopenedAccounting.runRows,
    pageRows: reopenedAccounting.pageRows,
    factRows: reopenedAccounting.factRows,
    revisionRows: reopenedAccounting.revisionRows,
    logicalBytes: reopenedAccounting.logicalBytes,
  }, {
    state: accountingBeforeClose.state,
    runRows: accountingBeforeClose.runRows,
    pageRows: accountingBeforeClose.pageRows,
    factRows: accountingBeforeClose.factRows,
    revisionRows: accountingBeforeClose.revisionRows,
    logicalBytes: accountingBeforeClose.logicalBytes,
  }, "accounting survives close/reopen");
  assert.equal(reopened.getRetainedStage(input.runId)?.state, "failed");
  const failedAccounting = assertRetainedAccountingTotals(db, reopened);
  assert.equal(reopened.resumeRetainedStage(input).state, "collecting");
  assertRetainedAccountingTotals(db, reopened);
  assert.ok(reopened.readRetainedStageAccounting().accountingRevision > failedAccounting.accountingRevision);
  const resumed = reopened.appendRetainedStagePage({
    ...page,
    page: 1,
    cursorIn: "cursor-1",
    cursorOut: null,
    facts: [retainedFact("source-2", 12)],
    receivedAt: 10_002,
  });
  assert.deepEqual(
    { nextPage: resumed.nextPage, nextCursor: resumed.nextCursor, rows: resumed.rows, maxObservedSeq: resumed.maxObservedSeq },
    { nextPage: 2, nextCursor: null, rows: 2, maxObservedSeq: 12 },
    "a reconstructed store resumes from its persisted cursor",
  );
  assert.equal(reopened.readRetainedStageAccounting().factRows, 2n);
  assert.equal(reopened.getIndexState().generationId, 0, "staging must not publish an active generation");
  assert.equal(reopened.factsAsNdjson(90, 20_000), "", "staging must not change active v1 facts");
});

test("rolls back a new staged fact when a later fact in its page conflicts", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = retainedStageInput();
  store.openRetainedStage(input);
  store.appendRetainedStagePage({
    runId: input.runId, threadId: input.threadId, page: 0, cursorIn: null, cursorOut: "cursor-1",
    facts: [retainedFact("source-1", 11)], receivedAt: 10_001,
  });
  const beforeConflict = store.getRetainedStage(input.runId);

  assert.throws(() => store.appendRetainedStagePage({
    runId: input.runId, threadId: input.threadId, page: 1, cursorIn: "cursor-1", cursorOut: "cursor-2",
    facts: [retainedFact("new-source", 12), retainedFact("source-1", 13)], receivedAt: 10_002,
  }), /Conflicting retained stage fact replay/);
  assert.deepEqual(store.getRetainedStage(input.runId), beforeConflict, "a rejected page must not advance cursor or counters");
  assert.equal((db.prepare("SELECT count(*) AS count FROM analytics_retained_stage_pages WHERE run_id = ?").get(input.runId) as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT count(*) AS count FROM analytics_retained_stage_facts WHERE run_id = ?").get(input.runId) as { count: number }).count, 1, "the earlier new fact in the rejected page must roll back");
  assert.throws(() => store.openRetainedStage({ ...input, runId: "second-run" }), /Conflicting retained stage epoch\/thread/);
});

test("canonical retained facts tolerate key order but reject changed or raw fields", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = { ...retainedStageInput(), budget: { maxPages: 4, maxRows: 4, maxBytes: 20_000 } };
  store.openRetainedStage(input);
  const fact = retainedFact("source-1", 11);
  store.appendRetainedStagePage({
    runId: input.runId, threadId: input.threadId, page: 0, cursorIn: null, cursorOut: "cursor-1",
    facts: [fact], receivedAt: 10_001,
  });
  const reordered = Object.fromEntries(Object.entries(fact).reverse()) as ToolExecutionFact;
  const overlap = store.appendRetainedStagePage({
    runId: input.runId, threadId: input.threadId, page: 1, cursorIn: "cursor-1", cursorOut: null,
    facts: [reordered], receivedAt: 10_002,
  });
  assert.equal(overlap.rows, 1, "cross-page semantic overlap must not consume retained rows");
  assert.throws(() => store.appendRetainedStagePage({
    runId: input.runId, threadId: input.threadId, page: 2, cursorIn: null, cursorOut: null,
    facts: [{ ...fact, durationMs: fact.durationMs + 1 }], receivedAt: 10_003,
  }), /Conflicting retained stage fact replay/);
  assert.throws(() => store.appendRetainedStagePage({
    runId: input.runId, threadId: input.threadId, page: 2, cursorIn: null, cursorOut: null,
    facts: [{ ...retainedFact("raw-source", 12), rawSdkPayload: "must-not-persist" } as unknown as ToolExecutionFact], receivedAt: 10_004,
  }), /Invalid retained stage fact fields/);
});

test("enforces independent retained-stage page, row, and byte budgets", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());

  const pageBudget = { ...retainedStageInput("page-budget"), budget: { maxPages: 1, maxRows: 3, maxBytes: 20_000 } };
  store.openRetainedStage(pageBudget);
  store.appendRetainedStagePage({ runId: pageBudget.runId, threadId: pageBudget.threadId, page: 0, cursorIn: null, cursorOut: "cursor-1", facts: [retainedFact("page-1", 1)], receivedAt: 10_001 });
  assert.throws(() => store.appendRetainedStagePage({ runId: pageBudget.runId, threadId: pageBudget.threadId, page: 1, cursorIn: "cursor-1", cursorOut: null, facts: [retainedFact("page-2", 2)], receivedAt: 10_002 }), /page budget exceeded/);

  const rowBudget = { ...retainedStageInput("row-budget"), epochId: "membership-epoch-2", budget: { maxPages: 3, maxRows: 1, maxBytes: 20_000 } };
  store.openRetainedStage(rowBudget);
  store.appendRetainedStagePage({ runId: rowBudget.runId, threadId: rowBudget.threadId, page: 0, cursorIn: null, cursorOut: "cursor-1", facts: [retainedFact("row-1", 1)], receivedAt: 10_001 });
  assert.throws(() => store.appendRetainedStagePage({ runId: rowBudget.runId, threadId: rowBudget.threadId, page: 1, cursorIn: "cursor-1", cursorOut: null, facts: [retainedFact("row-2", 2)], receivedAt: 10_002 }), /row\/byte budget exceeded/);

  const byteFact = retainedFact("byte-1", 1);
  const byteBudget = { ...retainedStageInput("byte-budget"), epochId: "membership-epoch-3", budget: { maxPages: 3, maxRows: 3, maxBytes: canonicalizeRetainedStageFact(byteFact).bytes - 1 } };
  store.openRetainedStage(byteBudget);
  assert.throws(() => store.appendRetainedStagePage({ runId: byteBudget.runId, threadId: byteBudget.threadId, page: 0, cursorIn: null, cursorOut: null, facts: [byteFact], receivedAt: 10_001 }), /row\/byte budget exceeded/);
  assert.throws(() => store.openRetainedStage({ ...retainedStageInput("unbounded"), epochId: "membership-epoch-4", budget: { maxPages: RETAINED_STAGE_HARD_LIMITS.maxPages + 1, maxRows: 1, maxBytes: 1 } }), /Invalid retained stage budget/);
  assert.throws(() => store.openRetainedStage({ ...retainedStageInput("zero-projection"), epochId: "membership-epoch-5", targetProjectionVersion: 0 }), /Invalid retained stage budget/);

  const hardPage = { ...retainedStageInput("hard-page"), epochId: "membership-epoch-6" };
  store.openRetainedStage(hardPage);
  assert.throws(() => store.appendRetainedStagePage({
    runId: hardPage.runId,
    threadId: hardPage.threadId,
    page: 0,
    cursorIn: null,
    cursorOut: null,
    facts: Array.from({ length: RETAINED_STAGE_HARD_LIMITS.maxPageRows + 1 }, () => ({} as ToolExecutionFact)),
    receivedAt: 10_001,
  }), /configured row limit/);
});

test("commits retained version-5 facts and timestamp revisions atomically with immutable request replay", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = projectionStageInput();
  const opened = store.openRetainedProjectionStage(input);
  assert.equal(opened.targetProjectionVersion, RETAINED_TARGET_PROJECTION_VERSION);
  assert.equal(opened.algorithm, RETAINED_PROJECTION_ALGORITHM);
  assert.equal(opened.nextPage, 0);
  assert.match(opened.checkpointDigest, /^[0-9a-f]{64}$/);
  const firstFact = explicitProjectionFact("projection-event-1", 2, "turn-1", 100, null);
  const firstDigest = factDigest(firstFact);
  const firstCheckpoint = projectionCheckpoint(opened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "2",
    maxFactSeq: 2,
    turns: [{
      turnId: "turn-1",
      startedAtMs: 100,
      completedAtMs: null,
      startedSeq: 1,
      completedSeq: null,
      revisionSeq: null,
      lastSeenSeq: 2,
      degraded: false,
      status: "partial",
    }],
    timingRefs: [{
      sourceEventId: firstFact.sourceEventId,
      turnId: "turn-1",
      sequence: firstFact.sequence,
      factDigest: firstDigest,
      turnStartedAtMs: 100,
      turnCompletedAtMs: null,
    }],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const firstPage = projectionPage(input, opened, 0, firstCheckpoint, [firstFact], [], "2", "a".repeat(64));
  const afterFirst = store.appendRetainedProjectionStagePage(firstPage);
  assert.deepEqual({
    nextPage: afterFirst.nextPage,
    sourceAfterSeq: afterFirst.sourceAfterSeq,
    maxFactSeq: afterFirst.maxFactSeq,
    rows: afterFirst.rows,
    revisionCount: afterFirst.revisionCount,
  }, {
    nextPage: 1,
    sourceAfterSeq: "2",
    maxFactSeq: 2,
    rows: 1,
    revisionCount: 0,
  });

  const secondFact = explicitProjectionFact("projection-event-2", 4, null, null, null);
  const secondCheckpoint = projectionCheckpoint(afterFirst.checkpoint, {
    nextStagePage: 2,
    sourceAfterSeq: "3",
    maxFactSeq: 4,
    turns: [{
      turnId: "turn-1",
      startedAtMs: 200,
      completedAtMs: null,
      startedSeq: 3,
      completedSeq: null,
      revisionSeq: 3,
      lastSeenSeq: 3,
      degraded: false,
      status: "partial",
    }],
    timingRefs: [{
      sourceEventId: firstFact.sourceEventId,
      turnId: "turn-1",
      sequence: firstFact.sequence,
      factDigest: firstDigest,
      turnStartedAtMs: 200,
      turnCompletedAtMs: null,
    }],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const secondPage = projectionPage(input, afterFirst, 1, secondCheckpoint, [secondFact], [{
    revisionKey: "projection-event-1:3",
    sourceEventId: firstFact.sourceEventId,
    turnId: "turn-1",
    sequence: firstFact.sequence,
    timingRevisionSeq: 3,
    expectedFactDigest: firstDigest,
    turnStartedAtMs: 200,
    turnCompletedAtMs: null,
  }], "3", "b".repeat(64));
  const afterSecond = store.appendRetainedProjectionStagePage(secondPage);
  assert.equal(afterSecond.rows, 2);
  assert.equal(afterSecond.revisionCount, 1);
  assert.equal(afterSecond.sourceAfterSeq, "3");
  const afterRevisionAccounting = assertRetainedAccountingTotals(db, store);
  assert.equal(afterRevisionAccounting.factRows, 2n);
  assert.equal(afterRevisionAccounting.revisionRows, 1n);
  assert.equal(typeof (db.prepare("SELECT bytes_delta FROM analytics_retained_stage_revisions WHERE run_id=?").get(input.runId) as { bytes_delta: number }).bytes_delta, "number");
  assert.equal(retainedAccountingMaterialTotals(db).helper, Number(retainedAccountingMaterialTotals(db).sql));
  const revisedStored = db.prepare("SELECT fact_json FROM analytics_retained_stage_facts WHERE run_id=? AND source_event_id=?").get(input.runId, firstFact.sourceEventId) as { fact_json: string };
  assert.equal((JSON.parse(revisedStored.fact_json) as ToolExecutionFact).turnStartedAtMs, 200);
  assert.equal(store.getIndexState().generationId, 0);
  assert.equal(store.factsAsNdjson(90, 20_000), "");

  assert.deepEqual(
    store.appendRetainedProjectionStagePage(secondPage),
    afterSecond,
    "an exact submitted operation replay is a no-op before stale digest checks",
  );
  const alteredReplay = { ...secondPage, facts: [{ ...secondFact, durationMs: 121 }] };
  assert.throws(
    () => store.appendRetainedProjectionStagePage(alteredReplay),
    /Conflicting retained projection page replay/,
  );
  assert.deepEqual(store.getRetainedProjectionStage(input.runId), afterSecond);

  const alteredStoredFact = explicitProjectionFact(firstFact.sourceEventId, firstFact.sequence, "turn-1", 150, null);
  const alteredCanonical = canonicalizeRetainedStageFact(alteredStoredFact);
  db.prepare("UPDATE analytics_retained_stage_facts SET fact_json=?,fact_digest=? WHERE run_id=? AND source_event_id=?")
    .run(alteredCanonical.json, factDigest(alteredStoredFact), input.runId, firstFact.sourceEventId);
  const thirdFact = explicitProjectionFact("projection-event-3", 5, null, null, null);
  const thirdCheckpoint = projectionCheckpoint(afterSecond.checkpoint, {
    nextStagePage: 3,
    sourceAfterSeq: "5",
    maxFactSeq: 5,
    turns: [{
      turnId: "turn-1",
      startedAtMs: 300,
      completedAtMs: null,
      startedSeq: 3,
      completedSeq: null,
      revisionSeq: 5,
      lastSeenSeq: 5,
      degraded: false,
      status: "partial",
    }],
    timingRefs: [{
      sourceEventId: firstFact.sourceEventId,
      turnId: "turn-1",
      sequence: firstFact.sequence,
      factDigest: afterSecond.checkpoint.timingRefs[0]!.factDigest,
      turnStartedAtMs: 300,
      turnCompletedAtMs: null,
    }],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const stalePage = projectionPage(input, afterSecond, 2, thirdCheckpoint, [thirdFact], [{
    revisionKey: "projection-event-1:5",
    sourceEventId: firstFact.sourceEventId,
    turnId: "turn-1",
    sequence: firstFact.sequence,
    timingRevisionSeq: 5,
    expectedFactDigest: afterSecond.checkpoint.timingRefs[0]!.factDigest,
    turnStartedAtMs: 300,
    turnCompletedAtMs: null,
  }], "5", "c".repeat(64));
  assert.throws(
    () => store.appendRetainedProjectionStagePage(stalePage),
    /timing ref does not match staged fact and turn state/,
  );
  assert.deepEqual(store.getRetainedProjectionStage(input.runId), afterSecond, "stale revision rolls back the earlier insert");
  assert.equal((db.prepare("SELECT count(*) AS count FROM analytics_retained_stage_facts WHERE run_id=?").get(input.runId) as { count: number }).count, 2);
});

test("reopens retained version-5 checkpoint state and enforces projection byte bounds", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "analytics-retained-projection-"));
  const path = join(directory, "stage.sqlite");
  let db: Database.Database | null = new Database(path);
  context.after(() => {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const migration of analyticsMigrations) db.exec(migration);
  const input = projectionStageInput("durable-projection");
  const store = new AnalyticsStore(db);
  const opened = store.openRetainedProjectionStage(input);
  const fact = explicitProjectionFact("durable-event-1", 7, null, null, null);
  const checkpoint = projectionCheckpoint(opened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "7",
    maxFactSeq: 7,
  });
  const page = projectionPage(input, opened, 0, checkpoint, [fact], [], "7", "d".repeat(64));
  const committed = store.appendRetainedProjectionStagePage(page);
  db.close();
  db = new Database(path);
  const reopened = new AnalyticsStore(db);
  assert.deepEqual(reopened.getRetainedProjectionStage(input.runId), committed);
  assert.equal(reopened.getIndexState().generationId, 0);
  assert.equal(reopened.factsAsNdjson(90, 20_000), "");

  const byteInput = projectionStageInput("byte-projection", {
    epochId: "byte-projection-epoch",
    budget: {
      ...input.budget,
      maxBytes: canonicalizeRetainedStageFact(fact).bytes - 1,
    },
  });
  const byteStage = reopened.openRetainedProjectionStage(byteInput);
  const byteCheckpoint = projectionCheckpoint(byteStage.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "7",
    maxFactSeq: 7,
  });
  assert.throws(
    () => reopened.appendRetainedProjectionStagePage(projectionPage(byteInput, byteStage, 0, byteCheckpoint, [fact], [], "7", "e".repeat(64))),
    RetainedProjectionTerminalError,
  );
  assert.equal(reopened.getRetainedProjectionStage(byteInput.runId)?.terminalReason, "bytes");
  assertRetainedAccountingTotals(db, reopened);
  const metadataInput = projectionStageInput("metadata-projection", {
    epochId: "metadata-projection-epoch",
    budget: { ...input.budget, maxMetadataBytes: 1 },
  });
  const metadataStage = reopened.openRetainedProjectionStage(metadataInput);
  const metadataCheckpoint = projectionCheckpoint(metadataStage.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "7",
    maxFactSeq: 7,
  });
  assert.throws(
    () => reopened.appendRetainedProjectionStagePage(projectionPage(metadataInput, metadataStage, 0, metadataCheckpoint, [fact], [], "7", "f".repeat(64))),
    RetainedProjectionTerminalError,
  );
  assert.equal(reopened.getRetainedProjectionStage(metadataInput.runId)?.terminalReason, "metadata");
  assertRetainedAccountingTotals(db, reopened);
  assert.throws(
    () => reopened.openRetainedProjectionStage(projectionStageInput("checkpoint-cap", {
      epochId: "checkpoint-cap-epoch",
      budget: { ...input.budget, maxCheckpointBytes: 1 },
    })),
    /checkpoint budget cannot preserve bounded progress metadata/,
  );
  assert.equal(reopened.getRetainedProjectionStage("checkpoint-cap"), null);
});

test("requires exact ref-release and revision-state linkage before a v5 stage can drop timing refs", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = projectionStageInput("release-validation");
  const opened = store.openRetainedProjectionStage(input);
  const casInput = projectionStageInput("cas-validation", { epochId: "cas-validation-epoch" });
  const casOpened = store.openRetainedProjectionStage(casInput);
  db.prepare("UPDATE analytics_retained_stage_runs SET next_page=9 WHERE run_id=?").run(casInput.runId);
  const casFact = explicitProjectionFact("cas-event", 1, null, null, null);
  const casCheckpoint = projectionCheckpoint(casOpened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "1",
    maxFactSeq: 1,
  });
  assert.throws(
    () => store.appendRetainedProjectionStagePage(projectionPage(casInput, casOpened, 0, casCheckpoint, [casFact], [], "1", "c".repeat(64))),
    /Out-of-order or stale retained projection checkpoint/,
  );
  assert.equal((db.prepare("SELECT count(*) AS count FROM analytics_retained_stage_facts WHERE run_id=?").get(casInput.runId) as { count: number }).count, 0);
  const fact = explicitProjectionFact("release-event", 2, "release-turn", 100, null);
  const digest = factDigest(fact);
  const checkpoint = projectionCheckpoint(opened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: "2",
    maxFactSeq: 2,
    turns: [{
      turnId: "release-turn",
      startedAtMs: 100,
      completedAtMs: null,
      startedSeq: 1,
      completedSeq: null,
      revisionSeq: null,
      lastSeenSeq: 2,
      degraded: false,
      status: "partial",
    }],
    timingRefs: [{
      sourceEventId: fact.sourceEventId,
      turnId: "release-turn",
      sequence: fact.sequence,
      factDigest: digest,
      turnStartedAtMs: 100,
      turnCompletedAtMs: null,
    }],
    revisitReasons: ["incomplete", "partial-turn-timing"],
  });
  const first = projectionPage(input, opened, 0, checkpoint, [fact], [], "2", "f".repeat(64));
  const afterFirst = store.appendRetainedProjectionStagePage(first);

  const dropped = projectionCheckpoint(afterFirst.checkpoint, {
    nextStagePage: 2,
    sourceAfterSeq: "2",
    timingRefs: [],
  });
  assert.throws(
    () => store.appendRetainedProjectionStagePage(projectionPage(input, afterFirst, 1, dropped, [], [], "2", "0".repeat(64))),
    /dropped a ref without release evidence/,
  );

  const wronglyCompleted = projectionCheckpoint(afterFirst.checkpoint, {
    nextStagePage: 2,
    sourceAfterSeq: "2",
    timingRefs: [],
  });
  assert.throws(
    () => store.appendRetainedProjectionStagePage(projectionPage(
      input,
      afterFirst,
      1,
      wronglyCompleted,
      [],
      [],
      "2",
      "1".repeat(64),
      [{ sourceEventId: fact.sourceEventId, reason: "completed" }],
    )),
    /Completed retained ref release/,
  );

  const alteredFact = { ...fact, durationMs: 121 };
  const rollbackCheckpoint = projectionCheckpoint(afterFirst.checkpoint, {
    nextStagePage: 2,
    sourceAfterSeq: "3",
    maxFactSeq: 3,
  });
  const beforeRollback = store.getRetainedProjectionStage(input.runId);
  assert.throws(
    () => store.appendRetainedProjectionStagePage(projectionPage(
      input,
      afterFirst,
      1,
      rollbackCheckpoint,
      [explicitProjectionFact("new-before-conflict", 3, null, null, null), alteredFact],
      [],
      "3",
      "2".repeat(64),
    )),
    /Conflicting retained projection fact replay/,
  );
  assert.deepEqual(store.getRetainedProjectionStage(input.runId), beforeRollback);
  assert.equal((db.prepare("SELECT count(*) AS count FROM analytics_retained_stage_facts WHERE run_id=?").get(input.runId) as { count: number }).count, 1);
});

test("records bounded recoverable v5 failures and resumes only the exact nonterminal identity", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const input = projectionStageInput("recoverable-failure");
  const opened = store.openRetainedProjectionStage(input);
  const beforeFailureAccounting = store.readRetainedStageAccounting();
  const failed = store.failRetainedProjectionStage({ ...input, reason: "source-error", error: "temporary source outage" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureReason, "source-error");
  assert.equal(failed.nextPage, opened.nextPage);
  assert.equal(failed.checkpointDigest, opened.checkpointDigest);
  const failedAccounting = assertRetainedAccountingTotals(db, store);
  assert.ok(failedAccounting.accountingRevision > beforeFailureAccounting.accountingRevision);
  assert.equal(failedAccounting.runRows, beforeFailureAccounting.runRows);
  assert.deepEqual(store.failRetainedProjectionStage({ ...input, reason: "source-error", error: "same failure replay" }), failed);
  assert.throws(
    () => store.failRetainedProjectionStage({ ...input, reason: "aborted", error: "different failure" }),
    /Conflicting retained projection failure replay/,
  );
  assert.equal(store.resumeRetainedProjectionStage(input).state, "collecting");
  const resumedAccounting = assertRetainedAccountingTotals(db, store);
  assert.ok(resumedAccounting.accountingRevision > failedAccounting.accountingRevision);
  assert.equal(resumedAccounting.runRows, failedAccounting.runRows);
  assert.equal(store.getRetainedProjectionStage(input.runId)?.failureReason, null);
  assert.throws(
    () => store.resumeRetainedProjectionStage({ ...input, startedAt: input.startedAt + 1 }),
    /Conflicting retained projection stage replay/,
  );
});

test("closes reduced and hard v5 page limits only after a committed page boundary", (context) => {
  const { db, store } = migrateStore();
  context.after(() => db.close());
  const reducedInput = projectionStageInput("reduced-pages", {
    epochId: "reduced-pages-epoch",
    budget: { ...projectionStageInput().budget, maxPages: 1 },
  });
  const reducedOpened = store.openRetainedProjectionStage(reducedInput);
  const reducedCheckpoint = projectionCheckpoint(reducedOpened.checkpoint, {
    nextStagePage: 1,
    sourceAfterSeq: null,
    maxFactSeq: null,
  });
  const reducedCommitted = store.appendRetainedProjectionStagePage(projectionPage(
    reducedInput,
    reducedOpened,
    0,
    reducedCheckpoint,
    [],
    [],
    null,
    "3".repeat(64),
    [],
    true,
  ));
  const reducedClosed = store.closeRetainedProjectionStageAtPageLimit(reducedInput);
  assert.equal(reducedClosed.terminalReason, "pages");
  assert.equal(reducedClosed.checkpointDigest, reducedCommitted.checkpointDigest);
  const reducedAccounting = assertRetainedAccountingTotals(db, store);
  assert.equal(reducedAccounting.runRows, 1n);
  assert.ok(reducedAccounting.accountingRevision > 0n);
  assert.deepEqual(store.closeRetainedProjectionStageAtPageLimit(reducedInput), reducedClosed);

  const staleInput = projectionStageInput("stale-page-limit", { epochId: "stale-page-limit-epoch" });
  const staleOpened = store.openRetainedProjectionStage(staleInput);
  const staleCheckpoint = projectionCheckpoint(staleOpened.checkpoint, {
    nextStagePage: 2,
    sourceAfterSeq: "999",
    maxFactSeq: null,
  });
  assert.throws(
    () => store.appendRetainedProjectionStagePage(projectionPage(staleInput, staleOpened, 1, staleCheckpoint, [], [], "999", "4".repeat(64))),
    /Out-of-order or stale retained projection checkpoint/,
  );
  assert.equal(store.getRetainedProjectionStage(staleInput.runId)?.terminal, false);

  const hardInput = projectionStageInput("hard-pages", {
    epochId: "hard-pages-epoch",
    budget: {
      ...projectionStageInput().budget,
      maxPages: RETAINED_STAGE_HARD_LIMITS.maxPages,
      maxMetadataBytes: RETAINED_STAGE_HARD_LIMITS.maxMetadataBytes,
    },
  });
  let hardProgress = store.openRetainedProjectionStage(hardInput);
  for (let page = 0; page < RETAINED_STAGE_HARD_LIMITS.maxPages; page += 1) {
    const checkpoint = projectionCheckpoint(hardProgress.checkpoint, {
      nextStagePage: page + 1,
      sourceAfterSeq: null,
      maxFactSeq: null,
    });
    hardProgress = store.appendRetainedProjectionStagePage(projectionPage(
      hardInput,
      hardProgress,
      page,
      checkpoint,
      [],
      [],
      null,
      page.toString(16).padStart(64, "0"),
      [],
      true,
    ));
  }
  const hardClosed = store.closeRetainedProjectionStageAtPageLimit(hardInput);
  assert.equal(hardClosed.terminalReason, "pages");
  assert.equal(hardClosed.nextPage, RETAINED_STAGE_HARD_LIMITS.maxPages);
  assert.equal(hardClosed.checkpointDigest, hardProgress.checkpointDigest);
  assertRetainedAccountingTotals(db, store);
});

test("round-trips actual source adapter pages through v5 projection and file-backed staging", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "analytics-retained-roundtrip-"));
  const path = join(directory, "roundtrip.sqlite");
  let db: Database.Database | null = new Database(path);
  context.after(() => {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const migration of analyticsMigrations) db.exec(migration);

  const adapter = createRetainedSourceAdapter(roundtripSdk([
    [
      roundtripEvent("thread-projection", 1, "turn/started", "turn-roundtrip", "roundtrip-start", 10_001),
      roundtripEvent("thread-projection", 2, "item/completed", "turn-roundtrip", "roundtrip-item", 10_002),
    ],
    [roundtripEvent("thread-projection", 3, "turn/started", "turn-roundtrip", "roundtrip-revised-start", 10_000)],
    [roundtripEvent("thread-projection", 4, "turn/completed", "turn-roundtrip", "roundtrip-complete", 10_005)],
    [],
    [roundtripEvent("thread-projection", 5, "turn/started", "turn-roundtrip", "roundtrip-late-start", 9_999)],
  ]), roundtripSourceLimits());
  const input = projectionStageInput("adapter-roundtrip", {
    budget: { ...projectionStageInput().budget, maxPages: 6 },
  });
  const projectionLimits = { maxTurnStates: 8, maxTimingRefs: 8, maxCheckpointBytes: 16_000 };
  const store = new AnalyticsStore(db);
  const opened = store.openRetainedProjectionStage(input);
  const pageFor = (
    projected: ReturnType<typeof projectRetainedEventPage>,
    page: number,
  ): RetainedProjectionStagePage => ({
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    page,
    checkpointDigestIn: projected.checkpointDigestIn,
    source: projected.source,
    facts: projected.facts,
    timestampRevisions: projected.timestampRevisions,
    refReleases: projected.refReleases,
    checkpoint: projected.checkpoint,
    receivedAt: 20_000 + page,
  });
  const appendProjected = (
    projected: ReturnType<typeof projectRetainedEventPage>,
    page: number,
  ): ReturnType<AnalyticsStore["appendRetainedProjectionStagePage"]> => {
    const committed = store.appendRetainedProjectionStagePage(pageFor(projected, page));
    assert.ok(db != null);
    assertRetainedAccountingTotals(db, store);
    return committed;
  };

  const source1 = await adapter.eventPage({ threadId: input.threadId });
  const projected1 = projectRetainedEventPage({
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 0,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source1,
    checkpoint: null,
    limits: projectionLimits,
    receivedAt: 20_000,
  });
  const expectedOpen = explicitProjectionFact("roundtrip-item", 2, "turn-roundtrip", 10_001, null);
  assert.deepEqual(projected1.facts, [expectedOpen], "expected fact is independently authored");
  let progress = appendProjected(projected1, 0);
  assert.equal(progress.rewriteRequired, false);
  assert.equal(progress.sourceAfterSeq, "2");

  const source2 = await adapter.eventPage({ threadId: input.threadId, afterSeq: source1.metadata.sourceAfterSeq });
  const projected2 = projectRetainedEventPage({
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 1,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source2,
    checkpoint: progress.checkpoint,
    limits: projectionLimits,
    receivedAt: 20_001,
  });
  assert.equal(projected2.timestampRevisions.length, 1);
  assert.equal(projected2.checkpoint.timingRefs.length, 1, "partial-to-partial revision retains its ref");
  assert.equal(projected2.refReleases.length, 0);
  const partialPage = pageFor(projected2, 1);
  progress = store.appendRetainedProjectionStagePage(partialPage);
  const partialAccounting = assertRetainedAccountingTotals(db, store);
  assert.deepEqual(store.appendRetainedProjectionStagePage(partialPage), progress, "exact partial revision replay is a no-op");
  assert.deepEqual(store.readRetainedStageAccounting(), partialAccounting);
  const storedRevised = db.prepare("SELECT fact_json FROM analytics_retained_stage_facts WHERE run_id=? AND source_event_id=?")
    .get(input.runId, "roundtrip-item") as { fact_json: string };
  assert.deepEqual(JSON.parse(storedRevised.fact_json), explicitProjectionFact("roundtrip-item", 2, "turn-roundtrip", 10_000, null));

  const source3 = await adapter.eventPage({ threadId: input.threadId, afterSeq: source2.metadata.sourceAfterSeq });
  const projected3 = projectRetainedEventPage({
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 2,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source3,
    checkpoint: progress.checkpoint,
    limits: projectionLimits,
    receivedAt: 20_002,
  });
  assert.equal(projected3.timestampRevisions.length, 1);
  assert.deepEqual(projected3.refReleases, [{ sourceEventId: "roundtrip-item", reason: "completed" }]);
  progress = appendProjected(projected3, 2);
  const recordedRelease = db.prepare("SELECT ref_releases_json FROM analytics_retained_stage_pages WHERE run_id=? AND page=?")
    .get(input.runId, 2) as { ref_releases_json: string };
  assert.deepEqual(JSON.parse(recordedRelease.ref_releases_json), [{ sourceEventId: "roundtrip-item", reason: "completed" }]);
  const storedCompleted = db.prepare("SELECT fact_json FROM analytics_retained_stage_facts WHERE run_id=? AND source_event_id=?")
    .get(input.runId, "roundtrip-item") as { fact_json: string };
  assert.deepEqual(JSON.parse(storedCompleted.fact_json), explicitProjectionFact("roundtrip-item", 2, "turn-roundtrip", 10_000, 10_005));

  const source4 = await adapter.eventPage({ threadId: input.threadId, afterSeq: source3.metadata.sourceAfterSeq });
  assert.equal(source4.rows.length, 0);
  assert.equal(source4.metadata.sourceAfterSeq, "4");
  const projected4 = projectRetainedEventPage({
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 3,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source4,
    checkpoint: progress.checkpoint,
    limits: projectionLimits,
    receivedAt: 20_003,
  });
  progress = appendProjected(projected4, 3);
  assert.equal(progress.sourceAfterSeq, "4");
  const source5 = await adapter.eventPage({ threadId: input.threadId, afterSeq: source4.metadata.sourceAfterSeq });
  const projected5 = projectRetainedEventPage({
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 4,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: source5,
    checkpoint: progress.checkpoint,
    limits: projectionLimits,
    receivedAt: 20_004,
  });
  assert.equal(projected5.facts.length, 0);
  assert.equal(projected5.timestampRevisions.length, 0);
  assert.equal(projected5.checkpoint.rewriteRequired, true);
  assert.ok(projected5.checkpoint.rewriteDirective?.reasons.includes("revisit-required"));
  progress = appendProjected(projected5, 4);
  assert.equal(progress.rewriteRequired, true);
  db.close();
  db = new Database(path);
  const reopened = new AnalyticsStore(db);
  assert.deepEqual(reopened.getRetainedProjectionStage(input.runId), progress);
  assert.equal(reopened.getIndexState().generationId, 0, "active publication remains untouched");

  const samePageAdapter = createRetainedSourceAdapter(roundtripSdk([[
    roundtripEvent("thread-projection", 1, "turn/started", "turn-clean", "clean-start", 100),
    roundtripEvent("thread-projection", 2, "item/completed", "turn-clean", "clean-item", 200),
    roundtripEvent("thread-projection", 3, "turn/completed", "turn-clean", "clean-complete", 500),
  ]]), roundtripSourceLimits());
  const samePageSource = await samePageAdapter.eventPage({ threadId: "thread-projection" });
  const samePage = projectRetainedEventPage({
    runId: "same-page", threadId: "thread-projection", mode: "rewrite",
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM, stagePage: 0,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: samePageSource, checkpoint: null, limits: projectionLimits, receivedAt: 30_000,
  });
  assert.equal(samePage.checkpoint.revisitReasons.length, 0);
  assert.equal(samePage.checkpoint.rewriteRequired, false);
  assert.deepEqual(samePage.facts[0], {
    ...explicitProjectionFact("clean-item", 2, "turn-clean", 100, 500),
    createdAtMs: 200,
  });

  const inversionAdapter = createRetainedSourceAdapter(roundtripSdk([[
    roundtripEvent("thread-projection", 1, "turn/started", "turn-invert", "invert-start", 500),
    roundtripEvent("thread-projection", 2, "turn/completed", "turn-invert", "invert-complete", 100),
    roundtripEvent("thread-projection", 3, "item/completed", "turn-invert", "invert-item", 300),
  ]]), roundtripSourceLimits());
  const inversionSource = await inversionAdapter.eventPage({ threadId: "thread-projection" });
  const inversion = projectRetainedEventPage({
    runId: "inversion", threadId: "thread-projection", mode: "rewrite",
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM, stagePage: 0,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: inversionSource, checkpoint: null, limits: projectionLimits, receivedAt: 30_001,
  });
  assert.deepEqual(
    { started: inversion.facts[0]?.turnStartedAtMs, completed: inversion.facts[0]?.turnCompletedAtMs },
    { started: null, completed: null },
  );

  const cappedAdapter = createRetainedSourceAdapter(roundtripSdk([[
    roundtripEvent("thread-projection", 1, "turn/started", "turn-cap-a", "cap-a-start", 100),
    roundtripEvent("thread-projection", 2, "item/completed", "turn-cap-a", "cap-a-item", 200),
    roundtripEvent("thread-projection", 3, "turn/started", "turn-cap-b", "cap-b-start", 300),
    roundtripEvent("thread-projection", 4, "item/completed", "turn-cap-b", "cap-b-item", 400),
  ]]), roundtripSourceLimits({ eventPageSize: 4 }));
  const cappedSource = await cappedAdapter.eventPage({ threadId: "thread-projection" });
  const capped = projectRetainedEventPage({
    runId: "cap-run", threadId: "thread-projection", mode: "rewrite",
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM, stagePage: 0,
    dimensions: { projectId: "project-1", providerId: "provider-1" },
    source: cappedSource, checkpoint: null,
    limits: { maxTurnStates: 8, maxTimingRefs: 1, maxCheckpointBytes: 16_000 }, receivedAt: 30_002,
  });
  assert.equal(capped.checkpoint.rewriteRequired, true);
  assert.ok(capped.refReleases.some((release) => release.reason === "ref-cap"));
  const cappedInput = projectionStageInput("cap-run", {
    epochId: "cap-run-epoch",
    budget: { ...input.budget, maxTimingRefs: 1 },
  });
  const cappedStore = new AnalyticsStore(db);
  const cappedOpened = cappedStore.openRetainedProjectionStage(cappedInput);
  assert.equal(cappedOpened.nextPage, 0);
  const cappedProgress = cappedStore.appendRetainedProjectionStagePage({
    runId: cappedInput.runId, threadId: cappedInput.threadId, mode: cappedInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    page: 0, checkpointDigestIn: capped.checkpointDigestIn, source: capped.source,
    facts: capped.facts, timestampRevisions: capped.timestampRevisions,
    refReleases: capped.refReleases, checkpoint: capped.checkpoint, receivedAt: 30_002,
  });
  assert.equal(cappedProgress.rewriteDirective?.threadId, cappedInput.threadId);
  assert.equal(cappedProgress.rewriteDirective?.restart, "beginning");

  const longTurnId = `turn-${"x".repeat(430)}`;
  const laterTurnEvents = Array.from({ length: 4 }, (_, index) => {
    const turnId = `turn-later-${index}-${"y".repeat(420)}`;
    return [
      roundtripEvent("thread-projection", 4 + index * 2, "turn/started", turnId, `byte-later-start-${index}`, 600 + index * 200),
      roundtripEvent("thread-projection", 5 + index * 2, "turn/completed", turnId, `byte-later-complete-${index}`, 700 + index * 200),
    ];
  }).flat();
  const byteProjectionLimits = { maxTurnStates: 8, maxTimingRefs: 8, maxCheckpointBytes: 2_048 };
  const byteAdapter = createRetainedSourceAdapter(roundtripSdk([
    [
      roundtripEvent("thread-projection", 1, "turn/started", longTurnId, "byte-start", 100),
      roundtripEvent("thread-projection", 2, "item/completed", longTurnId, "byte-item", 200),
    ],
    [roundtripEvent("thread-projection", 3, "turn/completed", longTurnId, "byte-complete", 500), ...laterTurnEvents],
  ]), roundtripSourceLimits({ eventPageSize: 10 }));
  const byteInput = projectionStageInput("byte-eviction", {
    epochId: "byte-eviction-epoch",
    budget: { ...input.budget, ...byteProjectionLimits },
  });
  const byteStore = new AnalyticsStore(db);
  const byteOpened = byteStore.openRetainedProjectionStage(byteInput);
  assert.equal(byteOpened.nextPage, 0);
  const byteSource1 = await byteAdapter.eventPage({ threadId: byteInput.threadId });
  const byteProjected1 = projectRetainedEventPage({
    runId: byteInput.runId, threadId: byteInput.threadId, mode: byteInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 0, dimensions: { projectId: "project-1", providerId: "provider-1" }, source: byteSource1,
    checkpoint: null, limits: byteProjectionLimits, receivedAt: 50_000,
  });
  let byteProgress = byteStore.appendRetainedProjectionStagePage({
    runId: byteInput.runId, threadId: byteInput.threadId, mode: byteInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    page: 0, checkpointDigestIn: byteProjected1.checkpointDigestIn, source: byteProjected1.source,
    facts: byteProjected1.facts, timestampRevisions: byteProjected1.timestampRevisions,
    refReleases: byteProjected1.refReleases, checkpoint: byteProjected1.checkpoint, receivedAt: 50_000,
  });
  assert.equal(byteProgress.checkpoint.timingRefs.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(byteProgress.checkpoint), "utf8") <= byteProjectionLimits.maxCheckpointBytes);
  const byteSource2 = await byteAdapter.eventPage({ threadId: byteInput.threadId, afterSeq: byteSource1.metadata.sourceAfterSeq });
  const byteProjected2 = projectRetainedEventPage({
    runId: byteInput.runId, threadId: byteInput.threadId, mode: byteInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage: 1, dimensions: { projectId: "project-1", providerId: "provider-1" }, source: byteSource2,
    checkpoint: byteProgress.checkpoint, limits: byteProjectionLimits, receivedAt: 50_001,
  });
  assert.deepEqual(byteProjected2.refReleases, [{ sourceEventId: "byte-item", reason: "checkpoint-byte-cap" }]);
  assert.equal(byteProjected2.timestampRevisions.length, 0, "byte-cap release removes the completed revision");
  byteProgress = byteStore.appendRetainedProjectionStagePage({
    runId: byteInput.runId, threadId: byteInput.threadId, mode: byteInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    page: 1, checkpointDigestIn: byteProjected2.checkpointDigestIn, source: byteProjected2.source,
    facts: byteProjected2.facts, timestampRevisions: byteProjected2.timestampRevisions,
    refReleases: byteProjected2.refReleases, checkpoint: byteProjected2.checkpoint, receivedAt: 50_001,
  });
  assert.equal(byteProgress.rewriteRequired, true);
  assert.equal(byteProgress.sourceAfterSeq, "11");
  assert.ok(byteProgress.checkpoint.revisitReasons.includes("turn-state-evicted"));

  const terminalAdapter = createRetainedSourceAdapter(roundtripSdk([
    [
      roundtripEvent("thread-projection", 1, "turn/started", "turn-terminal", "terminal-start", 100),
      roundtripEvent("thread-projection", 2, "item/completed", "turn-terminal", "terminal-item", 200),
    ],
    [roundtripEvent("thread-projection", 3, "turn/completed", "turn-terminal", "terminal-complete", 500)],
  ]), roundtripSourceLimits());
  const terminalInput = projectionStageInput("terminal-run", {
    epochId: "terminal-run-epoch",
    budget: { ...input.budget, maxPages: 1 },
  });
  const terminalStore = new AnalyticsStore(db);
  const terminalOpened = terminalStore.openRetainedProjectionStage(terminalInput);
  const terminalSource1 = await terminalAdapter.eventPage({ threadId: terminalInput.threadId });
  const terminalProjected1 = projectRetainedEventPage({
    runId: terminalInput.runId, threadId: terminalInput.threadId, mode: terminalInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM, stagePage: 0,
    dimensions: { projectId: "project-1", providerId: "provider-1" }, source: terminalSource1,
    checkpoint: null, limits: projectionLimits, receivedAt: 40_000,
  });
  const terminalProgress = terminalStore.appendRetainedProjectionStagePage({
    runId: terminalInput.runId, threadId: terminalInput.threadId, mode: terminalInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    page: 0, checkpointDigestIn: terminalProjected1.checkpointDigestIn, source: terminalProjected1.source,
    facts: terminalProjected1.facts, timestampRevisions: terminalProjected1.timestampRevisions,
    refReleases: terminalProjected1.refReleases, checkpoint: terminalProjected1.checkpoint, receivedAt: 40_000,
  });
  assert.equal(terminalProgress.terminal, false);
  const terminalClosed = terminalStore.closeRetainedProjectionStageAtPageLimit(terminalInput);
  assert.equal(terminalClosed.terminal, true);
  assert.equal(terminalClosed.terminalReason, "pages");
  assert.equal(terminalClosed.nextPage, terminalProgress.nextPage);
  assert.equal(terminalClosed.checkpointDigest, terminalProgress.checkpointDigest);
  assert.equal(terminalClosed.sourceAfterSeq, terminalProgress.sourceAfterSeq);
  assert.deepEqual(terminalStore.closeRetainedProjectionStageAtPageLimit(terminalInput), terminalClosed);
  assert.throws(() => terminalStore.appendRetainedProjectionStagePage({
    runId: terminalInput.runId, threadId: terminalInput.threadId, mode: terminalInput.mode,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION, algorithm: RETAINED_PROJECTION_ALGORITHM,
    page: 1, checkpointDigestIn: terminalProjected1.checkpointDigestIn, source: terminalProjected1.source,
    facts: terminalProjected1.facts, timestampRevisions: terminalProjected1.timestampRevisions,
    refReleases: terminalProjected1.refReleases, checkpoint: terminalProjected1.checkpoint, receivedAt: 40_001,
  }), RetainedProjectionTerminalError);
  assert.equal(terminalStore.getRetainedProjectionStage(terminalInput.runId)?.terminalReason, "pages");
  assert.throws(() => terminalStore.resumeRetainedProjectionStage(terminalInput), RetainedProjectionTerminalError);
});

test("atomically replaces and serializes a bounded 25k-fact snapshot", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);

  const loadStarted = performance.now();
  store.replaceFacts(facts(25_000));
  const loadElapsed = performance.now() - loadStarted;
  assert.ok(loadElapsed < 2_000, `25k SQLite fact load took ${loadElapsed.toFixed(1)} ms`);

  const serializeStarted = performance.now();
  const ndjson = store.factsAsNdjson(14);
  const serializeElapsed = performance.now() - serializeStarted;
  assert.equal(ndjson.split("\n").length - 1, 25_000);
  assert.ok(serializeElapsed < 1_000, `25k fact serialization took ${serializeElapsed.toFixed(1)} ms`);
  assert.doesNotMatch(ndjson, /arguments|private output|free-text/);
  const firstFact = JSON.parse(ndjson.split("\n")[0] ?? "{}");
  assert.equal(typeof firstFact.command_uses_help, "boolean");
  assert.equal(typeof firstFact.command_attribution_eligible, "boolean");

  store.replaceFacts(facts(10));
  assert.equal(store.factsAsNdjson(14).split("\n").length - 1, 10);
});

test("stores immutable analytics reference capsules independently of fact generations", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const capsule: AnalyticsReferenceCapsule = {
    version: 1,
    id: "reference-id",
    token: "analytics-ref:v1:reference-id",
    createdAt: 1_000,
    bundleId: "tool-reliability",
    bundleTitle: "Tool reliability",
    queryId: "problem-tools",
    queryTitle: "Problem tools",
    querySql: "SELECT capability_key FROM tool_execution_fact_v1",
    visualizationId: "failures",
    visualizationTitle: "Failures",
    visualizationKind: "bar",
    resultGeneration: "generation",
    snapshotGenerationId: 2,
    snapshotUpdatedAt: 900,
    rangeDays: 14,
    coverage: { kind: "exact", rows: 1 },
    selection: {
      datumKey: "generation:row",
      label: "read_file",
      row: { capability_key: "read_file", failures: 3 },
      predicate: { field: "capability_key", operator: "eq", value: "read_file" },
    },
  };
  store.saveReference(capsule);
  assert.deepEqual(store.getReference(capsule.id), capsule);
  assert.equal(store.getReference("missing"), null);
});

test("publishes generation, thread coverage, removals, and facts atomically", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const first = facts(2).map((fact, index) => ({ ...fact, threadId: index === 0 ? "keep" : "remove" }));

  store.commitSnapshot({
    completedAt: 1_000,
    durationMs: 10,
    selectedThreadIds: ["keep", "remove"],
    threads: [
      { threadId: "keep", projectId: "project", providerId: "provider", updatedAt: 10, outcome: "loaded", facts: [first[0]!], maxObservedSeq: 3, truncated: false },
      { threadId: "remove", projectId: "project", providerId: "provider", updatedAt: 9, outcome: "loaded", facts: [first[1]!], maxObservedSeq: 2, truncated: true },
    ],
    loadedThreads: 2,
    factCount: 2,
    truncatedThreads: 1,
    degraded: false,
    lastError: null,
    factsChanged: true,
    lastFullReconciliationAt: 1_000,
  });
  assert.equal(store.getIndexState().generationId, 1);
  assert.equal(store.getIndexState().snapshotUpdatedAt, 1_000);
  assert.deepEqual(store.listThreadStates().map((thread) => thread.threadId), ["keep", "remove"]);

  store.commitSnapshot({
    completedAt: 2_000,
    durationMs: 12,
    selectedThreadIds: ["keep"],
    threads: [{ threadId: "keep", projectId: "project", providerId: "provider", updatedAt: 11, outcome: "loaded", facts: [], maxObservedSeq: 4, truncated: false }],
    loadedThreads: 1,
    factCount: 0,
    truncatedThreads: 0,
    degraded: false,
    lastError: null,
    factsChanged: true,
  });
  assert.equal(store.getIndexState().generationId, 2);
  assert.equal(store.factsAsNdjson(90, 3_000), "");
  assert.deepEqual(store.listThreadStates().map((thread) => thread.threadId), ["keep"]);
  assert.equal(store.listThreadStates()[0]?.maxObservedSeq, 4);
});

test("failed rereads preserve prior facts and mark the published snapshot degraded", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const prior = facts(1).map((fact) => ({ ...fact, threadId: "thread-1" }));
  store.commitSnapshot({
    completedAt: 1_000,
    durationMs: 1,
    selectedThreadIds: ["thread-1"],
    threads: [{ threadId: "thread-1", projectId: "project", providerId: "provider", updatedAt: 10, outcome: "loaded", facts: prior, maxObservedSeq: 8, truncated: true }],
    loadedThreads: 1,
    factCount: 1,
    truncatedThreads: 1,
    degraded: false,
    lastError: null,
    factsChanged: true,
  });
  store.commitSnapshot({
    completedAt: 2_000,
    durationMs: 1,
    selectedThreadIds: ["thread-1"],
    threads: [{ threadId: "thread-1", projectId: "project", providerId: "provider", updatedAt: 12, outcome: "failed", error: "temporary read failure" }],
    loadedThreads: 1,
    factCount: 1,
    truncatedThreads: 1,
    degraded: true,
    lastError: "temporary read failure",
    factsChanged: false,
  });
  const state = store.getIndexState();
  assert.equal(state.generationId, 1, "preserving prior facts must not invalidate DuckDB caches");
  assert.equal(state.degraded, true);
  assert.equal(state.lastError, "temporary read failure");
  assert.equal(store.factsAsNdjson(90, 3_000).split("\n").length - 1, 1);
  assert.equal(store.listThreadStates()[0]?.lastError, "temporary read failure");
  assert.equal(store.listThreadStates()[0]?.factCount, 1);
  assert.equal(store.listThreadStates()[0]?.updatedAt, 10, "failed source revision must remain retryable");
});

test("a new failed thread keeps an unobserved revision so the next pull retries", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  store.commitSnapshot({
    completedAt: 1_000,
    durationMs: 1,
    selectedThreadIds: ["new-thread"],
    threads: [{
      threadId: "new-thread",
      projectId: "project",
      providerId: "provider",
      updatedAt: 99,
      outcome: "failed",
      error: "temporary read failure",
    }],
    loadedThreads: 0,
    factCount: 0,
    truncatedThreads: 0,
    degraded: true,
    lastError: "temporary read failure",
    factsChanged: false,
  });
  assert.equal(store.listThreadStates()[0]?.updatedAt, 0);
  assert.equal(store.listThreadStates()[0]?.lastError, "temporary read failure");
});

test("refresh coordinator starts one shared flight for concurrent stale requests", async () => {
  let now = 2_000;
  let snapshotUpdatedAt: number | null = 1_000;
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new AnalyticsRefreshCoordinator(
    () => ({ snapshotUpdatedAt }),
    async () => {
      calls += 1;
      await pending;
      snapshotUpdatedAt = now;
    },
    () => now,
  );

  coordinator.getOrRefresh(500);
  coordinator.getOrRefresh(500);
  assert.equal(calls, 1);
  assert.equal(coordinator.isRefreshing(), true);
  release?.();
  while (coordinator.isRefreshing()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshotUpdatedAt, 2_000);
  coordinator.getOrRefresh(500);
  assert.equal(calls, 1);
});

test("strict freshness waits on the same shared refresh flight", async () => {
  let snapshotUpdatedAt: number | null = null;
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new AnalyticsRefreshCoordinator(
    () => ({ snapshotUpdatedAt }),
    async () => {
      calls += 1;
      await pending;
      snapshotUpdatedAt = 10_000;
    },
    () => 10_000,
  );

  const first = coordinator.waitForRefresh(1_000);
  const second = coordinator.waitForRefresh(1_000);
  assert.equal(calls, 1);
  release?.();
  assert.equal((await first).snapshotUpdatedAt, 10_000);
  assert.equal((await second).snapshotUpdatedAt, 10_000);
});
