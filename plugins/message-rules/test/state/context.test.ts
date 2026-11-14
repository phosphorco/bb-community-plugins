import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  source,
  memoryFiles,
  jevRule,
  count,
  answer,
  waitUntil,
} from "../helpers.ts";
import { createFiles } from "../../files/files.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { VERSION } from "../../contracts/model.ts";
import { prepare } from "../../evaluation/evaluator.ts";
import { parseFixture } from "../../contracts/fixture.ts";
test("zero-attempt interrupted run releases only the fenced, never-invoked slot", () => {
  const { db, store } = setup(),
    p = store.get("project")!;
  const frozen = {
    version: VERSION,
    projectId: "project",
    config: p.config,
    rules: [],
    groups: p.groups,
    occurrences: [],
    basis: savedBasis(p),
    denominator: 0,
    actor: {},
  };
  const r = store.start("before-permit", frozen, "old");
  store.recover("replacement");
  assert.equal(store.run(r.id)!.quiescent, true);
  assert.equal(store.run(r.id)!.status, "cancelled");
  assert.throws(() => store.attempt(r.id, "old", "wire", {}));
  assert.ok(store.start("explicit-new", frozen, "replacement"));
  db.close();
});
test("actual reservations persist occurrence and exact bindings for identical fixture wires across partitions", async () => {
  const { db, store } = setup();
  const rule = jevRule();
  rule.criteria.push({
    ...rule.criteria[0]!,
    id: "second",
    instructions: "Another check",
  });
  store.saveRule("project", store.get("project")!.revision, rule);
  const files = createFiles(
    memoryFiles({ "a.md": source("a"), "b.md": source("b") }).port,
    store,
  );
  let p = await files.discover("project");
  const fixture = parseFixture(p.occurrences[0]!.source!);
  const one = { ...rule, criteria: [rule.criteria[0]!] };
  const two = prepare(
    { ...fixture.capture, projectId: "project" },
    [rule],
    p.config.connection,
    count,
  );
  const single = prepare(
    { ...fixture.capture, projectId: "project" },
    [one],
    p.config.connection,
    count,
  );
  const size = (w: any) =>
    count(JSON.stringify({ state: w.state, questions: w.questions }));
  const budget = Math.floor(
    (size(two.partitions[0]!.wire) + size(single.partitions[0]!.wire)) / 2,
  );
  store.configure("project", p.revision, {
    ...p.config,
    connection: {
      ...p.config.connection,
      perRequestTokens: budget,
      maxCalls: 4,
    },
  });
  p = store.get("project")!;
  let calls = 0;
  const service = createSuiteService(
    store,
    () => async (w, _, dispatch) => {
      calls++;
      assert.ok(dispatch?.bindings);
      const row = db
        .prepare(
          "SELECT context,state FROM mr_attempts ORDER BY rowid DESC LIMIT 1",
        )
        .get() as any;
      assert.equal(row.state, "invocation-owned");
      const ctx = JSON.parse(row.context);
      assert.ok(ctx.occurrenceId);
      assert.deepEqual(ctx.dispatch, dispatch);
      return answer(w);
    },
    count,
  );
  const run = service.start("project", "binding-context", savedBasis(p), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(calls, 4);
  assert.equal(store.run(run.id)!.results.length, 2);
  const attempts = db
    .prepare("SELECT request_hash,context FROM mr_attempts")
    .all() as any[];
  const byHash = new Map<string, Set<string>>();
  for (const a of attempts) {
    const c = JSON.parse(a.context);
    const ids = byHash.get(a.request_hash) ?? new Set<string>();
    ids.add(c.occurrenceId);
    byHash.set(a.request_hash, ids);
    assert.equal(c.savedBasis, run.frozen.basis);
    assert.equal(
      c.sourceHash,
      run.frozen.occurrences.find((o) => o.occurrenceId === c.occurrenceId)!
        .hash,
    );
    assert.equal(c.dispatch.partitionHash, a.request_hash);
    assert.ok(
      Object.values(c.dispatch.bindings).every(
        (b: any) => b.ruleId === rule.id && b.revision === rule.revision + 1,
      ),
    );
  }
  assert.equal(byHash.size, 2);
  assert.ok([...byHash.values()].every((ids) => ids.size === 2));
  await service.dispose();
  db.close();
});
test("binding context survives fencing before result append without reconstruction or replay", async () => {
  const { db, store } = setup();
  store.saveRule("project", store.get("project")!.revision, jevRule());
  await createFiles(memoryFiles({ "a.md": source("a") }).port, store).discover(
    "project",
  );
  let calls = 0;
  const service = createSuiteService(store, () => async (w) => {
    calls++;
    store.recover("replacement");
    return answer(w);
  });
  const p = store.get("project")!,
    run = service.start("project", "before-append", savedBasis(p), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(calls, 1);
  assert.equal(store.run(run.id)!.results.length, 0);
  const ctx = JSON.parse(
    (db.prepare("SELECT context FROM mr_attempts").get() as any).context,
  );
  assert.equal(ctx.occurrenceId, run.frozen.occurrences[0]!.occurrenceId);
  assert.equal(ctx.dispatch.bindings.q0.criterionId, "progress");
  await service.dispose();
  db.close();
});
