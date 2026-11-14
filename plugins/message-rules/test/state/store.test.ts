import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  source,
  memoryFiles,
  count,
  answer,
  waitUntil,
  jevRule,
} from "../helpers.ts";
import { createFiles } from "../../files/files.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { fingerprint } from "../../contracts/hash.ts";
import { VERSION } from "../../contracts/model.ts";
test("concurrent rule revision writes conflict and frozen denominator does not drift", async () => {
  const { db, store } = setup();
  const p = store.get("project")!;
  store.saveRule("project", p.revision, jevRule());
  assert.throws(
    () => store.saveRule("project", p.revision, jevRule()),
    /changed/,
  );
  const files = createFiles(
    memoryFiles({ "one.md": source("one"), "invalid.md": "broken" }).port,
    store,
  );
  await files.discover("project");
  const service = createSuiteService(
    store,
    () => async (w) => answer(w),
    count,
  );
  const before = store.get("project")!,
    run = service.start("project", "request", savedBasis(before), {
      kind: "machine",
    });
  store.toggle(
    "project",
    before.revision,
    before.occurrences[0]!.occurrenceId,
    false,
  );
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(store.run(run.id)!.frozen.denominator, 2);
  assert.equal(store.run(run.id)!.results.length, 2);
  assert.equal(
    store.run(run.id)!.results.filter((r) => r.status === "error").length,
    1,
  );
  await service.dispose();
  db.close();
});
test("lost dispatch response retains reservation and explicit rerun does not replay old request", async () => {
  const { db, store } = setup();
  store.saveRule("project", store.get("project")!.revision, jevRule());
  await createFiles(
    memoryFiles({ "one.md": source("one") }).port,
    store,
  ).discover("project");
  let calls = 0;
  const service = createSuiteService(
    store,
    () => async () => {
      calls++;
      throw Error("response lost after remote acceptance");
    },
    count,
  );
  const p = store.get("project")!,
    basis = savedBasis(p),
    run = service.start("project", "same-request", basis, {});
  assert.equal(service.start("project", "same-request", basis, {}).id, run.id);
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(calls, 1);
  assert.equal(store.run(run.id)!.status, "stopped-unknown");
  assert.equal(store.unresolved("project").length, 1);
  assert.equal(service.start("project", "same-request", basis, {}).id, run.id);
  assert.equal(calls, 1);
  await service.dispose();
  db.close();
});
test("never-invoked reserved run is fenced and releases its slot on restart", () => {
  const { db, store } = setup(),
    p = store.get("project")!;
  const frozen = {
    version: VERSION,
    projectId: "project",
    config: p.config,
    rules: [],
    occurrences: [],
    basis: savedBasis(p),
    denominator: 0,
    actor: {},
  };
  const run = store.start("request", frozen, "old-owner"),
    attempt = store.attempt(run.id, "old-owner", fingerprint({}), {});
  store.recover("new-owner");
  assert.throws(() => store.invoke(attempt, "old-owner"), /retired/);
  assert.equal(store.run(run.id)!.status, "cancelled");
  assert.equal(store.run(run.id)!.quiescent, true);
  assert.ok(store.start("request-2", frozen, "new-owner"));
  db.close();
});
test("cancel denies later permits; late answers cannot overwrite cancelled run", () => {
  const { db, store } = setup(),
    p = store.get("project")!;
  const run = store.start(
    "request",
    {
      version: VERSION,
      projectId: "project",
      config: p.config,
      rules: [],
      occurrences: [],
      basis: savedBasis(p),
      denominator: 0,
      actor: {},
    },
    "owner",
  );
  const attempt = store.attempt(run.id, "owner", "h", {});
  store.cancel(run.id);
  assert.throws(() => store.invoke(attempt, "owner"));
  assert.equal(
    store.append(run.id, "owner", {
      occurrenceId: "o",
      path: "one.md",
      status: "pass",
      reason: "late",
    }),
    false,
  );
  assert.equal(store.run(run.id)!.status, "cancelled");
  store.quiesce(run.id, "owner");
  assert.equal(store.run(run.id)!.quiescent, true);
  db.close();
});
test("unsupported frozen version stops visibly without reinterpretation", () => {
  const { db, store } = setup(),
    p = store.get("project")!;
  const r = store.start(
    "request",
    {
      version: "future-99",
      projectId: "project",
      config: p.config,
      rules: [],
      occurrences: [],
      basis: "h",
      denominator: 0,
      actor: {},
    },
    "old",
  );
  store.recover("new");
  assert.equal(store.run(r.id)!.status, "stopped-incompatible-version");
  assert.throws(() => store.attempt(r.id, "old", "h", {}));
  db.close();
});
