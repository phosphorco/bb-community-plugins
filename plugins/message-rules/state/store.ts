import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonical, fingerprint } from "../contracts/hash.ts";
import {
  validateRule,
  migrateRule,
  VERSION,
  defaultConnection,
  GroupSchema,
  newGroup,
} from "../contracts/model.ts";
import type {
  Rule,
  RuleGroup,
  Connection,
  Evaluation,
  FileLocation,
} from "../contracts/model.ts";
export type SuiteConfig = {
  hostId: string;
  root: string;
  connection: Connection;
  locationRevision?: number;
};
export type Occurrence = {
  occurrenceId: string;
  path: string;
  logicalId: string | null;
  hash: string | null;
  enabled: boolean;
  missing: boolean;
  source: string | null;
  error: string | null;
  groupId?: string;
  projectId?: string | null;
  sourceProjectId?: string;
  sourceOccurrenceId?: string;
  location?: FileLocation;
  ownership?: string;
  ruleAliases?: Record<string, string>;
};
export type TestResult = {
  occurrenceId: string;
  path: string;
  status: "pass" | "fail" | "error" | "unknown";
  reason: string;
  evaluation?: Evaluation;
};
export type FrozenSuite = {
  selectedOccurrenceIds?: string[];
  version: string;
  projectId: string;
  config: SuiteConfig;
  rules: Rule[];
  groups?: RuleGroup[];
  occurrences: Occurrence[];
  basis: string;
  denominator: number;
  actor: unknown;
};
export type Run = {
  id: string;
  requestId: string;
  inputHash: string;
  status:
    | "running"
    | "complete"
    | "cancelled"
    | "stopped-unknown"
    | "stopped-ownership-unknown"
    | "stopped-incompatible-version";
  owner: string;
  generation: number;
  frozen: FrozenSuite;
  results: TestResult[];
  error: string | null;
  createdAt: number;
  quiescent: boolean;
};
export class Conflict extends Error {
  constructor(
    message = "Saved inputs changed. Refresh and preserve your draft before retrying.",
  ) {
    super(message);
    this.name = "Conflict";
  }
}
export function createStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mr_projects(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,config TEXT NOT NULL,rules TEXT NOT NULL,occurrences TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mr_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,frozen TEXT NOT NULL,results TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,quiescent INTEGER NOT NULL DEFAULT 0,UNIQUE(project_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS mr_active_suite ON mr_runs(project_id) WHERE quiescent=0;
 CREATE TABLE IF NOT EXISTS mr_attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,request_hash TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,observation TEXT,reserved_calls INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS mr_receipts(id TEXT PRIMARY KEY,original_id TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL,observation TEXT);
 CREATE TABLE IF NOT EXISTS mr_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const schema = db
    .prepare("SELECT value FROM mr_metadata WHERE key='schema-version'")
    .get() as { value: string } | undefined;
  if (schema && !["1", "2", "3", "4"].includes(schema.value))
    throw Error(
      "Unsupported Message Rules storage version " +
        schema.value +
        ". No operations were replayed.",
    );
  if (!schema)
    db.prepare("INSERT INTO mr_metadata VALUES('schema-version','1')").run();
  db.transaction(() => {
    const columns = db.prepare("PRAGMA table_info(mr_projects)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "groups")) {
      db.exec(
        "ALTER TABLE mr_projects ADD COLUMN groups TEXT NOT NULL DEFAULT '[]'",
      );
      const legacy = {
        ...newGroup("legacy-unscoped"),
        title: "Imported rules · scope required",
      };
      db.prepare("UPDATE mr_projects SET groups=?,revision=revision+1").run(
        canonical([legacy]),
      );
    }
    const attempts = db.prepare("PRAGMA table_info(mr_attempts)").all() as {
      name: string;
    }[];
    if (!attempts.some((c) => c.name === "context"))
      db.exec(
        "ALTER TABLE mr_attempts ADD COLUMN context TEXT NOT NULL DEFAULT '{}'",
      );
    db.prepare(
      "UPDATE mr_metadata SET value=CASE WHEN value='4' THEN '4' ELSE '3' END WHERE key='schema-version'",
    ).run();
  })();
  type Row = {
    id: string;
    revision: number;
    config: string;
    rules: string;
    occurrences: string;
    groups: string;
  };
  const get = (id: string) => {
    const r = db.prepare("SELECT * FROM mr_projects WHERE id=?").get(id) as
      | Row
      | undefined;
    return r
      ? {
          id,
          revision: r.revision,
          config: {
            ...JSON.parse(r.config),
            locationRevision: JSON.parse(r.config).locationRevision ?? 0,
          } as SuiteConfig,
          rules: (JSON.parse(r.rules) as Rule[]).map((rule) => ({
            ...migrateRule(rule),
            groupId: rule.groupId ?? "legacy-unscoped",
          })),
          groups: JSON.parse(r.groups) as RuleGroup[],
          occurrences: JSON.parse(r.occurrences) as Occurrence[],
        }
      : null;
  };
  const write = db.transaction(
    (
      id: string,
      expected: number | null,
      fn: (p: NonNullable<ReturnType<typeof get>>) => void,
    ) => {
      let p = get(id);
      if (!p) {
        if (expected !== null) throw new Conflict();
        p = {
          id,
          revision: 0,
          config: { hostId: "", root: "", connection: defaultConnection },
          rules: [],
          groups: [],
          occurrences: [],
        };
      } else if (expected !== p.revision) throw new Conflict();
      fn(p);
      p.revision++;
      db.prepare(
        "INSERT INTO mr_projects(id,revision,config,rules,occurrences,groups) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config,rules=excluded.rules,occurrences=excluded.occurrences,groups=excluded.groups",
      ).run(
        id,
        p.revision,
        canonical(p.config),
        canonical(p.rules),
        canonical(p.occurrences),
        canonical(p.groups),
      );
      return p;
    },
  );
  const runRow = (r: Record<string, unknown>): Run => ({
    id: String(r.id),
    requestId: String(r.request_id),
    inputHash: String(r.input_hash),
    status: r.status as Run["status"],
    owner: String(r.owner),
    generation: Number(r.generation),
    frozen: JSON.parse(String(r.frozen)),
    results: JSON.parse(String(r.results)),
    error: r.error as string | null,
    createdAt: Number(r.created_at),
    quiescent: !!r.quiescent,
  });
  const run = (id: string) => {
    const r = db.prepare("SELECT * FROM mr_runs WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? runRow(r) : null;
  };
  return {
    db,
    get,
    write,
    configure(id: string, revision: number | null, config: SuiteConfig) {
      return write(id, revision, (p) => {
        if (
          p.config.hostId !== config.hostId ||
          p.config.root !== config.root
        ) {
          if (
            p.occurrences.some(
              (x) =>
                x.enabled && (!x.sourceProjectId || x.sourceProjectId === id),
            )
          )
            throw new Conflict(
              "Disable or explicitly resolve existing tests before changing suite location.",
            );
          p.occurrences = p.occurrences.filter(
            (o) => o.sourceProjectId && o.sourceProjectId !== id,
          );
        }
        const changed =
          p.config.hostId !== config.hostId || p.config.root !== config.root;
        p.config = {
          ...config,
          locationRevision:
            (p.config.locationRevision ?? 0) + (changed ? 1 : 0),
        };
      });
    },
    saveGroup(id: string, revision: number, group: RuleGroup) {
      return write(id, revision, (p) => {
        const current = p.groups.find((g) => g.id === group.id);
        if (current && current.revision !== group.revision)
          throw new Conflict(
            "Group revision changed. Your draft is preserved.",
          );
        const value = GroupSchema.parse({
          ...group,
          revision: (current?.revision ?? 0) + 1,
        });
        p.groups = [...p.groups.filter((g) => g.id !== value.id), value];
      });
    },
    removeGroup(id: string, revision: number, groupId: string) {
      return write(id, revision, (p) => {
        if (
          p.rules.some((r) => r.groupId === groupId) ||
          p.occurrences.some((o) => o.groupId === groupId)
        )
          throw new Conflict(
            "Move child rules and owned tests before deleting this group.",
          );
        p.groups = p.groups.filter((g) => g.id !== groupId);
      });
    },
    saveRule(id: string, revision: number, rule: Rule) {
      return write(id, revision, (p) => {
        if (!p.groups.some((g) => g.id === rule.groupId))
          throw new Conflict("Choose a saved rule group first.");
        const current = p.rules.find((x) => x.id === rule.id);
        if (current && current.revision !== rule.revision)
          throw new Conflict("Rule revision changed. Your draft is preserved.");
        const value = validateRule({
          ...rule,
          revision: (current?.revision ?? 0) + 1,
        });
        p.rules = [...p.rules.filter((x) => x.id !== value.id), value];
      });
    },
    removeRule(id: string, revision: number, ruleId: string) {
      return write(id, revision, (p) => {
        p.rules = p.rules.filter((x) => x.id !== ruleId);
      });
    },
    discover(id: string, revision: number, occurrences: Occurrence[]) {
      return write(id, revision, (p) => {
        p.occurrences = occurrences;
      });
    },
    toggle(
      id: string,
      revision: number,
      occurrenceId: string,
      enabled: boolean,
    ) {
      return write(id, revision, (p) => {
        const o = p.occurrences.find((x) => x.occurrenceId === occurrenceId);
        if (!o) throw new Conflict();
        o.enabled = enabled;
      });
    },
    run,
    latest(projectId: string) {
      const r = db
        .prepare(
          "SELECT * FROM mr_runs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(projectId) as Record<string, unknown> | undefined;
      return r ? runRow(r) : null;
    },
    start: db.transaction(
      (requestId: string, frozen: FrozenSuite, owner: string) => {
        const inputHash = fingerprint(frozen),
          old = db
            .prepare(
              "SELECT * FROM mr_runs WHERE project_id=? AND request_id=?",
            )
            .get(frozen.projectId, requestId) as
            | Record<string, unknown>
            | undefined;
        if (old) {
          if (old.input_hash !== inputHash)
            throw new Conflict(
              "Request ID was already used with different saved inputs.",
            );
          return runRow(old);
        }
        if (
          db
            .prepare(
              "SELECT id FROM mr_runs WHERE quiescent=0 AND (project_id=? OR project_id='message-rules-global' OR ?='message-rules-global')",
            )
            .get(frozen.projectId, frozen.projectId)
        )
          throw new Conflict(
            "A run still owns this suite. Cancel and wait for local workers to stop; unresolved prior ownership requires recovery.",
          );
        const id = randomUUID();
        db.prepare(
          "INSERT INTO mr_runs(id,project_id,request_id,input_hash,status,owner,generation,frozen,results,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          frozen.projectId,
          requestId,
          inputHash,
          "running",
          owner,
          0,
          canonical(frozen),
          "[]",
          Date.now(),
        );
        return run(id)!;
      },
    ),
    attempt: db.transaction(
      (
        runId: string,
        owner: string,
        hash: string,
        wire: unknown,
        context: unknown = {},
      ) => {
        const r = run(runId);
        if (
          !r ||
          r.owner !== owner ||
          r.status !== "running" ||
          r.frozen.version !== VERSION
        )
          throw new Conflict("Run no longer permits transport invocation.");
        const n = (
          db
            .prepare("SELECT count(*) n FROM mr_attempts WHERE run_id=?")
            .get(runId) as { n: number }
        ).n;
        const exposure = (
          db
            .prepare(
              "SELECT count(*) n FROM mr_attempts a JOIN mr_runs r ON r.id=a.run_id WHERE (r.project_id=? OR ?='message-rules-global') AND a.run_id<>? AND a.state IN ('unknown','invocation-owned')",
            )
            .get(r.frozen.projectId, r.frozen.projectId, runId) as { n: number }
        ).n;
        if (n + exposure >= r.frozen.config.connection.maxCalls)
          throw Error("Run call budget exhausted.");
        const id = randomUUID();
        db.prepare(
          "INSERT INTO mr_attempts(id,run_id,owner,request_hash,request,state,context) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id,
          runId,
          owner,
          hash,
          canonical(wire),
          "reserved",
          canonical(context),
        );
        return id;
      },
    ),
    invoke: db.transaction((attemptId: string, owner: string) => {
      const a = db
        .prepare("SELECT * FROM mr_attempts WHERE id=?")
        .get(attemptId) as
        | { run_id: string; state: string; owner: string }
        | undefined;
      const r = a && run(a.run_id);
      if (
        !a ||
        a.state !== "reserved" ||
        a.owner !== owner ||
        !r ||
        r.owner !== owner ||
        r.status !== "running"
      )
        throw new Conflict("Invocation ownership retired.");
      db.prepare(
        "UPDATE mr_attempts SET state='invocation-owned' WHERE id=?",
      ).run(attemptId);
    }),
    observe(
      attemptId: string,
      state: "observed" | "unknown" | "not-sent",
      value: unknown,
    ) {
      db.prepare("UPDATE mr_attempts SET state=?,observation=? WHERE id=?").run(
        state,
        canonical(value),
        attemptId,
      );
    },
    append(runId: string, owner: string, result: TestResult) {
      const r = run(runId);
      if (!r || r.owner !== owner || r.status !== "running") return false;
      r.results.push(result);
      db.prepare("UPDATE mr_runs SET results=? WHERE id=?").run(
        canonical(r.results),
        runId,
      );
      return true;
    },
    finish(
      runId: string,
      owner: string,
      status: Run["status"],
      error: string | null = null,
    ) {
      db.prepare(
        "UPDATE mr_runs SET status=?,error=? WHERE id=? AND owner=? AND status='running'",
      ).run(status, error, runId, owner);
    },
    cancel(runId: string) {
      db.prepare(
        "UPDATE mr_runs SET status='cancelled',generation=generation+1 WHERE id=? AND quiescent=0",
      ).run(runId);
    },
    quiesce(runId: string, owner: string) {
      db.prepare("UPDATE mr_runs SET quiescent=1 WHERE id=? AND owner=?").run(
        runId,
        owner,
      );
    },
    recover: db.transaction((newOwner: string) => {
      db.prepare(
        "UPDATE mr_attempts SET state='unknown' WHERE owner<>? AND state='invocation-owned'",
      ).run(newOwner);
      db.prepare(
        `UPDATE mr_runs SET
          status=CASE WHEN json_extract(frozen,'$.version')<>? THEN 'stopped-incompatible-version'
            WHEN NOT EXISTS(SELECT 1 FROM mr_attempts a WHERE a.run_id=mr_runs.id AND a.state<>'reserved') THEN 'cancelled' ELSE 'stopped-ownership-unknown' END,
          error=CASE WHEN NOT EXISTS(SELECT 1 FROM mr_attempts a WHERE a.run_id=mr_runs.id AND a.state<>'reserved')
            THEN 'Interrupted before any invocation permit. Old owner fenced; new explicit Test is available.'
            ELSE 'Previous transport owner termination is unproved. No automatic paid replay; local slot retained.' END,
          quiescent=CASE WHEN NOT EXISTS(SELECT 1 FROM mr_attempts a WHERE a.run_id=mr_runs.id AND a.state<>'reserved') THEN 1 ELSE 0 END
          WHERE owner<>? AND quiescent=0`,
      ).run(VERSION, newOwner);
    }),
    unresolved(projectId: string) {
      return db
        .prepare(
          "SELECT a.id,a.state,a.request_hash FROM mr_attempts a JOIN mr_runs r ON r.id=a.run_id WHERE (r.project_id=? OR ?='message-rules-global') AND a.state IN ('unknown','invocation-owned')",
        )
        .all(projectId, projectId);
    },
  };
}
export type Store = ReturnType<typeof createStore>;
