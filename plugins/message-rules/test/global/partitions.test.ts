import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createStore } from "../../state/store.ts";
import { createGlobalCatalog } from "../../state/global.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { newGroup } from "../../contracts/model.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { prepare } from "../../evaluation/evaluator.ts";
import { parseFixture } from "../../contracts/fixture.ts";
import { fingerprint, sha256 } from "../../contracts/hash.ts";
import { jevRule, source, count, answer, waitUntil } from "../helpers.ts";
test("first fixture one call plus second fixture multiple partitions shares one global cap and exact persisted bindings", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  createGlobalCatalog(store);
  let p = store.get(G)!;
  p = store.configure(G, p.revision, {
    ...p.config,
    connection: { ...p.config.connection, maxWireBytes: 1700, maxCalls: 2 },
  });
  p = store.saveGroup(G, p.revision, {
    ...newGroup("all"),
    enabled: true,
    match: { kind: "all", children: [] },
  });
  for (const [id, msg, instructions] of [
    ["one", "one", "short"],
    ["two-a", "two", "a".repeat(700)],
    ["two-b", "two", "b".repeat(700)],
  ]) {
    const r = jevRule(id);
    r.groupId = "all";
    r.match = {
      kind: "condition",
      field: "message",
      operator: "equals",
      value: msg!,
      insensitive: false,
    };
    r.criteria[0]!.instructions = instructions!;
    p = store.saveRule(G, p.revision, r);
  }
  const a = source("one")
    .replace("expected_rules: [avoid-status-pings]", "expected_rules: [one]")
    .replace("Still working on it.", "one");
  const b = source("two")
    .replace(
      "expected_rules: [avoid-status-pings]",
      "expected_rules: [two-a, two-b]",
    )
    .replace("Still working on it.", "two");
  assert.equal(
    prepare(parseFixture(a).capture, p.rules, p.config.connection, count)
      .partitions.length,
    1,
  );
  assert.equal(
    prepare(parseFixture(b).capture, p.rules, p.config.connection, count)
      .partitions.length,
    2,
  );
  p = store.discover(
    G,
    p.revision,
    [a, b].map((bytes, i) => ({
      occurrenceId: i ? "two-occ" : "one-occ",
      path: i ? "two.md" : "one.md",
      groupId: "all",
      projectId: "project",
      source: bytes,
      hash: sha256(bytes),
      logicalId: i ? "two" : "one",
      enabled: true,
      missing: false,
      error: null,
    })),
  );
  let calls = 0;
  const service = createSuiteService(
      store,
      () => async (wire) => {
        calls++;
        return answer(wire);
      },
      count,
    ),
    run = service.start(G, "partition-budget", savedBasis(p), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  const done = store.run(run.id)!;
  assert.equal(calls, 2);
  assert.deepEqual(
    done.results.map((r) => r.status),
    ["pass", "unknown"],
  );
  assert.equal(done.frozen.denominator, 2);
  const attempts = store.db
    .prepare("SELECT * FROM mr_attempts WHERE run_id=? ORDER BY rowid")
    .all(run.id) as any[];
  assert.equal(attempts.length, 2);
  const contexts = attempts.map((a) => JSON.parse(a.context));
  assert.deepEqual(
    contexts.map((c) => c.occurrenceId),
    ["one-occ", "two-occ"],
  );
  assert.deepEqual(
    contexts.map((c) =>
      Object.values(c.dispatch.bindings).map((b: any) => b.ruleId),
    ),
    [["one"], ["two-a"]],
  );
  for (let i = 0; i < attempts.length; i++) {
    assert.equal(attempts[i].state, "observed");
    assert.equal(
      attempts[i].request_hash,
      fingerprint(JSON.parse(attempts[i].request)),
    );
    assert.equal(contexts[i].savedBasis, run.frozen.basis);
    assert.equal(contexts[i].sourceHash, done.frozen.occurrences[i]!.hash);
    assert.ok(contexts[i].dispatch.partitionHash);
  }
  await service.dispose();
  db.close();
});
