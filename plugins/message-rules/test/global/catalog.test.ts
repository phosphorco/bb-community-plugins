import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createStore, type Occurrence } from "../../state/store.ts";
import { createGlobalCatalog } from "../../state/global.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import {
  newGroup,
  newRule,
  defaultConnection,
  VERSION,
} from "../../contracts/model.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { sha256 } from "../../contracts/hash.ts";
import { waitUntil } from "../helpers.ts";

const fixture = (
  id: string,
  expected: string[],
  advice: string[],
  projectId?: string,
) =>
  `---\nversion: 1\nid: ${id}\nexpect: reject\nexpected_rules: ${JSON.stringify(expected)}\n${projectId ? "project_id: " + projectId + "\n" : ""}---\n# Message\nblock\n\n# Expected advice\n${advice.join("\n---\n")}\n`;
const occurrence = (id: string, source: string): Occurrence => ({
  occurrenceId: id,
  path: "same.md",
  logicalId: id,
  hash: sha256(source),
  source,
  enabled: true,
  missing: false,
  error: null,
});
function seed(store: ReturnType<typeof createStore>, id: string) {
  let p = store.configure(id, null, {
    hostId: "host",
    root: "/" + id,
    connection: defaultConnection,
  });
  p = store.saveGroup(id, p.revision, {
    ...newGroup("same-group"),
    title: "Same name",
    enabled: true,
    match: { kind: "all", children: [] },
  });
  p = store.saveRule(id, p.revision, {
    ...newRule("same-rule", "same-group"),
    enabled: true,
    action: "reject",
    advice: "legacy",
    match: { kind: "all", children: [] },
  });
  return store.discover(id, p.revision, [
    occurrence("same-occurrence", fixture("one", ["same-rule"], ["legacy"])),
  ]);
}
test("migration preserves legacy rows/bytes/history and maps colliding IDs, names, paths and fixture expectations without widening scopes", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  seed(store, "a");
  seed(store, "b");
  const before = db.prepare("SELECT * FROM mr_projects ORDER BY id").all();
  const historic = store.start(
    "historic",
    {
      version: "message-rules-v1.3",
      projectId: "a",
      config: store.get("a")!.config,
      groups: store.get("a")!.groups,
      rules: store.get("a")!.rules,
      occurrences: store.get("a")!.occurrences,
      basis: "old",
      denominator: 1,
      actor: {},
    },
    "old",
  );
  store.finish(historic.id, "old", "complete");
  store.quiesce(historic.id, "old");
  const runBefore = db.prepare("SELECT * FROM mr_runs").all();
  const catalog = createGlobalCatalog(store),
    p = store.get(G)!;
  assert.deepEqual(
    db.prepare("SELECT * FROM mr_projects WHERE id<>? ORDER BY id").all(G),
    before,
  );
  assert.deepEqual(db.prepare("SELECT * FROM mr_runs").all(), runBefore);
  assert.equal(new Set(p.groups.map((g) => g.id)).size, 2);
  assert.equal(new Set(p.rules.map((r) => r.id)).size, 2);
  assert.equal(new Set(p.occurrences.map((o) => o.occurrenceId)).size, 2);
  assert.deepEqual(
    p.occurrences.map((o) => o.projectId),
    ["a", "b"],
  );
  assert.ok(
    p.occurrences.every(
      (o) => o.source === store.get(o.projectId!)!.occurrences[0]!.source,
    ),
  );
  assert.ok(
    p.occurrences.every((o) => o.ownership?.includes("unique expected-rule")),
  );
  let calls = 0;
  const service = createSuiteService(store, () => async () => {
    calls++;
    throw Error("No model call permitted");
  });
  const r = service.start(G, "global", savedBasis(p), {});
  await waitUntil(() => !!store.run(r.id)?.quiescent);
  const final = store.run(r.id)!;
  assert.equal(final.frozen.denominator, 2);
  assert.deepEqual(
    final.results.map((r) => r.status),
    ["pass", "pass"],
  );
  for (const result of final.results)
    assert.equal(
      result.evaluation!.groups!.filter((g) => g.status === "in-scope").length,
      1,
    );
  assert.equal(calls, 0);
  const stable = JSON.stringify(store.get(G));
  createGlobalCatalog(store);
  assert.equal(JSON.stringify(store.get(G)), stable);
  assert.equal(catalog.info().aliases.length, 6);
  await service.dispose();
  db.close();
});

