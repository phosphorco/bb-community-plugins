import { randomUUID } from "node:crypto";
import os from "node:os";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { MachineMonitorReferenceDelivery } from "./attachment-delivery.ts";
import {
  FleetCoordinator,
  legacySampleFromFleetCore,
  targetMonitoredDirectories,
  type FleetLane,
} from "./fleet-coordinator.ts";
import { FleetStore } from "./fleet-store.ts";
import { FLEET_CONTRACT_VERSION } from "./fleet-contract.ts";
import {
  type HostCoreSample,
  type HostDirectorySample,
  type HostMemoryDiagnostic,
  hostRpcContract,
} from "./host-contract.ts";
import {
  bucketSizeFor,
  collectDirectorySamples,
  collectMemoryDiagnostics,
  exclusiveDirectorySizes,
  MAX_MEMORY_DIAGNOSTICS_SNAPSHOTS,
  MEMORY_DIAGNOSTICS_RETENTION_MS,
  RETENTION_MS,
  type DirectorySample,
  type MemoryDiagnosticState,
  type MemoryDiagnostics,
  type MonitoredDirectory,
  withDirectoryHierarchy,
} from "./monitor.ts";
import { createPlatformCollector } from "./platform-collectors.ts";
import { rpcContract } from "./rpc-contract.ts";
import { MachineMonitorReferenceStore, MachineMonitorStore, machineMonitorMigrations } from "./store.ts";
import { SqliteTimelineQuerySource, TimelineQueryService } from "./timeline-query.ts";

const THREAD_SEARCH_LIMIT_PER_GROUP = 12;

/**
 * The original local-only tables and channels remain an application-facing
 * projection. Keeping this adapter small makes its write-before-notify order
 * explicit while FleetStore remains the coordinator's durable truth.
 */
export function createLegacyLocalProjection(
  store: MachineMonitorStore,
  publish: (channel: string, payload: Record<string, boolean | number>) => void,
  setLastError: (value: string | null) => void,
) {
  return {
    onLocalCollection(sample: HostCoreSample, normalizedAtMs: number): void {
      store.insert(legacySampleFromFleetCore(sample, normalizedAtMs));
      publish("machine-monitor-sample", { collectedAt: normalizedAtMs });
    },
    onLocalDirectories(details: readonly DirectorySample[]): void {
      store.insertDirectories([...details]);
      publish("machine-monitor-directories", { collectedAt: details.at(-1)?.collectedAt ?? Date.now() });
    },
    onLocalMemory(detail: MemoryDiagnostics): void {
      store.insertMemoryDiagnostics(detail);
      publish("machine-monitor-memory", { collectedAt: detail.collectedAt });
    },
    onLocalError(lane: FleetLane, message: string | null, occurredAtMs: number): void {
      // Historically only core sampling drove the overall local health error.
      if (lane !== "core") return;
      setLastError(message);
      if (message != null) publish("machine-monitor-sample", { collectedAt: occurredAtMs, error: true });
    },
    onLocalPrune(nowMs: number): void {
      store.prune(nowMs - RETENTION_MS);
      store.pruneMemoryDiagnostics(nowMs - MEMORY_DIAGNOSTICS_RETENTION_MS, MAX_MEMORY_DIAGNOSTICS_SNAPSHOTS);
    },
  };
}

function truncatePickerText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function threadPickerEntry(
  thread: { id: string; projectId: string; title: string | null; titleFallback: string | null; archivedAt: number | null },
  detail?: string,
) {
  const entry: { id: string; projectId: string; title: string; detail?: string; archived: boolean } = {
    id: thread.id,
    projectId: thread.projectId,
    title: truncatePickerText(thread.title || thread.titleFallback || `Thread ${thread.id}`, 256),
    archived: thread.archivedAt != null,
  };
  if (detail != null && detail.trim().length > 0) entry.detail = truncatePickerText(detail, 256);
  return entry;
}

