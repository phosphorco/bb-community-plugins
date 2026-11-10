import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createMessageRules } from "../../ui-suite-server.ts";
import { snapshotSchema } from "../../suite-rpc-contract.ts";
import { defaultConnection } from "../../contracts/model.ts";
import {
  testGroup,
  memoryFiles,
  source,
  jevRule,
  count,
  answer,
  waitUntil,
} from "../helpers.ts";
test("actual factory -> public RPC -> identity -> files/state/suite composition; no queue/send calls", async () => {
  const fake = createFakePluginHost({ pluginId: "message-rules" }),
    db = new Database(":memory:");
  fake.bb.storage.database = () => db;
  const mem = memoryFiles({ "one.md": source("one") });
  for (const name of ["list", "read", "write", "mkdir"] as const)
    fake.harness.inspection.sdk.stub("files." + name, mem.port[name] as never);
  const product = createMessageRules(fake.bb, {
    transportFor: () => async (w) => answer(w),
    countTokens: count,
  });
  const rpc = async (method: string, input: object) =>
    snapshotSchema.parse(
      await fake.harness.behavior.callRpc(method, {
        projectId: "project",
        ...input,
      }),
    );
  let s = await rpc("configure", {
    revision: null,
    hostId: "host-proof",
    root: "/tests",
    connection: defaultConnection,
  });
  s = await rpc("saveGroup", {
    revision: s.project!.revision,
    group: testGroup,
  });
  s = await rpc("saveRule", { revision: s.project!.revision, rule: jevRule() });
  await assert.rejects(
    () =>
      rpc("startSuite", {
        requestId: "draft",
        basis: s.basis,
        hasRelevantDrafts: true,
      }),
    /Save or discard/,
  );
  s = await rpc("startSuite", {
    requestId: "run",
    basis: s.basis,
    hasRelevantDrafts: false,
  });
  await waitUntil(() => !!product.store.latest("project")?.quiescent);
  s = await rpc("snapshot", {});
  assert.equal(s.run!.results[0]!.status, "pass");
  assert.equal(s.run!.frozen.denominator, 1);
  assert.ok(s.run!.frozen.actor);
  assert.equal(
    fake.harness.inspection.sdk.calls.filter((x) =>
      x.path.startsWith("threads."),
    ).length,
    0,
  );
  const list = mem.port.list;
  fake.harness.inspection.sdk.stub("files.list", (() => {
    throw Error("offline");
  }) as never);
  s = await rpc("snapshot", {});
  assert.match(s.readError!, /offline/);
  assert.equal(s.project!.occurrences.length, 1);
  s = await rpc("snapshot", { discoverFiles: false });
  assert.match(
    s.readError!,
    /offline/,
    "progress-only reads cannot clear a file discovery failure",
  );
  fake.harness.inspection.sdk.stub("files.list", list as never);
  s = await rpc("snapshot", { discoverFiles: false });
  assert.match(s.readError!, /offline/);
  s = await rpc("snapshot", {});
  assert.equal(s.readError, null);
  assert.equal(s.project!.occurrences.length, 1);
  await fake.harness.lifecycle.dispose();
  await assert.rejects(() => rpc("snapshot", {}));
  db.close();
});

test("configured factory's real HTTP boundary dispatches an explicit scoped Test without tokenizer", async () => {
  const fake = createFakePluginHost({
    pluginId: "message-rules",
    settings: { apiKey: "message-rules-own-test-key" },
  });
  const db = new Database(":memory:");
  fake.bb.storage.database = () => db;
  const mem = memoryFiles({
    "inside.md": source("inside").replace(
      "sender_title: null",
      "destination_id: canary-thread\nsender_title: null",
    ),
    "outside.md": source("outside").replace(
      "sender_title: null",
      "destination_id: other-thread\nsender_title: null",
    ),
  });
  for (const name of ["list", "read", "write", "mkdir"] as const)
    fake.harness.inspection.sdk.stub("files." + name, mem.port[name] as never);
  let calls = 0;
  const product = createMessageRules(fake.bb, {
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(
        (init!.headers as any).Authorization,
        "Bearer message-rules-own-test-key",
      );
      assert.equal(
        (db.prepare("SELECT state FROM mr_attempts").get() as any).state,
        "invocation-owned",
      );
      return new Response(
        JSON.stringify(answer(JSON.parse(init!.body as string))),
      );
    },
  });
  const rpc = async (method: string, input: object) =>
    snapshotSchema.parse(
      await fake.harness.behavior.callRpc(method, {
        projectId: "project",
        ...input,
      }),
    );
  let s = await rpc("configure", {
    revision: null,
    hostId: "host-proof",
    root: "/tests",
    connection: defaultConnection,
  });
  s = await rpc("saveGroup", {
    revision: s.project!.revision,
    group: {
      ...testGroup,
      match: {
        kind: "all",
        children: [
          testGroup.match,
          {
            kind: "condition",
            field: "destination_thread_id",
            operator: "equals",
            value: "canary-thread",
            insensitive: false,
          },
        ],
      },
    },
  });
  s = await rpc("saveRule", { revision: s.project!.revision, rule: jevRule() });
  s = await rpc("startSuite", {
    requestId: "configured-no-tokenizer",
    basis: s.basis,
    hasRelevantDrafts: false,
  });
  await waitUntil(() => !!product.store.latest("project")?.quiescent);
  s = await rpc("snapshot", {});
  assert.equal(calls, 1);
  assert.equal(s.connection.tokenAccounting, false);
  assert.equal(s.connection.mode, "live");
  assert.equal(
    s.run!.results.find((r) => r.path === "inside.md")!.status,
    "pass",
  );
  assert.equal(
    s.run!.results.find((r) => r.path === "outside.md")!.evaluation!.groups![0]!
      .status,
    "outside-scope",
  );
  assert.equal(
    s.run!.results.find((r) => r.path === "outside.md")!.evaluation!.advice
      .length,
    0,
  );
  assert.equal(
    fake.harness.inspection.sdk.calls.some((c) =>
      c.path.startsWith("threads."),
    ),
    false,
  );
  await fake.harness.lifecycle.dispose();
  db.close();
});
