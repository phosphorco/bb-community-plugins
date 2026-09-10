import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { SELECTED_EXECUTION_RUNTIME, deriveExecutionDatumKeys, parameterDeclarationDigestInput, sqlSha256Input } from "../../../../execution-contract.ts";

/**
 * Scheduler-only controls import the current production factory while replacing
 * node:child_process.spawn with a bounded in-memory child protocol. They prove
 * parent scheduling/cleanup wiring only: no DuckDB, SQLite, production child,
 * or normal-acceptance claim is involved.
 */
export async function runSchedulerControls({ fixture, makeInput, canonicalJson }) {
  return withMockedSpawn(async (mock) => {
    const { createQueryRuntime } = await import(new URL("../../../../query-runtime/index.mjs?unit=" + Date.now() + "-" + Math.random(), import.meta.url));
    const checks = [];
    checks.push(await closeBeforeDispatch(createQueryRuntime, fixture, makeInput, mock));
    checks.push(await privatePrepareLimitsAreExact(createQueryRuntime, fixture, makeInput, mock));
    checks.push(await sharedSubscriberIdentity(createQueryRuntime, fixture, makeInput, canonicalJson, mock));
    checks.push(await oversizedCacheDoesNotLoop(createQueryRuntime, fixture, makeInput, mock));
    checks.push(await lastAbortDetachesAndDrains(createQueryRuntime, fixture, makeInput, mock));
    checks.push(await earlyChildCloseFailsStartup(createQueryRuntime, fixture, makeInput, mock));
    return checks;
  });
}

async function withMockedSpawn(run) {
  const spawnMock = new MockSpawn();
  const originalKill = process.kill;
  mock.method(childProcess, "spawn", spawnMock.spawn);
  process.kill = (pid, signal) => {
    const child = spawnMock.children.find((candidate) => candidate.pid === Math.abs(pid));
    if (child) {
      child.close(null, signal);
      return true;
    }
    throw new Error("Unexpected mocked-child PID target.");
  };
  syncBuiltinESMExports();
  try {
    return await run(spawnMock);
  } finally {
    process.kill = originalKill;
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

async function closeBeforeDispatch(createQueryRuntime, fixture, makeInput, mock) {
  const gate = deferredGate();
  const input = await preAdmit(createQueryRuntime, fixture, makeInput, 1, "scheduler-close-before-dispatch");
  const priorSpawns = mock.calls.length;
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff, testControl: { beforeDispatch: gate.wait } });
  try {
    const pending = runtime.worker.execute(input, new AbortController().signal);
    const entered = await settleWithin(gate.entered(), 100);
    const closed = await settleWithin(runtime.close(), 100);
    const outcome = await settleWithin(pending, 100);
    return control("scheduler-close-before-dispatch-no-spawn", entered.kind === "fulfilled" && closed.kind === "fulfilled" && isError(outcome.value, "cancelled") && mock.calls.length === priorSpawns, "A close while the real factory is held before dispatch settles cancellation without spawning a new child.");
  } finally {
    gate.release();
    await runtime.close().catch(() => {});
  }
}

async function preAdmit(createQueryRuntime, fixture, makeInput, value, label) {
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff });
  try {
    return await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value }], fixture, label);
  } finally {
    await runtime.close().catch(() => {});
  }
}

// The child validates this private IPC object independently. This mocked-child
// control observes the exact message emitted by the current parent factory;
// it does not implement child limit policy or turn a bad shape into success.
async function privatePrepareLimitsAreExact(createQueryRuntime, fixture, makeInput, mock) {
  const before = mock.prepareMessages.length;
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff });
  try {
    const input = await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 6 }], fixture, "scheduler-private-limits");
    const outcome = await runtime.worker.execute(input, new AbortController().signal);
    const observed = mock.prepareMessages.slice(before);
    const exact = observed.length === 1 && hasExactKeys(observed[0]?.limits, childPrepareLimitKeys);
    return control("scheduler-private-prepare-limit-keys", outcome?.kind === "success" && exact, "The actual parent prepare IPC contained exactly the child-owned limit keys; scheduler/cache/retention limits were not forwarded.");
  } finally {
    await runtime.close().catch(() => {});
  }
}

