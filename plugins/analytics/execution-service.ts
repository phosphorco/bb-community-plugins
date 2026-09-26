import { BoundedExecutionStore } from "./execution-store.ts";
import type { AnalyticsSnapshotArtifact, AnalyticsSnapshotLease } from "./snapshot-provider.ts";
import { createHash } from "node:crypto";
import { analyticsSnapshotV1Schema } from "./execution-contract.ts";

export type AnalyticsSnapshotV1 = AnalyticsSnapshotArtifact;

export type ExecutionFailure = Readonly<{
  kind: "error";
  error: Readonly<{ code: "isolation-unavailable" | "cancelled" | "queue-full" | "worker-crashed" | "stale-snapshot"; retryable: boolean; message: string }>;
}>;
export type ExecutionSuccess<T> = Readonly<{ kind: "success"; value: T; cache: "hit" | "miss"; snapshot: Pick<AnalyticsSnapshotV1, "snapshotId" | "generationId" | "sourceGeneration" | "integrityDigest" | "coverage"> }>;
export type ExecutionOutcome<T> = ExecutionSuccess<T> | ExecutionFailure;

export interface AnalyticsSnapshotProvider {
  readSnapshot(input: Readonly<{ dataset: string; sourceScope: string }>): AnalyticsSnapshotLease | null | Promise<AnalyticsSnapshotLease | null>;
  releaseSnapshot(leaseId: string): Promise<void> | void;
}
export interface EnforcedWorker<Resolved, Result> {
  /** Must not expose a database path, host SDK, network, or operational RPC. */
  execute(input: Readonly<{ snapshot: AnalyticsSnapshotV1; resolved: Resolved }>, signal: AbortSignal): Promise<Result>;
  close?(): Promise<void>;
}
export interface IsolationGate {
  /** A deployment-owned proof; missing proof must deny before snapshot acquisition. */
  assertAvailable(): void | Promise<void>;
}
/**
 * Resolver-owned, structured physical identity. This is not a feature string:
 * the integration must derive these digests from admitted ResolvedExecution
 * fields (using canonicalPhysicalCacheKeyInput) before calling this service.
 */
export type PhysicalQueryIdentity = Readonly<{
  sqlSha256: string;
  astPolicyRevision: string;
  resultContractRevision: string;
  parameterDeclarationDigest: string;
  normalizedParametersSha256: string;
  maxRows: number;
  frozenStartInclusiveMs: number;
  frozenEndExclusiveMs: number;
}>;

type Scheduled<T> = Readonly<{ runtimeKey: string; bytes: number; execute: (signal: AbortSignal) => Promise<T>; signal?: AbortSignal; resolve: (value: T | ExecutionFailure) => void }>;

/** One scheduler exists per process-wide platform key, never per feature/runtime. */
class GlobalFairScheduler {
  #active = 0;
  #queuedBytes = 0;
  #queues = new Map<string, Scheduled<unknown>[]>();
  #roundRobin: string[] = [];
  readonly limits: Readonly<{ maxActive: number; maxQueued: number; maxQueuedBytes: number }>;
  constructor(limits: Readonly<{ maxActive: number; maxQueued: number; maxQueuedBytes: number }>) { this.limits = limits; }

