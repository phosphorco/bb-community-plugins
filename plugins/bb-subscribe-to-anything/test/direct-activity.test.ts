import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { Store } from "../store.ts";

test("idle reads public request events directly even if a removed capability getter throws", async () => {
  let reads = 0;
  const host = createFakePluginHost({ pluginId: "bb-subscribe-to-anything", sdk: { threads: {
    get: async () => makeThreadResponse({ id: "owner", projectId: "project" }),
    events: { list: async () => { reads++; return []; } },
  } } });
  Object.defineProperty(host.bb, "experimental_messageAdmission", { get() { throw Error("retired capability accessed"); } });
  plugin(host.bb);
  const response = await host.harness.callAgentTool("subscription_changes", { trigger: { kind: "idle", thread: "owner", seconds: 3600 }, message: "idle" }, { threadId: "owner", projectId: "project" });
  assert.ok(typeof response !== "string" && !response.isError);
  const id = JSON.parse((response.content[0] as { text: string }).text).subscription_id;
  const store = new Store(host.bb.storage.database());
  const row = store.get(id); row.next_at = Date.now() - 1; store.save(row);
  const service = host.harness.runService("subscription-supervisor");
  try {
    const deadline = performance.now() + 3000;
    while (!reads && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(reads > 0, "public event path must run independently of removed capability");
    const tables = host.bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.ok(!JSON.stringify(tables).includes("subscription_admission_activity"));
  } finally { service.controller.abort(); await service.done; await host.harness.dispose(); }
});

test("subscription manifest has no retired admission dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["@phosphorco/bb-message-admission"], undefined);
});

test("paged retries preserve idle anchor across supervisor restarts", async () => {
  type Event = Awaited<ReturnType<import("@get-bb/plugin-sdk").BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
  type Request = Extract<Event, { type: "client/turn/requested" }>;
  const events: Request[] = [], afters: number[] = [];
  const host = createFakePluginHost({ pluginId: "bb-subscribe-to-anything", sdk: { threads: {
    get: async () => makeThreadResponse({ id: "owner", projectId: "project" }),
    events: { list: async ({ afterSeq, limit }) => {
      afters.push(Number(afterSeq)); return events.filter(e => e.seq > Number(afterSeq)).slice(0, Number(limit));
    } },
  } } });
  plugin(host.bb);
  const response = await host.harness.callAgentTool("subscription_changes", { trigger: { kind: "idle", thread: "owner", seconds: 3600 }, message: "idle" }, { threadId: "owner", projectId: "project" });
  assert.ok(typeof response !== "string" && !response.isError);
  const id = JSON.parse((response.content[0] as { text: string }).text).subscription_id;
  let store = new Store(host.bb.storage.database());
  const anchor = store.get(id).idle_anchor;
  const request = (seq: number, patch: Partial<Request["data"]> = {}): Request => ({
    id: `event_${seq}`, threadId: "owner", seq, createdAt: anchor + seq,
    scope: { kind: "thread" }, type: "client/turn/requested",
    data: { direction: "outbound", requestId: `req_${seq}`, initiator: "user", senderThreadId: null, source: "tell",
      input: [{ type: "text", text: "visible", mentions: [] }], target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: { model: "test", serviceTier: "default", reasoningLevel: "medium", permissionMode: "auto", source: "client/turn/requested" }, ...patch },
  });
  for (let seq = 1; seq <= 205; seq++) events.push(request(seq, seq % 2 ? { retryOfRequestId: "original" } : { initiator: "system" }));
  const drain = async (seq: number) => {
    const row = store.get(id); row.next_at = Date.now() - 1; store.save(row);
    const service = host.harness.runService("subscription-supervisor");
    try {
      const deadline = performance.now() + 5000;
      while ((store.get(id).activity_seq ?? 0) < seq && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(store.get(id).activity_seq, seq);
    } finally { service.controller.abort(); await service.done; }
  };
  try {
    await drain(100); assert.equal(store.get(id).idle_anchor, anchor);
    store = new Store(host.bb.storage.database());
    await drain(200); await drain(205); assert.equal(store.get(id).idle_anchor, anchor);
    events.push(request(206, { input: [{ type: "text", text: "private", mentions: [], visibility: "agent-only" }] }));
    events.push(request(207, { senderThreadId: "agent" }));
    events.push(request(208, { systemMessageKind: "unlabeled" }));
    await drain(208); assert.equal(store.get(id).idle_anchor, anchor);
    events.push(request(209)); await drain(209); assert.equal(store.get(id).idle_anchor, anchor + 209);
    events.push(request(210, { retryOfRequestId: "req_209", initiator: "system" }));
    await drain(210); assert.equal(store.get(id).idle_anchor, anchor + 209);
    assert.ok(afters.includes(100) && afters.includes(200));
  } finally { await host.harness.dispose(); }
});
