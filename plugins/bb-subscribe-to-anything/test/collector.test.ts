import test from "node:test";
import assert from "node:assert/strict";
import Sqlite from "better-sqlite3";
import { Collectors } from "../collector.ts";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import { Engine } from "../engine.ts";
import type { Ports } from "../engine.ts";
import { classify } from "../classifier.ts";
import { publicRecord, recipeSchema } from "../contracts.ts";
import type { Run } from "../contracts.ts";

const recipe = recipeSchema.parse({ script: 'printf false >> "$SUB_OUTPUT"',
  interpretation: "ready flag unchanged", coverage: "snapshot", history_count: 0,
  evaluation: { kind: "json_equals", path: [], value: true }, timeout_seconds: 1 });
const authority = { environment: "parent-env", host: "parent-host", observer: "observer", permission_mode: "accept-edits" };
const signal = () => new AbortController().signal;
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture() {
  const db = new Sqlite(":memory:");
  let now = 100000, notifications = 0, wakes = 0, sends = 0;
  const store = new Store(db as unknown as Database, () => notifications++);
  const collectors = new Collectors(store, () => now);
  const ports: Ports = {
    now: () => now, owner: async () => "available", launch: async () => "observer",
    wake: async () => { wakes++; }, stop: async () => {}, send: async () => { sends++; },
    run: (r, s) => collectors.run(r, s),
    classify: (r, run, s) => classify(r, run, { enabled: false, model: "fixture", signal: s }),
  };
  const engine = new Engine(store, ports);
  const id = engine.create("owner", "project", "parent-env", "until", {
    subject: "private fixture", notify_when: "ready", required_evidence: "boolean", timeout_minutes: 60,
  }).subscription_id;
  const setup = async () => {
    await engine.tick(signal()); engine.install("observer", recipe);
    collectors.install(store.get(id), authority);
  };
  const start = async () => {
    await engine.tick(signal(), false);
    for (let i = 0; i < 100; i++) {
      const r = store.get(id);
      if (r.state === "running" && r.collector?.task && !r.collector.task.result) break;
      await pause();
    }
    const r = store.get(id); assert.equal(r.state, "running"); assert.ok(r.collector?.task);
    return r.collector!;
  };
  const finish = async () => { await Promise.all(engine.tasks.values()); };
  const run = (generation: number, output = "false", problem?: string): Run => ({
    id: "worker-id-is-not-authoritative", generation, started_at: now, ended_at: now,
    duration_ms: 1, output, stdout: "", stderr: "", exit_code: problem ? 7 : 0, problem,
  });
  return { db, store, collectors, engine, ports, id, setup, start, finish, run,
    advance: (ms: number) => { now += ms; }, counts: () => ({ notifications, wakes, sends }) };
}

