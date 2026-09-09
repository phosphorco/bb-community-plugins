import assert from "node:assert/strict";
import { test } from "node:test";
import { createCache } from "../cache.ts";

test("coalesces clients and caches bounded settled results", async () => {
  let calls = 0;
  const cache = createCache(async key => { calls++; return key; }, 60_000, 2);
  assert.deepEqual(await Promise.all([cache.get("a"), cache.get("a")]), ["a", "a"]);
  assert.equal(calls, 1);
  await cache.get("a"); assert.equal(calls, 1);
  await cache.get("b"); await cache.get("c"); await cache.get("a");
  assert.equal(calls, 4);
});
for (const fail of [false, true]) test(`invalidation during ${fail ? "failed" : "successful"} request retries current generation`, async () => {
  let settle!: () => void;
  let calls = 0;
  const cache = createCache(async () => {
    if (++calls === 1) { await new Promise<void>((resolve, reject) => { settle = () => fail ? reject(new Error("old request")) : resolve(); }); return "old"; }
    return "new";
  });
  const request = cache.get("t");
  cache.invalidate("t"); settle();
  assert.equal(await request, "new");
  assert.equal(await cache.get("t"), "new");
  assert.equal(calls, 2);
});

test("invalidation keeps one in-flight request per key and respects the global limit", async () => {
  let settle!: () => void;
  let calls = 0;
  const cache = createCache(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { settle = resolve; });
    return calls;
  }, 60_000, 1);
  const before = cache.get("a");
  cache.invalidate("a");
  const after = cache.get("a");
  assert.equal(calls, 1);
  await assert.rejects(cache.get("b"), /Too many/);
  settle();
  assert.deepEqual(await Promise.all([before, after]), [2, 2]);
  assert.equal(calls, 2);
});