test("one global snapshot evaluates two project fixtures against cross-group rules with exact advice/expectations; ownership never filters", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  seed(store, "a");
  seed(store, "b");
  const catalog = createGlobalCatalog(store);
  let p = store.get(G)!;
  p = store.saveGroup(G, p.revision, {
    ...newGroup("any-project"),
    enabled: true,
    order: 10,
    match: { kind: "all", children: [] },
  });
  p = store.saveRule(G, p.revision, {
    ...newRule("global-reject", "any-project"),
    enabled: true,
    action: "reject",
    advice: "global advice",
    order: 10,
    match: { kind: "all", children: [] },
  });
  for (const sourceId of ["a", "b"]) {
    const source = store.get(sourceId)!;
    store.discover(sourceId, source.revision, [
      occurrence(
        "same-occurrence",
        fixture(
          "one",
          ["same-rule", "global-reject"],
          ["legacy", "global advice"],
        ),
      ),
    ]);
  }
  p = catalog.sync();
  let calls = 0;
  const service = createSuiteService(store, () => async () => {
    calls++;
    throw Error("No inference");
  });
  const r = service.start(G, "all", savedBasis(p), {});
  // A concurrent catalog save cannot alter the captured denominator or catalog.
  store.saveRule(G, p.revision, {
    ...p.rules.find((r) => r.id === "global-reject")!,
    advice: "new advice",
  });
  await waitUntil(() => !!store.run(r.id)?.quiescent);
  const result = store.run(r.id)!;
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["pass", "pass"],
  );
  assert.ok(
    result.results.every(
      (r) =>
        r.evaluation!.rules.find((r) => r.id === "global-reject")?.status ===
        "reject",
    ),
  );
  assert.equal(
    result.frozen.rules.find((r) => r.id === "global-reject")!.advice,
    "global advice",
  );
  assert.notEqual(savedBasis(store.get(G)!), result.frozen.basis);
  assert.equal(
    service.start(G, "all", result.frozen.basis, {}).id,
    r.id,
    "lost start ack returns same run even after edits",
  );
  assert.equal(calls, 0);
  await service.dispose();
  db.close();
});

test("enabled malformed/missing tests survive migration denominator, fallback ownership and disabled exclusion", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  let p = seed(store, "a");
  p = store.discover("a", p.revision, [
    { ...occurrence("bad", "invalid"), error: "Invalid YAML" },
    {
      ...occurrence("missing", ""),
      source: null,
      missing: true,
      error: "Missing",
    },
    {
      ...occurrence("disabled", "invalid"),
      enabled: false,
      error: "Invalid YAML",
    },
  ]);
  createGlobalCatalog(store);
  const global = store.get(G)!;
  assert.ok(
    global.occurrences.every(
      (o) => o.groupId && o.ownership?.includes("fallback"),
    ),
  );
  const service = createSuiteService(store, () => async () => {
    throw Error("No call");
  });
  const r = service.start(G, "errors", savedBasis(global), {});
  await waitUntil(() => !!store.run(r.id)?.quiescent);
  assert.equal(store.run(r.id)!.frozen.denominator, 2);
  assert.deepEqual(
    store.run(r.id)!.results.map((r) => r.status),
    ["error", "error"],
  );
  await service.dispose();
  db.close();
});

test("global active slot and inherited paid uncertainty fence legacy work and survive reopen without replay", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  seed(store, "a");
  const catalog = createGlobalCatalog(store),
    p = store.get(G)!;
  const frozen = {
    version: VERSION,
    projectId: "a",
    config: store.get("a")!.config,
    rules: store.get("a")!.rules,
    groups: store.get("a")!.groups,
    occurrences: store.get("a")!.occurrences,
    basis: "old",
    denominator: 1,
    actor: {},
  };
  const old = store.start("paid", frozen, "old-owner");
  const attempt = store.attempt(old.id, "old-owner", "hash", {});
  store.invoke(attempt, "old-owner");
  let calls = 0;
  const service = createSuiteService(store, () => async () => {
    calls++;
    throw Error("No replay");
  });
  assert.equal(store.unresolved(G).length, 1);
  assert.equal(store.run(old.id)!.status, "stopped-ownership-unknown");
  assert.throws(
    () => service.start(G, "blocked", savedBasis(p), {}),
    /still owns/,
  );
  assert.equal(calls, 0);
  // Old owner explicitly proves quiescence; unknown spend still counts globally.
  store.quiesce(old.id, "old-owner");
  const r = service.start(G, "new-explicit", savedBasis(catalog.sync()), {});
  await waitUntil(() => !!store.run(r.id)?.quiescent);
  assert.equal(store.unresolved(G).length, 1);
  assert.equal(calls, 0);
  await service.dispose();
  db.close();
});

