import assert from "node:assert/strict";
import test from "node:test";

import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

import {
  createMachineMonitorHostEntry,
  type MachineMonitorHostDependencies,
} from "../host.ts";
import type { MemoryDiagnosticState } from "../monitor.ts";
import type { PlatformCollector } from "../platform-collectors.ts";

function corePayload(sessionId: string, sequence: number, observedAtMs: number) {
  return {
    contractVersion: 1 as const,
    collectorSessionId: sessionId,
    sequence,
    hostObservedAtMs: observedAtMs,
    metrics: [],
  };
}

function sampleCollector(sessionId = "host-session"): PlatformCollector {
  const metadata: PlatformCollector["metadata"] = {
    hostName: "host.example",
    platform: "linux",
    platformDetail: "Linux test",
    uptimeSeconds: 120,
    capabilities: ["core-sampling", "directory-sampling", "memory-diagnostics"],
    capabilityFacts: [],
  };
  return {
    metadata,
    createSession: () => ({ collectorSessionId: sessionId, sequence: 0, previousCpu: null }),
    async collectCore(state, options) {
      if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return {
        sample: {
          collectedAt: options?.observedAtMs ?? 1_000,
          cpuPercent: null,
          memoryUsedBytes: 10,
          memoryTotalBytes: 20,
          diskUsedBytes: 30,
          diskTotalBytes: 40,
          load1: 0,
          load5: 0,
        },
        payload: corePayload(state.collectorSessionId, state.sequence, options?.observedAtMs ?? 1_000),
        metadata,
        state: { ...state, sequence: state.sequence + 1 },
      };
    },
  };
}

function emptyMemoryState(collectedAt: number): MemoryDiagnosticState {
  return {
    collectedAt,
    processes: new Map(),
    system: null,
    reportedProcesses: [],
    processDetailsCollectedAt: null,
  };
}

function dependencies(overrides: Partial<MachineMonitorHostDependencies> = {}): MachineMonitorHostDependencies {
  return {
    now: () => 1_000,
    createPlatformCollector: () => sampleCollector(),
    collectDirectorySamples: async () => [],
    collectMemoryDiagnostics: async (_previous, collectedAt = 1_000) => ({
      diagnostics: {
        collectedAt,
        processDetailsCollectedAt: null,
        sampleIntervalMs: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInPagesPerSecond: null,
        swapOutPagesPerSecond: null,
        refaultPagesPerSecond: null,
        reclaimPagesPerSecond: null,
        bbCgroupMemoryBytes: null,
        processes: [],
      },
      state: emptyMemoryState(collectedAt),
    }),
    ...overrides,
  };
}

test("host entry exposes bounded, validated calls without retaining its worker", async () => {
  const memoryOptions: Array<{ includeProcesses?: boolean; includeProcessDetails?: boolean } | undefined> = [];
  const entry = createMachineMonitorHostEntry(dependencies({
    collectDirectorySamples: async (collectedAt) => [{
      collectedAt: collectedAt ?? 1_000,
      location: "cache",
      bytes: 42,
      onRootFilesystem: true,
      partial: false,
    }],
    collectMemoryDiagnostics: async (previous, collectedAt = 1_000, _signal, options) => {
      memoryOptions.push(options);
      return {
        diagnostics: {
          collectedAt,
          processDetailsCollectedAt: null,
          sampleIntervalMs: previous == null ? null : collectedAt - previous.collectedAt,
          pressureSomePercent: 0,
          pressureFullPercent: 0,
          swapInPagesPerSecond: null,
          swapOutPagesPerSecond: null,
          refaultPagesPerSecond: null,
          reclaimPagesPerSecond: null,
          bbCgroupMemoryBytes: null,
          processes: [],
        },
        state: emptyMemoryState(collectedAt),
      };
    },
  }));
  const harness = experimental_createHostEntryHarness(entry);

  assert.equal(entry.experimental_apiVersion, 1);
  await assert.doesNotReject(harness.experimental_call("describe", null));
  assert.deepEqual(await harness.experimental_call("coreSample", null), corePayload("host-session", 0, 1_000));
  assert.deepEqual(await harness.experimental_call("directorySample", {
    directoryId: "cache",
    paths: [".cache"],
  }), {
    contractVersion: 1,
    collectorSessionId: "host-session",
    sequence: 0,
    observedAtMs: 1_000,
    directoryId: "cache",
    bytes: 42,
    onRootFilesystem: true,
    partial: false,
    availability: "available",
    reason: null,
  });
  assert.equal((await harness.experimental_call("memoryDiagnostics", { includeProcessDetails: false })).processes.length, 0);
  assert.deepEqual(memoryOptions, [{ includeProcesses: false, includeProcessDetails: false }]);
  assert.equal(harness.experimental_getRetainedWorkerLeaseCount(), 0);
  await assert.rejects(harness.experimental_call("directorySample", {
    directoryId: "too-many-paths",
    paths: Array.from({ length: 9 }, (_, index) => `/tmp/${index}`),
  } as never));
});

