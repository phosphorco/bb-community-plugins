import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

type Sqlite = Database.Database;

export const restartResumeMigrations = [
  `CREATE TABLE IF NOT EXISTS restart_resume_project_messages (
     project_id TEXT PRIMARY KEY,
     message TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS restart_resume_attempts (
     thread_id TEXT NOT NULL,
     interruption_seq INTEGER NOT NULL,
     interruption_created_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'skipped')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     last_error TEXT,
     resumed_at INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (thread_id, interruption_seq)
   );
   CREATE INDEX IF NOT EXISTS restart_resume_attempts_pending_idx
     ON restart_resume_attempts(status, next_attempt_at)`,
  `ALTER TABLE restart_resume_attempts ADD COLUMN lease_token TEXT`,
] as const;

export type RestartResumeAttemptStatus = "pending" | "sent" | "skipped";

export interface RestartResumeAttempt {
  threadId: string;
  interruptionSeq: number;
  interruptionCreatedAt: number;
  status: RestartResumeAttemptStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  lastError: string | null;
  resumedAt: number | null;
}

export interface RestartResumeCounts {
  pending: number;
  resumed: number;
}

const CLAIM_LEASE_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

interface AttemptRow {
  thread_id: string;
  interruption_seq: number;
  interruption_created_at: number;
  status: RestartResumeAttemptStatus;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  last_error: string | null;
  resumed_at: number | null;
  updated_at: number;
}

function attemptFromRow(row: AttemptRow): RestartResumeAttempt {
  return {
    threadId: row.thread_id,
    interruptionSeq: row.interruption_seq,
    interruptionCreatedAt: row.interruption_created_at,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    lastError: row.last_error,
    resumedAt: row.resumed_at,
  };
}

export class RestartResumeStore {
  private readonly db: Sqlite;

  constructor(db: Sqlite) {
    this.db = db;
  }

