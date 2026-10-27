import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  canonicalizeResource,
  projectionPayloadDigest,
  type Resource,
} from "../canonical.ts";
import { runCrossReferencesConformance } from "@phosphorco/bb-cross-references/testing";
import { rpcContract } from "../rpc-contract.ts";
import crossReferencesPlugin from "../server.ts";

const source: Resource = {
  provider: "test",
  keys: { source: "server" },
  presentation: { label: "Server source", url: "/plugins/test" },
};
const target: Resource = {
  provider: "bb",
  keys: { project: "proj_server01", thread: "thr_server01" },
  presentation: { label: "Server target" },
};
const externalTarget: Resource = {
  provider: "url",
  keys: { href: "https://example.test/forward" },
  presentation: { label: "External target", url: "https://example.test/forward" },
};

const input = {
  protocolVersion: 1 as const,
  producerPluginId: "machine-monitor",
  mutationId: "00000000-0000-4000-8000-000000000011",
  source,
  revision: 1,
  expectedRevision: 0,
  tombstone: false,
  targets: [target, externalTarget],
  payloadDigest: projectionPayloadDigest(
    "machine-monitor",
    canonicalizeResource(source),
    false,
    [canonicalizeResource(target), canonicalizeResource(externalTarget)],
  ),
};

test("registers the typed RPCs, verifies FK-backed storage, and publishes committed invalidation", async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (url, init) => {
    fetchCalls += 1;
    assert.equal(url, "https://example.test/forward");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const signals: Array<{ channel: string; payload: unknown }> = [];
  let handlers: Record<string, (input: any) => unknown> | null = null;
  const events = new Map<string, (event: any) => void>();
  const services: string[] = [];
  const bb = {
    sdk:{subscribe:()=>()=>{}},onDispose:()=>{},
    events: { on: (name: string, handler: (event: any) => void) => events.set(name, handler) },
    background: { service: (name: string) => services.push(name) },
    storage: {
      database: () => db,
      migrate: (_database: Database.Database, migrations: string[]) => migrations.forEach((migration) => db.exec(migration)),
    },
    rpc: {
      register: (_contract: unknown, registeredHandlers: Record<string, (input: any) => unknown>) => { handlers = registeredHandlers; },
    },
    realtime: {
      publish: (channel: string, payload: unknown) => signals.push({ channel, payload }),
    },
  } as any;
  crossReferencesPlugin(bb);
  assert.deepEqual(services, ["cross-references-assistant-links"]);
  assert.deepEqual([...events.keys()], ["thread.idle", "thread.failed", "thread.deleted"]);
  events.get("thread.idle")!({ thread: { projectId: "proj_event", id: "thr_event" } });
  events.get("thread.deleted")!({ thread: { projectId: "proj_event", id: "thr_event" } });
  assert.equal((db.prepare("SELECT deleted FROM assistant_link_jobs WHERE thread_id = ?").get("thr_event") as { deleted: number }).deleted, 1);

  const parsed = await rpcContract.applyProjection.input["~standard"].validate(input);
  assert.equal("issues" in parsed, false);

  assert.deepEqual(Object.keys(handlers ?? {}), ["crossReferences.describe", "applyProjection", "getProjection", "listBacklinks", "listForwardReferences", "checkForwardReferences"]);
  assert.equal((await handlers!.applyProjection(input) as { outcome: string }).outcome, "applied");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.channel, "cross-references-changed");
  const signal = signals[0]?.payload as { affectedIdentityDigests: string[]; revision: number };
  assert.equal(signal.revision, 1);
  assert.equal(signal.affectedIdentityDigests.length, 3);

  const projection = await handlers!.getProjection({
    producerPluginId: "machine-monitor",
    source: { provider: source.provider, keys: source.keys },
  }) as { projection: { targets: Resource[] } | null };
  assert.equal(projection.projection?.targets[0]?.presentation.label, "Server target");
  const backlinks = await handlers!.listBacklinks({ target: { provider: target.provider, keys: target.keys }, pageSize: 1 }) as { rows: unknown[]; total: number; nextCursor: string | null };
  assert.equal(backlinks.rows.length, 1);
  assert.equal(backlinks.total, 1);
  assert.equal(backlinks.nextCursor, null);

  const forward = await handlers!.listForwardReferences({ source: { provider: source.provider, keys: source.keys }, pageSize: 1 }) as { rows: Array<{ target: Resource }>; total: number; nextCursor: string | null };
  assert.equal(forward.rows.length, 1);
  assert.equal(forward.total, 2);
  assert.equal(forward.rows[0]?.target.presentation.label, "Server target");
  assert.notEqual(forward.nextCursor, null);

  const statuses = await handlers!.checkForwardReferences({
    source: { provider: source.provider, keys: source.keys },
  }) as Array<{ url: string; status: number | null; label: string }>;
  assert.deepEqual(statuses, [{ url: "https://example.test/forward", status: 204, label: "Available" }]);
  assert.equal(fetchCalls, 1);

  assert.throws(
    () => handlers!.applyProjection({ ...input, targets: Array.from({ length: 257 }, () => target) }),
    /targets/i,
  );

  const conformance = await runCrossReferencesConformance({
    sdk: { plugins: { callRpc: async ({ method, input, outputSchema }: any) => {
      const methodContract = (rpcContract as any)[method];
      if (!methodContract || !handlers?.[method]) throw Object.assign(new Error("Unknown method"), { code: "unknown_method" });
      const parsedInput = await methodContract.input["~standard"].validate(input);
      if ("issues" in parsedInput) throw new Error("Invalid input");
      const result = await handlers[method]!(parsedInput.value);
      const parsedOutput = await methodContract.output["~standard"].validate(result);
      if ("issues" in parsedOutput) throw new Error("Invalid output");
      return outputSchema.parse(parsedOutput.value);
    } } } as any,
    command: input,
  });
  assert.equal(conformance.level, "source-conformance");
  assert.ok(conformance.checks.includes("backlinks-acceptance"));

});

