import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_LIMITS, CaptureAdmissionLane, CaptureBudget } from "../extraction/capture-budget.ts";
import { RetainedQueryCache } from "../retained-query-cache.ts";

test("all callers share one slot without queued work, including after cancellation", async () => {
  let now = 0;
  const lane = new CaptureAdmissionLane(() => now);
  let finish!: () => void;
  let calls = 0;
  const budget = new CaptureBudget();
  const active = lane.run(() => budget.read(async () => {
    calls++;
    await new Promise<void>((resolve) => { finish = resolve; });
    return [];
  }));
  try {
    budget.controller.abort(new Error("cancelled"));
    for (let i = 0; i < 1000; i++) {
      assert.equal((await lane.run(async () => { calls++; })).status, "busy");
    }
    assert.equal(calls, 1, "cancellation cannot admit replacements while the underlying call is alive");
    finish();
    await assert.rejects(active, /cancelled/);
    assert.equal((await lane.run(async () => { calls++; })).status, "cooldown");
    now += CAPTURE_LIMITS.minimumIntervalMs;
    assert.equal((await lane.run(async () => { calls++; })).status, "completed");
    assert.equal(calls, 2);
  } finally { budget.dispose(); }
});

test("the request limit counts the full capture, not each page or partition", async () => {
  const budget = new CaptureBudget();
  let calls = 0;
  try {
    for (let i = 0; i < CAPTURE_LIMITS.requests; i++) await budget.read(async () => { calls++; return []; });
    await assert.rejects(budget.read(async () => { calls++; return []; }), /request budget/);
    assert.equal(calls, CAPTURE_LIMITS.requests);
  } finally { budget.dispose(); }
});

test("deadline aborts the SDK signal and refuses late results and subsequent reads", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = new CaptureBudget();
  let finish!: () => void;
  let observed: AbortSignal | undefined;
  const read = budget.read(async (signal) => {
    observed = signal;
    await new Promise<void>((resolve) => { finish = resolve; });
    return "late data";
  });
  try {
    context.mock.timers.tick(CAPTURE_LIMITS.elapsedMs);
    assert.equal(observed?.aborted, true);
    finish();
    await assert.rejects(read, /deadline/);
    await assert.rejects(budget.read(async () => assert.fail("deadline must prevent new source work")), /deadline/);
  } finally { budget.dispose(); }
});

test("response bytes are cumulative and dispose prevents follow-on reads", async () => {
  const budget = new CaptureBudget();
  try {
    const page = "x".repeat(CAPTURE_LIMITS.responseBytes / 2);
    await budget.read(async () => page);
    await assert.rejects(budget.read(async () => page), /response budget/);
  } finally { budget.dispose(); }
  await assert.rejects(budget.read(async () => assert.fail("must not call SDK after dispose")), /budget|ended/);
});

test("retained cache separates parameters and generations and protects cached objects", () => {
  const cache = new RetainedQueryCache<{ count: number }>();
  let loads = 0;
  const load = () => ({ count: ++loads });
  const first = cache.read("1", { project: "a" }, load);
  first.count = 999;
  assert.equal(cache.read("1", { project: "a" }, load).count, 1);
  assert.equal(cache.read("1", { project: "b" }, load).count, 2);
  assert.equal(cache.read("2", { project: "a" }, load).count, 3);
  assert.equal(loads, 3);
});

test("retained cache evicts at entry and byte limits instead of growing with queries", () => {
  const cache = new RetainedQueryCache<string>();
  let loads = 0;
  for (let i = 0; i < 25; i++) cache.read("1", i, () => { loads++; return "value"; });
  cache.read("1", 0, () => { loads++; return "value"; });
  assert.equal(loads, 26);
  const big = "x".repeat(900_000);
  for (let i = 0; i < 5; i++) cache.read("2", i, () => big);
  let evicted = false;
  cache.read("2", 0, () => { evicted = true; return big; });
  assert.equal(evicted, true);
  let oversized = 0;
  for (let i = 0; i < 2; i++) cache.read("3", 0, () => { oversized++; return "x".repeat(1024 * 1024); });
  assert.equal(oversized, 2, "an oversized entry cannot bypass the per-entry limit");
});
