import { test } from "node:test";
import assert from "node:assert/strict";
import { captureProduction } from "../../evaluation/capture.ts";
import { prepare, evaluate } from "../../evaluation/evaluator.ts";
import { parseFixture } from "../../contracts/fixture.ts";
import { defaultConnection } from "../../contracts/model.ts";
import { count, answer, jevRule } from "../helpers.ts";
test("parity begins at public history/metadata and authored fixture capture, not identical frozen objects", async () => {
  const r = jevRule();
  r.criteria[0]!.context.senderHistory = 1;
  r.criteria[0]!.context.destinationHistory = 1;
  const captured = await captureProduction(
    "Hello",
    "sender",
    "destination",
    [r],
    {
      async title(id) {
        return id === "sender" ? "Sender" : "Destination";
      },
      async history(id) {
        return {
          events: [
            {
              id: "fixture-1",
              text: id === "sender" ? "Sender context" : "Destination context",
              sequence: 1,
            },
          ],
          complete: true,
          through: 1,
        };
      },
    },
  );
  const fixture = parseFixture(
    "---\nversion: 1\nid: parity\nsender_title: Sender\ndestination_title: Destination\nexpect: reject\n---\n# Message\nHello\n\n# Sender context\nSender context\n\n# Destination context\nDestination context\n",
  );
  const fixtureCapture = {
    ...fixture.capture,
    provenance: captured.provenance,
  };
  assert.deepEqual(
    prepare(captured, [r], defaultConnection, count),
    prepare(fixtureCapture, [r], defaultConnection, count),
  );
  const signal = new AbortController().signal;
  assert.deepEqual(
    await evaluate(
      captured,
      [r],
      defaultConnection,
      async (w) => answer(w),
      signal,
      count,
    ),
    await evaluate(
      fixtureCapture,
      [r],
      defaultConnection,
      async (w) => answer(w),
      signal,
      count,
    ),
  );
});
test("public capture read failure is unavailable; empty successful history is separately confirmed", async () => {
  const r = jevRule();
  r.criteria[0]!.context.senderHistory = 2;
  r.criteria[0]!.context.destinationHistory = 1;
  const c = await captureProduction("Hello", "s", "d", [r], {
    async title() {
      throw Error("offline");
    },
    async history(id) {
      if (id === "s") throw Error("offline");
      return { events: [], complete: true, through: 3 };
    },
  });
  assert.equal(c.senderTitle, null);
  assert.equal(c.sender.coverage, "unavailable");
  assert.equal(c.destination.coverage, "empty-confirmed");
});
