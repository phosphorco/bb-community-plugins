import test from "node:test";
import assert from "node:assert/strict";
import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptedActivityReader } from "../accepted-activity.ts";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import { Engine } from "../engine.ts";
import type { AcceptedActivityV1 } from "@phosphorco/bb-message-admission/protocol";

// Scripted public native read ports; consumer persistence is real SQLite.
// This does not prove native acceptance transactions or process restart.
function nativeFixture() {
  const items: AcceptedActivityV1[] = [], reads: number[] = [];
  let failed = false;
  const inert = () => { throw new Error("No native writes permitted"); };
  const native = {
    describe: () => ({ protocol: "bb-message-admission", versions: [1], capabilities: { admission: true, publication: true, operations: true, activity: true, originalManifest: false, placement: false, feedback: false, limits: { requestBytes: 1_000_000, responseBytes: 1_000_000, snapshotBytes: 1_000_000, evidenceBytes: 1_000_000, manifestBytes: 1_000_000, evaluationMs: 1000, concurrentEvaluations: 1 } } }),
    registerEvaluator: inert, unregisterEvaluator: inert, publish: inert, readActivePublication: inert, lookupOperation: inert, recheckOperation: inert,
    readThreadActivity: () => {
      if (failed) throw new Error("native unavailable");
      const last = items.filter(item => item.source.visibleHumanActivity).at(-1);
      return { version: 1, threadId: "owner", messageAcceptanceSequence: items.length, lastVisibleHumanAcceptedAt: last?.acceptedAt ?? null, lastVisibleHumanOriginal: last?.original ?? null };
    },
    listAcceptedActivity: ({ afterSequence, limit }: { afterSequence: number; limit: number }) => {
      reads.push(afterSequence);
      const page = items.filter(item => item.acceptanceSequence > afterSequence).slice(0, limit);
      const throughSequence = page.at(-1)?.acceptanceSequence ?? afterSequence;
      return { version: 1, threadId: "owner", afterSequence, throughSequence, latestSequence: items.length, complete: throughSequence === items.length, items: page };
    },
  };
  return { bb: { experimental_messageAdmission: native }, reads,
    fail(value: boolean) { failed = value; },
    accept(at: number, human = true) {
      items.push({ acceptanceSequence: items.length + 1, original: { originalId: `o-${items.length}`, revision: 1 }, acceptedAt: new Date(at).toISOString(), source: { senderThreadId: human ? null : "agent", initiator: human ? "user" : "agent", author: null, editor: null, origin: null, externalOperation: null, visibleHumanActivity: human } });
    },
  };
}