// The runtime's staged discard closes databases and invalidates the API without
// starting services or running dispose hooks. Normal disposal aborts services,
// waits for them, runs hooks LIFO, then closes databases. Keep those seams distinct.
function lifecycleFixture(t: any) {
  const db = new Database(":memory:");
  t.after(() => { if (db.open) db.close(); });
  let invalidated = false, sdkReads = 0, unsubscribes = 0;
  const hooks: Array<() => void> = [];
  const services: Array<{ start(signal: AbortSignal): Promise<void> }> = [];
  const subscriptions = new Set<any>(), captured: any[] = [];
  const events = new Map<string, (event: any) => void>();
  const warnings: string[] = [], published: unknown[] = [];
  let handlers: any;
  const sdk: any = {
    subscribe(args: any) {
      subscriptions.add(args); captured.push(args);
      return () => { if (subscriptions.delete(args)) unsubscribes++; };
    },
    plugins: { list: async () => ({ plugins: [] }) },
  };
  const bb: any = {
    storage: { database: () => db, migrate: (_: unknown, sql: string[]) => sql.forEach(s => db.exec(s)) },
    events: { on: (name: string, handler: (event: any) => void) => events.set(name, handler) },
    background: { service: (_: string, service: any) => services.push(service) },
    onDispose: (hook: () => void) => hooks.push(hook),
    rpc: { register: (_: unknown, registered: any) => { handlers = registered; } },
    realtime: { publish: (_: string, signal: unknown) => published.push(signal) },
    log: { warn: (message: string) => warnings.push(message) },
    get sdk() { assert.equal(invalidated, false, "stale runtime API handle"); sdkReads++; return sdk; },
  };
  crossReferencesPlugin(bb);
  const queuedCallbacks = () => {
    for (let n = 0; n < 3; n++) for (const {event, callback} of captured) {
      callback(event === "system:changed" ? {changes: ["plugins-changed"]} : {reconnected: true});
    }
    for (const handler of events.values()) handler({thread: {projectId: "proj_event", id: "thr_event"}});
  };
  return {db, sdk, hooks, services, subscriptions, captured, events, warnings, published,
    handlers: () => handlers, queuedCallbacks, sdkReads: () => sdkReads, unsubscribes: () => unsubscribes,
    close: () => { db.close(); invalidated = true; }};
}

test("actual factory discarded before service start creates no SDK subscriptions and stale thread callbacks cannot reach closed SQLite", async t => {
  const f = lifecycleFixture(t);
  assert.equal(f.services.length, 1);
  assert.equal(f.sdkReads(), 0);
  assert.equal(f.subscriptions.size, 0);
  // No dispose hooks: this is candidate rollback, not ordinary plugin disposal.
  f.close();
  assert.doesNotThrow(f.queuedCallbacks);
  await f.services[0]!.start(new AbortController().signal);
  assert.equal(f.sdkReads(), 0);
  assert.equal(f.subscriptions.size, 0);
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.published, []);
});

