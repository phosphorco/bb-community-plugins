import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  classifyCrossReferencesError,
  MachineMonitorReferenceDelivery,
  REFERENCE_LEASE_MS,
} from "../attachment-delivery.ts";
import {
  canonicalizeResource,
  machineMonitorResource,
  projectionPayloadDigest,
  threadResource,
  type Resource,
} from "../attachment-contract.ts";
import { ABSENT_RETRY_MS, MachineMonitorReferenceStore, machineMonitorMigrations, type ClaimedProjection } from "../store.ts";

function makeStore(): { db: Database.Database; store: MachineMonitorReferenceStore } {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  return { db, store: new MachineMonitorReferenceStore(db) };
}

function thread(id: string, label = id): Resource {
  return threadResource("proj_12345678", id, { label, detail: "BB thread" });
}

function command(store: MachineMonitorReferenceStore, now: number): ClaimedProjection {
  const claimed = store.claimDue(now);
  assert.ok(claimed);
  return claimed;
}

test("attaches exact BB threads locally with source CAS, active-empty removal, and coalesced pending state", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  const first = store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_first01")] }, 100);
  assert.equal(first.outcome, "applied");
  assert.deepEqual(first.snapshot.targets.map((target) => target.keys.thread), ["thr_first01"]);
  assert.equal(first.snapshot.status.state, "pending");

  const unchanged = store.replaceAttachments({ expectedSourceRevision: 1, targets: [thread("thr_first01")] }, 101);
  assert.equal(unchanged.outcome, "unchanged");
  assert.equal(unchanged.snapshot.sourceRevision, 1);

  const mismatch = store.replaceAttachments({ expectedSourceRevision: 0, targets: [] }, 102);
  assert.equal(mismatch.outcome, "cas-mismatch");
  assert.deepEqual(mismatch.snapshot.targets.map((target) => target.keys.thread), ["thr_first01"]);

  const inFlight = command(store, 100);
  const second = store.replaceAttachments({ expectedSourceRevision: 1, targets: [thread("thr_second01")] }, 110);
  assert.equal(second.outcome, "applied");
  assert.equal(second.snapshot.sourceRevision, 2);
  const inFlightAfterEdit = db.prepare("SELECT revision, mutation_id AS mutationId, payload_digest AS payloadDigest FROM machine_monitor_reference_outbox WHERE slot = 'in_flight'").get() as { revision: number; mutationId: string; payloadDigest: string };
  assert.deepEqual(inFlightAfterEdit, { revision: inFlight.command.revision, mutationId: inFlight.command.mutationId, payloadDigest: inFlight.payloadDigest });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM machine_monitor_reference_outbox").get() as { count: number }).count, 2);

  assert.equal(store.recordResponse(inFlight, { outcome: "applied", currentRevision: 1, currentDigest: inFlight.payloadDigest }, 120), "acknowledged");
  const pending = db.prepare("SELECT revision, expected_remote_revision AS expectedRevision, mutation_id AS mutationId FROM machine_monitor_reference_outbox WHERE slot = 'pending'").get() as { revision: number; expectedRevision: number; mutationId: string };
  assert.deepEqual(pending, { revision: 2, expectedRevision: 1, mutationId: pending.mutationId });
  assert.equal(command(store, 120).command.revision, 2);

  const removed = store.replaceAttachments({ expectedSourceRevision: 2, targets: [] }, 130);
  assert.equal(removed.outcome, "applied");
  assert.deepEqual(removed.snapshot.targets, []);
  assert.equal(removed.snapshot.sourceRevision, 3);
  assert.equal(removed.snapshot.status.pending, true);
});

