import os from "node:os";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { MachineMonitorReferenceDelivery } from "./attachment-delivery.ts";
import { additionalDirectories, bucketSizeFor, collectDirectorySamples, collectMemoryDiagnostics, collectSample, DIRECTORY_SAMPLE_INTERVAL_MS, exclusiveDirectorySizes, MAX_MEMORY_DIAGNOSTICS_SNAPSHOTS, MEMORY_DIAGNOSTICS_INTERVAL_MS, MEMORY_DIAGNOSTICS_RETENTION_MS, MEMORY_PRESSURE_CAPTURE_MS, MEMORY_PRESSURE_INTERVAL_MS, memoryPressureActive, MONITORED_DIRECTORIES, RETENTION_MS, SAMPLE_INTERVAL_MS, type CpuCounters, type MemoryDiagnosticState, type MonitoredDirectory, withDirectoryHierarchy } from "./monitor.ts";
import { rpcContract } from "./rpc-contract.ts";
import { MachineMonitorReferenceStore, MachineMonitorStore, machineMonitorMigrations } from "./store.ts";

const THREAD_SEARCH_LIMIT_PER_GROUP = 12;

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

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); done(); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default function machineMonitorPlugin(bb: BbPluginApi) {
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
  const referenceStore = new MachineMonitorReferenceStore(db);
  const referenceDelivery = new MachineMonitorReferenceDelivery(bb, referenceStore);
  let cpu: CpuCounters | null = null;
  let memoryState: MemoryDiagnosticState | null = null;
  let lastError: string | null = null;
  let processDetailsEnabled = false;
  void settings.get().then((configured) => { processDetailsEnabled = configured.showProcessDetails; });

  const percentage = (used: number | null, total: number | null) => used == null || total == null || total <= 0 ? null : used / total * 100;
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
  const warningSummary = (latest: ReturnType<MachineMonitorStore["latest"]>, cpuAverage: number | null, thresholds: Awaited<ReturnType<typeof configuredThresholds>>) => {
    if (lastError != null) return ["Collector unavailable"];
    if (latest == null) return [];
    const ram = percentage(latest.memoryUsedBytes, latest.memoryTotalBytes);
    const disk = percentage(latest.diskUsedBytes, latest.diskTotalBytes);
    return [
      cpuAverage != null && cpuAverage >= thresholds.cpu ? `CPU 5m average ${cpuAverage.toFixed(0)}% (threshold ${thresholds.cpu}%)` : null,
      ram != null && ram >= thresholds.ram ? `RAM ${ram.toFixed(0)}% (threshold ${thresholds.ram}%)` : null,
      disk != null && disk >= thresholds.disk ? `Root disk ${disk.toFixed(0)}% (threshold ${thresholds.disk}%)` : null,
    ].filter((warning): warning is string => warning != null);
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
    const monitoredDirectories: MonitoredDirectory[] = withDirectoryHierarchy([...MONITORED_DIRECTORIES, ...additionalDirectories(configured.additionalDirectories)]);
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
    const thresholds = await configuredThresholds();
    const cpuAverage = store.averageCpuSince(Date.now() - 5 * 60_000);
    return {
      hostName: os.hostname(),
      latest: latest == null ? null : { ...latest, cpu5mPercent: cpuAverage },
      lastError,
      warnings: warningSummary(latest, cpuAverage, thresholds),
    };
  };
  bb.rpc.register(rpcContract, {
    health,
    snapshot: ({ rangeHours }) => snapshot(rangeHours),
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
    bb.realtime.publish("machine-monitor-sample", { settingsChanged: true });
  });

  bb.background.service("machine-monitor-core", {
    start: async (signal) => {
      while (!signal.aborted) {
        const startedAt = Date.now();
        try {
          const result = await collectSample(cpu, startedAt);
          cpu = result.cpu;
          store.insert(result.sample);
          store.prune(startedAt - RETENTION_MS);
          lastError = null;
          bb.realtime.publish("machine-monitor-sample", { collectedAt: startedAt });
        } catch (cause) {
          lastError = cause instanceof Error ? cause.message : String(cause);
          bb.log.warn(`Could not collect local machine health: ${lastError}`);
          bb.realtime.publish("machine-monitor-sample", { collectedAt: startedAt, error: true });
        }
        await wait(Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - startedAt)), signal);
      }
    },
  });

  bb.background.service("machine-monitor-directories", {
    start: async (signal) => {
      while (!signal.aborted) {
        const startedAt = Date.now();
        try {
          const configured = await settings.get();
          const monitoredDirectories: MonitoredDirectory[] = withDirectoryHierarchy([...MONITORED_DIRECTORIES, ...additionalDirectories(configured.additionalDirectories)]);
          for (const directory of monitoredDirectories) {
            if (signal.aborted) break;
            // Persist each destination independently: a large worktree must not hide /tmp or the caches.
            store.insertDirectories(await collectDirectorySamples(startedAt, signal, [directory]));
          }
          store.prune(startedAt - RETENTION_MS);
          bb.realtime.publish("machine-monitor-directories", { collectedAt: startedAt });
        } catch (cause) {
          if (signal.aborted) break;
          bb.log.warn(`Could not collect local directory usage: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        await wait(Math.max(0, DIRECTORY_SAMPLE_INTERVAL_MS - (Date.now() - startedAt)), signal);
      }
    },
  });

  bb.background.service("machine-monitor-memory-pressure", {
    start: async (signal) => {
      let captureUntil = 0;
      let lastProcessRankingAt = 0;
      let nextPruneAt = 0;
      while (!signal.aborted) {
        const startedAt = Date.now();
        try {
          const includeProcesses = startedAt - lastProcessRankingAt >= MEMORY_DIAGNOSTICS_INTERVAL_MS;
          const result = await collectMemoryDiagnostics(memoryState, startedAt, signal, { includeProcesses, includeProcessDetails: processDetailsEnabled });
          memoryState = result.state;
          if (includeProcesses) lastProcessRankingAt = startedAt;
          store.insertMemoryDiagnostics(result.diagnostics);
          if (startedAt >= nextPruneAt) {
            store.pruneMemoryDiagnostics(startedAt - MEMORY_DIAGNOSTICS_RETENTION_MS, MAX_MEMORY_DIAGNOSTICS_SNAPSHOTS);
            nextPruneAt = startedAt + 5 * 60_000;
          }
          if (memoryPressureActive(result.diagnostics)) captureUntil = Math.max(captureUntil, startedAt + MEMORY_PRESSURE_CAPTURE_MS);
          bb.realtime.publish("machine-monitor-memory", { collectedAt: startedAt });
        } catch (cause) {
          if (signal.aborted) break;
          bb.log.warn(`Could not collect memory-pressure diagnostics: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        const interval = Date.now() < captureUntil ? MEMORY_PRESSURE_INTERVAL_MS : MEMORY_DIAGNOSTICS_INTERVAL_MS;
        await wait(Math.max(1_000, interval - (Date.now() - startedAt)), signal);
      }
    },
  });

  bb.background.service("machine-monitor-cross-references", {
    start: (signal) => referenceDelivery.start(signal),
  });
}
