import assert from "node:assert/strict";
import test from "node:test";

import { hostCoreSampleSchema, hostMachineInventorySchema } from "../host-contract.ts";
import {
  createPlatformCollector,
  type PlatformAdapter,
  type PlatformCollectorDependencies,
} from "../platform-collectors.ts";

function dependencies(overrides: Partial<PlatformCollectorDependencies> = {}): PlatformCollectorDependencies {
  return {
    platform: () => "linux",
    release: () => "6.8.0",
    hostname: () => "daemon.example.test",
    uptime: () => 1_234,
    loadavg: () => [1, 0.5, 0.25],
    totalmem: () => 16_000,
    freemem: () => 4_000,
    cpus: () => [{ model: "Test CPU", speed: 2400, times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } }],
    arch: () => "x64",
    readText: async (path) => path === "/proc/stat"
      ? "cpu  100 0 100 800 0 0 0 0\n"
      : "MemTotal: 16000 kB\nMemAvailable: 4000 kB\n",
    statfs: async () => ({ bsize: 4_096, blocks: 1_000, bavail: 250 }),
    ...overrides,
  };
}

function metric(result: Awaited<ReturnType<ReturnType<typeof createPlatformCollector>["collectCore"]>>, metricId: string) {
  return result.payload.metrics.find((entry) => entry.metricId === metricId);
}

test("Darwin core adapter documents portable semantics and emits bounded catalog observations", async () => {
  let times = { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 };
  const collector = createPlatformCollector(dependencies({
    platform: () => "darwin",
    release: () => "23.5.0",
    totalmem: () => 16_000,
    freemem: () => 4_000,
    cpus: () => [{ times }],
  }));
  const first = await collector.collectCore(collector.createSession("darwin-session"), { observedAtMs: 1_000 });
  times = { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 };
  const second = await collector.collectCore(first.state, { observedAtMs: 2_000 });

  assert.deepEqual(second.metadata, {
    hostName: "daemon.example.test",
    platform: "darwin",
    platformDetail: "Darwin 23.5.0",
    uptimeSeconds: 1_234,
    capabilities: ["core-sampling", "directory-sampling"],
    capabilityFacts: [
      { capability: "core-sampling", state: "available", reason: null },
      { capability: "directory-sampling", state: "available", reason: null },
      { capability: "memory-diagnostics", state: "unavailable", reason: "This platform adapter does not provide the capability." },
      { capability: "linux-memory-pressure", state: "unavailable", reason: "This capability is available only on Linux/WSL." },
      { capability: "process-attribution", state: "unavailable", reason: "This capability is available only on Linux/WSL." },
    ],
  });
  // Darwin memory is Node's totalmem - freemem; it is intentionally not a Linux MemAvailable claim.
  assert.deepEqual(second.sample, {
    collectedAt: 2_000,
    cpuPercent: 50,
    memoryUsedBytes: 12_000,
    memoryTotalBytes: 16_000,
    diskUsedBytes: 3_072_000,
    diskTotalBytes: 4_096_000,
    load1: 1,
    load5: 0.5,
  });
  assert.equal(second.payload.collectorSessionId, "darwin-session");
  assert.equal(second.payload.sequence, 1);
  assert.equal(metric(first, "cpu.utilization.percent")?.availability.state, "not-collected");
  assert.deepEqual(metric(second, "cpu.utilization.percent"), {
    metricId: "cpu.utilization.percent", value: 50, availability: { state: "available", reason: null },
  });
  assert.equal(metric(second, "memory.pressure.some.percent")?.availability.state, "unavailable");
  assert.match(metric(second, "memory.pressure.some.percent")?.availability.reason ?? "", /Linux\/WSL/);
  assert.equal(hostCoreSampleSchema.safeParse(second.payload).success, true);
  assert.equal(second.payload.metrics.length, 11);
});

