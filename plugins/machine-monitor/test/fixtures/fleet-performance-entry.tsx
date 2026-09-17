import { createRoot } from "react-dom/client";

import plugin from "../../app.tsx";
import { FLEET_CONTRACT_VERSION } from "../../fleet-contract.ts";
import {
  createFleetPerformanceFixture,
  FLEET_PERFORMANCE_FIXTURE_FINGERPRINT,
  FLEET_PERFORMANCE_FIXTURE_VERSION,
  type FleetPerformanceGeneration,
} from "./fleet-performance.fixture.ts";
import { FleetPerformanceRuntimeProvider, type FleetPerformanceRuntime } from "./fleet-performance-sdk.tsx";

type Probe = {
  instrumentation?: { rpcProbe?: boolean };
  counters?: { rpc?: Record<string, number>; hostCalls?: number };
};

const probe = (globalThis as typeof globalThis & { __fleetPerformance?: Probe }).__fleetPerformance;
if (probe?.instrumentation != null) probe.instrumentation.rpcProbe = true;
if (probe?.counters != null) probe.counters.hostCalls = 0;

const fixture = createFleetPerformanceFixture();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const pending = new Map<string, Array<() => void>>();
const held = new Set<string>();
let timelineResponses = 0;

function incrementRpc(method: string): void {
  if (probe?.counters?.rpc == null) return;
  probe.counters.rpc[method] = (probe.counters.rpc[method] ?? 0) + 1;
}

function waitForRelease(machineId: string, resolve: () => void): void {
  const entries = pending.get(machineId) ?? [];
  entries.push(resolve);
  pending.set(machineId, entries);
}

const runtime: FleetPerformanceRuntime = {
  connection: "connected",
  rpc: {
    call: async (method, input) => {
      incrementRpc(method);
      if (method === "fleetOverview") return fixture.overview();
      if (method === "machineTimeline") {
        const request = input as {
          machine: { machineId: string };
          range: { startMs: number; endMs: number };
          generation: FleetPerformanceGeneration;
        };
        const value = fixture.timelineFor(request.machine.machineId, request.range, request.generation);
        if (!held.has(request.machine.machineId)) {
          timelineResponses += 1;
          return value;
        }
        return await new Promise((resolve) => waitForRelease(request.machine.machineId, () => {
          timelineResponses += 1;
          resolve(value);
        }));
      }
      if (method === "machineInventory") {
        const request = input as { machine: { source: string; machineId: string } };
        const machine = fixture.machines().find((candidate) => candidate.machine.machineId === request.machine.machineId);
        if (machine == null) throw new Error(`Unknown fixture machine inventory ${request.machine.machineId}.`);
        return {
          contractVersion: FLEET_CONTRACT_VERSION,
          machine: request.machine,
          generation: machine.generation,
          inventory: {
            contractVersion: FLEET_CONTRACT_VERSION,
            collectorSessionId: "fixture-inventory",
            observedAtMs: 1_700_000_000_000,
            visibility: "host-visible",
            os: { name: "Fixture Linux distribution with an intentionally long display name", version: "2026.09 long release", kernel: "fixture-kernel-with-a-deliberately-long-version", architecture: "x86_64" },
            cpu: { logicalCores: 12345, observedPhysicalCores: 6789, observedPackages: 12, model: "Fixture processor with an intentionally long model name for narrow-layout proof", speedMHz: 5432, availability: { state: "available", reason: null } },
            memory: { usableBytes: 128 * 1024 ** 3, availability: { state: "available", reason: null } },
            disks: [], disksAvailability: { state: "partial", reason: "No fixture disks." },
            raid: { state: "not-detected", arrays: [], source: "linux-mdstat", reason: "No active Linux md arrays were reported." },
            location: { value: null, source: "unavailable" },
            limitations: ["Fixture context only."],
          },
          receivedAtMs: 1_700_000_000_001,
          lastError: null,
          lastErrorAtMs: null,
        };
      }
      if (method === "getAttachments") return fixture.overview().attachments.snapshot;
      if (method === "health") return { hostName: "latency-fixture", latest: null, lastError: null, warnings: [] };
      if (method === "searchThreads") return { threads: [] };
      throw new Error(`Unexpected fleet performance RPC ${method}.`);
    },
  },
  subscribe(channel, callback) {
    const entries = listeners.get(channel) ?? new Set();
    entries.add(callback);
    listeners.set(channel, entries);
    return () => entries.delete(callback);
  },
  navigate: { toThread: () => undefined },
};

function emit(channel: string, payload: unknown): void {
  for (const callback of listeners.get(channel) ?? []) callback(payload);
}

const navPanel = (plugin as unknown as { panels: readonly [{ component: typeof import("react").Component }] }).panels[0];
if (navPanel == null) throw new Error("Machine Monitor did not register a nav panel for the latency witness.");
const root = document.getElementById("root");
if (root == null) throw new Error("Latency witness root is absent.");
createRoot(root).render(<FleetPerformanceRuntimeProvider runtime={runtime}><navPanel.component /></FleetPerformanceRuntimeProvider>);

Object.assign(globalThis, {
  __fleetPerformanceControl: {
    fixture: {
      version: FLEET_PERFORMANCE_FIXTURE_VERSION,
      fingerprint: fixture.fixtureFingerprint,
      expectedFingerprint: FLEET_PERFORMANCE_FIXTURE_FINGERPRINT,
      machineCount: fixture.machines().length,
      coreTracks: 3,
      bucketsPerCoreTrack: 720,
      selectedEvents: (fixture.timelineFor("latency-machine-00").events as { events: unknown[] }).events.length,
    },
    hold(machineId: string) { held.add(machineId); },
    release(machineId: string) {
      held.delete(machineId);
      const entries = pending.get(machineId) ?? [];
      pending.delete(machineId);
      entries.forEach((resolve) => resolve());
    },
    revisionUpdate(machineId: string) {
      const generation = fixture.revise(machineId);
      emit("machine-monitor-fleet", {
        machine: { source: "enrolled-host", machineId },
        dataRevision: generation.dataRevision,
        settingsRevision: generation.settingsRevision,
        kinds: ["collection"],
      });
    },
    counters: () => ({ ...structuredClone(probe?.counters ?? {}), timelineResponses }),
    fixtureRange: fixture.range,
    contractVersion: FLEET_CONTRACT_VERSION,
  },
});
