import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPercent, activitySpans, IDLE_DISPLAY_CAP } from "../activity.ts";
import { turnSpans, type TimingRow } from "../timing.ts";

test("turns merge into active spans; idle gaps remain", () => {
  const result = activitySpans([{ from: 0, to: 100 }, { from: 90, to: 150 }, { from: 500, to: 600 }], 1000)!;
  assert.deepEqual(result.spans.map(({ from, to }) => ({ from, to })), [{ from: 0, to: 150 }, { from: 500, to: 600 }]);
  assert.equal(result.activeMs, 250);
  assert.equal(result.end, 1000);
  assert.equal(result.running, false);
  assert.equal(activityPercent(result), "25%");
});

test("an open turn runs until now and is marked running", () => {
  const result = activitySpans([{ from: 200, to: null }], 500)!;
  assert.deepEqual(result.spans, [{ from: 200, to: 500, running: true }]);
  assert.equal(result.running, true);
});

test("long idle gaps are compressed for display but not for the percentage", () => {
  const day = 86_400_000;
  const result = activitySpans([{ from: 0, to: 60_000 }, { from: day, to: day + 60_000 }], day + 60_000)!;
  assert.equal(result.breaks.length, 1);
  const shown = 120_000 + IDLE_DISPLAY_CAP;
  assert.ok(Math.abs(result.layout[1]!.left - (60_000 + IDLE_DISPLAY_CAP) / shown) < 1e-9);
  assert.equal(activityPercent(result), "<1%");
});

test("clock skew never draws past the end", () => {
  const result = activitySpans([{ from: 0, to: 2000 }], 1000)!;
  assert.equal(result.end, 2000);
  assert.ok(result.layout[0]!.left + result.layout[0]!.width <= 1);
});

test("no turns yields no strip", () => assert.equal(activitySpans([], 10), null));

const row = (id: string, turnId: string, seq: number, at: number, over: Partial<TimingRow> = {}): TimingRow => ({
  id, threadId: "t", kind: "conversation", role: "assistant", turnId, sourceSeqStart: seq, sourceSeqEnd: seq, createdAt: at, ...over });

test("turn spans include failed, empty, steered, and automation turns", () => {
  const rows = [
    row("u1", "a", 1, 100, { role: "user", initiator: "user" }),
    row("s1", "a", 2, 150, { role: "user", initiator: "user", turnRequest: { kind: "steer", status: "accepted" }, sentAt: null }),
    row("x", "b", 5, 300, { initiator: "automation" }),
    row("q", "c", 8, 400, { role: "user", turnRequest: { kind: "message", status: "pending" } }),
  ];
  const completions = [{ turnId: "a", seq: 3, at: 200, status: "failed" }];
  assert.deepEqual(turnSpans("t", rows, completions, false), [{ from: 100, to: 200 }, { from: 300, to: 300 }]);
  assert.deepEqual(turnSpans("t", rows, completions, true), [{ from: 100, to: 200 }, { from: 300, to: null }]);
});
