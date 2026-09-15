import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

import {
  hostCoreSampleSchema,
  hostDescriptionSchema,
  hostDirectorySampleSchema,
  hostMemoryDiagnosticSchema,
  hostRpcContract,
  HOST_CONTRACT_VERSION,
} from "./host-contract.ts";
import {
  collectDirectorySamples,
  collectMemoryDiagnostics,
  type DirectorySample,
  type MemoryDiagnosticState,
  type MonitoredDirectory,
} from "./monitor.ts";
import {
  createPlatformCollector,
  throwIfAborted,
  type PlatformCollector,
} from "./platform-collectors.ts";

export interface MachineMonitorHostDependencies {
  readonly now: () => number;
  readonly createPlatformCollector: () => PlatformCollector;
  readonly collectDirectorySamples: (
    collectedAt?: number,
    signal?: AbortSignal,
    directories?: readonly MonitoredDirectory[],
  ) => Promise<DirectorySample[]>;
  readonly collectMemoryDiagnostics: (
    previous: MemoryDiagnosticState | null,
    collectedAt?: number,
    signal?: AbortSignal,
    options?: { includeProcesses?: boolean; includeProcessDetails?: boolean },
  ) => Promise<{
    diagnostics: Awaited<ReturnType<typeof collectMemoryDiagnostics>>["diagnostics"];
    state: MemoryDiagnosticState;
  }>;
}

const defaultDependencies: MachineMonitorHostDependencies = {
  now: () => Date.now(),
  createPlatformCollector: () => createPlatformCollector(),
  collectDirectorySamples,
  collectMemoryDiagnostics,
};

function operationSignal(context: {
  readonly signal: AbortSignal;
  readonly lifecycle: { readonly signal: AbortSignal };
}): AbortSignal {
  return AbortSignal.any([context.signal, context.lifecycle.signal]);
}

function waitForTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Machine monitor host request aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DOMException("Machine monitor host request aborted", "AbortError"));
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void turn.then(finish, finish);
  });
}

/** Serialize only stateful collection lanes; directory work never waits on core. */
function createCollectionLane() {
  let tail = Promise.resolve();
  return async function run<T>(signal: AbortSignal, collect: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tail = previous.then(() => current, () => current);
    try {
      await waitForTurn(previous, signal);
      throwIfAborted(signal);
      return await collect();
    } finally {
      release?.();
    }
  };
}

/**
 * All collector state is captured by this factory, so it dies with the host
 * worker. The coordinator's cadence keeps an active worker naturally reusable;
 * this entry intentionally takes no retention lease and emits no signals.
 */
export function createMachineMonitorHostEntry(
  dependencies: MachineMonitorHostDependencies = defaultDependencies,
) {
  const collector = dependencies.createPlatformCollector();
  let coreState = collector.createSession();
  let memoryState: MemoryDiagnosticState | null = null;
  let directorySequence = 0;
  let memorySequence = 0;
  const collectCore = createCollectionLane();
  const collectMemory = createCollectionLane();

  return experimental_defineHostEntry({
    contract: hostRpcContract,
    handlers: {
      describe(_input, context) {
        const signal = operationSignal(context);
        throwIfAborted(signal);
        return hostDescriptionSchema.parse({
          contractVersion: HOST_CONTRACT_VERSION,
          collectorSessionId: coreState.collectorSessionId,
          observedAtMs: dependencies.now(),
          hostName: collector.metadata.hostName,
          platform: collector.metadata.platform,
          platformDetail: collector.metadata.platformDetail,
          capabilities: collector.metadata.capabilities,
        });
      },

      async coreSample(_input, context) {
        const signal = operationSignal(context);
        return collectCore(signal, async () => {
          const result = await collector.collectCore(coreState, {
            observedAtMs: dependencies.now(),
            signal,
          });
          throwIfAborted(signal);
          coreState = result.state;
          return hostCoreSampleSchema.parse(result.payload);
        });
      },

      async directorySample(input, context) {
        const signal = operationSignal(context);
        throwIfAborted(signal);
        const sequence = directorySequence++;
        const directory: MonitoredDirectory = {
          id: input.directoryId,
          label: input.directoryId,
          paths: input.paths,
        };
        const samples = await dependencies.collectDirectorySamples(
          dependencies.now(),
          signal,
          [directory],
        );
        throwIfAborted(signal);
        const sample = samples.find((candidate) => candidate.location === input.directoryId);
        return hostDirectorySampleSchema.parse(sample == null
          ? {
            contractVersion: HOST_CONTRACT_VERSION,
            collectorSessionId: coreState.collectorSessionId,
            sequence,
            observedAtMs: dependencies.now(),
            directoryId: input.directoryId,
            bytes: null,
            onRootFilesystem: null,
            partial: false,
            availability: "unavailable",
            reason: "No requested paths could be sampled.",
          }
          : {
            contractVersion: HOST_CONTRACT_VERSION,
            collectorSessionId: coreState.collectorSessionId,
            sequence,
            observedAtMs: sample.collectedAt,
            directoryId: input.directoryId,
            bytes: sample.bytes,
            onRootFilesystem: sample.onRootFilesystem,
            partial: sample.partial,
            availability: "available",
            reason: null,
          });
      },

      async memoryDiagnostics(input, context) {
        const signal = operationSignal(context);
        return collectMemory(signal, async () => {
          const result = await dependencies.collectMemoryDiagnostics(
            memoryState,
            dependencies.now(),
            signal,
            {
              // Process enumeration and attribution are both opt-in. The
              // ordinary diagnostics lane never reads process details.
              includeProcesses: input.includeProcessDetails,
              includeProcessDetails: input.includeProcessDetails,
            },
          );
          throwIfAborted(signal);
          memoryState = result.state;
          const output = hostMemoryDiagnosticSchema.parse({
            contractVersion: HOST_CONTRACT_VERSION,
            collectorSessionId: coreState.collectorSessionId,
            sequence: memorySequence,
            observedAtMs: result.diagnostics.collectedAt,
            processDetailsCollectedAtMs: result.diagnostics.processDetailsCollectedAt,
            sampleIntervalMs: result.diagnostics.sampleIntervalMs,
            pressureSomePercent: result.diagnostics.pressureSomePercent,
            pressureFullPercent: result.diagnostics.pressureFullPercent,
            swapInPagesPerSecond: result.diagnostics.swapInPagesPerSecond,
            swapOutPagesPerSecond: result.diagnostics.swapOutPagesPerSecond,
            refaultPagesPerSecond: result.diagnostics.refaultPagesPerSecond,
            reclaimPagesPerSecond: result.diagnostics.reclaimPagesPerSecond,
            bbCgroupMemoryBytes: result.diagnostics.bbCgroupMemoryBytes,
            processes: result.diagnostics.processes,
          });
          memorySequence += 1;
          return output;
        });
      },
    },
  });
}

export default createMachineMonitorHostEntry();
