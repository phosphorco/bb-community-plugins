import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, label, projectTiming, sentAt, type TimingRow } from "../timing.ts";
import { attachRequestTimes } from "../request-times.ts";

const row = (id: string, seq: number, at: number, role = "user", turnId = "turn1"): TimingRow => ({
  id, sourceSeqStart: seq, sourceSeqEnd: seq, createdAt: at, threadId: "t", turnId,
  kind: "conversation", role, initiator: "user",
});
test("historical turnaround and wait freeze at the next human message", () => {
  const stamps = projectTiming("t", [row("u", 1, 0), row("a", 3, 120_000, "assistant"), row("u2", 5, 600_000)],
    [{ turnId: "turn1", seq: 4, at: 180_000, status: "completed" }]);
  assert.equal(stamps[1]?.previousUserAt, 0);
  assert.equal(stamps[1]?.nextUserAt, 600_000);
  assert.match(label(stamps[1]!, 3_000_000), /3m from your message · 7m until next message$/);
  assert.match(label(stamps[2]!, 660_000), /10m since previous message · 7m after agent finished · 1m since sent$/);
});
test("steering resets the origin; system prompts and child threads do not", () => {
  const rows = [row("u", 1, 0), { ...row("system", 2, 10_000), initiator: "system" },
    { ...row("child", 3, 20_000), threadId: "child" }, row("steer", 4, 60_000), row("a", 5, 100_000, "assistant")];
  const stamps = projectTiming("t", rows, [{ turnId: "turn1", seq: 6, at: 120_000, status: "completed" }]);
  assert.deepEqual(stamps.map(s => s.rowId), ["u", "steer", "a"]);
  assert.match(label(stamps[2]!, 180_000), /1m from your message · 1m since finish · 2m since your message$/);
});
test("summary segments are not treated as terminal completions", () => {
  const folded = { ...row("summary", 2, 1), kind: "turn", children: [row("steer", 3, 60_000)] };
  const stamps = projectTiming("t", [row("u", 1, 0), folded, row("a", 5, 80_000, "assistant")],
    [{ turnId: "turn1", seq: 6, at: 120_000, status: "interrupted" }]);
  assert.deepEqual(stamps.map(s => s.rowId), ["u", "steer", "a"]);
  assert.match(label(stamps[2]!, 120_000), /^Stopped /);
});
test("incomplete history and clock regressions never invent or negate intervals", () => {
  const stamps = projectTiming("t", [row("a", 5, 100, "assistant")], [{ turnId: "turn1", seq: 6, at: 200, status: "failed" }]);
  assert.equal(stamps[0]?.previousUserAt, null);
  assert.equal(duration(200, 100), null);
  assert.equal(duration(0, NaN), null);
  assert.match(label(stamps[0]!, 100), /^Failed /);
  assert.doesNotMatch(label(stamps[0]!, 100), /since|from your/);
});
test("same-turn final assistant row wins over earlier commentary and duplicates", () => {
  const a = row("a", 3, 60_000, "assistant");
  const stamps = projectTiming("t", [row("u", 1, 0), row("commentary", 2, 5_000, "assistant"), a, a],
    [{ turnId: "turn1", seq: 4, at: 120_000, status: "completed" }]);
  assert.deepEqual(stamps.map(s => s.rowId), ["u", "a"]);
});
test("relative calendar formatting survives spring DST", () => {
  const prior = process.env.TZ;
  process.env.TZ = "America/New_York";
  try { assert.match(sentAt(new Date("2026-03-08T12:00:00-04:00").getTime(), new Date("2026-03-09T10:00:00-04:00").getTime()), /^Yesterday /); }
  finally { if (prior == null) delete process.env.TZ; else process.env.TZ = prior; }
});

test("accepted steering joins send time by request identity instead of acceptance time", () => {
  const steer: TimingRow = { ...row("steer", 8, 180_000), turnRequest: { kind: "steer", status: "accepted" } };
  const rows = [row("u", 1, 0), steer, row("a", 9, 200_000, "assistant")];
  attachRequestTimes(rows, [
    { seq: 3, createdAt: 60_000, type: "client/turn/requested", data: { requestId: "r" } },
    { seq: 8, createdAt: 180_000, type: "turn/input/accepted", data: { clientRequestId: "r" } },
  ]);
  const stamps = projectTiming("t", rows, [{ turnId: "turn1", seq: 10, at: 240_000, status: "completed" }]);
  assert.equal(stamps.find(s => s.rowId === "steer")?.at, 60_000);
  assert.match(label(stamps.find(s => s.kind === "finish")!, 240_000), /3m from your message/);
});

for (const status of ["rejected", "pending"] as const) test(`${status} steering is displayed but cannot become a completion origin`, () => {
  const steer: TimingRow = { ...row("steer", 8, 180_000), turnRequest: { kind: "steer", status } };
  const stamps = projectTiming("t", [row("u", 1, 0), steer, row("a", 9, 200_000, "assistant")],
    [{ turnId: "turn1", seq: 10, at: 240_000, status: "completed" }]);
  assert.equal(stamps.find(s => s.kind === "finish")?.previousUserAt, 0);
  assert.match(label(stamps.find(s => s.rowId === "steer")!, 240_000), new RegExp(status));
});

test("missing original request keeps accepted-steer send intervals unknown", () => {
  const steer: TimingRow = { ...row("steer", 8, 180_000), turnRequest: { kind: "steer", status: "accepted" } };
  attachRequestTimes([steer], []);
  const stamps = projectTiming("t", [steer, row("a", 9, 200_000, "assistant")],
    [{ turnId: "turn1", seq: 10, at: 240_000, status: "completed" }]);
  assert.equal(stamps[0]?.at, null);
  assert.equal(stamps[1]?.previousUserAt, null);
  assert.match(label(stamps[0]!, 240_000), /Send time unavailable/);
  assert.doesNotMatch(label(stamps[1]!, 240_000), /from your message/);
});

test("completions without rendered rows still define the next human wait", () => {
  const stamps = projectTiming("t", [row("u", 1, 0), row("a", 2, 60_000, "assistant"), row("u2", 7, 420_000)], [
    { turnId: "turn1", seq: 3, at: 120_000, status: "completed" },
    { turnId: "no-visible-row", seq: 6, at: 360_000, status: "completed" },
  ]);
  assert.equal(stamps.find(s => s.rowId === "u2")?.previousFinishAt, 360_000);
  assert.match(label(stamps.find(s => s.rowId === "u2")!, 420_000), /1m after agent finished/);
});

test("another turn's accepted message does not reset this turn's origin", () => {
  const stamps = projectTiming("t", [row("u", 1, 0), row("other", 2, 60_000, "user", "turn2"), row("a", 3, 100_000, "assistant")],
    [{ turnId: "turn1", seq: 4, at: 120_000, status: "completed" }]);
  assert.equal(stamps.find(s => s.kind === "finish")?.previousUserAt, 0);
});
