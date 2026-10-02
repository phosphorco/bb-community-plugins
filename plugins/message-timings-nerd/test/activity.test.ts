import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPercent, activitySpans, gapDisplayWidth, IDLE_CAP, segmentLabel } from "../activity.ts";
import { turnSpans, type TimingRow } from "../timing.ts";

const active = (result: NonNullable<ReturnType<typeof activitySpans>>) =>
  result.segments.filter(segment => segment.kind === "active").map(({ from, to }) => ({ from, to }));

test("turns merge into active segments; idle segments fill the gaps", () => {
  const result = activitySpans([{ from: 0, to: 100 }, { from: 90, to: 150 }, { from: 500, to: 600 }], 1000)!;
  assert.deepEqual(active(result), [{ from: 0, to: 150 }, { from: 500, to: 600 }]);
  assert.deepEqual(result.segments.map(segment => segment.kind), ["active", "idle", "active", "idle"]);
  assert.equal(result.activeMs, 250);
  assert.equal(result.running, false);
  assert.equal(activityPercent(result), "25%");
  const last = result.segments[result.segments.length - 1]!;
  assert.ok(Math.abs(last.left + last.width - 1) < 1e-9);
});

test("an open turn runs until now and is marked running", () => {
  const result = activitySpans([{ from: 200, to: null }], 500)!;
  assert.deepEqual(result.segments, [{ kind: "active", from: 200, to: 500, running: true, left: 0, width: 1 }]);
  assert.equal(result.running, true);
});

test("idle over an hour counts as one hour and draws log-compressed", () => {
  const hour = 3_600_000;
  const result = activitySpans([{ from: 0, to: hour }, { from: 13 * hour, to: 14 * hour }], 14 * hour)!;
  assert.deepEqual(result.segments.map(segment => segment.kind), ["active", "gap", "active"]);
  assert.equal(result.hiddenIdleMs, 11 * hour);
  assert.equal(activityPercent(result), "67%");
  const shown = 2 * hour + gapDisplayWidth(12 * hour);
  assert.ok(Math.abs(result.segments[1]!.width - gapDisplayWidth(12 * hour) / shown) < 1e-9);
  assert.match(segmentLabel(result.segments[1]!, 14 * hour).detail, /counted as 1h/);
});

test("longer idle stays proportionally longer, never below the one-hour floor", () => {
  const hour = 3_600_000;
  assert.equal(gapDisplayWidth(30 * 60_000), 30 * 60_000);
  assert.equal(gapDisplayWidth(hour), hour);
  assert.ok(gapDisplayWidth(2 * hour) > hour);
  assert.ok(gapDisplayWidth(12 * hour) > 2 * gapDisplayWidth(2 * hour) / 1.2);
  assert.ok(gapDisplayWidth(72 * hour) > gapDisplayWidth(12 * hour));
});

test("clock skew never draws past the end", () => {
  const result = activitySpans([{ from: 0, to: 2000 }], 1000)!;
  assert.equal(result.end, 2000);
  assert.deepEqual(result.segments.map(({ left, width }) => ({ left, width })), [{ left: 0, width: 1 }]);
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
