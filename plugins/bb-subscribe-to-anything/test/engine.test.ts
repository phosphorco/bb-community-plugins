import test from "node:test";
import assert from "node:assert/strict";
import Sqlite from "better-sqlite3";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import { Engine } from "../engine.ts";
import type { Ports } from "../engine.ts";
import { recipeSchema } from "../contracts.ts";
import type { Run } from "../contracts.ts";
import { classify } from "../classifier.ts";

const signal = new AbortController().signal;
const recipe = recipeSchema.parse({
  script: 'echo \'{"ready":false}\' >> "$SUB_OUTPUT"',
  interpretation: "ready flag",
  coverage: "snapshot only",
  evaluation: { kind: "json_equals", path: ["ready"], value: true },
});
function fixture() {
  const db = new Sqlite(":memory:");
  const store = new Store(db as unknown as Database);
  let now = 100000,
    output = '{"ready":false}',
    sends = 0,
    wakes = 0,
    launches = 0;
  const ports: Ports = {
    now: () => now,
    owner: async () => "available",
    launch: async () => {
      launches++;
      return "observer";
    },
    wake: async () => {
      wakes++;
    },
    stop: async () => {},
    send: async () => {
      sends++;
      return { delivery: "queued" };
    },
    run: async (r) => ({
      id: `run-${r.checks}`,
      generation: r.generation,
      started_at: now,
      ended_at: now,
      duration_ms: 1,
      output,
      stdout: "",
      stderr: "",
      exit_code: 0,
    }),
    classify: (r, run, s) =>
      classify(r, run, { enabled: false, model: "test", signal: s }),
  };
  const engine = new Engine(store, ports);
  const create = (mode: "until" | "changes" = "until") =>
    engine.create("owner", "project", null, mode, {
      subject: "https://example.com",
      notify_when: "ready",
      required_evidence: "flag",
      timeout_minutes: 60,
    }).subscription_id;
  return {
    db,
    store,
    engine,
    ports,
    create,
    setOutput: (s: string) => {
      output = s;
    },
    advance: (ms: number) => {
      now += ms;
    },
    counts: () => ({ sends, wakes, launches }),
  };
}
test("pending checks never wake the owner or observer; match needs review", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  f.engine.install("observer", recipe);
  for (let i = 0; i < 3; i++) {
    await f.engine.tick(signal);
    f.advance(300000);
  }
  assert.deepEqual(f.counts(), { sends: 0, wakes: 0, launches: 1 });
  f.setOutput('{"ready":true}');
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).state, "reviewing");
  assert.equal(f.counts().sends, 0);
  await f.engine.tick(signal);
  assert.equal(f.counts().wakes, 1);
  const run = f.store.get(id).runs.at(-1)!;
  f.engine.report("observer", "Ready", "flag=true", run.id);
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).state, "fulfilled");
  assert.equal(f.counts().sends, 1);
  await f.engine.tick(signal);
  assert.equal(f.counts().sends, 1);
  f.db.close();
});
test("native interval coalesces missed boundaries and preserves acceptance anchor", async () => {
  const f = fixture();
  const id = f.engine.create("owner", "project", null, "changes", {
    trigger: { kind: "interval", seconds: 10 },
    message: "tick",
  }).subscription_id;
  f.advance(35000);
  await f.engine.tick(signal);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.counts().launches, 0);
  assert.equal(f.store.get(id).next_at, 140000);
  assert.match(f.store.findings(id)[0]!.evidence, /"missed_boundaries":2/);
  f.db.close();
});
test("native after expires or fires without model calls", async () => {
  const f = fixture();
  const id = f.engine.create("owner", "project", null, "until", {
    trigger: { kind: "after", seconds: 10 },
    message: "done",
  }).subscription_id;
  await f.engine.tick(signal);
  assert.equal(f.counts().sends, 0);
  f.advance(10000);
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).state, "fulfilled");
  assert.equal(f.counts().launches, 0);
  f.db.close();
});
test("idle per episode only rearms on explicit activity", async () => {
  const f = fixture();
  const id = f.engine.create("owner", "project", null, "changes", {
    trigger: { kind: "idle", thread: "owner", seconds: 10 },
    message: "idle",
  }).subscription_id;
  f.advance(11000);
  await f.engine.tick(signal);
  f.advance(100000);
  await f.engine.tick(signal);
  assert.equal(f.counts().sends, 1);
  f.engine.activity("owner", 211000);
  f.advance(11000);
  await f.engine.tick(signal);
  assert.equal(f.counts().sends, 2);
  assert.equal(f.store.get(id).idle_fired, true);
  f.db.close();
});
test("cancellation fences a late collector result", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  f.engine.install("observer", recipe);
  let finish!: (run: Run) => void;
  f.ports.run = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const tick = f.engine.tick(signal);
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.cancel(id, "owner");
  finish({
    id: "late",
    generation: 1,
    started_at: 1,
    ended_at: 2,
    duration_ms: 1,
    output: '{"ready":true}',
    stdout: "",
    stderr: "",
    exit_code: 0,
  });
  await tick;
  assert.equal(f.store.get(id).state, "cancelled");
  assert.equal(f.store.get(id).runs.length, 0);
  assert.equal(f.counts().sends, 0);
  f.db.close();
});
test("restart never blindly repeats uncertain launches or deliveries", async () => {
  const f = fixture(),
    id = f.create();
  let r = f.store.get(id);
  r.launch = "intent";
  f.store.save(r);
  f.store.putFinding({
    id: "f",
    subscription_id: id,
    owner: "owner",
    occurrence: "x",
    created_at: 1,
    outcome: "matched",
    summary: "x",
    evidence: "x",
    delivery: "sending",
  });
  f.engine.recover();
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).state, "uncertain");
  assert.equal(
    f.store.findings(id).find((f) => f.id === "f")!.delivery,
    "uncertain",
  );
  assert.equal(f.counts().launches, 0);
  assert.equal(f.counts().sends, 1); // One attention notice, never a replay of the uncertain finding.
  f.db.close();
});
test("restart during collection routes to review", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  f.engine.install("observer", recipe);
  const r = f.store.get(id);
  r.state = "running";
  f.store.save(r);
  f.engine.recover();
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).state, "reviewing");
  assert.equal(f.counts().wakes, 1);
  f.db.close();
});
test("expiry rejects late observer reports", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  f.advance(3600001);
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).state, "expired");
  assert.throws(() => f.engine.fail("observer", "late"));
  f.db.close();
});
test("changes establish a baseline, detect repeated transitions, continue after report", async () => {
  const f = fixture(),
    id = f.create("changes");
  await f.engine.tick(signal);
  f.engine.install("observer", {
    ...recipe,
    evaluation: { kind: "json_changes", path: ["ready"] },
  });
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).baseline, "false");
  assert.equal(f.counts().sends, 0);
  for (const value of [true, false, true]) {
    f.setOutput(JSON.stringify({ ready: value }));
    f.advance(300000);
    await f.engine.tick(signal);
    f.engine.report(
      "observer",
      String(value),
      String(value),
      f.store.get(id).runs.at(-1)!.id,
    );
    await f.engine.tick(signal);
  }
  assert.equal(f.counts().sends, 3);
  assert.equal(f.store.get(id).state, "watching");
  f.db.close();
});
test("owner and observer scope are enforced and normal inspection hides executor", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  assert.throws(() => f.engine.inspect(id, "other"));
  assert.throws(() => f.engine.install("other", recipe));
  assert.equal(
    JSON.stringify(f.engine.inspect(id, "owner")).includes('"observer"'),
    false,
  );
  assert.equal(
    f.engine.inspect(id, "owner", true).debug?.observer_thread_id,
    "observer",
  );
  f.db.close();
});
test("ambiguous send is recorded once, not retried", async () => {
  const f = fixture();
  f.ports.send = async () => {
    throw Error("response lost");
  };
  const id = f.engine.create("owner", "project", null, "until", {
    trigger: { kind: "after", seconds: 1 },
    message: "done",
  }).subscription_id;
  f.advance(1000);
  await f.engine.tick(signal);
  await f.engine.tick(signal);
  assert.equal(f.store.findings(id)[0]!.delivery, "uncertain");
  f.db.close();
});
test("native maximum wait wins even while ordinary idle deadline is later", async () => {
  const f = fixture();
  f.engine.create("owner", "project", null, "changes", {
    trigger: {
      kind: "idle",
      thread: "owner",
      seconds: 100,
      max_wait_seconds: 10,
    },
    message: "deadline",
  });
  f.advance(10000);
  await f.engine.tick(signal);
  assert.equal(f.counts().sends, 1);
  f.db.close();
});
test("a slow collector does not block native reminders in production sweep", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  f.engine.install("observer", recipe);
  let release!: (r: Run) => void;
  f.ports.run = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await f.engine.tick(signal, false);
  await new Promise((resolve) => setImmediate(resolve));
  f.engine.create("owner", "project", null, "until", {
    trigger: { kind: "after", seconds: 1 },
    message: "remind",
  });
  f.advance(1000);
  await f.engine.tick(signal, false);
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.tick(signal, false);
  assert.equal(f.counts().sends, 1);
  await f.engine.cancel(id, "owner");
  release({
    id: "late",
    generation: 1,
    started_at: 1,
    ended_at: 2,
    duration_ms: 1,
    output: "true",
    stdout: "",
    stderr: "",
    exit_code: 0,
  });
  await Promise.all(f.engine.tasks.values());
  f.db.close();
});
test("observer shutdown failure remains durable for retry", async () => {
  const f = fixture(),
    id = f.create();
  await f.engine.tick(signal);
  let fails = true;
  f.ports.stop = async () => {
    if (fails) throw Error("offline");
  };
  assert.equal((await f.engine.cancel(id, "owner")).shutdown, "unknown");
  assert.equal(f.store.get(id).stop_pending, true);
  fails = false;
  await f.engine.tick(signal);
  assert.equal(f.store.get(id).stop_pending, false);
  f.db.close();
});
test("cancellation withdraws a recorded queue receipt after fulfillment",async()=>{
  const f=fixture();let withdrawn=0;f.ports.withdraw=async()=>{withdrawn++;return true;};
  const id=f.engine.create("owner","project",null,"until",{trigger:{kind:"after",seconds:1},message:"test"}).subscription_id;
  f.advance(1000);await f.engine.tick(signal);assert.equal(f.store.get(id).state,"fulfilled");
  await f.engine.cancel(id,"owner");await f.engine.tick(signal);assert.equal(withdrawn,1);assert.equal(f.store.findings(id)[0]!.delivery,"cancelled");f.db.close();
});
test("cancellation wins while delivery awaits owner status",async()=>{
  const f=fixture();const id=f.engine.create("owner","project",null,"until",{trigger:{kind:"after",seconds:1},message:"test"}).subscription_id;
  let release!:()=>void;let checks=0;f.ports.owner=async()=>{checks++;if(checks===2)await new Promise<void>(resolve=>{release=resolve;});return "available";};
  f.advance(1000);const tick=f.engine.tick(signal);await new Promise(resolve=>setImmediate(resolve));
  await f.engine.cancel(id,"owner");release();await tick;assert.equal(f.counts().sends,0);assert.equal(f.store.findings(id)[0]!.delivery,"cancelled");f.db.close();
});
