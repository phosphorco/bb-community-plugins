import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ForkFreeSkillProjector, type ForkFreeSkillSdk } from "../extraction/fork-free-skill-projector.ts";
import { AnalyticsStore, analyticsMigrations } from "../store.ts";

test("an expired capture cannot publish after its final read, and preserves the last snapshot", async () => {
  const db = new Database(":memory:");
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const sdk = {
    skills: { list: async () => ({ skills: [] }), listFiles: async () => assert.fail("no listed skills"), getContent: async () => assert.fail("no listed skills") },
    threads: { list: async () => [], get: async () => assert.fail("no listed threads"), events: { list: async () => assert.fail("no listed threads") } },
  } as unknown as ForkFreeSkillSdk;
  const capture = () => db.prepare("SELECT capture_id FROM analytics_fork_free_catalog_captures_v1").all();
  try {
    await new ForkFreeSkillProjector(sdk, store, () => 1000).refresh("project-a", null);
    const before = capture();
    assert.equal(before.length, 1);
    let checks = 0;
    const late = new ForkFreeSkillProjector(sdk, store, () => 2000, () => {
      if (++checks === 2) throw new Error("capture expired before publication");
    });
    await assert.rejects(late.refresh("project-a", null), /expired before publication/);
    assert.deepEqual(capture(), before);
    assert.equal(checks, 2);
  } finally { db.close(); }
});
