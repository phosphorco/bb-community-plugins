import { test } from "node:test";
import assert from "node:assert/strict";
import { createFiles } from "../../files/files.ts";
import { fileLocation } from "../../contracts/model.ts";
import { sha256 } from "../../contracts/hash.ts";
import { setup, memoryFiles, source, waitUntil } from "../helpers.ts";
test("loaded A cannot save to B even with identical bytes; location epoch also rejects A->B->A", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({ "one.md": source("one") }),
    f = createFiles(mem.port, store);
  const p = store.get("project")!,
    old = fileLocation(p.config);
  store.configure("project", p.revision, { ...p.config, root: "/b" });
  await assert.rejects(
    () => f.save("project", "one.md", "new", sha256(source("one")), old),
    /location changed/,
  );
  assert.equal(mem.writes(), 0);
  const b = store.get("project")!;
  store.configure("project", b.revision, { ...b.config, root: "/tests" });
  await assert.rejects(
    () => f.save("project", "one.md", "new", sha256(source("one")), old),
    /location changed/,
  );
  assert.equal(mem.writes(), 0);
  db.close();
});
test("queued save rechecks loaded location before any host write", async () => {
  const { db, store } = setup(),
    mem = memoryFiles({ "one.md": source("one") });
  const real = mem.port.write;
  let calls = 0,
    release!: () => void;
  const block = new Promise<void>((r) => (release = r));
  mem.port.write = async (a) => {
    calls++;
    if (calls === 1) await block;
    return real(a);
  };
  const f = createFiles(mem.port, store),
    p = store.get("project")!,
    loc = fileLocation(p.config),
    h = sha256(source("one"));
  const first = f.save("project", "one.md", "A", h, loc);
  await waitUntil(() => calls === 1);
  const second = f.save("project", "one.md", "B", h, loc);
  const rejected = assert.rejects(second, /location changed/);
  store.configure("project", p.revision, { ...p.config, root: "/b" });
  release();
  await first;
  await rejected;
  assert.equal(calls, 1);
  db.close();
});
test("concurrent discovery is shared and host read concurrency is bounded", async () => {
  const { db, store } = setup(),
    mem = memoryFiles(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          "f" + i + ".md",
          source("f" + i),
        ]),
      ),
    );
  let lists = 0,
    reads = 0,
    active = 0,
    max = 0;
  const list = mem.port.list,
    read = mem.port.read;
  mem.port.list = async (a) => {
    lists++;
    return list(a);
  };
  mem.port.read = async (a) => {
    reads++;
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setImmediate(r));
    try {
      return await read(a);
    } finally {
      active--;
    }
  };
  const f = createFiles(mem.port, store);
  await Promise.all([f.discover("project"), f.discover("project")]);
  assert.equal(lists, 1);
  assert.equal(reads, 20);
  assert.ok(max <= 8);
  db.close();
});