test("actual mailbox and classifier keep repeated exact pending quiet and redact assignment secrets", async () => {
  const f = fixture(); await f.setup();
  for (let n = 0; n < 2; n++) {
    const c = await f.start(), before = f.counts().notifications;
    const task = f.collectors.poll(f.id, "observer", c.token, "worker");
    f.advance(2000); f.collectors.poll(f.id, "observer", c.token, "worker");
    assert.equal(f.counts().notifications, before);
    assert.deepEqual(task.task?.history, []);
    assert.throws(() => f.collectors.poll(f.id, "observer", c.token, "other-worker"), /mismatch/);
    assert.throws(() => f.collectors.submit(f.id, "observer", c.token, "worker", "out-of-order", f.run(c.generation)), /Stale/);
    const payload = f.run(c.generation);
    f.collectors.submit(f.id, "observer", c.token, "worker", c.task!.id, payload);
    f.collectors.submit(f.id, "observer", c.token, "worker", c.task!.id, payload);
    assert.throws(() => f.collectors.submit(f.id, "observer", c.token, "worker", c.task!.id, f.run(c.generation, "true")), /cannot be replaced/);
    await f.finish();
    const r = f.store.get(f.id);
    assert.equal(r.state, "watching"); assert.equal(r.runs.at(-1)!.id, c.task!.id);
    assert.deepEqual(r.runs.at(-1)!.provenance, authority);
    assert.ok(!JSON.stringify(publicRecord(r, true)).includes(c.token));
    assert.ok(!JSON.stringify(publicRecord(r)).includes('"observer":"observer"'));
    f.advance(300000);
    f.collectors.poll(f.id, "observer", c.token, "worker"); // Healthy idle heartbeat after the clock jump.
  }
  assert.equal(f.counts().wakes, 0); assert.equal(f.counts().sends, 0);
  f.db.close();
});
test("failed collection returns to repair; replacement fences old worker and later match still requires review", async () => {
  const f = fixture(); await f.setup(); const old = await f.start();
  f.collectors.poll(f.id, "observer", old.token, "worker");
  f.collectors.submit(f.id, "observer", old.token, "worker", old.task!.id, f.run(old.generation, "true", "CLI schema changed"));
  await f.finish(); await f.engine.tick(signal());
  assert.equal(f.store.get(f.id).state, "reviewing"); assert.equal(f.counts().wakes, 1); assert.equal(f.counts().sends, 0);
  assert.throws(() => f.engine.report("observer", "ready", "true", old.task!.id), /sealed run/);
  f.engine.install("observer", { ...recipe, script: 'printf true >> "$SUB_OUTPUT"' });
  f.collectors.install(f.store.get(f.id), authority);
  assert.throws(() => f.collectors.submit(f.id, "observer", old.token, "worker", old.task!.id, f.run(old.generation)), /mismatch/);
  const next = await f.start(); f.collectors.poll(f.id, "observer", next.token, "worker-new");
  f.collectors.submit(f.id, "observer", next.token, "worker-new", next.task!.id, f.run(next.generation, "true"));
  await f.finish(); assert.equal(f.counts().sends, 0);
  f.engine.report("observer", "ready", "sealed true", next.task!.id);
  await f.engine.tick(signal()); assert.equal(f.store.get(f.id).state, "fulfilled"); assert.equal(f.counts().sends, 1);
  f.db.close();
});
test("restart blocks older pending evidence and salvages only the current sealed task", async () => {
  const f = fixture(); await f.setup();
  let r = f.store.get(f.id); r.runs = [f.run(r.generation)];
  r.collector!.task = { id: "old", result: r.runs[0] }; f.store.save(r);
  f.ports.run = async () => { throw new Error("crash before assigning task"); };
  await f.engine.tick(signal()); r = f.store.get(f.id);
  assert.equal(r.collector!.task, undefined); assert.equal(r.report_blocked, true);
  r.state = "running"; f.store.save(r); f.engine.recover();
  assert.throws(() => f.engine.report("observer", "old", "old", r.runs[0]!.id), /sealed run/);
  r = f.store.get(f.id); r.state = "running";
  const sealed = { ...f.run(r.generation, "true"), id: "current" };
  r.collector!.task = { id: sealed.id, claimed: "worker", result: sealed }; f.store.save(r);
  f.engine.recover(); f.engine.report("observer", "ready", "current true", sealed.id);
  assert.equal(f.store.get(f.id).state, "fulfilled"); f.db.close();
});
test("expiry and cancellation revoke in-flight assignment and reject late evidence", async () => {
  for (const kind of ["expiry", "cancel"] as const) {
    const f = fixture(); await f.setup(); const c = await f.start();
    f.collectors.poll(f.id, "observer", c.token, "worker");
    if (kind === "cancel") await f.engine.cancel(f.id, "owner"); else f.advance(3600001);
    assert.equal(f.collectors.poll(f.id, "observer", c.token, "worker").stop, true);
    assert.throws(() => f.collectors.submit(f.id, "observer", c.token, "worker", c.task!.id, f.run(c.generation, "true")), /Stale/);
    await f.finish(); await f.engine.tick(signal());
    assert.equal(f.store.get(f.id).state, kind === "cancel" ? "cancelled" : "expired"); f.db.close();
  }
});
test("missing launch has bounded actionable review, and launch refusal can fail immediately", async () => {
  const f = fixture(); await f.setup(); await f.start(); f.advance(31000); await f.finish();
  assert.match(f.store.get(f.id).runs.at(-1)!.problem!, /Provider collector did not return/);
  assert.equal(f.store.get(f.id).state, "reviewing"); f.db.close();
  const g = fixture(); await g.setup(); g.engine.fail("observer", "Provider denied launch; need access to the assigned local log");
  assert.equal(g.store.get(g.id).state, "failed"); g.db.close();
});
test("four waiting collectors do not block a due native timer", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.engine.tasks.set(`busy-${i}`, new Promise(() => {}));
  const id = f.engine.create("owner", "project", null, "until", { trigger: { kind: "after", seconds: 1 }, message: "timer" }).subscription_id;
  f.advance(1000); await f.engine.tick(signal(), false);
  // Timer work is independent of the unresolved collection promises.
  for (let i = 0; i < 100 && f.store.get(id).state !== "fulfilled"; i++) await pause();
  assert.equal(f.store.get(id).state, "fulfilled"); f.engine.tasks.clear(); f.db.close();
});

