import assert from "node:assert/strict";
import test from "node:test";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

import {
  FLEET_CONTRACT_VERSION,
  type FleetOverviewResult,
  type MachineInventoryResult,
  type MachineTimelineResult,
} from "../fleet-contract.ts";
import {
  createMachineMonitorHostEntry,
  type MachineMonitorHostDependencies,
} from "../host.ts";
import type { MemoryDiagnosticState } from "../monitor.ts";
import { createPlatformCollector, type CollectorPlatform, type PlatformCollector } from "../platform-collectors.ts";
import plugin from "../server.ts";

type RemotePlatform = Extract<CollectorPlatform, "linux" | "wsl" | "darwin">;
type DirectoryMode = "available" | "rejected";

type ControlledTimer = {
  callback: (...args: unknown[]) => void;
  args: unknown[];
  dueAtMs: number;
};

function emptyMemoryState(collectedAt: number): MemoryDiagnosticState {
  return {
    collectedAt,
    processes: new Map(),
    system: null,
    reportedProcesses: [],
    processDetailsCollectedAt: null,
  };
}

function collectorFor(platform: RemotePlatform, sessionId: string, hostName: string): PlatformCollector {
  let cpuTick = 0;
  const base = createPlatformCollector({
    platform: () => platform === "darwin" ? "darwin" : "linux",
    release: () => platform === "wsl" ? "5.15.0-microsoft-standard-WSL2" : "test-kernel",
    hostname: () => hostName,
    uptime: () => 123,
    loadavg: () => [1, 2, 3],
    totalmem: () => 1_000,
    freemem: () => platform === "darwin" ? 600 : platform === "wsl" ? 300 : 100,
    cpus: () => [{ model: `${platform} test CPU`, speed: 2400, times: { user: 100 + cpuTick++ * 20, nice: 0, sys: 100, idle: 100, irq: 0 } }],
    arch: () => "x64",
    readText: async (path) => {
      if (path === "/proc/meminfo") return "MemTotal:       1000 kB\nMemAvailable:    100 kB\n";
      if (path === "/proc/stat") {
        const tick = cpuTick++;
        return `cpu  ${100 + tick * 20} 0 100 ${100 + tick * 5} 0 0 0 0 0 0\n`;
      }
      if (path === "/etc/os-release") return "PRETTY_NAME=Test Linux\nVERSION_ID=1\n";
      if (path === "/proc/mdstat") return "Personalities : [raid1]\nmd0 : active raid1\n";
      if (path.endsWith("physical_package_id")) return "0\n";
      if (path.endsWith("core_id")) return "0\n";
      if (path === "/sys/block/sda/size") return "2048\n";
      if (path.endsWith("/device/model")) return "Test disk\n";
      if (path.endsWith("/queue/rotational")) return "0\n";
      if (path.endsWith("/ro")) return "0\n";
      return "";
    },
    readDirectory: async (path) => path === "/sys/devices/system/cpu" ? ["cpu0"] : path === "/sys/block" ? ["sda"] : [],
    statfs: async () => ({ bsize: 1, blocks: 1_000, bavail: platform === "darwin" ? 400 : 50 }),
  });
  return {
    ...base,
    createSession: () => ({ collectorSessionId: sessionId, sequence: 0, previousCpu: null }),
  };
}

