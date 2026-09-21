import {
  FLEET_CONTRACT_VERSION,
  LOCAL_BB_SERVER_MACHINE_ID,
  type FleetMachineIdentity,
} from "./fleet-contract.ts";
import {
  type FleetMachineConnection,
  type FleetStore,
} from "./fleet-store.ts";
import {
  type HostCoreSample,
  type HostDescription,
  type HostDirectorySample,
  type HostMachineInventory,
  type HostMemoryDiagnostic,
} from "./host-contract.ts";
import {
  MEMORY_DIAGNOSTICS_INTERVAL_MS,
  MEMORY_PRESSURE_CAPTURE_MS,
  MEMORY_PRESSURE_INTERVAL_MS,
  MAX_ADDITIONAL_DIRECTORIES,
  MAX_ADDITIONAL_DIRECTORY_SETTING_BYTES,
  MONITORED_DIRECTORIES,
  RETENTION_MS,
  type DirectorySample,
  type MemoryDiagnostics,
  type MonitoredDirectory,
} from "./monitor.ts";

/** Collection intervals are deliberately independent; none is a prerequisite for another. */
export const FLEET_CORE_INTERVAL_MS = 30_000;
export const FLEET_DIRECTORY_INTERVAL_MS = 15 * 60_000;
export const FLEET_RECONCILE_INTERVAL_MS = 30_000;
export const FLEET_RPC_TIMEOUT_MS = 25_000;
export const FLEET_GLOBAL_CONCURRENCY = 8;
export const FLEET_CORE_RESERVED_SLOTS = 2;
export const FLEET_BACKOFF_MAX_MS = 5 * 60_000;
/** Retention is a fleet-wide maintenance pass, never part of a host lane. */
export const FLEET_RETENTION_INTERVAL_MS = 5 * 60_000;
/** Static context refreshes on start/reconnect and then at most once per day. */
export const FLEET_INVENTORY_INTERVAL_MS = 24 * 60 * 60_000;

const SCHEDULER_RETRY_MS = 100;
const JITTER_WINDOW_MS = 1_500;
const LOCAL_MACHINE: FleetMachineIdentity = {
  source: "local-bb-server",
  machineId: LOCAL_BB_SERVER_MACHINE_ID,
};

export type FleetLane = "describe" | "core" | "directory" | "memory" | "inventory";
export type FleetInvalidationKind = "machine" | "collection" | "directory" | "memory" | "inventory" | "error" | "settings" | "retention";

export type FleetInvalidation = {
  machine: FleetMachineIdentity;
  generation: { dataRevision: number; settingsRevision: number };
  kinds: readonly FleetInvalidationKind[];
};

export type EnrolledFleetHost = {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  /** Added by BB's machine-provider API; absent means an older persistent host. */
  type?: "persistent" | "ephemeral";
};

export type FleetCollectorTarget = {
  description: (signal: AbortSignal) => Promise<HostDescription>;
  core: (signal: AbortSignal) => Promise<HostCoreSample>;
  directory: (request: { directoryId: string; paths: readonly string[] }, signal: AbortSignal) => Promise<HostDirectorySample>;
  memory: (request: { includeProcessDetails: boolean }, signal: AbortSignal) => Promise<HostMemoryDiagnostic>;
  /** Optional only for legacy/test targets; production targets always implement it. */
  inventory?: (signal: AbortSignal) => Promise<HostMachineInventory>;
};

export type FleetCoordinatorDependencies = {
  store: FleetStore;
  listEnrolledHosts: (signal: AbortSignal) => Promise<readonly EnrolledFleetHost[]>;
  remote: (hostId: string) => FleetCollectorTarget;
  local: FleetCollectorTarget & { label: string; capabilities: readonly string[] };
  directories?: () => Promise<readonly MonitoredDirectory[]> | readonly MonitoredDirectory[];
  includeProcessDetails?: () => Promise<boolean> | boolean;
  publish?: (invalidation: FleetInvalidation) => void;
  log?: (level: "warn" | "debug", message: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Test seam; production uses the bounded public RPC deadline. */
  rpcTimeoutMs?: number;
  /** Compatibility projections are invoked only after canonical FleetStore commits. */
  onLocalCollection?: (sample: HostCoreSample, normalizedAtMs: number) => void;
  onLocalDirectories?: (details: readonly DirectorySample[]) => void;
  onLocalMemory?: (detail: MemoryDiagnostics) => void;
  /** `core` preserves the legacy sample-error refresh projection. */
  onLocalError?: (lane: FleetLane, message: string | null, occurredAtMs: number) => void;
  /** Legacy local retention is also scheduled by this coordinator, never per host call. */
  onLocalPrune?: (nowMs: number) => void;
};

type LaneState = {
  active: boolean;
  activeEpoch: number | null;
  /** Coalesces prompts received while this non-overlapping lane is active. */
  promptPending: boolean;
  dueAtMs: number;
  failures: number;
  sessionId: string | null;
  sequence: number;
  pressureUntilMs: number;
};

type TargetState = {
  machine: FleetMachineIdentity;
  label: string;
  connection: FleetMachineConnection;
  target: FleetCollectorTarget;
  capabilities: string[];
  platform: HostDescription["platform"] | null;
  currentSessionId: string | null;
  /** Cancels every lane from the prior observed worker lifecycle. */
  lifecycleEpoch: number;
  lifecycle: AbortController;
  lanes: Record<FleetLane, LaneState>;
};

function laneState(now: number): LaneState {
  return { active: false, activeEpoch: null, promptPending: false, dueAtMs: now, failures: 0, sessionId: null, sequence: -1, pressureUntilMs: 0 };
}

function targetKey(machine: FleetMachineIdentity): string {
  return `${machine.source}:${machine.machineId}`;
}

function normalizeEnrolledHosts(hosts: readonly EnrolledFleetHost[]): {
  hosts: EnrolledFleetHost[];
  conflictingIds: string[];
} {
  const byId = new Map<string, EnrolledFleetHost>();
  const conflictingIds = new Set<string>();
  for (const host of hosts) {
    const existing = byId.get(host.id);
    if (existing == null) {
      byId.set(host.id, host);
      continue;
    }
    // Host IDs should be unique. A contradictory directory response is not
    // authoritative enough to either delete history or schedule collection.
    if ((existing.type === "ephemeral") !== (host.type === "ephemeral")) conflictingIds.add(host.id);
  }
  return {
    hosts: [...byId.values()].filter((host) => !conflictingIds.has(host.id)),
    conflictingIds: [...conflictingIds],
  };
}

function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\s+/gu, " ").trim().slice(0, 512) || "Unknown fleet collector failure";
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function midpoint(sentAtMs: number, receivedAtMs: number): number {
  return sentAtMs + Math.floor((receivedAtMs - sentAtMs) / 2);
}