test("local replacement is transactionally atomic and rejects non-thread resources", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_atomic01")] }, 100);
  assert.throws(() => store.replaceAttachments({
    expectedSourceRevision: 1,
    targets: [{ provider: "github", keys: { owner: "x" }, presentation: { label: "Not a BB thread" } }],
  }, 101), /exact BB threads/);
  assert.throws(() => canonicalizeResource({
    provider: "bb",
    keys: { project: "proj with space" },
    presentation: { label: "Invalid BB identity" },
  }), /invalid BB id|v1 project/);
  assert.deepEqual(store.snapshot(101).targets.map((target) => target.keys.thread), ["thr_atomic01"]);

  db.exec(`CREATE TRIGGER prevent_reference_link_insert BEFORE INSERT ON machine_monitor_reference_links
    BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
  assert.throws(() => store.replaceAttachments({ expectedSourceRevision: 1, targets: [thread("thr_atomic02")] }, 102), /injected insert failure/);
  assert.deepEqual(store.snapshot(102).targets.map((target) => target.keys.thread), ["thr_atomic01"]);
  assert.equal(store.snapshot(102).sourceRevision, 1);
  assert.equal((db.prepare("SELECT revision FROM machine_monitor_reference_outbox WHERE slot = 'pending'").get() as { revision: number }).revision, 1);
});

test("retries the immutable tuple with bounded exponential backoff and recovers expired leases", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_retry01")] }, 0);
  const first = command(store, 0);
  assert.equal(store.recordFailure(first, { kind: "transient", code: "handler_error", status: 500, message: "temporary" }, 1), true);
  let row = db.prepare("SELECT slot, attempts, next_attempt_at AS nextAttemptAt, mutation_id AS mutationId, payload_digest AS payloadDigest FROM machine_monitor_reference_outbox").get() as Record<string, unknown>;
  assert.deepEqual(row, { slot: "pending", attempts: 1, nextAttemptAt: 1_001, mutationId: first.command.mutationId, payloadDigest: first.payloadDigest });
  assert.equal(store.claimDue(1_000), null);
  const second = command(store, 1_001);
  assert.equal(second.command.mutationId, first.command.mutationId);
  assert.equal(second.payloadDigest, first.payloadDigest);
  assert.equal(store.recordFailure(second, { kind: "transient", code: null, status: null, message: "still temporary" }, 2_000), true);
  row = db.prepare("SELECT attempts, next_attempt_at AS nextAttemptAt FROM machine_monitor_reference_outbox").get() as Record<string, unknown>;
  assert.deepEqual(row, { attempts: 2, nextAttemptAt: 4_000 });

  const third = command(store, 4_000);
  assert.equal(store.recordFailure(third, { kind: "transient", code: null, status: 503, message: "still temporary" }, 4_000), true);
  const fourth = command(store, 8_000);
  assert.equal(store.recordFailure(fourth, { kind: "transient", code: null, status: 503, message: "still temporary" }, 8_000), true);
  const fifth = command(store, 16_000);
  assert.equal(store.recordFailure(fifth, { kind: "transient", code: null, status: 503, message: "still temporary" }, 16_000), true);
  const sixth = command(store, 32_000);
  assert.equal(store.recordFailure(sixth, { kind: "transient", code: null, status: 503, message: "still temporary" }, 32_000), true);
  const seventh = command(store, 64_000);
  assert.equal(store.recordFailure(seventh, { kind: "transient", code: null, status: 503, message: "still temporary" }, 64_000), true);
  row = db.prepare("SELECT attempts, next_attempt_at AS nextAttemptAt FROM machine_monitor_reference_outbox").get() as Record<string, unknown>;
  assert.deepEqual(row, { attempts: 7, nextAttemptAt: 124_000 });

  const leased = command(store, 124_000);
  const leaseRow = db.prepare("SELECT lease_until AS leaseUntil FROM machine_monitor_reference_outbox WHERE slot = 'in_flight'").get() as { leaseUntil: number };
  assert.equal(leaseRow.leaseUntil, 124_000 + REFERENCE_LEASE_MS);
  assert.equal(store.recoverExpiredLeases(124_000 + REFERENCE_LEASE_MS + 1), true);
  const recovered = command(store, 124_000 + REFERENCE_LEASE_MS + 1);
  assert.equal(recovered.command.mutationId, leased.command.mutationId);
  assert.equal(recovered.payloadDigest, leased.payloadDigest);
});

test("requeues terminal absence on a bounded wake and after a successful peer reconciliation", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_absent_recovery01")] }, 0);
  const first = command(store, 0);
  assert.equal(store.recordFailure(first, { kind: "absent", code: "plugin_not_found", status: 404, message: "missing" }, 1), true);
  assert.equal(store.nextWakeAt(1), 1 + ABSENT_RETRY_MS);
  assert.equal(store.claimDue(ABSENT_RETRY_MS), null);

  assert.equal(store.reconcileRemote(null, 100), "queued");
  assert.equal(store.snapshot(100).status.errorKind, null);
  const requeued = command(store, 100);
  assert.equal(requeued.command.mutationId, first.command.mutationId);
  assert.equal(store.recordResponse(requeued, {
    outcome: "applied",
    currentRevision: 1,
    currentDigest: first.payloadDigest,
  }, 101), "acknowledged");
  assert.equal(store.snapshot(101).status.state, "synced");
});

test("rebases receiver conflicts without adopting remote targets and ignores stale acknowledgements", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_local01", "Local") ] }, 100);
  const original = command(store, 100);
  const differentDigest = "a".repeat(64);
  assert.equal(store.recordResponse(original, { outcome: "cas-mismatch", currentRevision: 5, currentDigest: differentDigest }, 200), "rebased");
  const rebased = command(store, 200);
  assert.equal(rebased.command.revision, 6);
  assert.notEqual(rebased.command.mutationId, original.command.mutationId);
  assert.equal(rebased.payloadDigest, original.payloadDigest);
  assert.deepEqual(store.snapshot(200).targets.map((target) => target.presentation.label), ["Local"]);
  assert.equal(store.recordResponse(original, { outcome: "applied", currentRevision: 1, currentDigest: original.payloadDigest }, 201), "ignored");

  const currentDigest = projectionPayloadDigest(
    "machine-monitor",
    canonicalizeResource(machineMonitorResource()),
    false,
    [canonicalizeResource(thread("thr_local01", "Local"))],
  );
  assert.equal(store.recordResponse(rebased, { outcome: "stale", currentRevision: 6, currentDigest: currentDigest }, 300), "acknowledged");
  assert.equal(store.snapshot(300).status.state, "synced");
  assert.equal(store.reconcileRemote({ revision: 4, payloadDigest: "b".repeat(64) }, 400), "queued");
  const rollbackRepair = command(store, 400);
  assert.equal(rollbackRepair.command.revision, 6);
  assert.equal(rollbackRepair.command.expectedRevision, 4);
  assert.equal(rollbackRepair.payloadDigest, currentDigest);
});

test("classifies structured Cross References failures and keeps idle service quiet and abort-aware", async (t) => {
  assert.equal(classifyCrossReferencesError({ status: 404, code: "unknown_method", message: "missing" }).kind, "incompatible");
  assert.equal(classifyCrossReferencesError({ status: 404, code: "plugin_not_found", message: "missing" }).kind, "absent");
  assert.equal(classifyCrossReferencesError({ status: 503, code: "handler_error", message: "down" }).kind, "transient");
  assert.equal(classifyCrossReferencesError({ status: 400, code: "invalid_input", message: "bad" }).kind, "blocked");
  assert.equal(classifyCrossReferencesError({ name: "ZodError", message: "invalid output" }).kind, "blocked");
  assert.equal(classifyCrossReferencesError({ code: "future_permanent_error", message: "not retryable" }).kind, "blocked");

  const { db, store } = makeStore();
  t.after(() => db.close());
  const calls: string[] = [];
  const bb = {
    sdk: {
      plugins: {
        callRpc: async (args: { method: string }) => {
          calls.push(args.method);
          return { projection: null };
        },
      },
    },
  } as any;
  const delivery = new MachineMonitorReferenceDelivery(bb, store);
  const controller = new AbortController();
  const running = delivery.start(controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["getProjection"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["getProjection"], "a clean source must not poll while idle");
  controller.abort();
  await running;

  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_absent01")] }, 500);
  const missingBb = {
    sdk: {
      plugins: {
        callRpc: async (args: { method: string }) => {
          calls.push(args.method);
          throw { status: 404, code: "plugin_not_found", message: "Cross References is not installed" };
        },
      },
    },
  } as any;
  const missingDelivery = new MachineMonitorReferenceDelivery(missingBb, store);
  const missingController = new AbortController();
  const missing = missingDelivery.start(missingController.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  missingController.abort();
  await missing;
  assert.deepEqual(store.snapshot(500).targets.map((target) => target.keys.thread), ["thr_absent01"]);
  assert.equal(store.snapshot(500).status.state, "degraded");
  assert.equal(store.snapshot(500).status.errorKind, "absent");
});

test("does not acknowledge a projection response that arrives after service abort", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_abort01")] }, 0);
  let releaseApply: ((value: unknown) => void) | null = null;
  const bb = {
    sdk: {
      plugins: {
        callRpc: async (args: { method: string }) => {
          if (args.method === "getProjection") return { projection: null };
          return await new Promise((resolve) => { releaseApply = resolve; });
        },
      },
    },
  } as any;
  const controller = new AbortController();
  const running = new MachineMonitorReferenceDelivery(bb, store).start(controller.signal);
  while (releaseApply == null) await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const settled = await Promise.race([
    running.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(settled, true, "service must settle before the host stop bound");
  const release = releaseApply as (value: unknown) => void;
  release({ outcome: "applied", currentRevision: 1, currentDigest: "a".repeat(64) });
  await running;
  assert.equal(store.snapshot(0).status.inFlight, true);
  assert.equal(store.snapshot(0).status.lastAckedRevision, 0);
});

test("aborts a service whose initial reconciliation RPC never resolves", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  let getStarted = false;
  const bb = {
    sdk: {
      plugins: {
        callRpc: async () => {
          getStarted = true;
          return await new Promise(() => {});
        },
      },
    },
  } as any;
  const controller = new AbortController();
  const running = new MachineMonitorReferenceDelivery(bb, store).start(controller.signal);
  while (!getStarted) await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await Promise.race([
    running.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]), true, "reconciliation must settle before the host stop bound");
});

test("a replacement service reclaims an unexpired in-flight lease", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_restart01")] }, 0);
  const oldGeneration = command(store, 0);
  const calls: string[] = [];
  const bb = {
    sdk: {
      plugins: {
        callRpc: async (args: { method: string; input?: { payloadDigest?: string } }) => {
          calls.push(args.method);
          if (args.method === "getProjection") return { projection: null };
          return { outcome: "applied", currentRevision: 1, currentDigest: args.input?.payloadDigest ?? oldGeneration.payloadDigest };
        },
      },
    },
  } as any;
  const controller = new AbortController();
  const running = new MachineMonitorReferenceDelivery(bb, store).start(controller.signal);
  while (!calls.includes("applyProjection")) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot(1).status.state, "synced");
  assert.deepEqual(calls, ["getProjection", "applyProjection"]);
  controller.abort();
  await running;
});

test("blocks semantically invalid receiver data and mismatched success acknowledgements", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  store.replaceAttachments({ expectedSourceRevision: 0, targets: [thread("thr_invalid01")] }, 0);
  const claimed = command(store, 0);
  assert.equal(store.recordResponse(claimed, {
    outcome: "applied",
    currentRevision: 1,
    currentDigest: "b".repeat(64),
  }, 1), "blocked");
  assert.equal(store.snapshot(1).status.state, "blocked");
  assert.equal(store.snapshot(1).status.errorKind, "blocked");

  const invalidTarget = canonicalizeResource({
    provider: "github",
    keys: { owner: "example", repo: "repo", issue: "1" },
    presentation: { label: "Not a BB thread" },
  });
  const source = canonicalizeResource(machineMonitorResource());
  const invalidProjection = {
    producerPluginId: "machine-monitor",
    source: machineMonitorResource(),
    revision: 1,
    mutationId: "123e4567-e89b-12d3-a456-426614174000",
    payloadDigest: projectionPayloadDigest("machine-monitor", source, false, [invalidTarget]),
    tombstone: false,
    targets: [{ provider: invalidTarget.provider, keys: invalidTarget.keys, presentation: invalidTarget.presentation }],
  };
  const bb = {
    sdk: {
      plugins: {
        callRpc: async () => ({ projection: invalidProjection }),
      },
    },
  } as any;
  const controller = new AbortController();
  const running = new MachineMonitorReferenceDelivery(bb, store).start(controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await running;
  assert.equal(store.snapshot(1).status.state, "blocked");
  assert.equal(store.snapshot(1).status.errorKind, "blocked");
});
