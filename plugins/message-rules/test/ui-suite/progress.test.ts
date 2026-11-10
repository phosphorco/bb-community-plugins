import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createMessageRules } from "../../ui-suite-server.ts";
import { defaultConnection } from "../../contracts/model.ts";
import {
  memoryFiles,
  source,
  testGroup,
  jevRule,
  answer,
  count,
  waitUntil,
} from "../helpers.ts";
test("two progress subscribers do not rescan files per result; only explicit/start/end discovery reads", async () => {
  const fake = createFakePluginHost({ pluginId: "message-rules" }),
    db = new Database(":memory:");
  fake.bb.storage.database = () => db;
  const n = 8,
    mem = memoryFiles(
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => ["f" + i + ".md", source("f" + i)]),
      ),
    );
  let lists = 0,
    reads = 0;
  const list = mem.port.list,
    read = mem.port.read;
  mem.port.list = async (a) => {
    lists++;
    return list(a);
  };
  mem.port.read = async (a) => {
    reads++;
    return read(a);
  };
  for (const [name, value] of mem.values)
    mem.values.set(
      name,
      value.replace("version: 1", "version: 1\nproject_id: project"),
    );
  for (const name of ["list", "read", "write", "mkdir"] as const)
    fake.harness.inspection.sdk.stub("files." + name, mem.port[name] as never);
  const product = createMessageRules(fake.bb, {
    transportFor: () => async (w) => answer(w),
    countTokens: count,
  });
  const rpc = async (method: string, input: object) =>
    (await fake.harness.behavior.callRpc(method, {
      projectId: G,
      ...input,
    })) as any;
  let s = await rpc("configure", {
    revision: product.store.get(G)!.revision,
    hostId: "h",
    root: "/tests",
    connection: defaultConnection,
  });
  s = await rpc("saveGroup", {
    revision: s.project.revision,
    group: testGroup,
  });
  s = await rpc("saveRule", { revision: s.project.revision, rule: jevRule() });
  assert.equal(reads, n);
  const pending: Promise<unknown>[] = [];
  const unsubscribe = product.service.subscribe((projectId, discover) => {
    assert.equal(projectId, G);
    pending.push(
      product.snapshot(projectId, discover),
      product.snapshot(projectId, discover),
    );
  });
  s = await rpc("startSuite", {
    requestId: "progress",
    basis: s.basis,
    hasRelevantDrafts: false,
  });
  await waitUntil(() => !!product.store.latest(G)?.quiescent);
  await Promise.all(pending);
  assert.equal(reads, 3 * n);
  assert.equal(lists, 3);
  assert.equal(product.store.latest(G)!.results.length, n);
  const baseline = reads;
  for (let i = 0; i < 10; i++) await rpc("snapshot", { discoverFiles: false });
  assert.equal(reads, baseline);
  unsubscribe();
  await fake.harness.lifecycle.dispose();
  db.close();
});