test("busy acceptance resets idle before drain; cancel, lost signal, reopen and retry keep original clock", async () => {
  const root = mkdtempSync(join(tmpdir(), "accepted-idle-"));
  let db = new Sqlite(join(root, "state.db"));
  const n = nativeFixture();
  let now = 100_000, sends = 0;
  try {
    let store = new Store(db as unknown as Database);
    let read = createAcceptedActivityReader(n.bb, store.db);
    const makeEngine = () => new Engine(store, {
      now: () => now,
      owner: async r => { const state = await read(r.id, r.owner, at => engine.activity(r.owner, at)); return state === "available" ? "available" : "offline"; },
      launch: async () => { throw new Error("No observer"); }, wake: async () => {}, stop: async () => {},
      send: async () => { sends++; return { delivery: "queued" }; },
      run: async () => { throw new Error("No collector"); }, classify: async () => { throw new Error("No inference"); },
    });
    let engine = makeEngine();
    const receipt = engine.create("owner", "project", null, "changes", { trigger: { kind: "idle", thread: "owner", seconds: 30, repeat: "per_idle_episode" }, message: "idle" });
    const id = receipt.subscription_id;
    n.accept(120_000); now = 130_000; // Busy queue; no callback delivered.
    await engine.tick(new AbortController().signal);
    assert.equal(sends, 0); assert.equal(store.get(id).idle_anchor, 120_000);
    assert.equal(store.get(id).activity_seq, undefined); // Separate cursor domain.
    n.accept(140_000); now = 151_000; // Queue cancelled, acceptance retained.
    store.dispose(); db.close();
    db = new Sqlite(join(root, "state.db")); store = new Store(db as unknown as Database);
    read = createAcceptedActivityReader(n.bb, store.db); engine = makeEngine(); engine.recover();
    await engine.tick(new AbortController().signal);
    assert.equal(sends, 0); assert.equal(store.get(id).idle_anchor, 140_000);
    assert.deepEqual(n.reads, [0, 1]);
    n.accept(160_000, false); now = 171_000; // Delivery/retry: no new human fact.
    await engine.tick(new AbortController().signal);
    assert.equal(sends, 1); assert.equal(store.get(id).idle_anchor, 140_000);
    assert.equal((db.prepare("SELECT sequence FROM subscription_admission_activity WHERE subscription_id = ?").get(id) as {sequence: number}).sequence, 3);
  } finally { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bounded catchup holds notification; native outage never falls back to request heuristics", async () => {
  const db = new Sqlite(":memory:"), n = nativeFixture();
  try {
    for (let i = 1; i <= 101; i++) n.accept(i * 1000);
    const read = createAcceptedActivityReader(n.bb, db as unknown as Database);
    let anchor = 0;
    assert.equal(await read("sub", "owner", at => { anchor = Math.max(anchor, at); }), "offline");
    assert.equal(anchor, 101_000);
    assert.equal(await read("sub", "owner", at => { anchor = Math.max(anchor, at); }), "available");
    assert.deepEqual(n.reads, [0, 100]);
    n.fail(true); await assert.rejects(read("sub", "owner", () => {}), /read-failed/);
    assert.equal(await createAcceptedActivityReader({}, db as unknown as Database)("old", "owner", () => {}), "legacy");
    assert.equal(await createAcceptedActivityReader({ experimental_messageAdmission: {} }, db as unknown as Database)("bad", "owner", () => {}), "offline");
  } finally { db.close(); }
});

test("actual server idle owner check consumes queue acceptance without a delivery event or hub signal", async () => {
  const { createFakePluginHost, makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  const { default: plugin } = await import("../server.ts");
  const n = nativeFixture();
  let sends = 0;
  const host = createFakePluginHost({ pluginId: "bb-subscribe-to-anything", sdk: { threads: {
    get: async () => makeThreadResponse({ id: "owner", projectId: "project" }),
    send: async () => { sends++; throw new Error("No notification should be sent"); },
    events: { list: async () => { throw new Error("Capable host must not use delivery-event heuristics"); } },
  } } });
  Object.defineProperty(host.bb, "experimental_messageAdmission", { value: n.bb.experimental_messageAdmission });
  plugin(host.bb);
  const store = new Store(host.bb.storage.database());
  const response = await host.harness.callAgentTool("subscription_changes", { trigger: { kind: "idle", thread: "owner", seconds: 30 }, message: "idle" }, { threadId: "owner", projectId: "project" });
  assert.ok(typeof response !== "string" && !response.isError);
  const id = JSON.parse((response.content[0] as {text: string}).text).subscription_id;
  const row = store.get(id); row.idle_anchor = Date.now() - 60_000; row.next_at = Date.now() - 1; store.save(row);
  const accepted = Date.now(); n.accept(accepted);
  const service = host.harness.runService("subscription-supervisor");
  try {
    const deadline = performance.now() + 3000;
    while (store.get(id).idle_anchor < accepted && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.get(id).idle_anchor, accepted); assert.equal(sends, 0);
  } finally { service.controller.abort(); await service.done; await host.harness.dispose(); }
});

test("a failed initial capability read recovers on the next existing idle check", async () => {
  const db = new Sqlite(":memory:"), n = nativeFixture();
  const describe = n.bb.experimental_messageAdmission.describe;
  let offline = true;
  n.bb.experimental_messageAdmission.describe = () => { if (offline) throw new Error("temporarily unavailable"); return describe(); };
  try {
    const read = createAcceptedActivityReader(n.bb, db as unknown as Database);
    assert.equal(await read("sub", "owner", () => {}), "offline");
    offline = false;
    assert.equal(await read("sub", "owner", () => {}), "available");
  } finally { db.close(); }
});

for (const mode of ["until", "changes"] as const) test(`new acceptance invalidates only a pending idle finding and rearms ${mode}`, async () => {
  const db = new Sqlite(":memory:"), n = nativeFixture();
  let now = 100_000, sends = 0;
  const store = new Store(db as unknown as Database);
  const read = createAcceptedActivityReader(n.bb, store.db);
  const engine = new Engine(store, {
    now: () => now,
    owner: async r => { const status = await read(r.id, r.owner, at => engine.activity(r.owner, at)); return status === "available" ? "available" : "offline"; },
    launch: async () => "forbidden", wake: async () => {}, stop: async () => {},
    send: async () => { sends++; return { delivery: "queued" }; },
    run: async () => { throw new Error("inert"); }, classify: async () => { throw new Error("inert"); },
  });
  try {
    const { subscription_id: id } = engine.create("owner", "project", null, mode, { trigger: { kind: "idle", thread: "owner", seconds: 30 }, message: "idle" });
    now = 130_000; await engine.step(id, now, new AbortController().signal);
    assert.equal(store.findings(id)[0]!.delivery, "pending");
    // Accepted before delivery check, discovered late; acceptance time precedes
    // finding creation, so comparing only created_at would miss the race.
    n.accept(125_000); now = 131_000;
    await engine.tick(new AbortController().signal);
    assert.equal(sends, 0); assert.equal(store.findings(id)[0]!.delivery, "cancelled");
    assert.equal(store.get(id).idle_anchor, 125_000); assert.equal(store.get(id).state, "watching");
    now = 156_000; await engine.tick(new AbortController().signal);
    assert.equal(sends, 1);
    assert.equal(store.findings(id).filter(f => f.delivery === "accepted").length, 1);
  } finally { db.close(); }
});

test("an invoked idle notification remains uncertain after new human activity and is never resent", async () => {
  const db = new Sqlite(":memory:"), n = nativeFixture();
  const store = new Store(db as unknown as Database);
  const read = createAcceptedActivityReader(n.bb, store.db);
  let now = 100_000, sends = 0;
  const engine = new Engine(store, {
    now: () => now,
    owner: async r => { const status = await read(r.id, r.owner, at => engine.activity(r.owner, at)); return status === "available" ? "available" : "offline"; },
    launch: async () => "forbidden", wake: async () => {}, stop: async () => {},
    send: async () => { sends++; n.accept(131_000); throw new Error("remote effect unknown"); },
    run: async () => { throw new Error("inert"); }, classify: async () => { throw new Error("inert"); },
  });
  try {
    const { subscription_id: id } = engine.create("owner", "project", null, "until", { trigger: { kind: "idle", thread: "owner", seconds: 30 }, message: "idle" });
    now = 130_000; await engine.tick(new AbortController().signal);
    assert.equal(store.findings(id)[0]!.delivery, "uncertain");
    engine.recover(); now = 200_000; await engine.tick(new AbortController().signal);
    assert.equal(store.findings(id)[0]!.delivery, "uncertain"); assert.equal(sends, 1);
  } finally { db.close(); }
});