function boundedUncertainty(sentAtMs: number, receivedAtMs: number): number {
  return Math.min(60 * 60_000, Math.ceil(Math.max(0, receivedAtMs - sentAtMs) / 2));
}

function metricValue(sample: HostCoreSample, id: HostCoreSample["metrics"][number]["metricId"]): number | null {
  return sample.metrics.find((metric) => metric.metricId === id)?.value ?? null;
}

function localSample(sample: HostCoreSample, collectedAt: number) {
  return {
    collectedAt,
    cpuPercent: metricValue(sample, "cpu.utilization.percent"),
    memoryUsedBytes: metricValue(sample, "memory.used.bytes"),
    memoryTotalBytes: metricValue(sample, "memory.total.bytes"),
    diskUsedBytes: metricValue(sample, "disk.root.used.bytes"),
    diskTotalBytes: metricValue(sample, "disk.root.total.bytes"),
    load1: metricValue(sample, "load.1"),
    load5: metricValue(sample, "load.5"),
  };
}

/** A stable, host-specific offset prevents a fleet-wide thundering herd. */
export function deterministicJitter(machine: FleetMachineIdentity, lane: FleetLane, windowMs = JITTER_WINDOW_MS): number {
  const source = `${machine.source}:${machine.machineId}:${lane}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash >>> 0) % Math.max(1, windowMs);
}

/**
 * Keep configured paths opaque until the selected host performs the lookup.
 * In particular, a remote host must never receive a server-expanded home path.
 */
export function targetMonitoredDirectories(source: string): MonitoredDirectory[] {
  if (new TextEncoder().encode(source).byteLength > MAX_ADDITIONAL_DIRECTORY_SETTING_BYTES) {
    throw new Error(`Additional directory paths must total at most ${MAX_ADDITIONAL_DIRECTORY_SETTING_BYTES} bytes.`);
  }
  const paths = source.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (paths.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw new Error(`At most ${MAX_ADDITIONAL_DIRECTORIES} additional directory paths may be configured.`);
  }
  if (new Set(paths).size !== paths.length) throw new Error("Additional directory paths must be unique.");
  return [
    ...MONITORED_DIRECTORIES,
    ...paths.map((path, index) => ({
      id: `configured-${index}-${deterministicPathId(path)}`,
      label: path.slice(0, 256),
      paths: [path],
    })),
  ];
}

function deterministicPathId(path: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A small non-queueing global gate. Non-core lanes can never occupy the core
 * reserve, so a stalled directory walk cannot keep a different machine's core
 * sample from beginning. A lane that cannot enter simply retries shortly.
 */
class FleetConcurrencyGate {
  private active = 0;
  private nonCoreActive = 0;

  tryAcquire(lane: FleetLane): (() => void) | null {
    if (this.active >= FLEET_GLOBAL_CONCURRENCY) return null;
    const nonCore = lane !== "core";
    if (nonCore && this.nonCoreActive >= FLEET_GLOBAL_CONCURRENCY - FLEET_CORE_RESERVED_SLOTS) return null;
    this.active += 1;
    if (nonCore) this.nonCoreActive += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (nonCore) this.nonCoreActive -= 1;
    };
  }

  snapshot(): { active: number; nonCoreActive: number } {
    return { active: this.active, nonCoreActive: this.nonCoreActive };
  }
}

async function callWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
  registerTimedOutTransport: (settled: Promise<void>) => void,
): Promise<T> {
  const timeout = new AbortController();
  const combined = AbortSignal.any([parent, timeout.signal]);
  const abortError = () => parent.reason instanceof Error
    ? parent.reason
    : new DOMException("Fleet RPC cancelled", "AbortError");
  if (parent.aborted) throw abortError();
  let removeParentAbort: () => void = () => {};
  const parentCancellation = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError());
    parent.addEventListener("abort", onAbort, { once: true });
    removeParentAbort = () => parent.removeEventListener("abort", onAbort);
  });
  let rejectTimeout: ((cause: Error) => void) | null = null;
  const timeoutElapsed = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  // A host transport is allowed to ignore AbortSignal. Keep its eventual
  // rejection observed after the coordinator has already raced ahead. A
  // deadline specifically retains the physical concurrency slot until this
  // settles; ordinary lifecycle cancellation retains its existing fast path.
  const operation = Promise.resolve().then(() => call(combined));
  const settled = operation.then(() => undefined, () => undefined);
  const timer = setTimeout(() => {
    const cause = new Error("Fleet RPC timed out");
    timeout.abort(new DOMException(cause.message, "AbortError"));
    registerTimedOutTransport(settled);
    rejectTimeout?.(cause);
  }, timeoutMs);
  try {
    return await Promise.race([operation, parentCancellation, timeoutElapsed]);
  } finally {
    clearTimeout(timer);
    removeParentAbort();
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Fleet RPC completed", "AbortError"));
  }
}

/**
 * The sole durable-writer/scheduler for both the local BB server source and
 * authenticated persistent daemons. Responses contain no machine identity: the
 * target selected from `hosts.list` (or the reserved local source) always wins.
 */
export class FleetCoordinator {
  private readonly dependencies: Required<Pick<FleetCoordinatorDependencies, "directories" | "includeProcessDetails" | "now" | "setTimer" | "clearTimer" | "rpcTimeoutMs">> & FleetCoordinatorDependencies;
  private readonly targets = new Map<string, TargetState>();
  private readonly gate = new FleetConcurrencyGate();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private tickPromise: Promise<void> | null = null;
  private nextReconcileAtMs = 0;
  private nextRetentionAtMs = 0;
  private reconcileFailures = 0;
  private running = false;
  private parentAbort: (() => void) | null = null;
  private wakePending = false;
  private readonly promptHostIds = new Set<string>();
  private readonly pendingInvalidations = new Map<string, FleetInvalidation>();
  private lastNowMs: number | null = null;

  constructor(dependencies: FleetCoordinatorDependencies) {
    this.dependencies = {
      ...dependencies,
      directories: dependencies.directories ?? (() => MONITORED_DIRECTORIES),
      includeProcessDetails: dependencies.includeProcessDetails ?? (() => false),
      now: dependencies.now ?? Date.now,
      setTimer: dependencies.setTimer ?? setTimeout,
      clearTimer: dependencies.clearTimer ?? clearTimeout,
      rpcTimeoutMs: Math.max(1, dependencies.rpcTimeoutMs ?? FLEET_RPC_TIMEOUT_MS),
    };
  }

  /**
   * Wall time is suitable for durable timestamps but can move backwards. Keep
   * scheduler deadlines and request timing chronological within this process.
   */
  private now(): number {
    const observed = this.dependencies.now();
    const candidate = Number.isFinite(observed) ? Math.max(0, Math.floor(observed)) : (this.lastNowMs ?? 0);
    this.lastNowMs = Math.max(this.lastNowMs ?? candidate, candidate);
    return this.lastNowMs;
  }

  /** The background-service entry point. It does not retain any host workers. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Fleet coordinator is already running.");
    if (signal.aborted) return;
    this.running = true;
    const abort = () => this.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.parentAbort = () => signal.removeEventListener("abort", abort);
    try {
      await this.tick();
      await new Promise<void>((resolve) => {
        if (this.controller.signal.aborted) { resolve(); return; }
        this.controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      await this.stop();
    }
  }

  /** Prompt collection after a host connection/realtime recovery or settings update. */
  requestReconcile(): void {
    if (this.controller.signal.aborted) return;
    this.nextReconcileAtMs = this.now();
    this.wake();
  }

  /** A host lifecycle event is stronger than a periodic list diff: poll it now. */
  noteHostConnected(hostId: string): void {
    if (hostId.length === 0 || this.controller.signal.aborted) return;
    const state = this.targets.get(targetKey({ source: "enrolled-host", machineId: hostId }));
    // A host-connected edge can represent an unseen worker replacement. Make
    // it a lifecycle boundary even when the periodic directory still says
    // "connected", so an old in-flight response cannot cross the handoff.
    if (state != null) this.invalidateLifecycle(state, this.now());
    this.promptHostIds.add(hostId);
    this.requestReconcile();
  }

  /** Worker crashes retain current history but add a machine-scoped error and bounded retry. */
  noteWorkerExit(hostId: string): void {
    const state = this.targets.get(targetKey({ source: "enrolled-host", machineId: hostId }));
    if (state == null || this.controller.signal.aborted) return;
    this.invalidateLifecycle(state, this.now());
    state.lanes.core.dueAtMs = this.now() + this.backoff(state.lanes.core, FLEET_CORE_INTERVAL_MS);
    void this.recordFailure(state, "core", new Error("Host plugin worker exited unexpectedly."));
  }

  /**
   * Settings are durable machine metadata. Bump every registered machine
   * before notifying consumers, then bring the connected lanes forward.
   */
  settingsChanged(): void {
    if (this.controller.signal.aborted) return;
    const now = this.now();
    for (const machine of this.dependencies.store.machines()) {
      const generation = this.dependencies.store.advanceSettingsGeneration(machine.machine);
      this.publish(machine.machine, generation, ["settings"]);
      const state = this.targets.get(targetKey(machine.machine));
      if (state != null && state.connection !== "disconnected") this.schedulePrompt(state, now, false);
    }
    this.requestReconcile();
  }

  /** Test/support seam: force one due pass without waiting for a wall-clock timer. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  async whenIdle(): Promise<void> {
    while (this.activeTasks.size > 0) await Promise.allSettled([...this.activeTasks]);
  }

  inspect(): { timers: number; activeCalls: number; gate: { active: number; nonCoreActive: number } } {
    return { timers: this.timer == null ? 0 : 1, activeCalls: this.activeTasks.size, gate: this.gate.snapshot() };
  }

  private wake(): void {
    if (!this.running) return;
    if (this.timer != null) {
      this.dependencies.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.tickPromise != null) {
      this.wakePending = true;
      return;
    }
    queueMicrotask(() => { void this.tick(); });
  }

  private arm(): void {
    if (!this.running || this.controller.signal.aborted) return;
    if (this.timer != null) this.dependencies.clearTimer(this.timer);
    const now = this.now();
    const due = [this.nextReconcileAtMs, ...[...this.targets.values()].flatMap((state) => Object.values(state.lanes).map((lane) => lane.active ? Number.POSITIVE_INFINITY : lane.dueAtMs))]
      .reduce((soonest, candidate) => Math.min(soonest, candidate), Number.POSITIVE_INFINITY);
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, Math.min(60_000, due - now)));
  }

  private async tick(): Promise<void> {
    if (this.tickPromise != null) return this.tickPromise;
    const running = this.tickWork();
    this.tickPromise = running;
    void running.then(
      () => this.finishTick(running),
      () => this.finishTick(running),
    );
    return running;
  }

  private finishTick(tick: Promise<void>): void {
    if (this.tickPromise !== tick) return;
    this.tickPromise = null;
    if (!this.wakePending || this.controller.signal.aborted) return;
    this.wakePending = false;
    this.wake();
  }

  private async tickWork(): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.flushPendingInvalidations();
    if (this.nextReconcileAtMs <= this.now()) await this.reconcile();
    if (this.controller.signal.aborted) return;
    const now = this.now();
    if (this.nextRetentionAtMs <= now) this.prune(now);
    for (const state of this.targets.values()) {
      if (state.connection === "disconnected") continue;
      for (const lane of ["describe", "core", "directory", "memory", "inventory"] as const) {
        if (lane === "inventory" && state.target.inventory == null) continue;
        if (lane === "inventory" && (state.currentSessionId == null || state.lanes.memory.sessionId !== state.currentSessionId)) continue;
        if (state.lanes[lane].dueAtMs <= now) this.launch(state, lane);
      }
    }
    this.arm();
  }

  private async reconcile(): Promise<void> {
    if (this.reconcilePromise != null) return this.reconcilePromise;
    const work = this.reconcileWork().finally(() => { this.reconcilePromise = null; });
    this.reconcilePromise = work;
    return work;
  }

  private async reconcileWork(): Promise<void> {
    const now = this.now();
    this.upsert(this.localState(now), now);
    try {
      const directory = normalizeEnrolledHosts(await this.dependencies.listEnrolledHosts(this.controller.signal));
      if (this.controller.signal.aborted) return;
      const listed = directory.hosts;
      for (const hostId of directory.conflictingIds) {
        const machine: FleetMachineIdentity = { source: "enrolled-host", machineId: hostId };
        const state = this.targets.get(targetKey(machine));
        if (state != null) {
          this.invalidateLifecycle(state, now);
          this.targets.delete(targetKey(machine));
        }
        this.promptHostIds.delete(hostId);
        this.dependencies.log?.("warn", `Quarantined conflicting Machine Monitor host directory records for ${hostId}`);
      }
      const activeIds = new Set(listed.map((host) => host.id));
      for (const hostId of directory.conflictingIds) activeIds.add(hostId);
      for (const host of listed.filter((candidate) => candidate.type === "ephemeral")) {
        const machine: FleetMachineIdentity = { source: "enrolled-host", machineId: host.id };
        const state = this.targets.get(targetKey(machine));
        if (state != null) {
          this.invalidateLifecycle(state, now);
          this.targets.delete(targetKey(machine));
        }
        this.promptHostIds.delete(host.id);
        const removed = this.dependencies.store.removeEnrolledMachine(machine);
        if (removed.removed) this.publish(machine, removed.generation, ["machine", "retention"]);
      }
      for (const host of listed.filter((candidate) => candidate.type !== "ephemeral")) {
        const machine: FleetMachineIdentity = { source: "enrolled-host", machineId: host.id };
        let state = this.targets.get(targetKey(machine));
        const wasConnected = state?.connection === "connected";
        if (state == null) {
          state = this.newState(machine, host.name, host.status === "connected" ? "connected" : "disconnected", this.dependencies.remote(host.id), now);
          this.targets.set(targetKey(machine), state);
        } else {
          const nextConnection: FleetMachineConnection = host.status === "connected" ? "connected" : "disconnected";
          if (state.connection !== "disconnected" && nextConnection === "disconnected") this.invalidateLifecycle(state, now);
          state.label = host.name;
          state.connection = nextConnection;
        }
        this.upsert(state, now);
        if (state.connection === "connected" && (!wasConnected || this.promptHostIds.delete(host.id))) this.schedulePrompt(state, now);
      }
      // A removed daemon remains a durable, stale summary rather than losing its history.
      for (const retained of this.dependencies.store.machines()) {
        if (retained.machine.source !== "enrolled-host" || activeIds.has(retained.machine.machineId)) continue;
        const state = this.targets.get(targetKey(retained.machine)) ?? this.newState(
          retained.machine,
          retained.label,
          "disconnected",
          this.dependencies.remote(retained.machine.machineId),
          now,
        );
        if (state.connection !== "disconnected") this.invalidateLifecycle(state, now);
        state.connection = "disconnected";
        state.capabilities = retained.capabilities;
        this.targets.set(targetKey(state.machine), state);
        this.upsert(state, now);
      }
      this.reconcileFailures = 0;
      this.nextReconcileAtMs = now + FLEET_RECONCILE_INTERVAL_MS;
    } catch (cause) {
      if (this.controller.signal.aborted || isAbort(cause)) return;
      this.reconcileFailures += 1;
      this.nextReconcileAtMs = now + Math.min(FLEET_BACKOFF_MAX_MS, FLEET_RECONCILE_INTERVAL_MS * 2 ** Math.min(8, this.reconcileFailures - 1));
      this.dependencies.log?.("warn", `Could not reconcile Machine Monitor fleet: ${errorText(cause)}`);
    }
  }

  private localState(now: number): TargetState {
    const existing = this.targets.get(targetKey(LOCAL_MACHINE));
    if (existing != null) return existing;
    const state = this.newState(LOCAL_MACHINE, this.dependencies.local.label, "local", this.dependencies.local, now);
    state.capabilities = [...this.dependencies.local.capabilities];
    this.targets.set(targetKey(LOCAL_MACHINE), state);
    return state;
  }

  private newState(machine: FleetMachineIdentity, label: string, connection: FleetMachineConnection, target: FleetCollectorTarget, now: number): TargetState {
    return {
      machine,
      label,
      connection,
      target,
      capabilities: [],
      platform: null,
      currentSessionId: null,
      lifecycleEpoch: 0,
      lifecycle: new AbortController(),
      lanes: { describe: laneState(now), core: laneState(now), directory: laneState(now), memory: laneState(now), inventory: laneState(now) },
    };
  }

  private schedulePrompt(state: TargetState, now: number, includeInventory = true): void {
    for (const [name, lane] of Object.entries(state.lanes) as Array<[FleetLane, LaneState]>) {
      if (name === "inventory" && !includeInventory) continue;
      this.promptLane(lane, now);
    }
  }

  private promptLane(lane: LaneState, now: number): void {
    if (lane.active) {
      lane.promptPending = true;
      return;
    }
    lane.dueAtMs = now;
  }

  /**
   * An exit/disconnect is a hard boundary: a transport may ignore AbortSignal,
   * so every result also carries this epoch through its final commit check.
   */
  private invalidateLifecycle(state: TargetState, now: number): void {
    state.lifecycleEpoch += 1;
    state.lifecycle.abort(new DOMException("Fleet target lifecycle changed", "AbortError"));
    state.lifecycle = new AbortController();
    state.currentSessionId = null;
    state.platform = null;
    for (const lane of Object.values(state.lanes)) {
      lane.sessionId = null;
      lane.sequence = -1;
      lane.pressureUntilMs = 0;
      if (!lane.active) lane.dueAtMs = now;
    }
  }

  private current(state: TargetState, epoch: number): boolean {
    return !this.controller.signal.aborted && state.lifecycleEpoch === epoch && !state.lifecycle.signal.aborted;
  }

  private laneSignal(state: TargetState): AbortSignal {
    return AbortSignal.any([this.controller.signal, state.lifecycle.signal]);
  }

  private upsert(state: TargetState, now: number): void {
    const result = this.dependencies.store.registerMachine({
      machine: state.machine,
      label: state.label,
      connection: state.connection,
      capabilities: state.capabilities,
      serverObservedAtMs: now,
    });
    if (result.changed) this.publish(state.machine, result.machine.generation, ["machine"]);
  }

  private launch(state: TargetState, lane: FleetLane): void {
    const laneState = state.lanes[lane];
    if (laneState.active || this.controller.signal.aborted) return;
    const release = this.gate.tryAcquire(lane);
    if (release == null) {
      laneState.dueAtMs = this.now() + SCHEDULER_RETRY_MS;
      return;
    }
    laneState.active = true;
    const epoch = state.lifecycleEpoch;
    laneState.activeEpoch = epoch;
    const timedOutTransports = new Set<Promise<void>>();
    const task = this.runLane(state, lane, epoch, (settled) => timedOutTransports.add(settled))
      .catch(() => undefined);
    this.activeTasks.add(task);
    void task.then(() => {
      this.activeTasks.delete(task);
      const releasePhysicalSlot = () => {
        release();
        if (laneState.activeEpoch === epoch) {
          laneState.active = false;
          laneState.activeEpoch = null;
          if (laneState.promptPending) {
            laneState.promptPending = false;
            laneState.dueAtMs = this.now();
          }
        }
        this.wake();
      };
      // Once shutdown begins, no replacement transport can be launched, so
      // releasing promptly preserves bounded shutdown even for a host that
      // never honours cancellation. While running, a timed-out transport
      // remains quarantined until it has physically settled.
      if (this.controller.signal.aborted) releasePhysicalSlot();
      else void Promise.allSettled([...timedOutTransports]).then(releasePhysicalSlot);
    });
  }

  private async runLane(state: TargetState, lane: FleetLane, epoch: number, registerTransport: (settled: Promise<void>) => void): Promise<void> {
    try {
      if (!this.current(state, epoch)) return;
      if (lane === "describe") await this.collectDescription(state, epoch, registerTransport);
      else if (lane === "core") await this.collectCore(state, epoch, registerTransport);
      else if (lane === "directory") await this.collectDirectories(state, epoch, registerTransport);
      else if (lane === "memory") await this.collectMemory(state, epoch, registerTransport);
      else await this.collectInventory(state, epoch, registerTransport);
      if (this.current(state, epoch)) {
        state.lanes[lane].failures = 0;
        this.scheduleNext(state, lane, this.now());
      }
    } catch (cause) {
      if (!this.current(state, epoch) || isAbort(cause)) return;
      await this.recordFailure(state, lane, cause);
    }
  }

  private async collectDescription(state: TargetState, epoch: number, registerTransport: (settled: Promise<void>) => void): Promise<void> {
    const description = await callWithTimeout((signal) => state.target.description(signal), this.laneSignal(state), this.dependencies.rpcTimeoutMs, registerTransport);
    if (!this.current(state, epoch)) return;
    // A late description from a prior worker cannot replace an already accepted core session.
    if (state.currentSessionId != null && state.currentSessionId !== description.collectorSessionId) return;
    state.currentSessionId = description.collectorSessionId;
    state.platform = description.platform;
    state.capabilities = [...description.capabilities].sort();
    this.upsert(state, this.now());
    this.promptLane(state.lanes.inventory, this.now());
  }

  private async collectCore(state: TargetState, epoch: number, registerTransport: (settled: Promise<void>) => void): Promise<void> {
    const sentAtMs = this.now();
    const payload = await callWithTimeout((signal) => state.target.core(signal), this.laneSignal(state), this.dependencies.rpcTimeoutMs, registerTransport);
    const receivedAtMs = this.now();
    if (!this.current(state, epoch)) return;
    const lane = state.lanes.core;
    if (lane.sessionId === payload.collectorSessionId && payload.sequence <= lane.sequence) return;
    // Core itself is non-overlapping. A changed session is a real new worker;
    // after accepting it, older description/detail responses are ignored.
    const sessionChanged = state.currentSessionId !== payload.collectorSessionId;
    lane.sessionId = payload.collectorSessionId;
    lane.sequence = payload.sequence;
    state.currentSessionId = payload.collectorSessionId;
    if (sessionChanged) {
      // Detail lanes never establish a session. Bring them forward so a fresh
      // worker is sampled promptly even if their first concurrent pass saw no
      // authoritative core session yet.
      this.promptLane(state.lanes.directory, receivedAtMs);
      this.promptLane(state.lanes.memory, receivedAtMs);
      this.promptLane(state.lanes.inventory, receivedAtMs);
    }
    const normalizedAtMs = midpoint(sentAtMs, receivedAtMs);
    const result = this.dependencies.store.recordCollection({
      machine: state.machine,
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: payload.collectorSessionId,
      sequence: payload.sequence,
      hostObservedAtMs: payload.hostObservedAtMs,
      metrics: payload.metrics,
      serverSentAtMs: sentAtMs,
      serverReceivedAtMs: receivedAtMs,
      normalizedAtMs,
      clockUncertaintyMs: boundedUncertainty(sentAtMs, receivedAtMs),
    });
    if (result.outcome === "inserted") {
      if (state.machine.source === "local-bb-server") {
        this.dependencies.onLocalCollection?.(payload, normalizedAtMs);
        this.dependencies.onLocalError?.("core", null, normalizedAtMs);
      }
      this.publish(state.machine, result.generation, ["collection"]);
    }
  }

  private async collectDirectories(state: TargetState, epoch: number, registerTransport: (settled: Promise<void>) => void): Promise<void> {
    const configured = await this.dependencies.directories();
    if (!this.current(state, epoch)) return;
    const batchSessionId = state.currentSessionId;
    if (batchSessionId == null) return;
    const lane = state.lanes.directory;
    let batchSequence = lane.sessionId === batchSessionId ? lane.sequence : -1;
    const details: DirectorySample[] = [];
    for (const directory of configured) {
      if (!this.current(state, epoch) || state.currentSessionId !== batchSessionId) return;
      const sentAtMs = this.now();
      const result = await callWithTimeout(
        (signal) => state.target.directory({ directoryId: directory.id, paths: directory.paths }, signal),
        this.laneSignal(state),
        this.dependencies.rpcTimeoutMs,
        registerTransport,
      );
      const receivedAtMs = this.now();
      if (!this.current(state, epoch) || state.currentSessionId !== batchSessionId) return;
      if (result.collectorSessionId !== batchSessionId || result.sequence <= batchSequence) return;
      batchSequence = result.sequence;
      if (result.availability !== "available" || result.bytes == null || result.onRootFilesystem == null) continue;
      details.push({
        collectedAt: midpoint(sentAtMs, receivedAtMs),
        location: directory.id,
        bytes: result.bytes,
        onRootFilesystem: result.onRootFilesystem,
        partial: result.partial,
      });
    }
    // A core result may have changed worker sessions while a prior directory
    // RPC was in flight. Validate the full batch immediately before its one
    // durable write; no mixed-session prefix is ever committed.
    if (!this.current(state, epoch) || state.currentSessionId !== batchSessionId) return;
    lane.sessionId = batchSessionId;
    lane.sequence = batchSequence;
    if (details.length === 0) return;
    const persisted = this.dependencies.store.recordDirectoryDetails(state.machine, details);
    if (persisted.inserted > 0) {
      if (state.machine.source === "local-bb-server") this.dependencies.onLocalDirectories?.(details);
      this.publish(state.machine, persisted.generation, ["directory"]);
    }
  }

  private async collectMemory(state: TargetState, epoch: number, registerTransport: (settled: Promise<void>) => void): Promise<void> {
    const sentAtMs = this.now();
    const includeProcessDetails = await this.dependencies.includeProcessDetails();
    const response = await callWithTimeout(
      (signal) => state.target.memory({ includeProcessDetails }, signal),
      this.laneSignal(state),
      this.dependencies.rpcTimeoutMs,
      registerTransport,
    );
    const receivedAtMs = this.now();
    if (!this.current(state, epoch)) return;
    if (!this.acceptSecondary(state, "memory", response.collectorSessionId, response.sequence)) return;
    const normalizedAtMs = midpoint(sentAtMs, receivedAtMs);
    const detail: MemoryDiagnostics = {
      collectedAt: normalizedAtMs,
      processDetailsCollectedAt: response.processDetailsCollectedAtMs == null ? null : normalizedAtMs,
      sampleIntervalMs: response.sampleIntervalMs,
      pressureSomePercent: response.pressureSomePercent,
      pressureFullPercent: response.pressureFullPercent,
      swapInPagesPerSecond: response.swapInPagesPerSecond,
      swapOutPagesPerSecond: response.swapOutPagesPerSecond,
      refaultPagesPerSecond: response.refaultPagesPerSecond,
      reclaimPagesPerSecond: response.reclaimPagesPerSecond,
      bbCgroupMemoryBytes: response.bbCgroupMemoryBytes,
      processes: response.processes,
    };
    // Core deliberately reports Linux/WSL pressure and swap as not-collected:
    // this independent lane owns their values and timing. Unsupported hosts
    // retain those core unavailable facts rather than gaining a null sample.
    const observation = state.platform === "linux" || state.platform === "wsl"
      ? {
        collectorSessionId: response.collectorSessionId,
        sequence: response.sequence,
        hostObservedAtMs: response.observedAtMs,
        serverSentAtMs: sentAtMs,
        serverReceivedAtMs: receivedAtMs,
        normalizedAtMs,
        clockUncertaintyMs: boundedUncertainty(sentAtMs, receivedAtMs),
        pressureSomePercent: response.pressureSomePercent,
        pressureFullPercent: response.pressureFullPercent,
        swapInPagesPerSecond: response.swapInPagesPerSecond,
        swapOutPagesPerSecond: response.swapOutPagesPerSecond,
      }
      : null;
    const persisted = observation == null
      ? this.dependencies.store.recordMemoryDetail(state.machine, detail)
      : this.dependencies.store.recordMemory(state.machine, observation, detail);
    if (persisted.outcome === "inserted") {
      if (state.machine.source === "local-bb-server") this.dependencies.onLocalMemory?.(detail);
      this.publish(state.machine, persisted.generation, ["memory"]);
    }
    if ((state.platform === "linux" || state.platform === "wsl")
      && ((response.pressureSomePercent ?? 0) >= 0.1 || (response.pressureFullPercent ?? 0) > 0)) {
      state.lanes.memory.pressureUntilMs = Math.max(state.lanes.memory.pressureUntilMs, normalizedAtMs + MEMORY_PRESSURE_CAPTURE_MS);
    }
  }

  private async collectInventory(state: TargetState, epoch: number, registerTransport: (settled: Promise<void>) => void): Promise<void> {
    // Description/core are authoritative for a host worker lifecycle. Avoid
    // accepting an inventory response from a worker we have not observed.
    // Inventory is informational. Let the first memory pass take the shared
    // non-core capacity so a static probe never delays operational telemetry.
    if (state.currentSessionId == null || state.lanes.memory.sessionId !== state.currentSessionId) {
      state.lanes.inventory.dueAtMs = this.now() + SCHEDULER_RETRY_MS;
      return;
    }
    if (state.target.inventory == null) {
      state.lanes.inventory.dueAtMs = this.now() + FLEET_INVENTORY_INTERVAL_MS;
      return;
    }
    const sentAtMs = this.now();
    const inventory = await callWithTimeout((signal) => state.target.inventory!(signal), this.laneSignal(state), this.dependencies.rpcTimeoutMs, registerTransport);
    const receivedAtMs = this.now();
    if (!this.current(state, epoch) || inventory.collectorSessionId !== state.currentSessionId) return;
    const persisted = this.dependencies.store.recordInventory({
      machine: state.machine,
      inventory,
      serverSentAtMs: sentAtMs,
      serverReceivedAtMs: receivedAtMs,
    });
    if (persisted.outcome !== "unchanged") this.publish(state.machine, persisted.generation, ["inventory"]);
  }

  private acceptSecondary(state: TargetState, laneName: "directory" | "memory", sessionId: string, sequence: number): boolean {
    const lane = state.lanes[laneName];
    // Do not let a detail lane establish a worker session. Core/describe own
    // that authority, so an old detail response racing a fresh worker restart
    // is discarded rather than becoming durable history.
    if (state.currentSessionId == null || state.currentSessionId !== sessionId) return false;
    if (lane.sessionId === sessionId && sequence <= lane.sequence) return false;
    lane.sessionId = sessionId;
    lane.sequence = sequence;
    return true;
  }

  private async recordFailure(state: TargetState, laneName: FleetLane, cause: unknown): Promise<void> {
    const lane = state.lanes[laneName];
    const now = this.now();
    const message = errorText(cause);
    lane.failures += 1;
    lane.dueAtMs = now + this.backoff(lane, this.intervalFor(laneName));
    const inventoryFailure = laneName === "inventory"
      ? this.dependencies.store.recordInventoryFailure(state.machine, message, now)
      : null;
    const result = this.dependencies.store.recordMachineError(state.machine, {
      errorId: `${laneName}-${now}-${lane.failures}`,
      occurredAtMs: now,
      kind: `collector-${laneName}`,
      message,
    });
    if (state.machine.source === "local-bb-server") this.dependencies.onLocalError?.(laneName, message, now);
    // A retained static profile can carry its own failure state. Publish that
    // fact with the ordinary collector error so clients refresh the profile
    // rather than continuing to present a silently successful old snapshot.
    if (result.outcome === "inserted") this.publish(state.machine, result.generation, inventoryFailure?.changed ? ["error", "inventory"] : ["error"]);
    else if (inventoryFailure?.changed) this.publish(state.machine, inventoryFailure.generation, ["inventory"]);
    this.dependencies.log?.("warn", `Machine Monitor ${laneName} collection failed for ${state.machine.machineId}: ${message}`);
  }

  private backoff(lane: LaneState, intervalMs: number): number {
    return Math.min(FLEET_BACKOFF_MAX_MS, Math.max(1_000, intervalMs) * 2 ** Math.min(8, Math.max(0, lane.failures)));
  }

  private intervalFor(lane: FleetLane): number {
    if (lane === "core" || lane === "describe") return FLEET_CORE_INTERVAL_MS;
    if (lane === "directory") return FLEET_DIRECTORY_INTERVAL_MS;
    if (lane === "inventory") return FLEET_INVENTORY_INTERVAL_MS;
    return MEMORY_DIAGNOSTICS_INTERVAL_MS;
  }

  private scheduleNext(state: TargetState, laneName: FleetLane, now: number): void {
    const lane = state.lanes[laneName];
    const base = laneName === "memory" && now < lane.pressureUntilMs && (state.platform === "linux" || state.platform === "wsl")
      ? MEMORY_PRESSURE_INTERVAL_MS
      : this.intervalFor(laneName);
    // The five-second pressure follow-up is intentionally exact; ordinary
    // periodic cycles receive a deterministic host/lane offset.
    lane.dueAtMs = now + base + (base === MEMORY_PRESSURE_INTERVAL_MS ? 0 : deterministicJitter(state.machine, laneName));
  }

  /**
   * Retention is intentionally independent from collection lanes. Compare
   * durable generations across the single FleetStore transaction, and only
   * then invalidate the affected machine caches.
   */
  private prune(now: number): void {
    this.nextRetentionAtMs = now + FLEET_RETENTION_INTERVAL_MS;
    try {
      const before = new Map(this.dependencies.store.machines().map((machine) => [
        targetKey(machine.machine),
        machine.generation.dataRevision,
      ]));
      const result = this.dependencies.store.prune(Math.max(0, now - RETENTION_MS));
      if (result.affectedMachines > 0) {
        for (const machine of this.dependencies.store.machines()) {
          if (before.get(targetKey(machine.machine)) !== machine.generation.dataRevision) {
            this.publish(machine.machine, machine.generation, ["retention"]);
          }
        }
      }
      this.dependencies.onLocalPrune?.(now);
    } catch (cause) {
      this.dependencies.log?.("warn", `Could not prune Machine Monitor fleet history: ${errorText(cause)}`);
    }
  }

  private publish(machine: FleetMachineIdentity, generation: { dataRevision: number; settingsRevision: number }, kinds: readonly FleetInvalidationKind[]): void {
    if (this.dependencies.publish == null) return;
    const key = targetKey(machine);
    const pending = this.pendingInvalidations.get(key);
    const invalidation: FleetInvalidation = pending == null ? { machine, generation, kinds } : {
      machine,
      generation: {
        dataRevision: Math.max(pending.generation.dataRevision, generation.dataRevision),
        settingsRevision: Math.max(pending.generation.settingsRevision, generation.settingsRevision),
      },
      kinds: [...new Set([...pending.kinds, ...kinds])],
    };
    try {
      // FleetStore methods commit synchronously before returning their generation.
      this.dependencies.publish(invalidation);
      this.pendingInvalidations.delete(key);
    } catch (cause) {
      this.pendingInvalidations.set(key, invalidation);
      this.dependencies.log?.("warn", `Could not publish Machine Monitor invalidation for ${machine.machineId}: ${errorText(cause)}`);
    }
  }

  private flushPendingInvalidations(): void {
    if (this.dependencies.publish == null || this.pendingInvalidations.size === 0) return;
    for (const invalidation of [...this.pendingInvalidations.values()]) {
      this.publish(invalidation.machine, invalidation.generation, invalidation.kinds);
    }
  }

  private async stop(): Promise<void> {
    this.running = false;
    this.parentAbort?.();
    this.parentAbort = null;
    if (!this.controller.signal.aborted) this.controller.abort();
    if (this.timer != null) {
      this.dependencies.clearTimer(this.timer);
      this.timer = null;
    }
    await this.whenIdle();
  }
}

export function legacySampleFromFleetCore(sample: HostCoreSample, collectedAt: number) {
  return localSample(sample, collectedAt);
}