test("collects a bounded daemon-visible static inventory without hardware identifiers or location probes", async () => {
  const collector = createPlatformCollector(dependencies({
    readText: async (path) => ({
      "/etc/os-release": "PRETTY_NAME=Test Linux\nVERSION_ID=1\n",
      "/proc/meminfo": "MemTotal: 16000 kB\nMemAvailable: 4000 kB\n",
      "/proc/mdstat": "Personalities : [raid1]\nmd0 : active raid1 sda1[0] sdb1[1]\n",
      "/sys/devices/system/cpu/cpu0/topology/physical_package_id": "0\n",
      "/sys/devices/system/cpu/cpu0/topology/core_id": "0\n",
      "/sys/block/sda/size": "2048\n",
      "/sys/block/sda/device/model": "Test SSD\n",
      "/sys/block/sda/queue/rotational": "0\n",
      "/sys/block/sda/ro": "0\n",
    })[path] ?? "",
    readDirectory: async (path) => path === "/sys/devices/system/cpu" ? ["cpu0"] : path === "/sys/block" ? ["sda", "loop0"] : [],
  }));
  const inventory = await collector.collectInventory!("inventory-session", { observedAtMs: 1_000 });
  assert.equal(hostMachineInventorySchema.safeParse(inventory).success, true);
  assert.equal(inventory.visibility, "host-visible");
  assert.deepEqual(inventory.cpu, {
    logicalCores: 1, observedPhysicalCores: 1, observedPackages: 1, model: "Test CPU", speedMHz: 2400,
    availability: { state: "available", reason: null },
  });
  assert.equal(inventory.memory.usableBytes, 16_384_000);
  assert.deepEqual(inventory.disks, [{ id: "disk-0", kind: "block", sizeBytes: 1_048_576, model: "Test SSD", rotational: false, readOnly: false }]);
  assert.deepEqual(inventory.raid, { state: "available", arrays: [{ name: "md0", status: "active raid1 sda1[0] sdb1[1]" }], source: "linux-mdstat", reason: null });
  assert.deepEqual(inventory.location, { value: null, source: "unavailable" });
  assert.ok(JSON.stringify(inventory).includes("serial") === false, "the static profile contains no serial identifier field");

  const wsl = createPlatformCollector(dependencies({ release: () => "5.15-microsoft-standard-WSL2", readDirectory: async () => [] }));
  assert.equal((await wsl.collectInventory!("wsl-session", { observedAtMs: 1_000 })).visibility, "guest-visible");
  const darwin = createPlatformCollector(dependencies({ platform: () => "darwin", readDirectory: async () => [] }));
  const darwinInventory = await darwin.collectInventory!("darwin-session", { observedAtMs: 1_000 });
  assert.equal(darwinInventory.disksAvailability.state, "partial");
  assert.equal(darwinInventory.raid.state, "unavailable");
});

test("Linux and WSL keep procfs core collection while pressure and process attribution remain capability-gated", async () => {
  const collector = createPlatformCollector(dependencies({
    release: () => "5.15.153.1-microsoft-standard-WSL2",
  }));
  const result = await collector.collectCore(collector.createSession("wsl-session"), { observedAtMs: 1_000 });

  assert.equal(result.metadata.platform, "wsl");
  assert.deepEqual(result.metadata.capabilities, ["core-sampling", "directory-sampling", "memory-diagnostics", "linux-memory-pressure", "process-attribution"]);
  assert.equal(result.sample.memoryUsedBytes, 12_288_000);
  assert.equal(metric(result, "memory.pressure.some.percent")?.availability.state, "not-collected");
  assert.equal(metric(result, "memory.swap.out.pages-per-second")?.availability.state, "not-collected");
});

test("an unknown platform returns explicit unavailable facts without probing the host", async () => {
  let probes = 0;
  const collector = createPlatformCollector(dependencies({
    platform: () => "sunos",
    readText: async () => { probes++; throw new Error("must not read procfs"); },
    statfs: async () => { probes++; throw new Error("must not stat root"); },
  }));
  const result = await collector.collectCore(collector.createSession("unknown-session"), { observedAtMs: 1_000 });

  assert.equal(result.metadata.platform, "unknown");
  assert.deepEqual(result.metadata.capabilities, []);
  assert.ok(result.metadata.capabilityFacts.every((fact) => fact.state === "unavailable" && fact.reason === "This platform has no supported collector adapter."));
  assert.equal(probes, 0);
  assert.ok(result.payload.metrics.every((entry) => entry.value == null && entry.availability.state === "unavailable"));
  assert.ok(result.payload.metrics.every((entry) => entry.availability.reason === "Core sampling is unavailable on this platform."));
  assert.equal(hostCoreSampleSchema.safeParse(result.payload).success, true);
  const inventory = await collector.collectInventory!("unknown-session", { observedAtMs: 1_001 });
  assert.equal(inventory.visibility, "unknown");
  assert.equal(inventory.cpu.availability.state, "unavailable");
  assert.equal(inventory.disks.length, 0);
  assert.equal(probes, 0, "unknown-platform inventory preserves the zero-probe boundary");
});

test("platform adapters and OS facts are dependency-injected, and cancellation happens before any probe", async () => {
  let calls = 0;
  const synthetic: PlatformAdapter = {
    id: "darwin",
    matches: (runtime) => runtime.nodePlatform === "synthetic",
    capabilities: () => ["core-sampling"],
    async collectCore() {
      calls++;
      return {
        cpu: { total: 20, idle: 10 },
        memoryUsedBytes: 3,
        memoryTotalBytes: 4,
        diskUsedBytes: 5,
        diskTotalBytes: 6,
        load1: 0,
        load5: 0,
        uptimeSeconds: 7,
      };
    },
  };
  const collector = createPlatformCollector(dependencies({ platform: () => "synthetic" }), [synthetic]);
  const session = collector.createSession("synthetic-session");
  await assert.rejects(collector.collectCore(session, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);

  const result = await collector.collectCore(session, { observedAtMs: 1_000 });
  assert.equal(calls, 1);
  assert.equal(result.metadata.platform, "darwin");
  assert.equal(result.payload.metrics.length, 11);
});
