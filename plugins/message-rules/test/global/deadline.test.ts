import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createStore } from "../../state/store.ts";
import { createGlobalCatalog } from "../../state/global.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { newGroup } from "../../contracts/model.ts";
import { source, jevRule, answer, count, waitUntil } from "../helpers.ts";
import { sha256 } from "../../contracts/hash.ts";
test("one global deadline stops promise-only fixture work at the next boundary without dropping its frozen denominator", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  createGlobalCatalog(store);
  let p = store.get(G)!;
  p = store.configure(G, p.revision, {
    ...p.config,
    connection: { ...p.config.connection, timeoutMs: 1000 },
  });
  p = store.saveGroup(G, p.revision, {
    ...newGroup("any"),
    enabled: true,
    match: { kind: "all", children: [] },
  });
  p = store.saveRule(G, p.revision, { ...jevRule(), groupId: "any" });
  p = store.discover(
    G,
    p.revision,
    ["a", "b"].map((id) => ({
      occurrenceId: id,
      path: id + ".md",
      groupId: "any",
      projectId: "project",
      logicalId: id,
      source: source(id),
      hash: sha256(source(id)),
      enabled: true,
      missing: false,
      error: null,
    })),
  );
  const realNow = Date.now;
  let now = realNow(),
    calls = 0;
  Date.now = () => now;
  const service = createSuiteService(
    store,
    () => async (wire) => {
      calls++;
      now += 1001;
      return answer(wire);
    },
    count,
  );
  try {
    const run = service.start(G, "deadline", savedBasis(p), {});
    await waitUntil(() => !!store.run(run.id)?.quiescent);
    const done = store.run(run.id)!;
    assert.equal(calls, 1);
    assert.equal(done.status, "cancelled");
    assert.equal(done.frozen.denominator, 2);
    assert.equal(done.results.length, 1);
    assert.match(done.error!, /time budget exhausted/);
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM mr_attempts WHERE run_id=?")
          .get(run.id) as any
      ).n,
      1,
    );
  } finally {
    Date.now = realNow;
    await service.dispose();
    db.close();
  }
});

test("absolute deadline denies the next partition permit before reserving or invoking; before-deadline control completes", async () => {
  for (const advance of [0, 1001]) {
    const db = new Database(":memory:"), store = createStore(db);
    createGlobalCatalog(store);
    let p = store.get(G)!;
    p = store.configure(G, p.revision, { ...p.config, connection: { ...p.config.connection, timeoutMs: 1000, maxWireBytes: 1700 } });
    p = store.saveGroup(G, p.revision, { ...newGroup("all"), enabled: true, match: { kind: "all", children: [] } });
    for (const id of ["one", "two"]) {
      const r = { ...jevRule(id), groupId: "all" };
      r.criteria[0]!.instructions = id.repeat(250);
      p = store.saveRule(G, p.revision, r);
    }
    const bytes = source("fixture").replace("expected_rules: [avoid-status-pings]", "expected_rules: [one, two]");
    p = store.discover(G, p.revision, [{ occurrenceId: "fixture", path: "fixture.md", groupId: "all", projectId: "project", logicalId: "fixture", source: bytes, hash: sha256(bytes), enabled: true, missing: false, error: null }]);
    const realNow = Date.now; let now = realNow(), calls = 0;
    Date.now = () => now;
    const service = createSuiteService(store, () => async wire => { calls++; now += advance; return answer(wire); }, count);
    try {
      const run = service.start(G, "partition-deadline", savedBasis(p), {});
      await waitUntil(() => !!store.run(run.id)?.quiescent);
      const done = store.run(run.id)!;
      assert.equal(calls, advance ? 1 : 2);
      assert.equal(done.status, advance ? "cancelled" : "complete");
      assert.equal(done.frozen.denominator, 1);
      assert.equal(done.results[0]!.evaluation!.policy, advance ? "unknown" : "reject");
      assert.deepEqual(done.results[0]!.evaluation!.advice.length, advance ? 0 : 1);
      assert.equal((db.prepare("SELECT count(*) n FROM mr_attempts").get() as any).n, calls);
    } finally { Date.now = realNow; await service.dispose(); db.close(); }
  }
});