function createRemoteHost(args: {
  id: string;
  platform: RemotePlatform;
  sessionId: string;
  directoryMode?: DirectoryMode;
}) {
  let observedAtMs = args.platform === "linux" ? 8_000_000 : args.platform === "wsl" ? 9_000_000 : 10_000_000;
  let coreCalls = 0;
  let directoryCalls = 0;
  let memoryCalls = 0;
  const dependencies: MachineMonitorHostDependencies = {
    now: () => observedAtMs++,
    createPlatformCollector: () => collectorFor(args.platform, args.sessionId, `${args.platform}-fleet-host`),
    collectDirectorySamples: async (collectedAt = observedAtMs, signal, directories = []) => {
      directoryCalls += 1;
      if (args.directoryMode === "rejected") throw new Error("directory walk deliberately rejected by representative WSL host");
      if (signal?.aborted) throw new DOMException("directory collection aborted", "AbortError");
      return directories.map((directory, index) => ({
        collectedAt,
        location: directory.id,
        bytes: 100 + index,
        onRootFilesystem: true,
        partial: false,
      }));
    },
    collectMemoryDiagnostics: async (previous, collectedAt = observedAtMs, signal) => {
      memoryCalls += 1;
      if (signal?.aborted) throw new DOMException("memory collection aborted", "AbortError");
      const linuxLike = args.platform === "linux" || args.platform === "wsl";
      return {
        diagnostics: {
          collectedAt,
          processDetailsCollectedAt: null,
          sampleIntervalMs: previous == null ? null : collectedAt - previous.collectedAt,
          pressureSomePercent: linuxLike ? 0 : null,
          pressureFullPercent: linuxLike ? 0 : null,
          swapInPagesPerSecond: linuxLike ? 3 : null,
          swapOutPagesPerSecond: linuxLike ? 4 : null,
          refaultPagesPerSecond: null,
          reclaimPagesPerSecond: null,
          bbCgroupMemoryBytes: linuxLike ? 50 : null,
          processes: [],
        },
        state: emptyMemoryState(collectedAt),
      };
    },
  };
  const entry = experimental_createHostEntryHarness(createMachineMonitorHostEntry(dependencies));
  return {
    harness: entry,
    get coreCalls() { return coreCalls; },
    get directoryCalls() { return directoryCalls; },
    get memoryCalls() { return memoryCalls; },
    async call(method: string, input: unknown, signal: AbortSignal | undefined): Promise<unknown> {
      if (method === "describe") return await entry.experimental_call("describe", null, { signal });
      if (method === "coreSample") {
        coreCalls += 1;
        return await entry.experimental_call("coreSample", null, { signal });
      }
      if (method === "directorySample") return await entry.experimental_call("directorySample", input as never, { signal });
      if (method === "memoryDiagnostics") return await entry.experimental_call("memoryDiagnostics", input as never, { signal });
      if (method === "machineInventory") return await entry.experimental_call("machineInventory", null, { signal });
      throw new Error(`unexpected representative host method ${method}`);
    },
  };
}

type RemoteHost = ReturnType<typeof createRemoteHost>;

function enrolledHost(id: string, name: string, status: "connected" | "disconnected") {
  return {
    createdAt: 0,
    id,
    lastRejectedProtocolVersion: null,
    lastSeenAt: null,
    maxPermissionMode: "full" as const,
    name,
    status,
    type: "persistent" as const,
    updatedAt: 0,
  };
}

function overviewMachine(overview: FleetOverviewResult, id: string) {
  const machine = overview.machines.find((entry) => entry.machine.source === "enrolled-host" && entry.machine.machineId === id);
  assert.ok(machine, `overview is missing ${id}`);
  return machine;
}

