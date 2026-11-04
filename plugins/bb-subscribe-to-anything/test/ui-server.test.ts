import test from "node:test";
import assert from "node:assert/strict";
import Sqlite from "better-sqlite3";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import type { Record } from "../contracts.ts";
import { readList, presentRow } from "../ui-server.ts";
import { detailSchema, listInput } from "../ui-contract.ts";
import { deliveryLabel } from "../ui-model.ts";

function record(id: string, owner = "a"): Record {
  return {
    id,
    owner,
    project: "p",
    environment: null,
    mode: "until",
    request: {
      trigger: { kind: "after", seconds: 600 },
      message: `Reminder ${id}`,
      delivery: "queue",
    },
    state: "watching",
    created_at: 100,
    expires_at: null,
    next_at: 600100,
    generation: 1,
    runs: [],
    revisions: [],
    checks: 0,
    observer_turns: 0,
    repairs: 0,
    idle_anchor: 100,
    idle_fired: false,
    max_anchor: 100,
  };
}
test("pagination includes every active record; scope, history and search apply before the page limit", () => {
  const db = new Sqlite(":memory:");
  const store = new Store(db as unknown as Database);
  for (let i = 0; i < 115; i++)
    store.save(record(String(i), i % 2 ? "a" : "b"));
  store.save({ ...record("old"), state: "fulfilled" });
  const first = readList(store, listInput.parse({})),
    second = readList(store, listInput.parse({ offset: 50 })),
    third = readList(store, listInput.parse({ offset: 100 }));
  assert.equal(first.total, 115);
  assert.equal(
    new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.id))
      .size,
    115,
  );
  assert.equal(readList(store, listInput.parse({ threadId: "a" })).total, 57);
  assert.equal(
    readList(store, listInput.parse({ query: "Reminder 114" })).total,
    1,
  );
  assert.equal(readList(store, listInput.parse({ query: "%" })).total, 0);
  assert.equal(
    readList(store, listInput.parse({ view: "history" })).rows[0]?.next_at,
    null,
  );
  db.close();
});
test("invalidation only publishes on changed durable values; terminal rows do not imply another check", () => {
  const db = new Sqlite(":memory:");
  let count = 0;
  const store = new Store(db as unknown as Database, () => count++);
  const r = record("one");
  store.save(r);
  store.save(r);
  assert.equal(count, 1);
  store.save({ ...r, state: "cancelled" });
  assert.equal(count, 2);
  assert.equal(presentRow(store.get(r.id)).next_at, null);
  assert.equal(deliveryLabel("accepted"), "Accepted by BB");
  db.close();
});
test("SDK UI RPCs enforce scope and stale cancellation, and do not expose observer execution in ordinary detail", async () => {
  const host = createFakePluginHost({
    pluginId: "bb-subscribe-to-anything",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thread-test", projectId: "project-test" }),
      },
    },
  });
  plugin(host.bb);
  const accepted = await host.harness.callAgentTool("subscription_until", {
    trigger: { kind: "after", seconds: 600 },
    message: "Stretch",
  });
  assert.ok(typeof accepted !== "string");
  const { subscription_id: id } = JSON.parse(
    (accepted.content[0] as { text: string }).text,
  );
  const detail = detailSchema.parse(
    await host.harness.callRpc("subscriptionDetail", { id }),
  );
  assert.equal(detail.row.subject, "Stretch");
  assert.equal(detail.runs.length, 0);
  assert.ok(!JSON.stringify(detail).includes("observer_thread_id"));
  await assert.rejects(
    host.harness.callRpc("subscriptionDetail", { id, threadId: "other" }),
    /another thread/,
  );
  await assert.rejects(
    host.harness.callRpc("subscriptionDiagnostics", { id, threadId: "other" }),
    /another thread/,
  );
  await assert.rejects(
    host.harness.callRpc("cancelSubscription", {
      id,
      owner: detail.row.owner,
      generation: 999,
    }),
    /changed/,
  );
  const result = (await host.harness.callRpc("cancelSubscription", {
    id,
    owner: detail.row.owner,
    generation: detail.row.generation,
  })) as { state: string };
  assert.equal(result.state, "cancelled");
  assert.equal(
    detailSchema.parse(await host.harness.callRpc("subscriptionDetail", { id }))
      .row.next_at,
    null,
  );
  assert.ok(
    host.harness.realtimeSignals.some((s) =>
      JSON.stringify(s).includes("subscriptions-changed"),
    ),
  );
  await host.harness.dispose();
});