  schedule<T>(item: Omit<Scheduled<T>, "resolve">): Promise<T | ExecutionFailure> {
    return new Promise((resolve) => {
      if (item.signal?.aborted) return resolve(cancelled());
      const queued = this.#totalQueued();
      if (queued >= this.limits.maxQueued || this.#queuedBytes + item.bytes > this.limits.maxQueuedBytes) {
        return resolve(queueFull());
      }
      const entry: Scheduled<T> = { ...item, resolve };
      const lane = this.#queues.get(item.runtimeKey) ?? [];
      if (!this.#queues.has(item.runtimeKey)) {
        this.#queues.set(item.runtimeKey, lane as Scheduled<unknown>[]);
        this.#roundRobin.push(item.runtimeKey);
      }
      lane.push(entry as Scheduled<unknown>);
      this.#queuedBytes += item.bytes;
      const removeIfQueued = () => {
        const index = lane.indexOf(entry as Scheduled<unknown>);
        if (index < 0) return;
        lane.splice(index, 1);
        this.#queuedBytes -= entry.bytes;
        entry.resolve(cancelled());
        this.#prune(item.runtimeKey);
      };
      item.signal?.addEventListener("abort", removeIfQueued, { once: true });
      this.#drain();
    });
  }
  #totalQueued() { return [...this.#queues.values()].reduce((total, lane) => total + lane.length, 0); }
  #prune(key: string) {
    if ((this.#queues.get(key)?.length ?? 0) !== 0) return;
    this.#queues.delete(key);
    this.#roundRobin = this.#roundRobin.filter((candidate) => candidate !== key);
  }
  #drain() {
    while (this.#active < this.limits.maxActive && this.#roundRobin.length) {
      const key = this.#roundRobin.shift()!;
      const lane = this.#queues.get(key);
      const item = lane?.shift();
      if (!item) { this.#prune(key); continue; }
      this.#queuedBytes -= item.bytes;
      if (lane!.length) this.#roundRobin.push(key); else this.#prune(key);
      if (item.signal?.aborted) { item.resolve(cancelled()); continue; }
      this.#active++;
      // The slot remains owned until execute settles. An abort only reaches the
      // worker; it is never mistaken for child exit/recovery confirmation.
      Promise.resolve(item.execute(item.signal ?? new AbortController().signal))
        .then((value) => item.resolve(value), () => item.resolve(workerCrashed()))
        .finally(() => { this.#active--; this.#drain(); });
    }
  }
}

type GlobalKernel = {
  scheduler: GlobalFairScheduler;
  cache: BoundedExecutionStore<unknown>;
  flights: Map<string, SharedFlight<unknown>>;
};
type SharedFlight<T> = {
  controller: AbortController;
  subscribers: Set<symbol>;
  promise: Promise<ExecutionOutcome<T>>;
};
const globalKernels = new Map<string, GlobalKernel>();
function getKernel(platformKey: string, limits: Readonly<{ maxActive: number; maxQueued: number; maxQueuedBytes: number; cacheEntries: number; cacheBytes: number; cacheTtlMs: number }>, now: () => number): GlobalKernel {
  const previous = globalKernels.get(platformKey);
  if (previous) {
    if (!sameLimits(previous.scheduler.limits, limits) ||
      previous.cache.limits.maxEntries !== limits.cacheEntries ||
      previous.cache.limits.maxBytes !== limits.cacheBytes ||
      previous.cache.limits.ttlMs !== limits.cacheTtlMs) {
      throw new Error("Conflicting execution limits for one process-wide platform key.");
    }
    return previous;
  }
  const next: GlobalKernel = {
    scheduler: new GlobalFairScheduler(limits),
    cache: new BoundedExecutionStore<unknown>({ maxEntries: limits.cacheEntries, maxBytes: limits.cacheBytes, ttlMs: limits.cacheTtlMs }, now),
    flights: new Map(),
  };
  globalKernels.set(platformKey, next);
  return next;
}

export function createExecutionService<Resolved, Result>(options: Readonly<{
  runtimeKey: string;
  platformKey?: string;
  dataset: string;
  sourceScope: string;
  snapshotProvider: AnalyticsSnapshotProvider;
  isolation: IsolationGate;
  worker: EnforcedWorker<Resolved, Result>;
  limits: Readonly<{ maxActive: number; maxQueued: number; maxQueuedBytes: number; cacheEntries: number; cacheBytes: number; cacheTtlMs: number }>;
  physicalIdentity(resolved: Resolved): PhysicalQueryIdentity;
  descriptorBytes(resolved: Resolved): number;
  resultBytes(result: Result): number;
  now?: () => number;
}>) {
  const now = options.now ?? Date.now;
  const kernel = getKernel(options.platformKey ?? "analytics-platform-v1", options.limits, now);

  async function execute(resolved: Resolved, signal?: AbortSignal): Promise<ExecutionOutcome<Result>> {
    try { await options.isolation.assertAvailable(); }
    catch { return isolationUnavailable(); }
    if (signal?.aborted) return cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let lease: AnalyticsSnapshotLease | null = null;
    let snapshot: AnalyticsSnapshotV1 | null = null;
    try {
      lease = await options.snapshotProvider.readSnapshot({ dataset: options.dataset, sourceScope: options.sourceScope });
      if (lease == null) return staleSnapshot();
      snapshot = lease.snapshot;
      assertSnapshot(snapshot, options.dataset, options.sourceScope);
      const key = physicalKey(snapshot, options.physicalIdentity(resolved));
      const cached = kernel.cache.get(key) as Result | null;
      if (cached != null) {
        await options.snapshotProvider.releaseSnapshot(lease.leaseId);
        lease = null;
        return success(cached, "hit", snapshot);
      }
      const existing = kernel.flights.get(key) as SharedFlight<Result> | undefined;
      if (existing) {
        await options.snapshotProvider.releaseSnapshot(lease.leaseId);
        lease = null;
        return await subscribe(existing, signal);
      }
      const jobController = new AbortController();
      const flight: SharedFlight<Result> = { controller: jobController, subscribers: new Set(), promise: Promise.resolve(workerCrashed()) };
      flight.promise = run(lease, key, resolved, jobController.signal);
      lease = null;
      kernel.flights.set(key, flight as SharedFlight<unknown>);
      // Do not clear a replacement flight installed after a crashed one.
      flight.promise.finally(() => { if (kernel.flights.get(key) === flight) kernel.flights.delete(key); }).catch(() => {});
      return await subscribe(flight, signal);
    } catch {
      return controller.signal.aborted ? cancelled() : workerCrashed();
    } finally {
      if (lease != null) await options.snapshotProvider.releaseSnapshot(lease.leaseId);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function run(lease: AnalyticsSnapshotLease, key: string, resolved: Resolved, signal: AbortSignal): Promise<ExecutionOutcome<Result>> {
    const snapshot = lease.snapshot;
    try {
      const outcome = await kernel.scheduler.schedule<Result>({ runtimeKey: options.runtimeKey, bytes: boundedBytes(options.descriptorBytes(resolved), options.limits.maxQueuedBytes), signal, execute: (sharedSignal) => options.worker.execute({ snapshot, resolved }, sharedSignal) });
      if (isFailure(outcome)) return outcome;
      kernel.cache.set(key, outcome, options.resultBytes(outcome));
      return success(outcome, "miss", snapshot);
    } finally {
      // Cancellation does not release the generation lease or scheduler slot
      // until worker.execute has returned/failed above.
      await options.snapshotProvider.releaseSnapshot(lease.leaseId);
    }
  }
  function subscribe(flight: SharedFlight<Result>, subscriberSignal?: AbortSignal): Promise<ExecutionOutcome<Result>> {
    const token = Symbol("analytics-execution-subscriber");
    flight.subscribers.add(token);
    return new Promise((resolve) => {
      let done = false;
      const detach = (outcome: ExecutionOutcome<Result>) => {
        if (done) return;
        done = true;
        subscriberSignal?.removeEventListener("abort", onAbort);
        flight.subscribers.delete(token);
        // This only requests child cancellation. run() keeps its scheduler slot
        // and snapshot lease until execute actually settles/exits.
        if (flight.subscribers.size === 0) flight.controller.abort();
        resolve(outcome);
      };
      const onAbort = () => detach(cancelled());
      subscriberSignal?.addEventListener("abort", onAbort, { once: true });
      if (subscriberSignal?.aborted) return onAbort();
      flight.promise.then((outcome) => detach(outcome), () => detach(workerCrashed()));
    });
  }
  return Object.freeze({ execute, close: () => options.worker.close?.() });
}

function assertSnapshot(snapshot: AnalyticsSnapshotV1, dataset: string, sourceScope: string): void {
  if (!analyticsSnapshotV1Schema.safeParse(snapshot).success ||
    snapshot.dataset !== dataset || snapshot.sourceScope !== sourceScope ||
    Buffer.byteLength(JSON.stringify(snapshot.facts), "utf8") !== snapshot.byteCount ||
    createHash("sha256").update(JSON.stringify({
      dataset: snapshot.dataset, sourceScope: snapshot.sourceScope,
      sourceGeneration: snapshot.sourceGeneration, factProjectionVersion: snapshot.factProjectionVersion,
      cursor: snapshot.cursor, facts: snapshot.facts, coverage: snapshot.coverage,
    })).digest("hex") !== snapshot.integrityDigest) {
    throw new Error("Invalid immutable analytics snapshot.");
  }
  // Provider coverage legitimately contains requestedFastPathDays; capability
  // key rejection applies to curated fact payloads, not those fixed schema keys.
  assertDataOnly(snapshot.facts);
}
const forbiddenArtifactKey = /(?:path|url|sdk|rpc|function|callback|database|handle|token|secret|credential|authorization)/iu;
function assertDataOnly(value: unknown): void {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) assertDataOnly(item); return; }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Analytics snapshot must contain plain JSON only.");
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenArtifactKey.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("Analytics snapshot contains a prohibited capability-shaped field.");
    }
    assertDataOnly(child);
  }
}
function physicalKey(snapshot: AnalyticsSnapshotV1, identity: PhysicalQueryIdentity): string {
  const hashes = [identity?.sqlSha256, identity?.astPolicyRevision, identity?.resultContractRevision,
    identity?.parameterDeclarationDigest, identity?.normalizedParametersSha256];
  if (!hashes.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
      !Number.isSafeInteger(identity?.maxRows) || identity.maxRows < 1 || identity.maxRows > 500 ||
      !Number.isSafeInteger(identity?.frozenStartInclusiveMs) || !Number.isSafeInteger(identity?.frozenEndExclusiveMs) ||
      identity.frozenEndExclusiveMs <= identity.frozenStartInclusiveMs) {
    throw new Error("A complete resolver-derived physical query identity is required.");
  }
  return createHash("sha256").update(canonicalJson({
    dataset: snapshot.dataset, sourceScope: snapshot.sourceScope, generationId: snapshot.generationId,
    sourceGeneration: snapshot.sourceGeneration, factProjectionVersion: snapshot.factProjectionVersion,
    integrityDigest: snapshot.integrityDigest, identity,
  })).digest("hex");
}
function sameLimits(left: Readonly<{ maxActive: number; maxQueued: number; maxQueuedBytes: number }>, right: Readonly<{ maxActive: number; maxQueued: number; maxQueuedBytes: number }>) {
  return left.maxActive === right.maxActive && left.maxQueued === right.maxQueued && left.maxQueuedBytes === right.maxQueuedBytes;
}
function boundedBytes(value: number, maximum: number) { return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : maximum + 1; }
function isFailure(value: unknown): value is ExecutionFailure { return !!value && typeof value === "object" && (value as { kind?: string }).kind === "error"; }
function success<T>(value: T, cache: "hit" | "miss", snapshot: AnalyticsSnapshotV1): ExecutionSuccess<T> { return Object.freeze({ kind: "success", value, cache, snapshot: { snapshotId: snapshot.snapshotId, generationId: snapshot.generationId, sourceGeneration: snapshot.sourceGeneration, integrityDigest: snapshot.integrityDigest, coverage: snapshot.coverage } }); }
function error(code: ExecutionFailure["error"]["code"], retryable: boolean, message: string): ExecutionFailure { return Object.freeze({ kind: "error", error: Object.freeze({ code, retryable, message }) }); }
function isolationUnavailable() { return error("isolation-unavailable", true, "Analytics execution isolation is not available."); }
function cancelled() { return error("cancelled", false, "The execution subscription was cancelled."); }
function queueFull() { return error("queue-full", true, "The bounded execution queue is full."); }
function workerCrashed() { return error("worker-crashed", true, "The isolated worker could not complete the operation."); }
function staleSnapshot() { return error("stale-snapshot", true, "No retained analytics snapshot is available."); }
function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}