test("exact cross-group mismatches fail and explicit fixture project identity overrides file organization", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  seed(store, "a");
  const catalog = createGlobalCatalog(store);
  let p = store.get(G)!;
  p = store.saveGroup(G, p.revision, {
    ...newGroup("global"),
    enabled: true,
    order: 10,
    match: { kind: "all", children: [] },
  });
  p = store.saveRule(G, p.revision, {
    ...newRule("other-rule", "global"),
    enabled: true,
    action: "reject",
    order: 10,
    advice: "other",
    match: { kind: "all", children: [] },
  });
  const source = store.get("a")!;
  store.discover("a", source.revision, [
    {
      ...occurrence(
        "wrong-rules",
        fixture("wrong-rules", ["same-rule"], ["legacy", "other"]),
      ),
      path: "wrong-rules.md",
    },
    {
      ...occurrence(
        "wrong-advice",
        fixture(
          "wrong-advice",
          ["same-rule", "other-rule"],
          ["other", "legacy"],
        ),
      ),
      path: "wrong-advice.md",
    },
    {
      ...occurrence(
        "other-project",
        fixture("other-project", ["other-rule"], ["other"], "b"),
      ),
      path: "other-project.md",
    },
  ]);
  p = catalog.sync();
  assert.equal(p.occurrences[2]!.projectId, "b");
  const service = createSuiteService(store, () => async () => {
      throw Error("No inference");
    }),
    run = service.start(G, "exact", savedBasis(p), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  const results = store.run(run.id)!.results;
  assert.deepEqual(
    results.map((r) => r.status),
    ["fail", "fail", "pass"],
  );
  assert.match(results[0]!.reason, /Rejecting rules differ/);
  assert.match(results[1]!.reason, /exact ordered advice/);
  assert.equal(
    results[2]!.evaluation!.groups!.find((g) => g.id === "same-group")!.status,
    "outside-scope",
  );
  await service.dispose();
  db.close();
});

test("global budget is shared across fixtures/groups, with one durable reservation rather than a budget per group", async () => {
  const { jevRule, answer, count } = await import("../helpers.ts");
  const db = new Database(":memory:"),
    store = createStore(db);
  seed(store, "a");
  seed(store, "b");
  const catalog = createGlobalCatalog(store);
  let p = store.get(G)!;
  p = store.configure(G, p.revision, {
    ...p.config,
    connection: { ...p.config.connection, maxCalls: 1 },
  });
  p = store.saveGroup(G, p.revision, {
    ...newGroup("all-one"),
    enabled: true,
    match: { kind: "all", children: [] },
  });
  p = store.saveGroup(G, p.revision, {
    ...newGroup("all-two"),
    enabled: true,
    match: { kind: "all", children: [] },
  });
  p = store.saveRule(G, p.revision, {
    ...jevRule("jev-one"),
    groupId: "all-one",
    order: 10,
  });
  p = store.saveRule(G, p.revision, {
    ...jevRule("jev-two"),
    groupId: "all-two",
    order: 11,
  });
  // Ignore assertions here: the oracle is total calls/reservations across both fixtures.
  let calls = 0;
  const service = createSuiteService(
    store,
    () => async (wire) => {
      calls++;
      assert.equal(Object.keys(wire.questions).length, 2);
      return answer(wire);
    },
    count,
  );
  const run = service.start(G, "one-budget", savedBasis(catalog.sync()), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(calls, 1);
  assert.equal(
    (
      db
        .prepare("SELECT count(*) n FROM mr_attempts WHERE run_id=?")
        .get(run.id) as { n: number }
    ).n,
    1,
  );
  assert.equal(store.run(run.id)!.frozen.denominator, 2);
  assert.equal(store.run(run.id)!.results[1]!.status, "unknown");
  await service.dispose();
  db.close();
});

test("ambiguous duplicate IDs inside one legacy catalog fail atomically, preserving original rows", () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  let p = seed(store, "a");
  store.write("a", p.revision, (p) =>
    p.rules.push({ ...p.rules[0]!, title: "Conflicting duplicate" }),
  );
  const before = db.prepare("SELECT * FROM mr_projects").all();
  assert.throws(
    () => createGlobalCatalog(store),
    /Ambiguous duplicate rule ID/,
  );
  assert.deepEqual(db.prepare("SELECT * FROM mr_projects").all(), before);
  assert.equal(store.get(G), null);
  db.close();
});