async function sharedSubscriberIdentity(createQueryRuntime, fixture, makeInput, canonicalJson, mock) {
  const initialCalls = mock.calls.length;
  const gate = deferredGate();
  const events = [];
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff, observer: (event) => events.push(event), testControl: { beforeChildExecution: gate.wait } });
  try {
    const firstInput = await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 2 }], fixture, "scheduler-share-first");
    const secondInput = await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 2 }], fixture, "scheduler-share-second");
    const firstSignal = trackedSignal();
    const secondSignal = trackedSignal();
    const first = runtime.coordinator.subscribe(firstInput, firstSignal.signal);
    const entered = await settleWithin(gate.entered(), 100);
    const second = runtime.coordinator.subscribe(secondInput, secondSignal.signal);
    gate.release();
    const [left, right] = await Promise.all([first, second]);
    const leftResult = left?.kind === "success" ? left.result : null;
    const rightResult = right?.kind === "success" ? right.result : null;
    const dispatches = events.filter((event) => event.kind === "dispatch");
    const isolated = leftResult?.executionId === firstInput.resolved.executionId && rightResult?.executionId === secondInput.resolved.executionId
      && leftResult?.cache.physicalExecutionKey != null && leftResult.cache.physicalExecutionKey === rightResult?.cache.physicalExecutionKey
      && canonicalJson(leftResult?.result.datumKeys) === canonicalJson(deriveExecutionDatumKeys(firstInput.resolved.executionId, leftResult?.result.rows ?? []))
      && canonicalJson(rightResult?.result.datumKeys) === canonicalJson(deriveExecutionDatumKeys(secondInput.resolved.executionId, rightResult?.result.rows ?? []))
      && canonicalJson(leftResult?.result.datumKeys) !== canonicalJson(rightResult?.result.datumKeys);
    const listenersRemoved = firstSignal.added === firstSignal.removed && secondSignal.added === secondSignal.removed;
    return control("scheduler-physical-share-subscriber-identity", entered.kind === "fulfilled" && mock.calls.length === initialCalls + 1 && dispatches.length === 1 && isolated && listenersRemoved, "Two physical-sharing subscriptions retain separate execution IDs/datum keys and remove their completion listeners through the actual scheduler rebind path.");
  } finally {
    gate.release();
    await runtime.close().catch(() => {});
  }
}

async function oversizedCacheDoesNotLoop(createQueryRuntime, fixture, makeInput, mock) {
  const initialCalls = mock.calls.length;
  const events = [];
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff, resourceLimits: { cacheMaxBytes: 1 }, observer: (event) => events.push(event) });
  try {
    const first = await runtime.coordinator.subscribe(await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 3 }], fixture, "scheduler-cache-first"), new AbortController().signal);
    const second = await runtime.coordinator.subscribe(await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 3 }], fixture, "scheduler-cache-second"), new AbortController().signal);
    const dispatches = events.filter((event) => event.kind === "dispatch");
    const cache = events.filter((event) => event.kind === "cache");
    return control("scheduler-oversized-cache-no-loop", first?.kind === "success" && second?.kind === "success" && dispatches.length === 2 && cache.length === 0 && mock.calls.length === initialCalls + 1, "An oversized valid result is returned uncached without cache retry/eviction looping.");
  } finally {
    await runtime.close().catch(() => {});
  }
}

async function lastAbortDetachesAndDrains(createQueryRuntime, fixture, makeInput, mock) {
  const gate = deferredGate();
  const signal = trackedSignal();
  const input = await preAdmit(createQueryRuntime, fixture, makeInput, 4, "scheduler-last-abort");
  const initialCalls = mock.calls.length;
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff, testControl: { beforeDispatch: gate.wait } });
  try {
    const pending = runtime.coordinator.subscribe(input, signal.signal);
    const entered = await settleWithin(gate.entered(), 100);
    signal.abort();
    const outcome = await settleWithin(pending, 100);
    const closed = await settleWithin(runtime.close(), 100);
    return control("scheduler-last-abort-removes-listener-and-drains", entered.kind === "fulfilled" && isError(outcome.value, "cancelled") && closed.kind === "fulfilled" && signal.added === signal.removed && mock.calls.length === initialCalls, "Last-subscriber abort removes its actual listener and drains an unspawned job.");
  } finally {
    gate.release();
    await runtime.close().catch(() => {});
  }
}

async function earlyChildCloseFailsStartup(createQueryRuntime, fixture, makeInput, mock) {
  const initialCalls = mock.calls.length;
  mock.closeBeforeReady = true;
  const runtime = await createQueryRuntime({ trustedSource: fixture.handoff });
  try {
    const admission = await settleWithin(makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 5 }], fixture, "scheduler-early-close"), 100);
    return control("scheduler-early-child-close-startup-cleanup", admission.kind === "rejected" && mock.calls.length === initialCalls + 1 && mock.children.at(-1)?.closed === true, "An actual factory admission whose spawned child closes early rejects promptly and releases its child owner.");
  } finally {
    await runtime.close().catch(() => {});
    mock.closeBeforeReady = false;
  }
}

