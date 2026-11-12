import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../../state/store.ts";
import { createMessageRules } from "../../ui-suite-server.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { defaultConnection, newGroup, newRule } from "../../contracts/model.ts";
import { admissionContract } from "../../admission-rpc-contract.ts";
import { contract, snapshotSchema } from "../../suite-rpc-contract.ts";
import { memoryFiles, waitUntil } from "../helpers.ts";
const bytes = (id: string) =>
  `---\nversion: 1\nid: ${id}\nexpect: reject\nexpected_rules: [both]\n---\n# Message\nhello\n\n# Expected advice\nShared advice\n`;
test("authoring RPC discovery publishes real schemas while preserving validation and internal registration policy", async () => {
  const fake = createFakePluginHost({ pluginId: "message-rules" });
  const db = new Database(":memory:");
  fake.bb.storage.database = () => db;
  createMessageRules(fake.bb);
  const published = fake.harness.inspection.registrations.experimental_publishedRpcMethods;
  assert.deepEqual(published.map((m) => m.method).sort(), [...Object.keys(contract),...Object.keys(admissionContract)].sort());
  const save = published.find((m) => m.method === "saveRule")!;
  assert.match(save.methodDescription!, /current catalog revision/);
  assert.ok(save.inputSchema.properties);
  assert.match(JSON.stringify(save.inputSchema), /groupId/);
  assert.match(JSON.stringify(save.inputSchema), /criteria/);
  const snapshot = await fake.harness.behavior.callRpc("snapshot", { projectId: G, discoverFiles: false }) as any;
  const before = snapshot.project.revision;
  await assert.rejects(() => fake.harness.behavior.callRpc("saveRule", {
    projectId: G, revision: before, rule: { id: "incomplete" },
  }));
  const after = await fake.harness.behavior.callRpc("snapshot", { projectId: G, discoverFiles: false }) as any;
  assert.equal(after.project.revision, before);
  assert.deepEqual(after.project.rules, []);
  assert.ok(Object.values(fake.harness.inspection.registrations.hooks).every((h) => h === null));
  await fake.harness.lifecycle.dispose();
  db.close();
});
test("public global RPC: per-source discovery/recovery, group-owned save, contextual identity, one frozen run, no send or inference", async () => {
  const fake = createFakePluginHost({ pluginId: "message-rules" }),
    db = new Database(":memory:"),
    seed = createStore(db);
  for (const id of ["a", "b"])
    seed.configure(id, null, {
      hostId: "h",
      root: "/" + id,
      connection: defaultConnection,
    });
  const a = memoryFiles({ "a.md": bytes("a") }),
    b = memoryFiles({ "b.md": bytes("b") });
  let reads = 0,
    offline = false;
  fake.bb.storage.database = () => db;
  fake.harness.inspection.sdk.stub("files.list", (async (i: any) => {
    if (offline && i.path === "/b") throw Error("source b offline");
    const files = i.path === "/a" ? a : b;
    const list = await files.port.list(i);
    return {
      ...list,
      files: list.files.map((f) => ({ ...f, path: i.path + "/" + f.name })),
    };
  }) as never);
  for (const name of ["read", "write", "mkdir"] as const)
    fake.harness.inspection.sdk.stub("files." + name, (async (i: any) => {
      if (name === "read") reads++;
      return (i.path.startsWith("/a/") ? a : b).port[name](i as never);
    }) as never);
  let inference = 0;
  const product = createMessageRules(fake.bb, {
    transportFor: () => async () => {
      inference++;
      throw Error("No model call");
    },
  });
  const rpc = async (method: string, i: object = {}) =>
    snapshotSchema.parse(
      await fake.harness.behavior.callRpc(method, { projectId: G, ...i }),
    );
  let s = await rpc("snapshot");
  assert.equal(s.project!.occurrences.length, 2);
  assert.equal(s.catalog!.sources.length, 2);
  s = await rpc("saveGroup", {
    revision: s.project!.revision,
    group: {
      ...newGroup("any"),
      enabled: true,
      match: { kind: "all", children: [] },
    },
  });
  s = await rpc("saveRule", {
    revision: s.project!.revision,
    rule: {
      ...newRule("both", "any"),
      enabled: true,
      action: "reject",
      advice: "Shared advice",
      match: { kind: "all", children: [] },
    },
  });
  const original = s.project!.occurrences[0]!;
  await assert.rejects(
    () =>
      rpc("saveGroup", {
        projectId: "a",
        revision: 1,
        group: newGroup("legacy-write"),
      }),
    /legacy project catalogs are read-only/,
  );
  s = await rpc("assignTest", {
    revision: s.project!.revision,
    occurrenceId: original.occurrenceId,
    groupId: "any",
  });
  assert.equal(
    s.project!.occurrences.find(
      (o) => o.occurrenceId === original.occurrenceId,
    )!.groupId,
    "any",
  );
  assert.equal(product.store.get("a")!.occurrences[0]!.source, original.source);
  s = await rpc("saveFile", {
    occurrenceId: original.occurrenceId,
    path: original.path,
    source: original.source,
    hash: original.hash,
    location: original.location,
  });
  assert.equal(a.writes(), 1);
  const baseline = reads;
  for (let i = 0; i < 3; i++) await rpc("snapshot", { discoverFiles: false });
  assert.equal(reads, baseline, "progress reads do not scan fixtures");
  offline = true;
  s = await rpc("snapshot");
  assert.match(s.readError!, /source b offline/);
  assert.equal(s.project!.occurrences.length, 2);
  await assert.rejects(
    () =>
      rpc("startSuite", {
        requestId: "offline",
        basis: s.basis,
        hasRelevantDrafts: false,
      }),
    /source b offline/,
  );
  s = await rpc("snapshot", { discoverFiles: false });
  assert.match(s.readError!, /offline/);
  offline = false;
  s = await rpc("snapshot");
  assert.equal(s.readError, null);
  const basis = s.basis;
  s = await rpc("startSuite", {
    requestId: "global",
    basis,
    hasRelevantDrafts: false,
  });
  const runId = s.run!.id;
  await waitUntil(() => !!product.store.run(runId)?.quiescent);
  s = await rpc("snapshot", { discoverFiles: false });
  assert.equal(s.run!.frozen.denominator, 2);
  assert.deepEqual(
    s.run!.results.map((r) => r.status),
    ["pass", "pass"],
  );
  assert.deepEqual(
    s.run!.frozen.occurrences.map((o) => o.projectId),
    ["a", "b"],
  );
  offline = true; // Lost acknowledgement must reconcile the existing immutable run even if discovery is now unavailable.
  const same = await rpc("startSuite", {
    requestId: "global",
    basis,
    hasRelevantDrafts: false,
  });
  assert.equal(same.run!.id, runId);
  assert.equal(inference, 0);
  assert.ok(
    !fake.harness.inspection.sdk.calls.some((c) =>
      c.path.startsWith("threads."),
    ),
  );
  await fake.harness.lifecycle.dispose();
  db.close();
});
