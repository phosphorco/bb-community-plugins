import { randomUUID } from "node:crypto";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

import { FLEET_CONTRACT_VERSION, FLEET_METRIC_CATALOG, type FleetMetricId } from "./fleet-contract.ts";
import type { HostCoreSample } from "./host-contract.ts";

/** Platforms supported by the daemon-facing host contract. */
export type CollectorPlatform = "darwin" | "linux" | "wsl" | "unknown";
export type CollectorCapability = "core-sampling" | "directory-sampling" | "memory-diagnostics" | "linux-memory-pressure" | "process-attribution";
export type CollectorCapabilityFact = {
  capability: CollectorCapability;
  state: "available" | "unavailable";
  reason: string | null;
};

const COLLECTOR_CAPABILITIES: readonly CollectorCapability[] = [
  "core-sampling",
  "directory-sampling",
  "memory-diagnostics",
  "linux-memory-pressure",
  "process-attribution",
];

export type CpuCounters = { total: number; idle: number };
export type MachineSample = {
  collectedAt: number;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  load1: number | null;
  load5: number | null;
};

type StatfsFacts = { bsize: number | bigint; blocks: number | bigint; bavail: number | bigint };
type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

/**
 * All OS access is supplied through this seam. Tests inject only the facts a
 * platform adapter needs; host workers use the Node implementations below.
 */
export type PlatformCollectorDependencies = {
  platform: () => string;
  release: () => string;
  hostname: () => string;
  uptime: () => number;
  loadavg: () => readonly number[];
  totalmem: () => number;
  freemem: () => number;
  cpus: () => readonly { times: CpuTimes }[];
  readText: (path: string, signal?: AbortSignal) => Promise<string>;
  statfs: (path: string) => Promise<StatfsFacts>;
};

export type PlatformRuntime = { nodePlatform: string; release: string };
export type PlatformMetadata = {
  hostName: string;
  platform: CollectorPlatform;
  /** Human-readable OS/kernel detail; bounded before it reaches host RPC. */
  platformDetail: string;
  /** OS uptime at the instant the core sample began, in seconds. */
  uptimeSeconds: number | null;
  capabilities: readonly CollectorCapability[];
  /** Closed, explicit availability facts; unknown platforms never imply support. */
  capabilityFacts: readonly CollectorCapabilityFact[];
};

export type CollectorSessionState = {
  collectorSessionId: string;
  /** Next core-sample sequence number for this worker session. */
  sequence: number;
  previousCpu: CpuCounters | null;
};

export type PlatformCoreFacts = {
  cpu: CpuCounters | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  load1: number | null;
  load5: number | null;
  uptimeSeconds: number | null;
};

export type PlatformAdapter = {
  readonly id: CollectorPlatform;
  matches(runtime: PlatformRuntime): boolean;
  capabilities(): readonly CollectorCapability[];
  collectCore(dependencies: PlatformCollectorDependencies, signal?: AbortSignal): Promise<PlatformCoreFacts>;
};

export type PlatformCoreResult = {
  sample: MachineSample;
  /** Identity-free, catalog-ordered payload for host RPC/fleet persistence. */
  payload: HostCoreSample;
  metadata: PlatformMetadata;
  state: CollectorSessionState;
};

export type PlatformCollector = {
  readonly metadata: PlatformMetadata;
  createSession(sessionId?: string): CollectorSessionState;
  collectCore(state: CollectorSessionState, options?: { observedAtMs?: number; signal?: AbortSignal }): Promise<PlatformCoreResult>;
};

function finiteNonnegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedText(value: string, fallback: string): string {
  const normalized = value.replace(/\p{Cc}/gu, " ").trim().slice(0, 256);
  return normalized.length > 0 ? normalized : fallback;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Machine monitor collection aborted", "AbortError");
}

/** Linux and WSL both expose the aggregate CPU counters through procfs. */
export function parseCpuCounters(source: string): CpuCounters | null {
  const line = source.split("\n").find((entry) => entry.startsWith("cpu "));
  if (line == null) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { total, idle: (fields[3] ?? 0) + (fields[4] ?? 0) };
}