function timelineMetric(result: MachineTimelineResult, metricId: string) {
  const metric = result.metrics.find((entry) => entry.metricId === metricId);
  assert.ok(metric, `timeline is missing ${metricId}`);
  return metric;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("representative fleet crosses the installed server and authenticated host boundary without leaking lifecycle work", async (t) => {
  let clock = 1_000_000;
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, ControlledTimer>();
  let nextTimerId = 1;
  Date.now = () => clock;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = nextTimerId++;
    timers.set(id, {
      callback,
      args,
      dueAtMs: clock + Math.max(0, Number(delay ?? 0)),
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer as unknown as number);
  }) as typeof clearTimeout;

  const runNextTimer = (): boolean => {
    const next = [...timers.entries()].sort(([, left], [, right]) => left.dueAtMs - right.dueAtMs || 0)[0];
    if (next == null) return false;
    const [id, timer] = next;
    timers.delete(id);
    clock = Math.max(clock, timer.dueAtMs);
    timer.callback(...timer.args);
    return true;
  };
  const eventually = async (predicate: () => boolean, message: string): Promise<void> => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (predicate()) return;
      await turn();
      if (predicate()) return;
      runNextTimer();
    }
    assert.fail(message);
  };

  const remotes = new Map<string, RemoteHost>([
    ["linux-auth", createRemoteHost({ id: "linux-auth", platform: "linux", sessionId: "linux-worker-1" })],
    ["wsl-auth", createRemoteHost({ id: "wsl-auth", platform: "wsl", sessionId: "wsl-worker-1", directoryMode: "rejected" })],
    ["darwin-auth", createRemoteHost({ id: "darwin-auth", platform: "darwin", sessionId: "darwin-worker-1" })],
  ]);
  let directory = [
    enrolledHost("linux-auth", "Authenticated Linux", "connected"),
    enrolledHost("wsl-auth", "Authenticated WSL", "connected"),
    enrolledHost("darwin-auth", "Authenticated Darwin", "connected"),
  ];
  let activeRoutedCalls = 0;
  let activeServerSubscriptions = 0;
  let holdLinuxResponse = false;
  let heldLinuxResponse = false;
  const subscriptions = new Map<string, (event: never) => void>();
  const host = createFakePluginHost({
    pluginId: "machine-monitor",
    settings: {
      cpuWarningPercent: "70",
      ramWarningPercent: "80",
      diskWarningPercent: "90",
      showProcessDetails: false,
    },
    sdk: {
      hosts: { list: async () => directory },
      subscribe: (args) => {
        activeServerSubscriptions += 1;
        subscriptions.set(args.event, args.callback as (event: never) => void);
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          activeServerSubscriptions -= 1;
          subscriptions.delete(args.event);
        };
      },
    },
    experimental_callHostRpc: async (call) => {
      const remote = remotes.get(call.hostId);
      assert.ok(remote, `the server selected the unknown host ${call.hostId}`);
      activeRoutedCalls += 1;
      try {
        const output = await remote.call(call.method, call.input, call.signal);
        if (holdLinuxResponse && call.hostId === "linux-auth" && call.method === "coreSample") {
          heldLinuxResponse = true;
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new DOMException("held representative response aborted", "AbortError"));
            if (call.signal?.aborted) abort();
            else call.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        // The request and reply timing is a deterministic server-side
        // interval, deliberately unrelated to each host's own clock.
        clock += 40;
        return output;
      } finally {
        activeRoutedCalls -= 1;
      }
    },
  });
  let service: ReturnType<typeof host.harness.runService> | null = null;
  let reloaded: Awaited<ReturnType<typeof host.harness.reload>> | null = null;
  t.after(async () => {
    service?.controller.abort();
    await service?.done.catch(() => undefined);
    await reloaded?.harness.dispose();
    await host.harness.dispose();
    await Promise.all([...remotes.values()].map(async (remote) => await remote.harness.experimental_dispose()));
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  await plugin(host.bb);
  service = host.harness.runService("machine-monitor-fleet");
  const linux = remotes.get("linux-auth")!;
  const wsl = remotes.get("wsl-auth")!;
  const darwin = remotes.get("darwin-auth")!;
  await eventually(
    () => linux.coreCalls > 0 && wsl.coreCalls > 0 && darwin.coreCalls > 0
      && linux.memoryCalls > 0 && wsl.memoryCalls > 0 && darwin.memoryCalls > 0,
    "the independent remote core and memory lanes did not all run",
  );

  const wslCoresBeforeDirectoryPrompt = wsl.coreCalls;
  await host.harness.setSettings({ ramWarningPercent: "70" });
  await eventually(() => wsl.directoryCalls > 0 && wsl.coreCalls > wslCoresBeforeDirectoryPrompt,
    "a settings prompt did not exercise rejected directory work while the WSL core lane advanced");

  const routedCalls = host.harness.experimental_hostRpcCalls;
  assert.ok(routedCalls.length > 0);
  assert.ok(routedCalls.every((call) => ["linux-auth", "wsl-auth", "darwin-auth"].includes(call.hostId)),
    "every daemon call is routed by the authenticated host-directory identity");
  assert.ok(routedCalls.every((call) => !(typeof call.input === "object" && call.input != null && "machineId" in call.input)),
    "identity-free host payloads never choose their own persisted machine");
  assert.ok(wsl.coreCalls > wsl.directoryCalls,
    "the WSL core lane continued independently despite its rejected directory work");

  const firstOverview = await host.harness.callRpc("fleetOverview", { contractVersion: FLEET_CONTRACT_VERSION }) as FleetOverviewResult;
  const linuxOverview = overviewMachine(firstOverview, "linux-auth");
  const wslOverview = overviewMachine(firstOverview, "wsl-auth");
  const darwinOverview = overviewMachine(firstOverview, "darwin-auth");
  assert.ok(linuxOverview.capabilities.includes("linux-memory-pressure"));
  assert.ok(wslOverview.capabilities.includes("linux-memory-pressure"));
  assert.equal(darwinOverview.capabilities.includes("linux-memory-pressure"), false);
  assert.ok(darwinOverview.warnings.some((warning) => warning.kind === "unsupported-capability"
    && warning.metricId === "memory.pressure.some.percent"), "Darwin retains its capability gap as public truth");
  assert.ok(linuxOverview.warnings.some((warning) => warning.kind === "metric-threshold" && warning.metricId === "memory.used.bytes"),
    "server settings produce a per-machine RAM warning through the registered overview RPC");
  await eventually(() => host.harness.experimental_hostRpcCalls.some((call) => call.method === "machineInventory"),
    "the low-churn inventory lane did not run after operational telemetry");
  const linuxInventory = await host.harness.callRpc("machineInventory", {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: linuxOverview.machine,
  }) as MachineInventoryResult;
  assert.equal(linuxInventory.inventory?.cpu.logicalCores, 1);
  assert.equal(linuxInventory.inventory?.location.value, null, "location remains unavailable without trusted enrollment metadata");
  assert.equal(linuxInventory.inventory?.disks[0]?.id, "disk-0", "disk identities are opaque ordinals rather than device paths");

  const range = { startMs: 900_000, endMs: clock + 60_000 };
  const linuxTimeline = await host.harness.callRpc("machineTimeline", {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: linuxOverview.machine,
    range,
    generation: linuxOverview.generation,
  }) as MachineTimelineResult;
  const darwinTimeline = await host.harness.callRpc("machineTimeline", {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: darwinOverview.machine,
    range,
    generation: darwinOverview.generation,
  }) as MachineTimelineResult;
  assert.deepEqual(linuxTimeline.machine, linuxOverview.machine);
  assert.deepEqual(darwinTimeline.machine, darwinOverview.machine);
  assert.notDeepEqual(timelineMetric(linuxTimeline, "memory.used.bytes").buckets, timelineMetric(darwinTimeline, "memory.used.bytes").buckets,
    "registered timeline reads remain machine-isolated");
  assert.equal(linuxTimeline.timeNormalization.basis, "remote-server-request-midpoint");
  assert.ok((linuxTimeline.timeNormalization.maxClockUncertaintyMs ?? 0) > 0,
    "the registered timeline exposes request-midpoint clock uncertainty, not a host timestamp as authoritative time");
  assert.ok((linuxTimeline.timeNormalization.rawHostObservedRange.firstMs ?? 0) > range.endMs,
    "the deliberately skewed host clock remains separately visible from normalized server time");

  const settingsBefore: Array<readonly [string, number]> = firstOverview.machines
    .map((machine) => [machine.machine.machineId, machine.generation.settingsRevision] as const);
  await host.harness.setSettings({ diskWarningPercent: "80" });
  const settingsOverview = await host.harness.callRpc("fleetOverview", { contractVersion: FLEET_CONTRACT_VERSION }) as FleetOverviewResult;
  for (const [machineId, revision] of settingsBefore) {
    const machine = settingsOverview.machines.find((entry) => entry.machine.machineId === machineId);
    assert.ok(machine, `settings overview is missing ${machineId}`);
    assert.equal(machine.generation.settingsRevision, revision + 1,
      "settings advance each registered machine before their public invalidation");
  }
  assert.ok(host.harness.realtimeSignals.some((signal) => signal.channel === "machine-monitor-fleet"
    && (signal.payload as { kinds?: readonly string[] }).kinds?.includes("settings")));

  const hostChanged = subscriptions.get("host:changed");
  assert.ok(hostChanged, "fleet service registered its host-directory subscription");
  await eventually(() => activeRoutedCalls === 0, "settings-triggered host calls did not settle before reconnect");
  await turn();
  await turn();
  const linuxCoresBeforeReconnect = linux.coreCalls;
  hostChanged({ changes: ["host-connected"], id: "linux-auth" } as never);
  hostChanged({ changes: ["host-connected"], id: "linux-auth" } as never);
  await eventually(() => linux.coreCalls >= linuxCoresBeforeReconnect + 1,
    `duplicate reconnect edges did not prompt collection (before ${linuxCoresBeforeReconnect}, now ${linux.coreCalls})`);
  await turn();
  assert.equal(linux.coreCalls, linuxCoresBeforeReconnect + 1,
    "duplicate reconnect edges coalesce to one prompt collection");

  // Intentionally ignore the corresponding realtime invalidation. A fresh
  // registered overview read must still recover the committed server truth.
  const staleOverview = firstOverview;
  const recoveredOverview = await host.harness.callRpc("fleetOverview", { contractVersion: FLEET_CONTRACT_VERSION }) as FleetOverviewResult;
  assert.ok(overviewMachine(recoveredOverview, "linux-auth").generation.dataRevision
    > overviewMachine(staleOverview, "linux-auth").generation.dataRevision,
  "rereading persisted truth recovers a missed invalidation without daemon work");

  directory = directory.map((entry) => entry.id === "darwin-auth" ? { ...entry, status: "disconnected" as const } : entry);
  const realtimeConnection = subscriptions.get("realtime:connection");
  assert.ok(realtimeConnection, "fleet service registered its realtime-recovery subscription");
  realtimeConnection({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  const exitedWsl = remotes.get("wsl-auth")!;
  await host.harness.experimental_emitHostWorkerExit("wsl-auth");
  await turn();
  const workerExitOverview = await host.harness.callRpc("fleetOverview", { contractVersion: FLEET_CONTRACT_VERSION }) as FleetOverviewResult;
  assert.match(overviewMachine(workerExitOverview, "wsl-auth").lastError ?? "", /worker exited unexpectedly/u,
    "an authenticated worker exit is retained as a machine-scoped server error");
  await exitedWsl.harness.experimental_dispose();
  remotes.set("wsl-auth", createRemoteHost({ id: "wsl-auth", platform: "wsl", sessionId: "wsl-worker-2", directoryMode: "rejected" }));
  const linuxCoresBeforeHealthyAdvance = linux.coreCalls;
  hostChanged({ changes: ["host-connected"], id: "linux-auth" } as never);
  await eventually(() => linux.coreCalls > linuxCoresBeforeHealthyAdvance,
    "a healthy peer did not advance while another host worker had exited");
  await eventually(() => activeRoutedCalls === 0, "host RPC calls did not settle after the lifecycle change");

  const retainedOverview = await host.harness.callRpc("fleetOverview", { contractVersion: FLEET_CONTRACT_VERSION }) as FleetOverviewResult;
  const retainedDarwin = overviewMachine(retainedOverview, "darwin-auth");
  const retainedWsl = overviewMachine(retainedOverview, "wsl-auth");
  assert.equal(retainedDarwin.connection, "disconnected");
  assert.equal(retainedDarwin.freshness, "stale");
  assert.ok(retainedDarwin.latestCollectedAtMs != null && retainedDarwin.warnings.some((warning) => warning.kind === "disconnected"),
    "a disconnected host retains its historical summary and exposes the offline warning");
  assert.ok(retainedWsl.lastError != null);
  assert.ok(retainedWsl.latestCollectedAtMs != null,
    "a worker exit records an error without discarding that machine's history");
  assert.equal(exitedWsl.harness.experimental_getRetainedWorkerLeaseCount(), 0);

  // Reload is a second lifecycle boundary. Hold one public host RPC open, then
  // prove that aborting the new service drains the coordinator's externally
  // observable work before its subscriptions are released.
  service.controller.abort();
  await service.done;
  assert.equal(timers.size, 0, "service abort cleared coordinator timers");
  assert.equal(activeServerSubscriptions, 0, "service abort released server subscriptions");
  reloaded = await host.harness.reload(plugin);
  holdLinuxResponse = true;
  const reloadedService = reloaded.harness.runService("machine-monitor-fleet");
  await eventually(() => heldLinuxResponse && activeRoutedCalls > 0,
    "reload did not begin the deliberately held public Linux host call");
  reloadedService.controller.abort();
  await reloadedService.done;
  assert.equal(timers.size, 0, "reload abort leaves no coordinator timer");
  assert.equal(activeRoutedCalls, 0, "reload abort leaves no routed active call or gate slot");
  assert.equal(activeServerSubscriptions, 0, "reload abort releases every server subscription");
  for (const remote of remotes.values()) {
    assert.equal(remote.harness.experimental_getRetainedWorkerLeaseCount(), 0,
      "collection hosts never retain a worker lease after service reload");
  }
});