test("private hints cover read races, remain quiet on heartbeat, and release on abort/dispose", async () => {
  const f = fixture(); await f.setup();
  const c = f.store.get(f.id).collector!;
  const hint = f.store.watch(f.id);
  const r = f.store.get(f.id); r.problem = "changed"; f.store.save(r);
  const started = Date.now(); await hint.wait(1000); assert.ok(Date.now() - started < 100); hint.close();
  const quiet = f.store.watch(f.id), abort = new AbortController();
  f.collectors.poll(f.id, "observer", c.token, "worker");
  setTimeout(() => abort.abort(), 25);
  await assert.rejects(quiet.wait(1000, abort.signal), /aborted/); quiet.close();
  // Repeated aborted mailbox requests must not consume the bounded waiter slots.
  for (let i = 0; i < 10; i++) {
    const stop = new AbortController(), waiting = f.collectors.wait(f.id, "observer", c.token, "worker", undefined, stop.signal);
    stop.abort(); await assert.rejects(waiting, /aborted/);
  }
  const watches = Array.from({ length: 4 }, () => f.store.watch(f.id));
  assert.throws(() => f.store.watch(f.id), /Too many/);
  watches.forEach(w => w.close());
  const waiting = f.collectors.wait(f.id, "observer", c.token, "worker", undefined);
  f.store.dispose(); await assert.rejects(waiting, /disposed/);
  assert.throws(() => f.store.watch(f.id), /disposed/); f.db.close();
});
test("mailbox hints reread authoritative state and reconcile independent writers without hints", async () => {
  for (const independent of [false, true]) {
    const f = fixture(); await f.setup(); const c = f.store.get(f.id).collector!;
    const waiting = f.collectors.wait(f.id, "observer", c.token, "worker", undefined);
    const writer = independent ? new Store(f.db as unknown as Database) : f.store;
    const start = Date.now(), r = writer.get(f.id); r.state = "cancelled"; r.generation++; writer.save(r);
    assert.equal((await waiting).stop, true);
    assert.ok(Date.now() - start < (independent ? 6000 : 250)); f.db.close();
  }
});
test("pre-sequence retained assignment is upgraded once and preserves claimed identity", async () => {
  const f = fixture(); await f.setup();
  const r = f.store.get(f.id); r.state = "running"; r.collector!.task = { id: "retained-before-upgrade" }; f.store.save(r);
  const c = r.collector!;
  const first = f.collectors.poll(f.id, "observer", c.token, "worker");
  const again = f.collectors.poll(f.id, "observer", c.token, "worker");
  assert.equal(first.task?.id, "retained-before-upgrade"); assert.equal(first.task?.sequence, 1);
  assert.equal(again.task?.sequence, 1);
  assert.equal(f.store.get(f.id).collector!.sequence, 1); f.db.close();
});

test("subscribe-before-read covers assignment race and reload recreates hints from durable state", async () => {
  const f = fixture(); await f.setup(); const c = f.store.get(f.id).collector!;
  const original = f.store.watch.bind(f.store);
  f.store.watch = id => {
    const hint = original(id);
    const raced = f.store.get(id); raced.state = "cancelled"; raced.generation++; f.store.save(raced);
    return hint;
  };
  assert.equal((await f.collectors.wait(f.id, "observer", c.token, "worker", undefined)).stop, true);
  f.store.dispose();
  const replacement = new Store(f.db as unknown as Database), afterReload = new Collectors(replacement);
  assert.equal((await afterReload.wait(f.id, "observer", c.token, "worker", undefined)).stop, true);
  // A deleted record throws after subscribing and must still release its slot.
  for (let i = 0; i < 6; i++) await assert.rejects(afterReload.wait("missing", "observer", c.token, "worker", undefined), /Unknown/);
  const slots = Array.from({ length: 4 }, () => replacement.watch("missing")); slots.forEach(w => w.close());
  replacement.dispose(); f.db.close();
});