export default async function machineMonitorPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    cpuWarningPercent: {
      type: "select" as const,
      label: "CPU warning threshold",
      description: "Warn when the rolling five-minute CPU average reaches this percentage. Short agent bursts do not alert.",
      options: ["70", "80", "90", "95"],
      default: "90",
    },
    ramWarningPercent: {
      type: "select" as const,
      label: "RAM warning threshold",
      description: "Warn when memory in use reaches this percentage; Linux cache remains available memory.",
      options: ["70", "80", "90", "95"],
      default: "90",
    },
    diskWarningPercent: {
      type: "select" as const,
      label: "Root disk warning threshold",
      description: "Warn when the root filesystem reaches this percentage. Cache-directory size trends remain diagnostics only.",
      options: ["70", "80", "90", "95"],
      default: "90",
    },
    showProcessDetails: {
      type: "boolean" as const,
      label: "Show process attribution",
      description: "Show local process names, PIDs, and inferred workloads in Memory pressure. Keep this off when panel readers should not see deployment-host workload details.",
      default: false,
    },
    additionalDirectories: {
      type: "string" as const,
      label: "Additional directory paths",
      description: "Optional absolute paths to measure, one per line (up to 32 paths and 16 KiB total). Paths on another filesystem are shown but are excluded from root-disk Other. Blank lines and # comments are ignored.",
      default: "",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, machineMonitorMigrations);
  const store = new MachineMonitorStore(db);
  const fleetStore = new FleetStore(db);
  const referenceStore = new MachineMonitorReferenceStore(db);
  const referenceDelivery = new MachineMonitorReferenceDelivery(bb, referenceStore);
  // Fleet reads are served from this shared, committed SQLite state only. In
  // particular, do not make a UI read (or machine switch) a collection prompt.
  // Overview freshness is intentionally calculated by TimelineQueryService on
  // each read rather than being cached at a wall-clock boundary.
  const timelineQueryService = new TimelineQueryService(
    fleetStore,
    new SqliteTimelineQuerySource(db),
    {
      attachmentSnapshot: () => referenceStore.snapshot(),
      warningThresholds: async () => {
        const configured = await settings.get();
        return {
          cpu: Number(configured.cpuWarningPercent),
          ram: Number(configured.ramWarningPercent),
          disk: Number(configured.diskWarningPercent),
        };
      },
    },
  );
  let lastError: string | null = null;
  // Await the stored value before registering/starting collection. The first
  // memory request must honor the user's privacy setting as well as later ones.
  let processDetailsEnabled = (await settings.get()).showProcessDetails;

  // This is the retained BB-server source. It implements the same
  // identity-free host contract as an enrolled daemon, while its identity is
  // still assigned by the coordinator rather than by its payload.
  const localCollector = createPlatformCollector();
  // The local source shares a durable machine identity across server reloads,
  // but its sequences are process-lifecycle scoped. Give every server load a
  // new server-assigned session so a restarted sequence zero cannot collide
  // with retained collection history.
  let localCoreState = localCollector.createSession(`local-bb-server:${randomUUID()}`);
  let localMemoryState: MemoryDiagnosticState | null = null;
  let localDirectorySequence = 0;
  let localMemorySequence = 0;
  const hostClient = bb.hosts.experimental_client({ contract: hostRpcContract });
  const localTarget = {
    label: "BB server",
    capabilities: localCollector.metadata.capabilities,
    async description(signal: AbortSignal) {
      if (signal.aborted) throw new DOMException("Local fleet description aborted", "AbortError");
      return {
        contractVersion: FLEET_CONTRACT_VERSION,
        collectorSessionId: localCoreState.collectorSessionId,
        observedAtMs: Date.now(),
        hostName: localCollector.metadata.hostName,
        platform: localCollector.metadata.platform,
        platformDetail: localCollector.metadata.platformDetail,
        capabilities: [...localCollector.metadata.capabilities],
      };
    },
    async core(signal: AbortSignal): Promise<HostCoreSample> {
      const result = await localCollector.collectCore(localCoreState, { observedAtMs: Date.now(), signal });
      localCoreState = result.state;
      return result.payload;
    },
    async directory(request: { directoryId: string; paths: readonly string[] }, signal: AbortSignal): Promise<HostDirectorySample> {
      const observedAtMs = Date.now();
      const sample = (await collectDirectorySamples(observedAtMs, signal, [{ id: request.directoryId, label: request.directoryId, paths: [...request.paths] }]))[0];
      const sequence = localDirectorySequence++;
      return sample == null
        ? {
          contractVersion: FLEET_CONTRACT_VERSION,
          collectorSessionId: localCoreState.collectorSessionId,
          sequence,
          observedAtMs,
          directoryId: request.directoryId,
          bytes: null,
          onRootFilesystem: null,
          partial: false,
          availability: "unavailable",
          reason: "No requested paths could be sampled.",
        }
        : {
          contractVersion: FLEET_CONTRACT_VERSION,
          collectorSessionId: localCoreState.collectorSessionId,
          sequence,
          observedAtMs: sample.collectedAt,
          directoryId: request.directoryId,
          bytes: sample.bytes,
          onRootFilesystem: sample.onRootFilesystem,
          partial: sample.partial,
          availability: "available",
          reason: null,
        };
    },
    async memory(request: { includeProcessDetails: boolean }, signal: AbortSignal): Promise<HostMemoryDiagnostic> {
      const result = await collectMemoryDiagnostics(localMemoryState, Date.now(), signal, {
        includeProcesses: request.includeProcessDetails,
        includeProcessDetails: request.includeProcessDetails,
      });
      localMemoryState = result.state;
      const diagnostics = result.diagnostics;
      const sequence = localMemorySequence++;
      return {
        contractVersion: FLEET_CONTRACT_VERSION,
        collectorSessionId: localCoreState.collectorSessionId,
        sequence,
        observedAtMs: diagnostics.collectedAt,
        processDetailsCollectedAtMs: diagnostics.processDetailsCollectedAt,
        sampleIntervalMs: diagnostics.sampleIntervalMs,
        pressureSomePercent: diagnostics.pressureSomePercent,
        pressureFullPercent: diagnostics.pressureFullPercent,
        swapInPagesPerSecond: diagnostics.swapInPagesPerSecond,
        swapOutPagesPerSecond: diagnostics.swapOutPagesPerSecond,
        refaultPagesPerSecond: diagnostics.refaultPagesPerSecond,
        reclaimPagesPerSecond: diagnostics.reclaimPagesPerSecond,
        bbCgroupMemoryBytes: diagnostics.bbCgroupMemoryBytes,
        processes: diagnostics.processes,
      };
    },
  };
  const fleetCoordinator = new FleetCoordinator({
    store: fleetStore,
    listEnrolledHosts: async (signal) => (await bb.sdk.hosts.list({ signal })).map(({ id, name, status }) => ({ id, name, status })),
    remote: (hostId) => ({
      description: (signal) => hostClient.call("describe", null, { hostId, signal }),
      core: (signal) => hostClient.call("coreSample", null, { hostId, signal }),
      directory: (request, signal) => hostClient.call("directorySample", { ...request, paths: [...request.paths] }, { hostId, signal }),
      memory: (request, signal) => hostClient.call("memoryDiagnostics", request, { hostId, signal }),
    }),
    local: localTarget,
    directories: async () => targetMonitoredDirectories((await settings.get()).additionalDirectories),
    includeProcessDetails: () => processDetailsEnabled,
    ...createLegacyLocalProjection(store, (channel, payload) => bb.realtime.publish(channel, payload), (value) => { lastError = value; }),
    publish: ({ machine, generation, kinds }) => {
      // FleetStore commits before it returns a generation. Invalidate the one
      // affected machine's detail cache (and the aggregate overview) before
      // advertising that committed revision to clients.
      timelineQueryService.invalidateMachine(machine, "all");
      bb.realtime.publish("machine-monitor-fleet", {
        machine,
        dataRevision: generation.dataRevision,
        settingsRevision: generation.settingsRevision,
        kinds,
      });
    },
    log: (_level, message) => bb.log.warn(message),
  });

  const configuredThresholds = async () => {
    const configured = await settings.get();
    return {
      cpu: Number(configured.cpuWarningPercent),
      ram: Number(configured.ramWarningPercent),
      disk: Number(configured.diskWarningPercent),
      showProcessDetails: configured.showProcessDetails,
    };
  };
  const withRollingCpu = <T extends { collectedAt: number; cpuPercent: number | null }>(samples: T[]) => {
    const window: T[] = [];
    let total = 0;
    return samples.map((sample) => {
      window.push(sample);
      if (sample.cpuPercent != null) total += sample.cpuPercent;
      while (window[0] != null && window[0].collectedAt < sample.collectedAt - 5 * 60_000) {
        const removed = window.shift()!;
        if (removed.cpuPercent != null) total -= removed.cpuPercent;
      }
      const count = window.reduce((sum, entry) => sum + (entry.cpuPercent == null ? 0 : 1), 0);
      return { ...sample, cpu5mPercent: count === 0 ? null : total / count };
    });
  };
  const snapshot = async (rangeHours: number) => {
    const now = Date.now();
    const since = now - rangeHours * 60 * 60_000;
    const samples = withRollingCpu(store.history(since, now));
    const cpuAverage = store.averageCpuSince(now - 5 * 60_000);
    const { showProcessDetails, ...thresholds } = await configuredThresholds();
    const latest = store.latest();
    const diskSamples = samples.filter((sample): sample is typeof sample & { diskUsedBytes: number } => sample.diskUsedBytes != null);
    const contiguousDiskSamples: Array<typeof diskSamples[number]> = [];
    const maxGap = bucketSizeFor(now - since) * 3;
    for (let index = diskSamples.length - 1; index >= 0; index -= 1) {
      const sample = diskSamples[index]!;
      const newest = contiguousDiskSamples[0];
      if (newest != null && newest.collectedAt - sample.collectedAt > maxGap) break;
      contiguousDiskSamples.unshift(sample);
    }
    const first = contiguousDiskSamples[0];
    const last = contiguousDiskSamples.at(-1);
    const diskGrowthBytesPerDay = first == null || last == null || last.collectedAt <= first.collectedAt
      ? null : (last.diskUsedBytes! - first.diskUsedBytes!) / (last.collectedAt - first.collectedAt) * 86_400_000;
    const configured = await settings.get();
    const monitoredDirectories: MonitoredDirectory[] = withDirectoryHierarchy(targetMonitoredDirectories(configured.additionalDirectories));
    const byId = new Map(monitoredDirectories.map((entry) => [entry.id, entry]));
    const parents = new Set(monitoredDirectories.map((entry) => entry.parentId).filter((id): id is string => id != null));
    const summariesById = new Map(store.directorySummary(since, now).map((entry) => [entry.location, { ...entry, id: entry.location }]));
    const summaries = monitoredDirectories.map((directory) => summariesById.get(directory.id)).filter((entry): entry is NonNullable<typeof entry> => entry != null);
    const directories = exclusiveDirectorySizes(summaries, monitoredDirectories).map((entry) => {
      const definition = byId.get(entry.id)!;
      const growthBytesPerDay = entry.firstCollectedAt >= entry.collectedAt ? null : (entry.exclusiveBytes - entry.exclusiveFirstBytes) / (entry.collectedAt - entry.firstCollectedAt) * 86_400_000;
      return { id: entry.id, label: parents.has(entry.id) ? `Other ${definition.label}` : definition.label, bytes: entry.exclusiveBytes, growthBytesPerDay, derived: parents.has(entry.id), partial: entry.partial === true, onRootFilesystem: entry.onRootFilesystem === true };
    });
    const rootMeasuredBytes = directories.filter((entry) => entry.onRootFilesystem).reduce((total, entry) => total + entry.bytes, 0);
    if (latest?.diskUsedBytes != null) directories.push({ id: "other", label: "Other /", bytes: Math.max(0, latest.diskUsedBytes - rootMeasuredBytes), growthBytesPerDay: null, derived: true, partial: false, onRootFilesystem: true });
    const memoryDiagnostics = store.latestMemoryDiagnostics();
    return {
      hostName: os.hostname(),
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      uptimeSeconds: Math.round(os.uptime()),
      latest: latest == null ? null : { ...latest, cpu5mPercent: cpuAverage },
      samples,
      thresholds,
      diskGrowthBytesPerDay,
      directories: directories.map(({ onRootFilesystem: _, ...entry }) => entry),
      memoryDiagnostics: memoryDiagnostics == null || showProcessDetails ? memoryDiagnostics : { ...memoryDiagnostics, processes: [] },
      processDetailsEnabled: showProcessDetails,
      lastError,
    };
  };

  const health = async () => {
    const latest = store.latest();
    const cpuAverage = store.averageCpuSince(Date.now() - 5 * 60_000);
    const overview = await timelineQueryService.fleetOverview({ contractVersion: FLEET_CONTRACT_VERSION });
    return {
      hostName: os.hostname(),
      latest: latest == null ? null : { ...latest, cpu5mPercent: cpuAverage },
      lastError,
      // The legacy/sidebar response remains an array of strings, but now
      // names each affected machine and exposes the precise fleet warning
      // category (offline, stale, collection error, capability, or metric).
      warnings: overview.machines.flatMap((machine) => machine.warnings.map(
        (warning) => `${machine.label} (${machine.machine.machineId}): ${warning.kind}: ${warning.message}`,
      )),
    };
  };
  bb.rpc.register(rpcContract, {
    health,
    snapshot: ({ rangeHours }) => snapshot(rangeHours),
    fleetOverview: (input) => timelineQueryService.fleetOverview(input),
    machineTimeline: (input) => timelineQueryService.machineTimeline(input),
    searchThreads: async ({ query }) => {
      const result = await bb.sdk.threads.search({
        query: query.trim(),
        limitPerGroup: String(THREAD_SEARCH_LIMIT_PER_GROUP),
      });
      const threads = [
        ...result.active.results.map((entry) => threadPickerEntry(entry.thread, entry.matches[0]?.text)),
        ...result.archived.results.map((entry) => threadPickerEntry(entry.thread, entry.matches[0]?.text)),
      ].slice(0, THREAD_SEARCH_LIMIT_PER_GROUP * 2);
      return { threads };
    },
    getThread: async ({ threadId }) => threadPickerEntry(await bb.sdk.threads.get({ threadId })),
    replaceAttachments: (input) => {
      const result = referenceStore.replaceAttachments(input);
      if (result.outcome === "applied") {
        referenceDelivery.wake();
        bb.realtime.publish("machine-monitor-attachments", { sourceRevision: result.snapshot.sourceRevision });
      }
      return {
        outcome: result.outcome,
        sourceRevision: result.snapshot.sourceRevision,
        targets: result.snapshot.targets,
        status: result.snapshot.status,
      };
    },
    getAttachments: () => referenceStore.snapshot(),
    attachmentStatus: () => referenceStore.snapshot().status,
  });
  settings.onChange(async () => {
    processDetailsEnabled = (await settings.get()).showProcessDetails;
    fleetCoordinator.settingsChanged();
    // Preserve the existing local snapshot invalidation for settings-only UI.
    bb.realtime.publish("machine-monitor-sample", { settingsChanged: true });
  });

  bb.background.service("machine-monitor-fleet", {
    async start(signal) {
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected") && typeof event.id === "string") fleetCoordinator.noteHostConnected(event.id);
          else fleetCoordinator.requestReconcile();
        },
      });
      const unsubscribeRealtime = bb.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected) fleetCoordinator.requestReconcile();
        },
      });
      const unsubscribeWorkerExit = hostClient.experimental_onWorkerExit(({ hostId }) => fleetCoordinator.noteWorkerExit(hostId));
      try {
        await fleetCoordinator.start(signal);
      } finally {
        unsubscribeWorkerExit();
        unsubscribeRealtime();
        unsubscribeHost();
      }
    },
  });

  bb.background.service("machine-monitor-cross-references", {
    start: (signal) => referenceDelivery.start(signal),
  });
}
