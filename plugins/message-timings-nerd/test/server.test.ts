import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { Stamp } from "../timing.ts";

test("RPC respects the event-page ceiling and exposes incomplete coverage", async () => {
  let pages = 0;
  const { bb, harness } = createFakePluginHost({ sdk: { threads: {
    timeline: () => {
      pages++;
      return { rows: [], maxSeq: 5000, timelinePage: { hasOlderRows: true, olderCursor: { anchorSeq: 5000 - pages, anchorId: `anchor${pages}` } } };
    },
    events: { list: ({ types, beforeSeq, limit }) => {
      assert.equal(beforeSeq, "5001"); assert.equal(limit, "100");
      if (types?.[0] !== "turn/completed") return [];
      return Array.from({ length: 100 }, (_, i) => ({ type: "turn/completed", scope: { kind: "turn", turnId: `turn${i}` }, seq: i + 1, createdAt: i, data: { status: "completed" } }));
    } },
  } } });
  plugin(bb);
  const result = await harness.callRpc("timings", { threadId: "t" }) as { truncated: boolean; stamps: Stamp[]; coveredIds: string[] };
  assert.equal(pages, 12); assert.equal(result.truncated, true); assert.deepEqual(result.stamps, []);
  assert.deepEqual(result.coveredIds, []);
});

test("an in-turn page boundary never invents an origin or consume a newer completion", async () => {
  let pages = 0;
  const { bb, harness } = createFakePluginHost({ sdk: { threads: {
    timeline: () => {
      pages++;
      return { rows: [{ id: "answer", threadId: "t", turnId: "turn", kind: "conversation", role: "assistant", sourceSeqStart: 10, sourceSeqEnd: 11, createdAt: 100 }],
        maxSeq: pages === 1 ? 12 : 20, timelinePage: { hasOlderRows: pages < 2, olderCursor: { anchorSeq: 9, anchorId: "older" } } };
    },
    events: { list: ({ types, beforeSeq }) => {
      assert.equal(beforeSeq, "13", "completion reads stay at the first page's snapshot");
      return types?.[0] === "turn/completed" ? [{ type: "turn/completed", scope: { kind: "turn", turnId: "turn" }, seq: 12, createdAt: 200, data: { status: "completed" } }] : [];
    } },
  } } });
  plugin(bb);
  const result = await harness.callRpc("timings", { threadId: "t" }) as { stamps: Stamp[] };
  assert.equal(result.stamps.length, 1);
  assert.equal(result.stamps[0]?.previousUserAt, null);
  assert.equal(result.stamps[0]?.at, 200);
});

test("RPC rejects malformed input without reading thread history", async () => {
  const { bb, harness } = createFakePluginHost();
  plugin(bb);
  await assert.rejects(harness.callRpc("timings", { threadId: "t", extra: true }));
  assert.equal(harness.sdk.calls.length, 0);
});


test("unchanged history needs only a head probe after invalidation", async () => {
  let pages = 0; let eventReads = 0;
  const { bb, harness } = createFakePluginHost({ sdk: { threads: {
    timeline: () => { pages++; return { rows: [], maxSeq: 5000,
      timelinePage: { hasOlderRows: true, olderCursor: { anchorSeq: 5000 - pages, anchorId: `a${pages}` } } }; },
    events: { list: () => { eventReads++; return []; } },
  } } });
  plugin(bb);
  const before = await harness.callRpc("timings", { threadId: "t" });
  assert.equal(pages, 12); assert.equal(eventReads, 2);
  await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t" }), lastAssistantText: null });
  const after = await harness.callRpc("timings", { threadId: "t" });
  assert.deepEqual(after, before);
  assert.equal(pages, 13); assert.equal(eventReads, 2);
});
