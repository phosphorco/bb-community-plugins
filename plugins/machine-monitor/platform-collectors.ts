import { randomUUID } from "node:crypto";
import { readFile, readdir, statfs } from "node:fs/promises";
import os from "node:os";

import { FLEET_CONTRACT_VERSION, FLEET_METRIC_CATALOG, type FleetMetricId } from "./fleet-contract.ts";
import type { HostCoreSample, HostMachineInventory } from "./host-contract.ts";

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
type CpuInfo = { times: CpuTimes; model?: string; speed?: number };
const MAX_INVENTORY_CPU_ENTRIES = 256;
const MAX_INVENTORY_DISKS = 24;

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
  cpus: () => readonly CpuInfo[];
  arch?: () => string;
  readText: (path: string, signal?: AbortSignal) => Promise<string>;
  readDirectory?: (path: string, signal?: AbortSignal) => Promise<readonly string[]>;
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
  collectInventory?: (sessionId: string, options?: { observedAtMs?: number; signal?: AbortSignal }) => Promise<HostMachineInventory>;
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

function cpuCountersFromDarwin(cpus: readonly CpuInfo[]): CpuCounters | null {
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

type InventoryAvailability = HostMachineInventory["cpu"]["availability"];
type InventoryDisk = HostMachineInventory["disks"][number];

function inventoryAvailability(state: InventoryAvailability["state"], reason: string | null): InventoryAvailability {
  return { state, reason: state === "available" ? null : reason ?? "This inventory fact is unavailable." };
}

function safeInventoryText(value: string | undefined | null, max = 256): string | null {
  if (value == null) return null;
  const text = value.replace(/\p{Cc}/gu, " ").trim().slice(0, max);
  return text.length === 0 ? null : text;
}

function parseOsRelease(source: string | null): { name: string; version: string | null } {
  if (source == null) return { name: "Linux", version: null };
  const facts = new Map<string, string>();
  for (const line of source.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (match == null) continue;
    const raw = match[2]!.replace(/^"|"$/gu, "");
    facts.set(match[1]!, raw);
  }
  return {
    name: safeInventoryText(facts.get("PRETTY_NAME") ?? facts.get("NAME"), 128) ?? "Linux",
    version: safeInventoryText(facts.get("VERSION_ID"), 128),
  };
}

function integerText(source: string | null): number | null {
  if (source == null || !/^\s*[0-9]+\s*$/u.test(source)) return null;
  const value = Number(source.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function linuxTopology(dependencies: PlatformCollectorDependencies, signal?: AbortSignal): Promise<{ physicalCores: number | null; packages: number | null }> {
  const entries = dependencies.readDirectory == null ? null : await dependencies.readDirectory("/sys/devices/system/cpu", signal).catch(() => null);
  throwIfAborted(signal);
  if (entries == null) return { physicalCores: null, packages: null };
  const cpus = entries.filter((entry) => /^cpu[0-9]+$/u.test(entry)).sort().slice(0, MAX_INVENTORY_CPU_ENTRIES);
  if (cpus.length === 0) return { physicalCores: null, packages: null };
  const values = await Promise.all(cpus.map(async (cpu) => {
    const [packageId, coreId] = await Promise.all([
      dependencies.readText(`/sys/devices/system/cpu/${cpu}/topology/physical_package_id`, signal).catch(() => null),
      dependencies.readText(`/sys/devices/system/cpu/${cpu}/topology/core_id`, signal).catch(() => null),
    ]);
    return { packageId: integerText(packageId), coreId: integerText(coreId) };
  }));
  throwIfAborted(signal);
  const complete = values.filter((value): value is { packageId: number; coreId: number } => value.packageId != null && value.coreId != null);
  if (complete.length === 0) return { physicalCores: null, packages: null };
  return {
    physicalCores: new Set(complete.map((value) => `${value.packageId}:${value.coreId}`)).size,
    packages: new Set(complete.map((value) => value.packageId)).size,
  };
}

async function linuxDisks(dependencies: PlatformCollectorDependencies, signal?: AbortSignal): Promise<{ disks: InventoryDisk[]; availability: InventoryAvailability }> {
  const entries = dependencies.readDirectory == null ? null : await dependencies.readDirectory("/sys/block", signal).catch(() => null);
  throwIfAborted(signal);
  if (entries == null) return { disks: [], availability: inventoryAvailability("unavailable", "Linux block inventory could not read sysfs.") };
  const devices = entries.filter((entry) => !/^(loop|ram|fd)/u.test(entry)).sort().slice(0, MAX_INVENTORY_DISKS);
  const disks = (await Promise.all(devices.map(async (device, index) => {
    const [sectors, model, rotational, readOnly] = await Promise.all([
      dependencies.readText(`/sys/block/${device}/size`, signal).catch(() => null),
      dependencies.readText(`/sys/block/${device}/device/model`, signal).catch(() => null),
      dependencies.readText(`/sys/block/${device}/queue/rotational`, signal).catch(() => null),
      dependencies.readText(`/sys/block/${device}/ro`, signal).catch(() => null),
    ]);
    const sectorCount = integerText(sectors);
    if (sectorCount == null || sectorCount > Math.floor(Number.MAX_SAFE_INTEGER / 512)) return null;
    const rotation = integerText(rotational);
    const readOnlyValue = integerText(readOnly);
    return {
      id: `disk-${index}`,
      kind: "block" as const,
      sizeBytes: sectorCount * 512,
      model: safeInventoryText(model, 256),
      rotational: rotation == null ? null : rotation !== 0,
      readOnly: readOnlyValue == null ? null : readOnlyValue !== 0,
    };
  }))).filter((disk) => disk != null) as InventoryDisk[];
  return disks.length > 0
    ? { disks, availability: inventoryAvailability("available", null) }
    : { disks: [], availability: inventoryAvailability("partial", "No enumerable Linux block devices were visible.") };
}

function parseMdstat(source: string | null): HostMachineInventory["raid"] {
  if (source == null) return { state: "unavailable", arrays: [], source: "unavailable", reason: "Linux md RAID status could not be read." };
  const arrays: Array<{ name: string; status: string }> = [];
  for (const line of source.split("\n")) {
    const match = /^(md[0-9A-Za-z_.-]+)\s*:\s*(.+)$/u.exec(line.trim());
    if (match == null || arrays.length >= 8) continue;
    const status = safeInventoryText(match[2], 256);
    if (status != null) arrays.push({ name: match[1]!, status });
  }
  return arrays.length > 0
    ? { state: "available", arrays, source: "linux-mdstat", reason: null }
    : { state: "not-detected", arrays: [], source: "linux-mdstat", reason: "No active Linux md arrays were reported; hardware RAID, LVM, and ZFS are not probed." };
}

async function collectInventory(
  platform: CollectorPlatform,
  dependencies: PlatformCollectorDependencies,
  sessionId: string,
  observedAtMs: number,
  signal?: AbortSignal,
): Promise<HostMachineInventory> {
  throwIfAborted(signal);
  if (platform === "unknown") {
    return {
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: sessionId,
      observedAtMs,
      visibility: "unknown",
      os: { name: "Unknown platform", version: null, kernel: null, architecture: null },
      cpu: { logicalCores: null, observedPhysicalCores: null, observedPackages: null, model: null, speedMHz: null, availability: inventoryAvailability("unavailable", "This platform has no inventory adapter.") },
      memory: { usableBytes: null, availability: inventoryAvailability("unavailable", "This platform has no inventory adapter.") },
      disks: [], disksAvailability: inventoryAvailability("unavailable", "This platform has no inventory adapter."),
      raid: { state: "unavailable", arrays: [], source: "unavailable", reason: "This platform has no inventory adapter." },
      location: { value: null, source: "unavailable" },
      limitations: ["Unknown platforms perform no inventory probes."],
    };
  }
  const cpuInfos = dependencies.cpus();
  const cpu = cpuInfos[0];
  const visibility: HostMachineInventory["visibility"] = platform === "wsl" ? "guest-visible" : "host-visible";
  const common = {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: sessionId,
    observedAtMs,
    visibility,
    cpu: {
      logicalCores: cpuInfos.length || null,
      observedPhysicalCores: null as number | null,
      observedPackages: null as number | null,
      model: safeInventoryText(cpu?.model, 256),
      speedMHz: finiteNonnegative(cpu?.speed ?? Number.NaN),
      availability: cpuInfos.length > 0 ? inventoryAvailability("available", null) : inventoryAvailability("unavailable", "Node did not expose logical CPU entries."),
    },
    memory: {
      usableBytes: finiteNonnegative(dependencies.totalmem()),
      availability: finiteNonnegative(dependencies.totalmem()) == null ? inventoryAvailability("unavailable", "The runtime did not expose visible memory.") : inventoryAvailability("available", null),
    },
    location: { value: null, source: "unavailable" as const },
  };
  if (platform === "darwin") {
    const disk = await rootDisk(dependencies, signal);
    const disks: InventoryDisk[] = disk.diskTotalBytes == null ? [] : [{ id: "disk-0", kind: "volume", sizeBytes: disk.diskTotalBytes, model: null, rotational: null, readOnly: null }];
    return {
      ...common,
      os: { name: "macOS", version: null, kernel: safeInventoryText(dependencies.release(), 256), architecture: safeInventoryText(dependencies.arch?.(), 128) },
      disks,
      disksAvailability: disks.length > 0 ? inventoryAvailability("partial", "Only the root volume capacity is available without a system profiler probe.") : inventoryAvailability("unavailable", "The root volume could not be inspected."),
      raid: { state: "unavailable", arrays: [], source: "unavailable", reason: "Darwin RAID inventory is not collected without a bounded system profiler adapter." },
      limitations: ["Physical CPU topology is unavailable without a Darwin sysctl adapter.", "Only the visible root volume is reported; device and RAID topology are unavailable."],
    };
  }
  const [osRelease, meminfo, topology, diskResult, mdstat] = await Promise.all([
    dependencies.readText("/etc/os-release", signal).catch(() => null),
    dependencies.readText("/proc/meminfo", signal).catch(() => null),
    linuxTopology(dependencies, signal),
    linuxDisks(dependencies, signal),
    dependencies.readText("/proc/mdstat", signal).catch(() => null),
  ]);
  throwIfAborted(signal);
  const osReleaseFacts = parseOsRelease(osRelease);
  const memory = meminfo == null ? null : parseMeminfo(meminfo);
  return {
    ...common,
    os: { name: osReleaseFacts.name, version: osReleaseFacts.version, kernel: safeInventoryText(dependencies.release(), 256), architecture: safeInventoryText(dependencies.arch?.(), 128) },
    cpu: { ...common.cpu, observedPhysicalCores: topology.physicalCores, observedPackages: topology.packages },
    memory: memory == null
      ? { usableBytes: null, availability: inventoryAvailability("unavailable", "Linux MemTotal could not be read.") }
      : { usableBytes: memory.total, availability: inventoryAvailability("available", null) },
    disks: diskResult.disks,
    disksAvailability: diskResult.availability,
    raid: parseMdstat(mdstat),
    limitations: platform === "wsl"
      ? ["CPU, memory, disk, and kernel facts describe the WSL guest/VM view, not the Windows host.", "Location is not inferred; configure it through trusted enrollment metadata when available."]
      : ["Linux CPU package/core identifiers are platform-dependent observed topology.", "Linux md status cannot establish hardware RAID, LVM, or ZFS topology.", "Location is not inferred; configure it through trusted enrollment metadata when available."],
  };
}

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
    arch: os.arch,
    readText: (path, signal) => readFile(path, { encoding: "utf8", signal }),
    readDirectory: async (path) => await readdir(path, { encoding: "utf8" }),
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
    async collectInventory(sessionId, options = {}) {
      return await collectInventory(adapter.id, dependencies, boundedText(sessionId, randomUUID()), options.observedAtMs ?? Date.now(), options.signal);
    },
  };
}
