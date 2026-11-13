import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonical, fingerprint } from "../contracts/hash.ts";
import type { Evaluation } from "../contracts/model.ts";

export type AdmissionRecord = {
  id: string;
  basis: string;
  owner: string;
  state: "running" | "complete" | "unknown" | "cancelled";
  evaluation: Evaluation | null;
  reason: string | null;
};

// Native owns admission/publication truth. This journal owns only whether MR
// may invoke its paid transport and whether its response still belongs to it.
// It has no suite lock, queue writes, publication pointer or recovery runner.
export function createAdmissionLedger(db: Database.Database, owner: string = randomUUID()) {
  db.exec(`CREATE TABLE IF NOT EXISTS mr_admissions(
    id TEXT PRIMARY KEY,basis TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,
    frozen TEXT NOT NULL,evaluation TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS mr_admission_attempts(
    id TEXT PRIMARY KEY,admission_id TEXT NOT NULL,owner TEXT NOT NULL,
    partition_hash TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,observation TEXT,
    UNIQUE(admission_id,partition_hash));`);
  const get = (id: string): AdmissionRecord | null => {
    const row = db.prepare("SELECT * FROM mr_admissions WHERE id=?").get(id) as
      { id: string; basis: string; owner: string; state: AdmissionRecord["state"]; evaluation: string | null; reason: string | null } | undefined;
    return row ? { ...row, evaluation: row.evaluation ? JSON.parse(row.evaluation) : null } : null;
  };
  // A new plugin generation fences its predecessor, even when a process may
  // still return a late answer. Restart is never evidence that paid work did
  // not happen. Persist unknown; native/operator must reconcile, never replay.
  db.transaction(() => {
    db.prepare("UPDATE mr_admission_attempts SET state='unknown' WHERE owner<>? AND state='invoking'").run(owner);
    db.prepare("UPDATE mr_admissions SET state='unknown',reason='Plugin generation changed; no paid work was replayed.' WHERE owner<>? AND state='running'").run(owner);
  })();
  const owned = (id: string) => {
    const row = get(id);
    if (!row || row.owner !== owner || row.state !== "running")
      throw Error("Admission invocation ownership retired. No transport replay is permitted.");
    return row;
  };
  return {
    owner,
    get,
    begin: db.transaction((id: string, frozen: unknown) => {
      const basis = fingerprint(frozen), previous = get(id);
      if (previous) {
        if (previous.basis !== basis) throw Error("Admission identity reused with different frozen inputs.");
        return { record: previous, fresh: false };
      }
      db.prepare("INSERT INTO mr_admissions(id,basis,owner,state,frozen) VALUES(?,?,?,'running',?)").run(id,basis,owner,canonical(frozen));
      return { record: get(id)!, fresh: true };
    }),
    reserve: db.transaction((id: string, partitionHash: string, wire: unknown, maxCalls: number) => {
      owned(id);
      const n = (db.prepare("SELECT count(*) n FROM mr_admission_attempts WHERE admission_id=?").get(id) as { n: number }).n;
      if (n >= maxCalls) throw Error("Admission call budget exhausted.");
      const attempt = randomUUID();
      db.prepare("INSERT INTO mr_admission_attempts(id,admission_id,owner,partition_hash,request,state) VALUES(?,?,?,?,?,'reserved')").run(attempt,id,owner,partitionHash,canonical(wire));
      return attempt;
    }),
    invoke: db.transaction((id: string, attempt: string) => {
      owned(id);
      const changed = db.prepare("UPDATE mr_admission_attempts SET state='invoking' WHERE id=? AND admission_id=? AND owner=? AND state='reserved'").run(attempt,id,owner).changes;
      if (!changed) throw Error("Invocation permit retired or already used.");
    }),
    observe(attempt: string, state: "observed" | "unknown", observation: unknown) {
      // Retain late diagnostics without letting them promote an unknown owner.
      // The durable unknown marker already survives a closed old host handle.
      if (!db.open) return;
      db.prepare("UPDATE mr_admission_attempts SET observation=?,state=CASE WHEN state='invoking' THEN ? ELSE state END WHERE id=? AND owner=?").run(canonical(observation),state,attempt,owner);
    },
    finish(id: string, evaluation: Evaluation) {
      return !!db.prepare("UPDATE mr_admissions SET state='complete',evaluation=? WHERE id=? AND owner=? AND state='running'").run(canonical(evaluation),id,owner).changes;
    },
    retire: db.transaction((id: string, reason: string, cancelled = false) => {
      db.prepare("UPDATE mr_admissions SET state=?,reason=? WHERE id=? AND owner=? AND state='running'").run(cancelled ? "cancelled" : "unknown",reason,id,owner);
      db.prepare("UPDATE mr_admission_attempts SET state='unknown' WHERE admission_id=? AND owner=? AND state='invoking'").run(id,owner);
    }),
    dispose: db.transaction(() => {
      db.prepare("UPDATE mr_admissions SET state='unknown',reason='Plugin disposed; native disposition must reconcile without replay.' WHERE owner=? AND state='running'").run(owner);
      db.prepare("UPDATE mr_admission_attempts SET state='unknown' WHERE owner=? AND state='invoking'").run(owner);
    }),
  };
}
export type AdmissionLedger = ReturnType<typeof createAdmissionLedger>;