test("directory sampling does not wait for the stateful core lane", async () => {
  let startCore: (() => void) | undefined;
  let finishCore: (() => void) | undefined;
  const coreStarted = new Promise<void>((resolve) => {
    startCore = resolve;
  });
  const coreFinished = new Promise<void>((resolve) => {
    finishCore = resolve;
  });
  const collector = sampleCollector();
  collector.collectCore = async (state, options) => {
    startCore?.();
    await coreFinished;
    return {
      sample: {
        collectedAt: options?.observedAtMs ?? 1_000,
        cpuPercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        diskUsedBytes: null,
        diskTotalBytes: null,
        load1: null,
        load5: null,
      },
      payload: corePayload(state.collectorSessionId, state.sequence, options?.observedAtMs ?? 1_000),
      metadata: collector.metadata,
      state: { ...state, sequence: state.sequence + 1 },
    };
  };
  const harness = experimental_createHostEntryHarness(createMachineMonitorHostEntry(dependencies({
    createPlatformCollector: () => collector,
    collectDirectorySamples: async (collectedAt) => [{
      collectedAt: collectedAt ?? 1_000,
      location: "cache",
      bytes: 1,
      onRootFilesystem: true,
      partial: false,
    }],
  })));

  const core = harness.experimental_call("coreSample", null);
  await coreStarted;
  await assert.doesNotReject(harness.experimental_call("directorySample", {
    directoryId: "cache",
    paths: [".cache"],
  }));
  finishCore?.();
  await core;
});

test("session and delta state stay inside one worker lifecycle", async () => {
  let collectorNumber = 0;
  const hostDependencies = dependencies({
    createPlatformCollector: () => sampleCollector(`host-session-${++collectorNumber}`),
  });
  const first = experimental_createHostEntryHarness(createMachineMonitorHostEntry(hostDependencies));
  assert.equal((await first.experimental_call("coreSample", null)).sequence, 0);
  assert.equal((await first.experimental_call("coreSample", null)).sequence, 1);
  assert.equal((await first.experimental_call("describe", null)).collectorSessionId, "host-session-1");
  await first.experimental_dispose();

  const second = experimental_createHostEntryHarness(createMachineMonitorHostEntry(hostDependencies));
  assert.equal((await second.experimental_call("coreSample", null)).sequence, 0);
  assert.equal((await second.experimental_call("describe", null)).collectorSessionId, "host-session-2");
  await second.experimental_dispose();
});

test("request and worker-lifecycle cancellation reach active collectors", async () => {
  const calls: AbortSignal[] = [];
  let reportStarted: (() => void) | undefined;
  const collector = sampleCollector();
  collector.collectCore = async (_state, options) => new Promise((_, reject) => {
    const signal = options?.signal;
    assert.ok(signal != null);
    calls.push(signal);
    reportStarted?.();
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const makeHarness = () => experimental_createHostEntryHarness(createMachineMonitorHostEntry(dependencies({
    createPlatformCollector: () => collector,
  })));

  const requestHarness = makeHarness();
  const requestController = new AbortController();
  const requestStarted = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const request = requestHarness.experimental_call("coreSample", null, { signal: requestController.signal });
  await requestStarted;
  requestController.abort();
  await assert.rejects(request, /aborted/u);
  assert.equal(calls[0]?.aborted, true);
  await requestHarness.experimental_dispose();

  const lifecycleHarness = makeHarness();
  const lifecycleStarted = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const lifecycleCall = lifecycleHarness.experimental_call("coreSample", null);
  await lifecycleStarted;
  await lifecycleHarness.experimental_dispose();
  await assert.rejects(lifecycleCall, /aborted/u);
  assert.equal(calls[1]?.aborted, true);
});
