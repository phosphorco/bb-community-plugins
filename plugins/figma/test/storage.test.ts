import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateJsonStore } from "../storage.ts";

test("private connection survives reopening, has restrictive permissions, and can be disconnected", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-figma-storage-"));
  try {
    const directory = join(root, "credentials");
    const store = privateJsonStore(directory, "oauth");
    assert.equal(await store.read(), null);
    await store.write({ access_token: "test-only", pending: { state: "fixture-state" } });
    assert.deepEqual(await privateJsonStore(directory, "oauth").read(), { access_token: "test-only", pending: { state: "fixture-state" } });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "oauth.json"))).mode & 0o777, 0o600);
    await store.write(null);
    assert.equal(await store.read(), null);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("queued writes capture input and reads wait for the last committed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-figma-storage-"));
  try {
    const store = privateJsonStore(root, "settings");
    const value = { token: "first" };
    const first = store.write(value);
    value.token = "mutated";
    await first;
    assert.deepEqual(await store.read(), { token: "first" });
    const writes = Array.from({ length: 20 }, (_, revision) => store.write({ revision }));
    const result = store.read();
    await Promise.all(writes);
    assert.deepEqual(await result, { revision: 19 });
    assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), { revision: 19 });
    assert.deepEqual(await readdir(root), ["settings.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corruption never leaks saved bytes and failure does not poison subsequent writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-figma-storage-"));
  try {
    const store = privateJsonStore(root, "oauth");
    await writeFile(join(root, "oauth.json"), "fixture-secret-broken-json");
    await assert.rejects(store.read(), error => {
      assert.equal((error as Error).message, "Saved Figma connection is invalid. Reconnect in settings.");
      return true;
    });
    await store.write({ recovered: true });
    assert.deepEqual(await store.read(), { recovered: true });
    assert.throws(() => privateJsonStore(root, "../escape"), /Invalid credential store name/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