export function parseMeminfo(source: string): { total: number; available: number } | null {
  const values = new Map<string, number>();
  for (const line of source.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match != null) values.set(match[1]!.toLowerCase(), Number(match[2]) * 1024);
  }
  const total = values.get("memtotal");
  const available = values.get("memavailable");
  return total != null && available != null ? { total, available } : null;
}

export function cpuPercent(previous: CpuCounters | null, current: CpuCounters): number | null {
  if (previous == null) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

function cpuCountersFromDarwin(cpus: readonly { times: CpuTimes }[]): CpuCounters | null {
  if (cpus.length === 0) return null;
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    const values = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
    total += values.reduce((sum, value) => sum + value, 0);
    idle += times.idle;
  }
  return total > 0 ? { total, idle } : null;
}

async function rootDisk(dependencies: PlatformCollectorDependencies, signal?: AbortSignal): Promise<Pick<PlatformCoreFacts, "diskUsedBytes" | "diskTotalBytes">> {
  throwIfAborted(signal);
  const filesystem = await dependencies.statfs("/").catch(() => null);
  throwIfAborted(signal);
  if (filesystem == null) return { diskUsedBytes: null, diskTotalBytes: null };
  const blockSize = Number(filesystem.bsize);
  const blocks = Number(filesystem.blocks);
  const availableBlocks = Number(filesystem.bavail);
  const diskTotalBytes = blocks * blockSize;
  const diskUsedBytes = (blocks - availableBlocks) * blockSize;
  return {
    diskUsedBytes: finiteNonnegative(diskUsedBytes),
    diskTotalBytes: finiteNonnegative(diskTotalBytes),
  };
}

function loadAndUptime(dependencies: PlatformCollectorDependencies): Pick<PlatformCoreFacts, "load1" | "load5" | "uptimeSeconds"> {
  const load = dependencies.loadavg();
  return {
    load1: finiteNonnegative(Number(load[0])),
    load5: finiteNonnegative(Number(load[1])),
    uptimeSeconds: finiteNonnegative(dependencies.uptime()),
  };
}

export const linuxPlatformAdapter: PlatformAdapter = {
  id: "linux",
  matches: (runtime) => runtime.nodePlatform === "linux" && !/microsoft|wsl/i.test(runtime.release),
  capabilities: () => ["core-sampling", "directory-sampling", "memory-diagnostics", "linux-memory-pressure", "process-attribution"],
  async collectCore(dependencies, signal) {
    throwIfAborted(signal);
    const [meminfoSource, cpuinfoSource, disk] = await Promise.all([
      dependencies.readText("/proc/meminfo", signal).catch(() => null),
      dependencies.readText("/proc/stat", signal).catch(() => null),
      rootDisk(dependencies, signal),
    ]);
    throwIfAborted(signal);
    const memory = meminfoSource == null ? null : parseMeminfo(meminfoSource);
    const cpu = cpuinfoSource == null ? null : parseCpuCounters(cpuinfoSource);
    return {
      cpu,
      memoryUsedBytes: memory == null ? null : finiteNonnegative(memory.total - memory.available),
      memoryTotalBytes: memory == null ? null : finiteNonnegative(memory.total),
      ...disk,
      ...loadAndUptime(dependencies),
    };
  },
};

export const wslPlatformAdapter: PlatformAdapter = {
  ...linuxPlatformAdapter,
  id: "wsl",
  matches: (runtime) => runtime.nodePlatform === "linux" && /microsoft|wsl/i.test(runtime.release),
};