class MockSpawn {
  constructor() {
    this.calls = [];
    this.children = [];
    this.prepareMessages = [];
    this.closeBeforeReady = false;
    this.nextPid = 31_000;
    this.spawn = this.spawn.bind(this);
  }
  spawn() {
    const child = new MockChild(this.nextPid++, this.closeBeforeReady, this);
    this.calls.push(child);
    this.children.push(child);
    return child;
  }
}

class MockChild extends EventEmitter {
  constructor(pid, closeBeforeReady, owner) {
    super();
    this.pid = pid;
    this.connected = true;
    this.closed = false;
    this.closeBeforeReady = closeBeforeReady;
    this.owner = owner;
    this.prepared = new Map();
    queueMicrotask(() => {
      this.emit("spawn");
      if (this.closeBeforeReady) this.close(null, "SIGKILL");
    });
  }
  send(message, callback) {
    queueMicrotask(() => callback?.());
    if (this.closed) return false;
    if (message.kind === "bootstrap") {
      if (!this.closeBeforeReady) this.deliver({ kind: "ready", bootstrapFingerprint: bootstrapFingerprint() });
    } else if (message.kind === "admit") {
      this.deliver({
        kind: "admitted",
        token: message.token,
        admission: {
          astPolicyRevision: "a".repeat(64),
          astNodeCount: 1,
          sqlSha256: sha256(sqlSha256Input(message.sql)),
          parameterDeclarationDigest: sha256(parameterDeclarationDigestInput(message.parameters)),
          cacheability: message.cacheability,
        },
      });
    } else if (message.kind === "prepare") {
      this.owner.prepareMessages.push({ limits: message.limits });
      this.prepared.set(message.token, message);
      this.deliver({ kind: "started", token: message.token, materializationId: "d".repeat(64), childReadCount: 1, reused: false });
    } else if (message.kind === "continue") {
      const prepared = this.prepared.get(message.token);
      const value = prepared?.parameters?.find((parameter) => parameter.name === "value")?.value ?? 0;
      this.deliver({ kind: "result", token: message.token, columns: [{ name: "bound_value", logicalType: "integer", nullable: false }], rows: [{ bound_value: value }], truncated: false, elapsedMs: 0 });
    } else if (message.kind === "close") this.close(0, null);
    return true;
  }
  kill() { this.close(null, "SIGKILL"); }
  disconnect() { this.connected = false; }
  unref() {}
  deliver(message) { queueMicrotask(() => { if (!this.closed) this.emit("message", message); }); }
  close(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    queueMicrotask(() => this.emit("close", code, signal));
  }
}

function bootstrapFingerprint() {
  return createHash("sha256").update(canonicalJson({
    packageName: SELECTED_EXECUTION_RUNTIME.packageName,
    packageVersion: SELECTED_EXECUTION_RUNTIME.packageVersion,
    bootstrap: SELECTED_EXECUTION_RUNTIME.bootstrap,
  })).digest("hex");
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
const childPrepareLimitKeys = Object.freeze([
  "maxAstNodes",
  "maxColumns",
  "maxRows",
  "maxCells",
  "maxCellStringBytes",
  "maxCanonicalResultBytes",
  "maxTransferChunkBytes",
  "maxTransferRowsPerChunk",
  "materializationDeadlineMs",
]);
function hasExactKeys(value, keys) {
  return value != null && typeof value === "object"
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function deferredGate() {
  let enter, release;
  const enteredPromise = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  return { wait: async () => { enter(true); await held; }, entered: () => enteredPromise, release: () => release() };
}
function trackedSignal() {
  const target = new EventTarget();
  let aborted = false;
  let added = 0;
  let removed = 0;
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(type, listener, options) { if (type === "abort") added += 1; target.addEventListener(type, listener, options); },
      removeEventListener(type, listener, options) { if (type === "abort") removed += 1; target.removeEventListener(type, listener, options); },
    },
    abort() { aborted = true; target.dispatchEvent(new Event("abort")); },
    get added() { return added; },
    get removed() { return removed; },
  };
}
async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ kind: "fulfilled", value }), (reason) => ({ kind: "rejected", reason })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
function isError(outcome, code) { return outcome?.kind === "error" && outcome.error?.code === code; }
function control(id, pass, details) { return { id, status: pass ? "pass" : "fail", details }; }
function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}
