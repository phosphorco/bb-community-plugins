import assert from "node:assert/strict";
import test from "node:test";

import { deliverAnnotationInput } from "../lib/delivery.ts";

const input = [{ type: "text" as const, text: "feedback", mentions: [] }];

function deliveryHarness() {
  const calls: Array<{ method: "send" | "queue"; args: unknown }> = [];
  return {
    calls,
    threads: {
      async send(args: unknown) {
        calls.push({ method: "send", args });
      },
      queuedMessages: {
        async create(args: unknown) {
          calls.push({ method: "queue", args });
        },
      },
    },
  };
}

test("send delivery submits the annotation immediately", async () => {
  const harness = deliveryHarness();
  await deliverAnnotationInput(harness.threads, "thr_1", input, "send");

  assert.deepEqual(harness.calls, [
    {
      method: "send",
      args: { threadId: "thr_1", mode: "auto", input },
    },
  ]);
});

test("queue delivery creates a queued message without steering", async () => {
  const harness = deliveryHarness();
  await deliverAnnotationInput(harness.threads, "thr_1", input, "queue");

  assert.deepEqual(harness.calls, [
    {
      method: "queue",
      args: { threadId: "thr_1", input },
    },
  ]);
});