export const darwinPlatformAdapter: PlatformAdapter = {
  id: "darwin",
  matches: (runtime) => runtime.nodePlatform === "darwin",
  // The legacy memory lane is procfs-only. Do not advertise a capability
  // until Darwin has a bounded diagnostic with meaningful semantics.
  capabilities: () => ["core-sampling", "directory-sampling"],
  async collectCore(dependencies, signal) {
    throwIfAborted(signal);
    const disk = await rootDisk(dependencies, signal);
    const total = finiteNonnegative(dependencies.totalmem());
    const free = finiteNonnegative(dependencies.freemem());
    const memoryUsedBytes = total == null || free == null ? null : finiteNonnegative(Math.max(0, total - free));
    return {
      cpu: cpuCountersFromDarwin(dependencies.cpus()),
      memoryUsedBytes,
      memoryTotalBytes: total,
      ...disk,
      ...loadAndUptime(dependencies),
    };
  },
};

/** Unknown platforms intentionally do no probing: every catalog metric says why it is absent. */
export const unknownPlatformAdapter: PlatformAdapter = {
  id: "unknown",
  matches: () => true,
  capabilities: () => [],
  async collectCore(_dependencies, signal) {
    throwIfAborted(signal);
    return {
      cpu: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      load1: null,
      load5: null,
      uptimeSeconds: null,
    };
  },
};

export const DEFAULT_PLATFORM_ADAPTERS: readonly PlatformAdapter[] = [linuxPlatformAdapter, wslPlatformAdapter, darwinPlatformAdapter];

function defaultDependencies(): PlatformCollectorDependencies {
  return {
    platform: os.platform,
    release: os.release,
    hostname: os.hostname,
    uptime: os.uptime,
    loadavg: os.loadavg,
    totalmem: os.totalmem,
    freemem: os.freemem,
    cpus: os.cpus,
    readText: (path, signal) => readFile(path, { encoding: "utf8", signal }),
    statfs: (path) => statfs(path),
  };
}

function observation(metricId: FleetMetricId, value: number | null, unavailableReason: string): HostCoreSample["metrics"][number] {
  const safeValue = value == null ? null : finiteNonnegative(value);
  return safeValue == null
    ? { metricId, value: null, availability: { state: "unavailable", reason: unavailableReason } }
    : { metricId, value: safeValue, availability: { state: "available", reason: null } };
}

function metricObservations(platform: CollectorPlatform, facts: PlatformCoreFacts): HostCoreSample["metrics"] {
  const platformReason = platform === "unknown" ? "Core sampling is unavailable on this platform." : "The platform did not expose this metric.";
  const values: Partial<Record<FleetMetricId, number | null>> = {
    "cpu.utilization.percent": facts.cpu == null ? null : undefined,
    "memory.used.bytes": facts.memoryUsedBytes,
    "memory.total.bytes": facts.memoryTotalBytes,
    "disk.root.used.bytes": facts.diskUsedBytes,
    "disk.root.total.bytes": facts.diskTotalBytes,
    "load.1": facts.load1,
    "load.5": facts.load5,
  };
  const metrics: HostCoreSample["metrics"] = [];
  for (const metric of FLEET_METRIC_CATALOG) {
    const metricId = metric.id;
    if (metricId === "memory.pressure.some.percent" || metricId === "memory.pressure.full.percent" || metricId === "memory.swap.in.pages-per-second" || metricId === "memory.swap.out.pages-per-second") {
      metrics.push(platform === "linux" || platform === "wsl"
        ? { metricId, value: null, availability: { state: "not-collected", reason: "Collected by the Linux memory diagnostics lane." } }
        : observation(metricId, null, platform === "unknown" ? platformReason : "Linux/WSL memory-pressure capability is unavailable."));
      continue;
    }
    metrics.push(observation(metricId, values[metricId] ?? null, platformReason));
  }
  return metrics;
}

function platformDetail(platform: CollectorPlatform, runtime: PlatformRuntime): string {
  const name = platform === "unknown" ? "Unknown platform" : platform === "wsl" ? "Windows Subsystem for Linux" : platform === "darwin" ? "Darwin" : "Linux";
  return boundedText(`${name} ${runtime.release}`, name);
}

