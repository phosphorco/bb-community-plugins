import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { assistantLinkLabel, extractAssistantLinkCandidates, resolveAssistantLinks, type AssistantMessage } from "./assistant-links.ts";
import { threadIdentity, threadResource } from "./canonical.ts";
import type { CrossReferencesChangedSignal } from "./model.ts";
import { CrossReferenceStore } from "./store.ts";

type Job = { thread_id: string; project_id: string; version: number; deleted: number; attempts: number };

/** SQLite owns pending work; one abort-aware worker resumes it after reload. */
export class AssistantLinkCollector {
  private wake: (() => void) | undefined;
  private readonly bb: BbPluginApi;
  private readonly db: Database.Database;
  private readonly store: CrossReferenceStore;
  private readonly publish: (signal: CrossReferencesChangedSignal) => void;
  constructor(bb: BbPluginApi, db: Database.Database, store: CrossReferenceStore, publish: (signal: CrossReferencesChangedSignal) => void) {
    this.bb = bb;
    this.db = db;
    this.store = store;
    this.publish = publish;
  }

  enqueue(projectId: string, threadId: string, deleted = false, force = false, prioritize = false): void {
    threadIdentity(projectId, threadId);
    if (!force && this.db.prepare("SELECT 1 FROM assistant_link_jobs WHERE thread_id = ?").get(threadId) !== undefined) {
      // A viewed source should not wait behind the startup backfill. Preserve
      // generation and failed-job backoff while promoting only fresh work.
      if (prioritize) this.db.prepare("UPDATE assistant_link_jobs SET retry_at = -1 WHERE thread_id = ? AND attempts = 0").run(threadId);
      this.wake?.();
      return;
    }
    const synced = this.db.prepare("SELECT synced_at FROM assistant_link_sync WHERE thread_id = ?").get(threadId) as { synced_at: number } | undefined;
    if (!force && synced !== undefined && Date.now() - synced.synced_at < 30_000) return;
    this.db.prepare(`INSERT INTO assistant_link_jobs(thread_id, project_id, version, deleted, retry_at)
      VALUES (?, ?, 1, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET
      version = version + 1, deleted = MAX(deleted, excluded.deleted), retry_at = excluded.retry_at, attempts = 0`).run(threadId, projectId, deleted ? 1 : 0, prioritize ? -1 : 0);
    this.wake?.();
  }

  seed(): void {
    const sources = this.db.prepare(`SELECT DISTINCT resources.canonical_keys_json FROM source_projections
      JOIN resources ON resources.id = source_projections.source_resource_id
      WHERE resources.provider = 'bb' AND source_projections.tombstone = 0
        AND source_projections.producer_plugin_id IN ('thread-links', 'cross-references')`).all() as Array<{ canonical_keys_json: string }>;
    for (const source of sources) {
      const keys = JSON.parse(source.canonical_keys_json) as { project?: string; thread?: string };
      if (keys.project !== undefined && keys.thread !== undefined) this.enqueue(keys.project, keys.thread, false, true);
    }
  }

  async processNext(signal: AbortSignal): Promise<boolean> {
    const job = this.db.prepare("SELECT * FROM assistant_link_jobs WHERE retry_at <= ? ORDER BY retry_at, rowid LIMIT 1").get(Date.now()) as Job | undefined;
    if (job === undefined || signal.aborted) return false;
    try {
      let title = "Thread";
      let deleted = job.deleted === 1;
      let complete = true;
      const messages = new Map<string, AssistantMessage>();
      if (!deleted) {
        try {
          const thread = await this.bb.sdk.threads.get({ threadId: job.thread_id, signal });
          if (thread.projectId !== job.project_id) throw new Error("Thread project identity changed.");
          deleted = thread.deletedAt != null;
          title = thread.title ?? "Thread";
        } catch (error) {
          if (typeof error === "object" && error !== null && "status" in error && error.status === 404) deleted = true;
          else throw error;
        }
      }
      if (!deleted) {
        let cursor: { anchorSeq: number; anchorId: string } | null = null;
        for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
          if (signal.aborted) return true;
          const page = await this.bb.sdk.threads.timeline({
            threadId: job.thread_id, includeNestedRows: "false", segmentLimit: "100", signal,
            ...(cursor === null ? {} : { beforeAnchorSeq: String(cursor.anchorSeq), beforeAnchorId: cursor.anchorId }),
          });
          for (const row of page.rows) {
            if (row.kind === "conversation" && row.role === "assistant") messages.set(row.id, { text: row.text, createdAt: row.createdAt });
          }
          complete = !page.timelinePage.hasOlderRows;
          if (complete) break;
          const next = page.timelinePage.olderCursor;
          if (next === null || (cursor !== null && next.anchorId === cursor.anchorId && next.anchorSeq === cursor.anchorSeq)) throw new Error("Timeline cursor did not advance.");
          cursor = next;
        }
      }
      const observed = deleted ? [] : await resolveAssistantLinks(
        extractAssistantLinkCandidates([...messages.values()]),
        (threadId) => this.bb.sdk.threads.get({ threadId, signal }), this.bb.server.experimental_appUrl ?? undefined,
      );
      if (signal.aborted) return true;
      const signals = this.db.transaction(() => {
        const current = this.db.prepare("SELECT version FROM assistant_link_jobs WHERE thread_id = ?").get(job.thread_id) as { version: number } | undefined;
        if (current?.version !== job.version) return [];
        const result = this.store.replaceObservedThreadReferences(
          threadResource(job.project_id, job.thread_id, { label: assistantLinkLabel(title, "Thread"), url: `/projects/${job.project_id}/threads/${job.thread_id}` }),
          observed, complete, deleted,
        );
        this.db.prepare("DELETE FROM assistant_link_jobs WHERE thread_id = ? AND version = ?").run(job.thread_id, job.version);
        this.db.prepare(`INSERT INTO assistant_link_sync(thread_id, synced_at) VALUES (?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET synced_at = excluded.synced_at`).run(job.thread_id, Date.now());
        return result;
      })();
      for (const changed of signals) this.publish(changed);
      if (!complete) this.bb.log.warn(`Cross References retained older links for ${job.thread_id}: timeline exceeded the 50-page scan bound.`);
    } catch (error) {
      if (!signal.aborted) {
        const retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6));
        this.db.prepare(`UPDATE assistant_link_jobs SET retry_at = ?, attempts = attempts + 1
          WHERE thread_id = ? AND version = ?`).run(retryAt, job.thread_id, job.version);
        this.bb.log.warn(`Could not collect Cross References for ${job.thread_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  }

  private wait(signal: AbortSignal, delay: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      this.wake = done;
      timer = setTimeout(done, Math.max(1, Math.min(60_000, delay)));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }

  async start(signal: AbortSignal): Promise<void> {
    this.seed();
    while (!signal.aborted) {
      if (await this.processNext(signal)) continue;
      const next = this.db.prepare("SELECT MIN(retry_at) AS retry_at FROM assistant_link_jobs").get() as { retry_at: number | null };
      await this.wait(signal, next.retry_at === null ? 60_000 : next.retry_at - Date.now());
    }
  }
}
