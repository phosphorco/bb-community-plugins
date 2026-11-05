import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Record, Finding } from "./contracts.ts";
export type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export class Store {
  db: Database;
  onChange: (owner: string) => void;
  private listeners = new Map<string, Set<() => void>>();
  private disposed = false;
  // Hints only: callers subscribe BEFORE reading, and always reread SQLite.
  // Heartbeat-only saves deliberately do not wake assignment waiters.
  watch(id: string) {
    if (this.disposed) throw new Error("Subscription store disposed");
    let group = this.listeners.get(id);
    if (!group) {
      if (this.listeners.size >= 2000) throw new Error("Too many subscription waiters");
      group = new Set(); this.listeners.set(id, group);
    }
    if (group.size >= 4) throw new Error("Too many subscription waiters");
    let pending = false, closed = false, wake: (() => void) | undefined;
    const listener = () => { pending = true; wake?.(); };
    group.add(listener);
    return {
      wait: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer); signal?.removeEventListener("abort", done); wake = undefined;
          pending = false;
          if (this.disposed || closed) reject(new Error("Subscription store disposed"));
          else if (signal?.aborted) reject(new Error("Subscription wait aborted"));
          else resolve();
        };
        const timer = setTimeout(done, ms);
        wake = done; signal?.addEventListener("abort", done, { once: true });
        if (pending || closed || this.disposed || signal?.aborted) done();
      }),
      close: () => {
        closed = true; group!.delete(listener);
        if (!group!.size) this.listeners.delete(id);
        wake?.();
      },
    };
  }
  dispose() {
    this.disposed = true;
    for (const group of this.listeners.values()) for (const listener of group) listener();
    this.listeners.clear();
  }
  constructor(db: Database, onChange: (owner: string) => void = () => {}) {
    this.onChange = onChange;
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, occurrence TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(subscription_id, occurrence));
      CREATE INDEX IF NOT EXISTS subscription_owner ON subscriptions(owner);
      CREATE INDEX IF NOT EXISTS subscription_state ON subscriptions(state);
      CREATE INDEX IF NOT EXISTS finding_delivery ON findings(json_extract(body,'$.delivery'));
      CREATE INDEX IF NOT EXISTS subscription_cleanup ON subscriptions(json_extract(body,'$.stop_pending'));`);
  }
  save(r: Record, notify = true) {
    const changed = this.db
      .prepare(
        "INSERT INTO subscriptions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, body=excluded.body WHERE subscriptions.body != excluded.body",
      )
      .run(r.id, r.owner, r.state, JSON.stringify(r));
    if (changed.changes && notify) {
      for (const listener of this.listeners.get(r.id) ?? []) listener();
      this.onChange(r.owner);
    }
  }
  get(id: string): Record {
    const row = this.db
      .prepare("SELECT body FROM subscriptions WHERE id=?")
      .get(id) as { body: string } | undefined;
    if (!row) throw new Error("Unknown subscription");
    return JSON.parse(row.body);
  }
  active(): Record[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM subscriptions WHERE state NOT IN ('fulfilled','failed','expired','cancelled') LIMIT 1000",
        )
        .all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  cleanups(): Record[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM subscriptions WHERE json_extract(body,'$.stop_pending')=1 LIMIT 100",
        )
        .all() as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  owned(owner: string): Record[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM subscriptions WHERE owner=? ORDER BY (state IN ('fulfilled','failed','expired','cancelled')), rowid DESC LIMIT 100",
        )
        .all(owner) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  findings(id?: string): Finding[] {
    const rows = id
      ? this.db
          .prepare(
            "SELECT body FROM findings WHERE subscription_id=? ORDER BY rowid DESC LIMIT 100",
          )
          .all(id)
      : this.db
          .prepare(
            "SELECT body FROM findings WHERE json_extract(body,'$.delivery') IN ('pending','sending') LIMIT 100",
          )
          .all();
    return (rows as { body: string }[]).map((r) => JSON.parse(r.body));
  }
  withdrawals(): Finding[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM findings WHERE json_extract(body,'$.withdraw_pending')=1 LIMIT 100",
        )
        .all() as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  putFinding(f: Finding) {
    const changed = this.db
      .prepare(
        "INSERT INTO findings VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE findings.body != excluded.body",
      )
      .run(f.id, f.subscription_id, f.occurrence, JSON.stringify(f));
    if (changed.changes) this.onChange(f.owner);
  }
  hasOccurrence(id: string, key: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM findings WHERE subscription_id=? AND occurrence=?",
      )
      .get(id, key);
  }
  atomic(fn: () => void) {
    this.db.transaction(fn)();
  }
}
