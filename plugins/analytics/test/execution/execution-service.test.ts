import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createExecutionService, type AnalyticsSnapshotV1 } from "../../execution-service.ts";

const limits = Object.freeze({ maxActive: 1, maxQueued: 3, maxQueuedBytes: 1_024, cacheEntries: 4, cacheBytes: 1_024, cacheTtlMs: 60_000 });
const scope = "analytics-scope_execution_service";
function physicalIdentity(resolved: string) { return Object.freeze({ sqlSha256: createHash("sha256").update(resolved).digest("hex"), astPolicyRevision: "b".repeat(64), resultContractRevision: "c".repeat(64), parameterDeclarationDigest: "d".repeat(64), normalizedParametersSha256: "e".repeat(64), maxRows: 5, frozenStartInclusiveMs: 0, frozenEndExclusiveMs: 1 }); }

function snapshot(generation = 1, scopeKey: string = scope): AnalyticsSnapshotV1 {
  const dataset = "tool-execution-v1";
  const sourceGeneration = "source-" + generation;
  const facts = Object.freeze([] as const);
  const coverage = Object.freeze({ state: "complete" as const, asOfMs: 1, retainedAfterMs: 0, earliestRetainedInclusiveMs: 0, resetWatermark: null, sourceComplete: true, incompleteReasons: [], requestedFastPathDays: 7 as const, fastPathCoverage: "complete" as const, lastFailure: null });
  const integrityDigest = createHash("sha256").update(JSON.stringify({ dataset, sourceScope: scopeKey, sourceGeneration, factProjectionVersion: 1, cursor: "cursor", facts, coverage })).digest("hex");
  return Object.freeze({ format: "analytics-snapshot-v1", snapshotId: `analytics-snapshot_execution_service_${generation}_${scopeKey.slice(-4)}`, dataset, sourceScope: scopeKey, generationId: generation, sourceGeneration, factProjectionVersion: 1, cursor: "cursor", publishedAtMs: 1, rowCount: 0, byteCount: 2, integrityDigest, coverage, facts });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function service(runtimeKey: string, worker: { execute: (input: { snapshot: AnalyticsSnapshotV1; resolved: string }, signal: AbortSignal) => Promise<string> }, input = snapshot()) {
  return createExecutionService({
    runtimeKey,
    platformKey: "execution-service-test-" + runtimeKey.split("-")[0],
    dataset: "tool-execution-v1",
    sourceScope: input.sourceScope,
    snapshotProvider: { readSnapshot: async () => ({ leaseId: "lease-" + runtimeKey, snapshot: input }), releaseSnapshot: () => {} },
    isolation: { assertAvailable: () => {} },
    worker,
    limits,
    physicalIdentity: (resolved) => physicalIdentity(resolved),
    descriptorBytes: () => 10,
    resultBytes: (value) => value.length,
  });
}

test("generation-keyed result reuse crosses runtime instances but not scope/generation", async () => {
  let calls = 0;
  const worker = { execute: async ({ resolved }: { resolved: string }) => { calls++; return "answer:" + resolved; } };
  const first = service("reuse-a", worker);
  const second = service("reuse-b", worker);
  assert.equal((await first.execute("same")).kind, "success");
  const reused = await second.execute("same");
  assert.equal(reused.kind, "success");
  assert.equal(reused.kind === "success" && reused.cache, "hit");
  assert.equal(calls, 1);
  const newGeneration = service("reuse-c", worker, snapshot(2));
  await newGeneration.execute("same");
  const otherScope = service("reuse-d", worker, snapshot(2, "analytics-scope_execution_other"));
  await otherScope.execute("same");
  assert.equal(calls, 3);
});

test("one global fair queue bounds aggregate work across runtimes", async () => {
  const gate = deferred<string>();
  const order: string[] = [];
  const worker = { execute: async ({ resolved }: { resolved: string }) => { order.push(resolved); if (resolved === "a1") return await gate.promise; return resolved; } };
  const one = service("fair-one", worker);
  const two = service("fair-two", worker);
  const first = one.execute("a1");
  await new Promise((resolve) => setImmediate(resolve));
  const queuedA = one.execute("a2");
  const queuedB = two.execute("b1");
  gate.resolve("a1");
  await Promise.all([first, queuedA, queuedB]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
  // The next pair demonstrates round-robin: a queued second item cannot make
  // runtime one monopolize the platform after runtime two has joined.
  assert.equal((await one.execute("a3")).kind, "success");
});

test("cancellation holds the aggregate slot and snapshot lease until worker exit", async () => {
  const started = deferred<void>();
  const exit = deferred<string>();
  const leases: string[] = [];
  let active = 0;
  const worker = { execute: async ({ resolved }: { resolved: string }, signal: AbortSignal) => {
    active++; started.resolve();
    signal.addEventListener("abort", () => {}, { once: true });
    const value = await exit.promise;
    active--; return resolved + value;
  } };
  const instance = createExecutionService({
    runtimeKey: "cancel-runtime", platformKey: "execution-service-cancel", dataset: "tool-execution-v1",
    sourceScope: scope,
    snapshotProvider: { readSnapshot: async () => { const value = snapshot(); leases.push("+lease"); return { leaseId: "lease", snapshot: value }; }, releaseSnapshot: (id) => { leases.push("-" + id); } },
    isolation: { assertAvailable: () => {} }, worker, limits,
    physicalIdentity: (resolved) => physicalIdentity(resolved), descriptorBytes: () => 10, resultBytes: (value) => value.length,
  });
  const aborter = new AbortController();
  const pending = instance.execute("first", aborter.signal);
  await started.promise;
  aborter.abort();
  const second = instance.execute("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  assert.equal(leases.filter((item) => item.startsWith("-")).length, 0);
  exit.resolve("-done");
  await Promise.all([pending, second]);
  assert.equal(active, 0);
  assert.equal(leases.filter((item) => item.startsWith("-")).length, 2);
});

test("one cancelled subscriber does not abort a shared physical query", async () => {
  const started = deferred<void>();
  const exit = deferred<string>();
  const observed: { signal: AbortSignal | null } = { signal: null };
  let calls = 0;
  const worker = { execute: async ({ resolved }: { resolved: string }, signal: AbortSignal) => {
    calls++; observed.signal = signal; started.resolve(); return resolved + await exit.promise;
  } };
  const instance = service("shared-cancel", worker);
  const firstAbort = new AbortController();
  const first = instance.execute("same", firstAbort.signal);
  await started.promise;
  const second = instance.execute("same");
  await new Promise((resolve) => setImmediate(resolve));
  firstAbort.abort();
  const firstOutcome = await first;
  assert.equal(firstOutcome.kind, "error");
  assert.equal(firstOutcome.kind === "error" && firstOutcome.error.code, "cancelled");
  assert.equal(observed.signal?.aborted, false);
  exit.resolve("-done");
  assert.equal((await second).kind, "success");
  assert.equal(calls, 1);
});

test("missing isolation fails closed before snapshot acquisition", async () => {
  let reads = 0;
  const instance = createExecutionService({
    runtimeKey: "unavailable", platformKey: "execution-service-unavailable", dataset: "tool-execution-v1",
    sourceScope: scope,
    snapshotProvider: { readSnapshot: async () => { reads++; return { leaseId: "never", snapshot: snapshot() }; }, releaseSnapshot: () => {} },
    isolation: { assertAvailable: () => { throw new Error("no cgroup"); } },
    worker: { execute: async () => "unexpected" }, limits,
    physicalIdentity: () => physicalIdentity("unavailable"), descriptorBytes: () => 1, resultBytes: () => 1,
  });
  const outcome = await instance.execute("nope");
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.kind === "error" && outcome.error.code, "isolation-unavailable");
  assert.equal(reads, 0);
});

test("cached results are detached from a caller mutation", async () => {
  let calls = 0;
  const worker = { execute: async () => { calls++; return { nested: { value: 1 } }; } };
  const instance = createExecutionService({
    runtimeKey: "immutable", platformKey: "execution-service-immutable", dataset: "tool-execution-v1", sourceScope: scope,
    snapshotProvider: { readSnapshot: async () => ({ leaseId: "immutable-lease", snapshot: snapshot() }), releaseSnapshot: () => {} },
    isolation: { assertAvailable: () => {} }, worker, limits,
    physicalIdentity: () => physicalIdentity("immutable"), descriptorBytes: () => 1, resultBytes: () => 32,
  });
  const first = await instance.execute("immutable");
  assert.equal(first.kind, "success");
  if (first.kind === "success") first.value.nested.value = 99;
  const second = await instance.execute("immutable");
  assert.equal(second.kind, "success");
  assert.equal(second.kind === "success" && second.value.nested.value, 1);
  assert.equal(calls, 1);
});

test("conflicting process-wide limits are rejected", () => {
  const worker = { execute: async () => "ok" };
  service("limits-first", worker);
  assert.throws(() => createExecutionService({
    runtimeKey: "limits-second", platformKey: "execution-service-test-limits", dataset: "tool-execution-v1", sourceScope: scope,
    snapshotProvider: { readSnapshot: () => ({ leaseId: "limits", snapshot: snapshot() }), releaseSnapshot: () => {} },
    isolation: { assertAvailable: () => {} }, worker,
    limits: { ...limits, maxActive: 2 }, physicalIdentity: () => physicalIdentity("limits"), descriptorBytes: () => 1, resultBytes: () => 1,
  }), /Conflicting execution limits/);
});