function capabilityFacts(platform: CollectorPlatform, available: readonly CollectorCapability[]): readonly CollectorCapabilityFact[] {
  const supported = new Set(available);
  return COLLECTOR_CAPABILITIES.map((capability) => supported.has(capability)
    ? { capability, state: "available", reason: null }
    : {
      capability,
      state: "unavailable",
      reason: platform === "unknown"
        ? "This platform has no supported collector adapter."
        : capability === "linux-memory-pressure" || capability === "process-attribution"
          ? "This capability is available only on Linux/WSL."
          : "This platform adapter does not provide the capability.",
    });
}

/**
 * Creates an isolated collector for one worker lifecycle.  Passing `adapters`
 * lets a host implementation add a platform without changing monitor logic.
 *
 * Darwin semantics: CPU is the delta of aggregate `os.cpus()` times, memory
 * used is `totalmem - freemem` (not a Linux MemAvailable equivalent), root
 * disk uses `statfs("/")`, and load/uptime come from Node's `os` module.
 */
export function createPlatformCollector(
  overrides: Partial<PlatformCollectorDependencies> = {},
  adapters: readonly PlatformAdapter[] = DEFAULT_PLATFORM_ADAPTERS,
): PlatformCollector {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const runtime = { nodePlatform: dependencies.platform(), release: dependencies.release() };
  const adapter = adapters.find((candidate) => candidate.matches(runtime)) ?? unknownPlatformAdapter;
  const capabilities = adapter.capabilities();
  const metadata: PlatformMetadata = {
    hostName: boundedText(dependencies.hostname(), "unknown-host"),
    platform: adapter.id,
    platformDetail: platformDetail(adapter.id, runtime),
    uptimeSeconds: finiteNonnegative(dependencies.uptime()),
    capabilities,
    capabilityFacts: capabilityFacts(adapter.id, capabilities),
  };

  return {
    metadata,
    createSession: (sessionId = randomUUID()) => ({ collectorSessionId: boundedText(sessionId, randomUUID()), sequence: 0, previousCpu: null }),
    async collectCore(state, options = {}) {
      const observedAtMs = options.observedAtMs ?? Date.now();
      throwIfAborted(options.signal);
      const facts = await adapter.collectCore(dependencies, options.signal);
      throwIfAborted(options.signal);
      const currentCpuPercent = facts.cpu == null ? null : cpuPercent(state.previousCpu, facts.cpu);
      const sample: MachineSample = {
        collectedAt: observedAtMs,
        cpuPercent: currentCpuPercent,
        memoryUsedBytes: facts.memoryUsedBytes,
        memoryTotalBytes: facts.memoryTotalBytes,
        diskUsedBytes: facts.diskUsedBytes,
        diskTotalBytes: facts.diskTotalBytes,
        load1: facts.load1,
        load5: facts.load5,
      };
      const payload: HostCoreSample = {
        contractVersion: FLEET_CONTRACT_VERSION,
        collectorSessionId: state.collectorSessionId,
        sequence: state.sequence,
        hostObservedAtMs: observedAtMs,
        metrics: metricObservations(metadata.platform, { ...facts, cpu: facts.cpu == null ? null : facts.cpu }),
      };
      const cpuMetric = payload.metrics.find((metric) => metric.metricId === "cpu.utilization.percent");
      if (cpuMetric != null) {
        if (currentCpuPercent == null && metadata.platform !== "unknown") {
          cpuMetric.value = null;
          cpuMetric.availability = { state: "not-collected", reason: "CPU utilization requires a prior core sample." };
        } else if (currentCpuPercent != null) {
          cpuMetric.value = currentCpuPercent;
          cpuMetric.availability = { state: "available", reason: null };
        }
      }
      return {
        sample,
        payload,
        metadata: { ...metadata, uptimeSeconds: facts.uptimeSeconds },
        state: { collectorSessionId: state.collectorSessionId, sequence: state.sequence + 1, previousCpu: facts.cpu },
      };
    },
  };
}
