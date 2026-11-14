import { fileLocation } from "../../contracts/model.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFiles } from "../../files/files.ts";
import { setup, memoryFiles, source } from "../helpers.ts";
test("enabled invalid/missing/duplicate occurrences retain denominator and disabled choices", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({ "one.md": source("one") });
  const f = createFiles(mem.port, store);
  let p = await f.discover("project");
  const id = p.occurrences[0]!.occurrenceId;
  mem.values.set("one.md", "invalid yaml");
  p = await f.discover("project");
  assert.equal(p.occurrences[0]!.occurrenceId, id);
  assert.ok(p.occurrences[0]!.error);
  assert.equal(p.occurrences.filter((o) => o.enabled).length, 1);
  mem.values.delete("one.md");
  p = await f.discover("project");
  assert.ok(p.occurrences[0]!.missing);
  assert.equal(p.occurrences.filter((o) => o.enabled).length, 1);
  store.toggle("project", p.revision, id, false);
  mem.values.set("one.md", source("same"));
  mem.values.set("two.md", source("same"));
  p = await f.discover("project");
  assert.equal(p.occurrences.length, 2);
  assert.ok(p.occurrences.every((o) => o.error?.includes("Duplicate")));
  assert.equal(p.occurrences[0]!.enabled, false);
  assert.equal(p.occurrences[1]!.enabled, true);
  db.close();
});
test("unambiguous rename preserves identity and ambiguous rename retains tombstone", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({ "one.md": source("one") });
  const f = createFiles(mem.port, store);
  let p = await f.discover("project");
  const id = p.occurrences[0]!.occurrenceId;
  mem.values.delete("one.md");
  mem.values.set("renamed.md", source("one"));
  p = await f.discover("project");
  assert.equal(p.occurrences.length, 1);
  assert.equal(p.occurrences[0]!.occurrenceId, id);
  mem.values.delete("renamed.md");
  mem.values.set("a.md", source("different"));
  mem.values.set("b.md", source("different"));
  p = await f.discover("project");
  assert.equal(p.occurrences.filter((o) => o.enabled).length, 3);
  assert.ok(p.occurrences.some((o) => o.missing));
  db.close();
});
test("serialized concurrent guarded saves: one wins, one conflicts; drafts remain caller-owned", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({ "one.md": source("one") });
  const f = createFiles(mem.port, store),
    p = await f.discover("project");
  const h = p.occurrences[0]!.hash!;
  const results = await Promise.allSettled([
    f.save(
      "project",
      "one.md",
      "new A",
      h,
      fileLocation(store.get("project")!.config),
    ),
    f.save(
      "project",
      "one.md",
      "new B",
      h,
      fileLocation(store.get("project")!.config),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(mem.values.get("one.md"), "new A");
  assert.equal(mem.writes(), 1);
  db.close();
});
test("lost save response reconciles identical bytes; unsafe names never reach host", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({});
  const real = mem.port.write;
  mem.port.write = async (a) => {
    await real(a);
    throw Error("response lost");
  };
  const f = createFiles(mem.port, store);
  assert.equal(
    (
      await f.save(
        "project",
        "one.md",
        "exact",
        null,
        fileLocation(store.get("project")!.config),
      )
    ).state,
    "confirmed",
  );
  for (const name of ["../outside.md", "folder/test.md", "a.txt"])
    await assert.rejects(() =>
      f.save(
        "project",
        name,
        "bad",
        null,
        fileLocation(store.get("project")!.config),
      ),
    );
  assert.equal(mem.writes(), 1);
  db.close();
});
test("partial listing fails without deleting authoritative members", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({ "one.md": source("one") });
  const f = createFiles(mem.port, store);
  await f.discover("project");
  mem.port.list = async () => ({ files: [], truncated: true });
  await assert.rejects(() => f.discover("project"), /incomplete/);
  assert.equal(store.get("project")!.occurrences.length, 1);
  db.close();
});
