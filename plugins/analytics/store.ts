import type Database from "better-sqlite3";

import type { AnalyticsBundle } from "./bundle-contract.ts";
import type { ToolExecutionFact } from "./fact-projection.ts";

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
];

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
}

export interface SnapshotFreshnessState {
  snapshotUpdatedAt: number | null;
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

  dataDirectory(): string {
    const separator = this.db.name.lastIndexOf("/");
    return separator < 0 ? "." : this.db.name.slice(0, separator);
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
        failed, error_class, error_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

      const previous = this.db.prepare("SELECT last_full_reconciliation_at FROM analytics_index_state WHERE singleton = 1").get() as {
        last_full_reconciliation_at: number | null;
      };
      this.db.prepare(`
        UPDATE analytics_index_state
        SET status = 'ready', completed_at = ?, generation_id = generation_id + ?,
            snapshot_updated_at = ?, last_full_reconciliation_at = ?,
            loaded_threads = ?, fact_count = ?, truncated_threads = ?,
            duration_ms = ?, degraded = ?, error = ?
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

  replaceFacts(facts: readonly ToolExecutionFact[]): void {
    const insert = this.db.prepare(`
      INSERT INTO tool_execution_facts_v1 (
        source_event_id, thread_id, turn_id, sequence, project_id, provider_id,
        created_at_ms, capability_kind, capability_key, status, duration_ms,
        failed, error_class, error_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        duration_ms, failed, error_class, error_signature
      FROM tool_execution_facts_v1
      WHERE created_at_ms >= ?
      ORDER BY created_at_ms, thread_id, sequence
    `).iterate(cutoff) as Iterable<Record<string, unknown>>;
    let output = "";
    for (const row of rows) output += `${JSON.stringify({ ...row, failed: row.failed === 1 })}\n`;
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
