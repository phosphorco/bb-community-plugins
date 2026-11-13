import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  GroupSchema,
  newGroup,
  defaultConnection,
} from "../../contracts/model.ts";
import { evaluateScoped } from "../../evaluation/scoped.ts";
import { captureProduction } from "../../evaluation/capture.ts";
import { createStore } from "../../state/store.ts";
import { savedBasis, createSuiteService } from "../../suites/runner.ts";
import { createFiles } from "../../files/files.ts";
import { createHttpTransport } from "../../evaluation/transport.ts";
import {
  captured,
  jevRule,
  testGroup,
  setup,
  source,
  memoryFiles,
  answer,
  waitUntil,
} from "../helpers.ts";
const signal = new AbortController().signal;
const context = { ...captured, projectId: "project" };
test("outside/disabled/missing groups and unavailable scope do no capture, history or JEV work", async () => {
  const group = {
    ...testGroup,
    match: { ...testGroup.match, value: "small-rollout" },
  };
  for (const groups of [[group], [{ ...testGroup, enabled: false }], []]) {
    let reads = 0,
      calls = 0;
    const out = await evaluateScoped(
      context,
      groups,
      [jevRule()],
      defaultConnection,
      async () => {
        reads++;
        throw Error("expensive read outside scope");
      },
      async () => {
        calls++;
        throw Error("outside JEV");
      },
      signal,
    );
    assert.equal(reads, 0);
    assert.equal(calls, 0);
    assert.equal(out.policy, "allow");
    assert.equal(out.rules[0]!.status, "not-applicable");
    assert.deepEqual(out.advice, []);
  }
  let reads = 0;
  const unknown = await evaluateScoped(
    { ...context, projectId: null },
    [testGroup],
    [jevRule()],
    defaultConnection,
    async () => {
      reads++;
      return captured;
    },
    async (w) => answer(w),
    signal,
  );
  assert.equal(unknown.policy, "unknown");
  assert.equal(reads, 0);
  assert.equal(unknown.groups![0]!.status, "scope-unavailable");
});
test("only children of matching groups enter history capture and shared JEV; child predicate stays independent", async () => {
  let histories = 0,
    calls = 0;
  const excluded = { ...jevRule("outside"), groupId: "outside" };
  excluded.criteria[0]!.context.senderHistory = 100;
  const active = jevRule();
  const result = await evaluateScoped(
    context,
    [
      testGroup,
      {
        ...newGroup("outside"),
        enabled: true,
        match: { ...testGroup.match, value: "other-project" },
      },
    ],
    [active, excluded],
    defaultConnection,
    async (rules) => {
      assert.deepEqual(
        rules.map((r) => r.id),
        [active.id],
      );
      return {
        ...(await captureProduction(
          captured.message,
          "sender",
          "destination",
          rules,
          {
            title: async (id) =>
              id === "sender"
                ? captured.senderTitle!
                : captured.destinationTitle!,
            history: async () => {
              histories++;
              throw Error("excluded child requested history");
            },
          },
        )),
        projectId: "project",
      };
    },
    async (w) => {
      calls++;
      assert.equal(Object.keys(w.questions).length, 1);
      return answer(w);
    },
    signal,
  );
  assert.equal(histories, 0);
  assert.equal(calls, 1);
  assert.equal(result.policy, "reject");
  assert.equal(
    result.rules.find((r) => r.id === "outside")!.status,
    "not-applicable",
  );
  const child = {
    ...active,
    match: {
      kind: "condition" as const,
      field: "message" as const,
      operator: "equals" as const,
      value: "different",
      insensitive: false,
    },
  };
  const nope = await evaluateScoped(
    context,
    [testGroup],
    [child],
    defaultConnection,
    async () => context,
    async () => {
      throw Error("child predicate ignored");
    },
    signal,
  );
  assert.equal(nope.policy, "allow");
});
test("scope rejects message-dependent predicates and bounds complexity", () => {
  assert.equal(
    GroupSchema.safeParse({
      ...testGroup,
      match: {
        kind: "condition",
        field: "message",
        operator: "contains",
        value: "x",
        insensitive: false,
      },
    }).success,
    false,
  );
  let match: any = testGroup.match;
  for (let i = 0; i < 14; i++) match = { kind: "not", child: match };
  assert.equal(GroupSchema.safeParse({ ...testGroup, match }).success, false);
});
test("v1 storage migrates transactionally with disabled legacy group; prior runs remain immutable", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE mr_projects(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,config TEXT NOT NULL,rules TEXT NOT NULL,occurrences TEXT NOT NULL)",
  );
  const old = { ...jevRule() } as any;
  delete old.groupId;
  db.prepare("INSERT INTO mr_projects VALUES(?,?,?,?,?)").run(
    "project",
    7,
    JSON.stringify({
      hostId: "h",
      root: "/tests",
      connection: defaultConnection,
    }),
    JSON.stringify([old]),
    "[]",
  );
  const store = createStore(db),
    p = store.get("project")!;
  assert.equal(p.revision, 8);
  assert.equal(p.groups[0]!.enabled, false);
  assert.equal(p.rules[0]!.groupId, "legacy-unscoped");
  assert.equal(createStore(db).get("project")!.revision, 8);
  db.close();
});
test("group revision conflicts, removal, stale basis and frozen run scope are explicit", async () => {
  const { db, store } = setup();
  store.saveRule("project", store.get("project")!.revision, jevRule());
  await createFiles(
    memoryFiles({ "one.md": source("one") }).port,
    store,
  ).discover("project");
  const p = store.get("project")!,
    basis = savedBasis(p);
  const service = createSuiteService(store, () => async (w) => answer(w));
  const run = service.start("project", "group-freeze", basis, {});
  store.saveGroup("project", p.revision, { ...p.groups[0]!, enabled: false });
  assert.notEqual(savedBasis(store.get("project")!), basis);
  assert.throws(
    () => store.saveGroup("project", p.revision, p.groups[0]!),
    /changed/,
  );
  assert.throws(
    () =>
      store.removeGroup(
        "project",
        store.get("project")!.revision,
        testGroup.id,
      ),
    /child rules/,
  );
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(store.run(run.id)!.frozen.groups![0]!.enabled, true);
  assert.equal(store.run(run.id)!.results[0]!.status, "pass");
  await service.dispose();
  db.close();
});
test("provider context rejection without tokenizer retains pre-effect reservation, potential spend and one attempt", async () => {
  const { db, store } = setup();
  store.saveRule("project", store.get("project")!.revision, jevRule());
  await createFiles(
    memoryFiles({ "one.md": source("one") }).port,
    store,
  ).discover("project");
  let calls = 0;
  const service = createSuiteService(store, (run) =>
    createHttpTransport(
      run.frozen.config.connection,
      async () => "own-test-key",
      async () => {
        calls++;
        const a = db
          .prepare("SELECT state,reserved_calls FROM mr_attempts")
          .get() as any;
        assert.equal(a.state, "invocation-owned");
        assert.equal(a.reserved_calls, 1);
        return new Response('{"error":"max_tokens_exceeded"}', { status: 400 });
      },
    ),
  );
  const p = store.get("project")!,
    run = service.start("project", "context-reject", savedBasis(p), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  const out = store.run(run.id)!;
  assert.equal(calls, 1);
  assert.equal(out.results[0]!.status, "unknown");
  assert.equal(out.status, "stopped-unknown");
  const attempt = db
    .prepare("SELECT state,observation,reserved_calls FROM mr_attempts")
    .get() as any;
  assert.equal(attempt.state, "unknown");
  assert.equal(attempt.reserved_calls, 1);
  assert.equal(JSON.parse(attempt.observation).observation.status, 400);
  assert.match(
    JSON.parse(attempt.observation).observation.body,
    /max_tokens_exceeded/,
  );
  assert.equal(
    service.start("project", "context-reject", savedBasis(p), {}).id,
    run.id,
  );
  assert.equal(calls, 1);
  await service.dispose();
  db.close();
});