  getProjectMessage(projectId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT message FROM restart_resume_project_messages WHERE project_id = ?`,
      )
      .get(projectId) as { message: string } | undefined;
    return row?.message ?? null;
  }

  listProjectMessages(): Array<{ projectId: string; message: string }> {
    const rows = this.db
      .prepare(
        `SELECT project_id, message
           FROM restart_resume_project_messages
          ORDER BY project_id`,
      )
      .all() as Array<{ project_id: string; message: string }>;
    return rows.map((row) => ({ projectId: row.project_id, message: row.message }));
  }

  setProjectMessage(projectId: string, message: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO restart_resume_project_messages (project_id, message, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           message = excluded.message,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, message, now);
  }

  clearProjectMessage(projectId: string): void {
    this.db
      .prepare(`DELETE FROM restart_resume_project_messages WHERE project_id = ?`)
      .run(projectId);
  }

  getAttempt(threadId: string, interruptionSeq: number): RestartResumeAttempt | null {
    const row = this.db
      .prepare(
        `SELECT thread_id, interruption_seq, interruption_created_at, status,
                attempts, next_attempt_at, lease_token, last_error, resumed_at, updated_at
           FROM restart_resume_attempts
          WHERE thread_id = ? AND interruption_seq = ?`,
      )
      .get(threadId, interruptionSeq) as AttemptRow | undefined;
    return row === undefined ? null : attemptFromRow(row);
  }

  /** Claim a recovery attempt, including reclaiming a lease left by a crash. */
  claim(
    threadId: string,
    interruptionSeq: number,
    interruptionCreatedAt: number,
    now: number,
  ): string | null {
    const claim = this.db.transaction(() => {
      const existing = this.getAttempt(threadId, interruptionSeq);
      if (existing?.status === "sent" || existing?.status === "skipped") {
        return null;
      }
      if (existing !== null && existing.nextAttemptAt > now) {
        return null;
      }
      const leaseToken = randomUUID();

      if (existing === null) {
        this.db
          .prepare(
            `INSERT INTO restart_resume_attempts (
               thread_id, interruption_seq, interruption_created_at, status,
               attempts, next_attempt_at, lease_token, last_error, resumed_at, updated_at
             ) VALUES (?, ?, ?, 'pending', 1, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            threadId,
            interruptionSeq,
            interruptionCreatedAt,
            now + CLAIM_LEASE_MS,
            leaseToken,
            now,
          );
      } else {
        this.db
          .prepare(
            `UPDATE restart_resume_attempts
                SET status = 'pending',
                    attempts = attempts + 1,
                    next_attempt_at = ?,
                    lease_token = ?,
                    last_error = NULL,
                    updated_at = ?
              WHERE thread_id = ? AND interruption_seq = ?`,
          )
          .run(now + CLAIM_LEASE_MS, leaseToken, now, threadId, interruptionSeq);
      }
      return leaseToken;
    });
    return claim();
  }

  renewLease(threadId: string, interruptionSeq: number, leaseToken: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE restart_resume_attempts
            SET next_attempt_at = ?, updated_at = ?
          WHERE thread_id = ? AND interruption_seq = ?
            AND status = 'pending' AND lease_token = ?`,
      )
      .run(now + CLAIM_LEASE_MS, now, threadId, interruptionSeq, leaseToken);
    return result.changes === 1;
  }

  markSent(
    threadId: string,
    interruptionSeq: number,
    leaseToken: string,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE restart_resume_attempts
            SET status = 'sent', next_attempt_at = ?, lease_token = NULL,
                last_error = NULL, resumed_at = ?, updated_at = ?
          WHERE thread_id = ? AND interruption_seq = ?
            AND status = 'pending' AND lease_token = ?`,
      )
      .run(now, now, now, threadId, interruptionSeq, leaseToken);
    return result.changes === 1;
  }

  /** Record a request observed in the event log when the send worker crashed before marking it sent. */
  recordSent(
    threadId: string,
    interruptionSeq: number,
    interruptionCreatedAt: number,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO restart_resume_attempts (
           thread_id, interruption_seq, interruption_created_at, status,
           attempts, next_attempt_at, lease_token, last_error, resumed_at, updated_at
         ) VALUES (?, ?, ?, 'sent', 0, ?, NULL, NULL, ?, ?)
         ON CONFLICT(thread_id, interruption_seq) DO UPDATE SET
           status = 'sent', next_attempt_at = excluded.next_attempt_at,
           lease_token = NULL, last_error = NULL, resumed_at = excluded.resumed_at,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, interruptionSeq, interruptionCreatedAt, now, now, now);
  }

  markRetry(
    threadId: string,
    interruptionSeq: number,
    leaseToken: string,
    error: string,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE restart_resume_attempts
            SET status = 'pending', next_attempt_at = ?, lease_token = NULL, last_error = ?,
                updated_at = ?
          WHERE thread_id = ? AND interruption_seq = ?
            AND status = 'pending' AND lease_token = ?`,
      )
      .run(now + RETRY_DELAY_MS, error, now, threadId, interruptionSeq, leaseToken);
    return result.changes === 1;
  }

  markSkipped(
    threadId: string,
    interruptionSeq: number,
    interruptionCreatedAt: number,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO restart_resume_attempts (
           thread_id, interruption_seq, interruption_created_at, status,
           attempts, next_attempt_at, last_error, resumed_at, updated_at
         ) VALUES (?, ?, ?, 'skipped', 0, ?, NULL, NULL, ?)
         ON CONFLICT(thread_id, interruption_seq) DO UPDATE SET
           status = CASE
             WHEN restart_resume_attempts.status = 'sent' THEN 'sent'
             ELSE 'skipped'
           END,
           lease_token = NULL,
           next_attempt_at = excluded.next_attempt_at,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, interruptionSeq, interruptionCreatedAt, now, now);
  }

  dueThreadIds(now: number, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id
           FROM restart_resume_attempts
          WHERE status = 'pending' AND next_attempt_at <= ?
          GROUP BY thread_id
          ORDER BY MIN(next_attempt_at), thread_id
          LIMIT ?`,
      )
      .all(now, limit) as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  counts(): RestartResumeCounts {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
           FROM restart_resume_attempts
          GROUP BY status`,
      )
      .all() as Array<{ status: RestartResumeAttemptStatus; count: number }>;
    return {
      pending: rows.find((row) => row.status === "pending")?.count ?? 0,
      resumed: rows.find((row) => row.status === "sent")?.count ?? 0,
    };
  }
}
