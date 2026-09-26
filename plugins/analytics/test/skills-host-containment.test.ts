import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import analyticsPlugin from "../server.ts";
import { analyticsMigrations } from "../store.ts";

test("production server cannot reconnect legacy source capture", () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /bb\.sdk\b|BbPluginApi\["sdk"\]|bb\.events\.on\s*\(/);
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*(?:extraction\/|legacy-capture|test\/)/);
  assert.doesNotMatch(source, /AnalyticsRefreshCoordinator|runRefresh|listRecentThreadEvents|new\s+ForkFreeSkillProjector/);
});

test("production registration and cold Skills queries perform no source capture", async () => {
  const db = new Database(":memory:");
  const events: string[] = [];
  let dispose = () => {};
  let rpc: Record<string, (input: any) => any> = {};
  const routes = new Map<string, (input: any) => any>();
  let cli: { run: (argv: string[], context: any) => any };
  let sdkCalls = 0;
  let skillCalls = 0;
  const forbidden = () => { sdkCalls++; throw new Error("Source access from a retained query"); };
  const forbiddenSkills = () => { skillCalls++; return forbidden(); };
  try {
    analyticsPlugin({
      storage: { database: () => db, migrate: () => { for (const migration of analyticsMigrations) db.exec(migration); } },
      events: { on: (event: string) => events.push(event) },
      rpc: { register: (_contract: unknown, handlers: typeof rpc) => { rpc = handlers; } },
      sdk: { skills: { list: forbiddenSkills, listFiles: forbiddenSkills, getContent: forbiddenSkills }, threads: { list: forbidden, get: forbidden, events: { list: forbidden } } },
      http: { route: (_method: string, path: string, handler: (input: any) => any) => routes.set(path, handler) }, ui: { registerMentionProvider() {} }, cli: { register: (definition: typeof cli) => { cli = definition; } },
      agents: { registerTool() {}, configure() {} }, realtime: { publish() {} },
      onDispose: (callback: () => void) => { dispose = callback; },
      log: { info() {}, warn() {}, error() {} },
    } as unknown as BbPluginApi);
    assert.deepEqual(events, [], "Analytics has no feature-owned lifecycle capture");
    const input = { startMs: Date.now() - 7 * 86_400_000, endMs: Date.now() };
    for (let i = 0; i < 20; i++) {
      const result = rpc.skillsQuery!(input);
      assert.equal(result instanceof Promise, false, "a cold query returns retained coverage immediately");
      assert.equal(result.coverage.exactCatalogSnapshot, false);
      assert.match(result.coverage.snapshotExplanation, /not live data/);
    }
    assert.throws(() => rpc.skillsRawContributors!({ filters: input, ids: ["missing-retained-contributor"] }), /outside its exact filtered result/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sdkCalls, 0, "no detached extraction begins after the handler returns");
    const catalog = rpc.catalog!(null);
    for (const bundle of catalog.bundles) await rpc.getBundle!({ bundleId: bundle.id });
    const response = await routes.get("/facts.ndjson")!({ req: { url: "http://localhost/facts.ndjson?rangeDays=7" } });
    assert.equal(response.status, 200);
    assert.throws(() => rpc.requestRefresh!(null), { code: "isolation-unavailable" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sdkCalls, 0, "catalog, bundles, exports and refresh RPCs cannot initiate source work");
    assert.equal(skillCalls, 0, "tool refresh cannot start a Skills scan");
    const denied = await rpc.refreshSkills!({ projectId: "project-a", environmentId: null });
    assert.equal(denied.status, "failed", "Skills refresh RPC fails closed without a qualified collector");
    for (const command of [["refresh"], ["refresh-skills", "project-a", "none"]]) {
      const result = await cli!.run(command, {});
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /isolation-unavailable/);
    }
    assert.equal(sdkCalls, 0);
  } finally { dispose(); db.close(); }
});