test("active service owns plugin/reconnect subscriptions; abort removes them before hooks/close and queued callbacks are inert", {timeout: 2000}, async t => {
  const f = lifecycleFixture(t);
  let entered!: () => void;
  const listing = new Promise<void>(resolve => { entered = resolve; });
  f.sdk.plugins.list = () => { entered(); return new Promise(() => {}); };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = f.services[0]!.start(controller.signal);
  await listing;
  assert.equal(f.subscriptions.size, 2);
  const nativeSource = {provider: "bb", keys: {project: "proj_event", thread: "thr_event"}, presentation: {label: "Seed"}};
  const seed = {...input, producerPluginId: "cross-references", source: nativeSource, targets: [],
    payloadDigest: projectionPayloadDigest("cross-references", canonicalizeResource(nativeSource), false, [])};
  f.handlers().applyProjection(seed);
  const plugin = f.captured.find(s => s.event === "system:changed");
  const reconnect = f.captured.find(s => s.event === "realtime:connection");
  plugin.callback({changes: ["unrelated"]});
  reconnect.callback({reconnected: false});
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM assistant_link_jobs").get() as any).n, 0);
  plugin.callback({changes: ["plugins-changed"]});
  assert.equal((f.db.prepare("SELECT version FROM assistant_link_jobs").get() as any).version, 1);
  reconnect.callback({reconnected: true});
  assert.equal((f.db.prepare("SELECT version FROM assistant_link_jobs").get() as any).version, 1, "reconciliation preserves pending source generation");
  for (const event of ["thread.idle", "thread.failed", "thread.deleted"]) {
    f.events.get(event)!({thread: {projectId: "proj_event", id: "thr_event"}});
  }
  assert.equal((f.db.prepare("SELECT deleted FROM assistant_link_jobs").get() as any).deleted, 1);
  controller.abort();
  assert.equal(f.subscriptions.size, 0, "abort unregisters synchronously, before any stop wait");
  await running;
  const jobs = f.db.prepare("SELECT * FROM assistant_link_jobs").all();
  for (const s of f.captured) s.callback(s.event === "system:changed" ? {changes: ["plugins-changed"]} : {reconnected: true});
  assert.deepEqual(f.db.prepare("SELECT * FROM assistant_link_jobs").all(), jobs, "exited-run callbacks cannot invalidate later work");
  for (const hook of [...f.hooks].reverse()) hook();
  f.close();
  assert.doesNotThrow(f.queuedCallbacks);
  await f.services[0]!.start(new AbortController().signal); // Disposed collector cannot restart.
  assert.equal(f.subscriptions.size, 0);
  assert.equal(f.unsubscribes(), 2);
  assert.deepEqual(f.warnings, []);
});

test("service subscription setup failure cleans earlier registration and fences captured callbacks", async t => {
  const f = lifecycleFixture(t);
  const subscribe = f.sdk.subscribe;
  f.sdk.subscribe = (args: any) => {
    if (args.event === "realtime:connection") throw new Error("subscription unavailable");
    return subscribe(args);
  };
  await assert.rejects(f.services[0]!.start(new AbortController().signal), /subscription unavailable/);
  assert.equal(f.subscriptions.size, 0);
  f.close();
  assert.doesNotThrow(f.queuedCallbacks);
  assert.equal(f.unsubscribes(), 1);
});

test("pre-aborted service never subscribes; synchronous abort during setup leaves no registration behind", async t => {
  const f = lifecycleFixture(t);
  const controller = new AbortController();controller.abort();
  await f.services[0]!.start(controller.signal);
  assert.equal(f.sdkReads(), 0);
  const next = new AbortController();
  const subscribe = f.sdk.subscribe;
  f.sdk.subscribe = (args: any) => { const off = subscribe(args); next.abort(); return off; };
  await f.services[0]!.start(next.signal);
  assert.equal(f.subscriptions.size, 0);
  assert.equal(f.captured.length, 1);
  assert.equal(f.unsubscribes(), 1);
  f.close();
  assert.doesNotThrow(f.queuedCallbacks);
});

test("factory admits settled/deleted event rank1 and forward demand rank2 without priority promotion changing backoff or generation", t => {
  const f = lifecycleFixture(t);
  for (const [event, thread] of [["thread.idle", "thr_idle"], ["thread.failed", "thr_failed"], ["thread.deleted", "thr_deleted"]]) {
    f.events.get(event)!({thread: {projectId: "proj_event", id: thread}});
    const row = f.db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id=?").get(thread) as any;
    assert.equal(row.priority, 1);assert.equal(row.deleted, event === "thread.deleted" ? 1 : 0);
  }
  f.db.prepare("UPDATE assistant_link_jobs SET retry_at=900000, attempts=3 WHERE thread_id='thr_idle'").run();
  const before = f.db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_idle'").get() as any;
  f.handlers().listForwardReferences({source: {provider: "bb", keys: {project: "proj_event", thread: "thr_idle"}}});
  assert.deepEqual(f.db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_idle'").get(), {...before, priority: 2});
  // A genuine new thread event still advances the source generation. Its rank
  // cannot downgrade an already viewed pending job.
  f.events.get("thread.idle")!({thread: {projectId: "proj_event", id: "thr_idle"}});
  const next = f.db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_idle'").get() as any;
  assert.equal(next.version, before.version+1);assert.equal(next.priority, 2);
  assert.equal(next.retry_at, 0);assert.equal(next.attempts, 0);
});
