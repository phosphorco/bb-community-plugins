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
test("suite expected rejection passes, disabled exclusion and immutable revisions; no messaging port exists", async () => {
  const { db, store } = setup();
  store.saveRule("project", store.get("project")!.revision, jevRule());
  const f = createFiles(
    memoryFiles({ "one.md": source("one"), "disabled.md": "bad" }).port,
    store,
  );
  let p = await f.discover("project");
  store.toggle(
    "project",
    p.revision,
    p.occurrences.find((x) => x.path === "disabled.md")!.occurrenceId,
    false,
  );
  let calls = 0;
  const service = createSuiteService(
    store,
    () => async (w) => {
      calls++;
      return answer(w);
    },
    count,
  );
  p = store.get("project")!;
  const run = service.start("project", "request", savedBasis(p), {});
  await waitUntil(() => !!store.run(run.id)?.quiescent);
  assert.equal(store.run(run.id)!.frozen.denominator, 1);
  assert.equal(store.run(run.id)!.results[0]!.status, "pass");
  assert.equal(calls, 1);
  assert.ok(!("send" in service));
  await service.dispose();
  db.close();
});
test("zero-enabled is neutral; changed saved basis rejects before model call", async () => {
  const { db, store } = setup();
  let calls = 0;
  const service = createSuiteService(
    store,
    () => async () => {
      calls++;
      throw Error("not allowed");
    },
    count,
  );
  assert.throws(
    () => service.start("project", "wrong", "stale", {}),
    /changed/,
  );
  const p = store.get("project")!,
    r = service.start("project", "zero", savedBasis(p), {});
  await waitUntil(() => !!store.run(r.id)?.quiescent);
  assert.equal(store.run(r.id)!.frozen.denominator, 0);
  assert.equal(store.run(r.id)!.results.length, 0);
  assert.equal(calls, 0);
  await service.dispose();
  db.close();
});
test("disabled invalid file does not run, enabled invalid files are error results", async () => {
  const { db, store } = setup(),
    f = createFiles(
      memoryFiles({ "one.md": "bad", "two.md": "bad" }).port,
      store,
    );
  let p = await f.discover("project");
  store.toggle("project", p.revision, p.occurrences[0]!.occurrenceId, false);
  const service = createSuiteService(
    store,
    () => async () => {
      throw Error("no inference");
    },
    count,
  );
  p = store.get("project")!;
  const r = service.start("project", "errors", savedBasis(p), {});
  await waitUntil(() => !!store.run(r.id)?.quiescent);
  assert.equal(store.run(r.id)!.results.length, 1);
  assert.equal(store.run(r.id)!.results[0]!.status, "error");
  await service.dispose();
  db.close();
});
