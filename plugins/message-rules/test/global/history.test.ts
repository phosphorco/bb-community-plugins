import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../state/store.ts";
import { createGlobalCatalog } from "../../state/global.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { defaultConnection, newGroup } from "../../contracts/model.ts";
import { sha256 } from "../../contracts/hash.ts";
import { source, jevRule, answer, count, waitUntil } from "../helpers.ts";
test("real suite results, observed/unknown attempts and frozen aliases stay byte-identical through migration and SQLite reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mr-global-history-"));
  const file = path.join(root, "state.db");
  let db = new Database(file);
  try {
    let store = createStore(db),
      p = store.configure("legacy", null, {
        hostId: "h",
        root: "/legacy",
        connection: defaultConnection,
      });
    p = store.saveGroup("legacy", p.revision, {
      ...newGroup("legacy-group"),
      enabled: true,
      match: {
        kind: "condition",
        field: "project_id",
        operator: "equals",
        value: "legacy",
        insensitive: false,
      },
    });
    p = store.saveRule("legacy", p.revision, {
      ...jevRule(),
      groupId: "legacy-group",
    });
    const bytes = source("historical");
    p = store.discover("legacy", p.revision, [
      {
        occurrenceId: "historical-file",
        path: "same.md",
        logicalId: "historical",
        source: bytes,
        hash: sha256(bytes),
        enabled: true,
        missing: false,
        error: null,
      },
    ]);
    const completedService = createSuiteService(
      store,
      () => async (w) => answer(w),
      count,
    );
    const completed = completedService.start(
      "legacy",
      "completed-history",
      savedBasis(p),
      { person: "historical" },
    );
    await waitUntil(() => !!store.run(completed.id)?.quiescent);
    assert.equal(store.run(completed.id)!.results[0]!.status, "pass");
    await completedService.dispose();
    const uncertainService = createSuiteService(
      store,
      () => async () => {
        throw Error("Injected lost response after invocation");
      },
      count,
    );
    const uncertain = uncertainService.start(
      "legacy",
      "uncertain-history",
      savedBasis(p),
      {},
    );
    await waitUntil(() => !!store.run(uncertain.id)?.quiescent);
    assert.equal(store.run(uncertain.id)!.status, "stopped-unknown");
    assert.equal(store.run(uncertain.id)!.results[0]!.status, "unknown");
    await uncertainService.dispose();
    const rows = () =>
      Object.fromEntries(
        ["mr_runs", "mr_attempts"].map((t) => [
          t,
          db.prepare("SELECT * FROM " + t + " ORDER BY id").all(),
        ]),
      );
    const beforeMigration = rows();
    createGlobalCatalog(store);
    assert.deepEqual(rows(), beforeMigration);
    const globalService = createSuiteService(
      store,
      () => async (w) => answer(w),
      count,
    );
    const global = globalService.start(
      G,
      "frozen-alias-history",
      savedBasis(store.get(G)!),
      {},
    );
    await waitUntil(() => !!store.run(global.id)?.quiescent);
    assert.equal(store.run(global.id)!.results[0]!.status, "pass");
    assert.ok(
      store.run(global.id)!.frozen.occurrences[0]!.ruleAliases?.[
        "avoid-status-pings"
      ],
    );
    await globalService.dispose();
    const beforeReopen = rows();
    db.close();
    db = new Database(file);
    store = createStore(db);
    createGlobalCatalog(store);
    const replacement = createSuiteService(
      store,
      () => async () => {
        throw Error("No replay permitted");
      },
      count,
    );
    assert.deepEqual(rows(), beforeReopen);
    assert.equal(store.unresolved(G).length, 1);
    assert.equal(store.run(completed.id)!.frozen.denominator, 1);
    assert.equal(store.run(completed.id)!.results[0]!.status, "pass");
    assert.equal(store.run(uncertain.id)!.results[0]!.status, "unknown");
    assert.equal(store.latest("legacy")!.id, uncertain.id);
    const states = db
      .prepare("SELECT state,count(*) n FROM mr_attempts GROUP BY state")
      .all() as { state: string; n: number }[];
    assert.deepEqual(Object.fromEntries(states.map((r) => [r.state, r.n])), {
      observed: 2,
      unknown: 1,
    });
    await replacement.dispose();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
