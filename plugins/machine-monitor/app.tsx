import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import { MachineMonitorReferences } from "./attachments.tsx";
import {
  FleetClient,
  fleetGenerationMatches,
  mergeFleetOverview,
  type TimelineRange,
} from "./fleet-client.ts";
import {
  FLEET_CONTRACT_VERSION,
  fleetInvalidationSignalSchema,
  machineIdentityKey,
  metricCatalogEntry,
  type FleetMetricId,
  type FleetMachineIdentity,
  type FleetOverviewResult,
  type MachineInventoryResult,
  type MachineTimelineResult,
} from "./fleet-contract.ts";
import type { MachineMonitorHealth, rpcContract } from "./rpc-contract.ts";
import { FLEET_UTILIZATION_ATTENTION_PERCENT, FleetUtilizationChart, MachineDashboardChart, MachineTimelineChart, type FleetUtilizationDatum } from "./timeline-chart.tsx";
import type { TimelineEventActivation } from "./timeline-compiler.ts";
import "./app.css";

const RANGES = [1, 6, 24, 24 * 7, 24 * 30] as const;
type RangeHours = typeof RANGES[number];
type FleetMachine = FleetOverviewResult["machines"][number];
type TimelineView = Readonly<{ timeline: MachineTimelineResult; stale: boolean }> | null;
type InventoryView = Readonly<{ key: string | null; value: MachineInventoryResult | null; loading: boolean; error: string | null }>;

const PREFETCH_LIMIT = 6;
const INVENTORY_CACHE_LIMIT = 64;

/**
 * Inventory is a committed server read, so selection never asks a daemon to
 * probe hardware. Its cache identity is deliberately independent of live
 * telemetry revisions: core samples advance every few seconds while this
 * profile changes only through an explicit `inventory` invalidation.
 */
function useMachineInventory(machine: FleetMachine | null, inventoryRevision: string): Omit<InventoryView, "key"> {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<InventoryView>({ key: null, value: null, loading: false, error: null });
  const cache = useRef(new Map<string, MachineInventoryResult>());
  const flights = useRef(new Map<string, Promise<MachineInventoryResult>>());
  const key = machine == null ? null : `${machineIdentityKey(machine.machine)}:${inventoryRevision}`;
  const read = useCallback((next: FleetMachine): Promise<MachineInventoryResult> => {
    const nextKey = `${machineIdentityKey(next.machine)}:${inventoryRevision}`;
    const cached = cache.current.get(nextKey);
    if (cached != null) {
      cache.current.delete(nextKey);
      cache.current.set(nextKey, cached);
      return Promise.resolve(cached);
    }
    const existing = flights.current.get(nextKey);
    if (existing != null) return existing;
    const flight = rpc.call("machineInventory", { contractVersion: FLEET_CONTRACT_VERSION, machine: next.machine }).then((result) => {
      if (machineIdentityKey(result.machine) !== machineIdentityKey(next.machine)) throw new Error("Machine context response did not match its request.");
      cache.current.set(nextKey, result);
      while (cache.current.size > INVENTORY_CACHE_LIMIT) {
        const oldest = cache.current.keys().next().value;
        if (oldest == null) break;
        cache.current.delete(oldest);
      }
      return result;
    });
    flights.current.set(nextKey, flight);
    void flight.finally(() => {
      if (flights.current.get(nextKey) === flight) flights.current.delete(nextKey);
    }).catch(() => undefined);
    return flight;
  }, [inventoryRevision, rpc]);
  useEffect(() => {
    if (machine == null || key == null) {
      setView({ key: null, value: null, loading: false, error: null });
      return;
    }
    const cached = cache.current.get(key);
    if (cached != null) {
      cache.current.delete(key);
      cache.current.set(key, cached);
      return;
    }
    let current = true;
    // A profile from the same machine remains visible while an explicitly
    // invalidated inventory refreshes. It is truthful (the header says
    // Refreshing) and avoids removing/reinserting the context panel below the
    // chart on an otherwise ordinary overview reconciliation.
    setView((previous) => previous.value != null && machineIdentityKey(previous.value.machine) === machineIdentityKey(machine.machine)
      ? { key, value: previous.value, loading: true, error: null }
      : { key, value: null, loading: true, error: null });
    const collect = () => {
      void read(machine).then((result) => {
        if (!current || machineIdentityKey(result.machine) !== machineIdentityKey(machine.machine)) return;
        setView({ key, value: result, loading: false, error: null });
      }).catch((cause) => {
        if (current) setView((previous) => previous.value != null && machineIdentityKey(previous.value.machine) === machineIdentityKey(machine.machine)
          ? { key, value: previous.value, loading: false, error: cause instanceof Error ? cause.message : String(cause) }
          : { key, value: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) });
      });
    };
    // The profile is useful context, but it must never contend with the
    // selected machine's retained-or-fresh timeline on the interaction path.
    // Cached profiles return synchronously above; first reads yield to idle.
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(collect, { timeout: 1_200 });
      return () => { current = false; window.cancelIdleCallback(idle); };
    }
    const timer = window.setTimeout(collect, 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [key, machine, read]);
  const cached = key == null ? null : cache.current.get(key) ?? null;
  const retainedSameMachine = machine != null && view.value != null && machineIdentityKey(view.value.machine) === machineIdentityKey(machine.machine);
  const current = cached == null
    ? view.key === key ? view : retainedSameMachine ? { key, value: view.value, loading: true, error: view.error } : { key, value: null, loading: machine != null, error: null }
    : { key, value: cached, loading: false, error: null };
  return { value: current.value, loading: current.loading, error: current.error };
}

function rangeFor(hours: RangeHours, serverNowMs: number): TimelineRange {
  // Fleet history is normalized to local-server time. Never let a skewed
  // browser clock hide recent samples; only clamp the lower bound for the
  // timestamp contract and keep the range valid for the zero-time edge.
  const endMs = Math.max(1, Math.floor(serverNowMs));
  return { startMs: Math.max(0, endMs - hours * 60 * 60_000), endMs };
}

function rangeKey(range: TimelineRange): string {
  return `${range.startMs}:${range.endMs}`;
}

function generationText(machine: FleetMachine): string {
  return `Data ${machine.generation.dataRevision} · settings ${machine.generation.settingsRevision}`;
}

function connectionText(machine: FleetMachine): string {
  return `${machine.connection === "local" ? "Local" : machine.connection} · ${machine.freshness}`;
}

type FleetAtlasPressure = Readonly<{
  key: "cpu" | "memory" | "disk";
  label: string;
  shortLabel: string;
  value: number | null;
  level: "unavailable" | "nominal" | "elevated" | "critical";
}>;

type FleetAtlasUtilization = Readonly<{
  value: number | null;
  headroomToAttention: number | null;
  limitingResource: FleetAtlasPressure["shortLabel"] | null;
  state: "unavailable" | "below-attention" | "attention";
  description: string;
  compactLabel: string;
}>;

type FleetAtlasPresentation = Readonly<{
  pressures: readonly FleetAtlasPressure[];
  state: "current" | "stale" | "disconnected" | "failure" | "warning" | "pressure";
  stateLabel: string;
  glyph: string;
  collectorState: "clear" | "warning" | "failure";
  pressureLevel: FleetAtlasPressure["level"];
  utilization: FleetAtlasUtilization;
  anomalous: boolean;
}>;

function latestMetricValue(machine: FleetMachine, metricId: FleetMetricId): number | null {
  const observation = machine.latestMetrics.find((value) => value.metricId === metricId);
  return observation?.availability.state === "available" && observation.value != null ? observation.value : null;
}

function percentageOf(value: number | null, total: number | null): number | null {
  if (value == null || total == null || !Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, value / total * 100));
}

function pressure(value: number | null, key: FleetAtlasPressure["key"], label: string, shortLabel: string): FleetAtlasPressure {
  if (value == null || !Number.isFinite(value)) return { key, label, shortLabel, value: null, level: "unavailable" };
  const bounded = Math.min(100, Math.max(0, value));
  return {
    key,
    label,
    shortLabel,
    value: bounded,
    level: bounded >= 90 ? "critical" : bounded >= 75 ? "elevated" : "nominal",
  };
}

function pressureText(value: FleetAtlasPressure): string {
  return value.value == null ? `${value.label} unavailable` : `${value.label} ${value.value.toFixed(1)} percent`;
}

function fleetUtilization(pressures: readonly FleetAtlasPressure[]): FleetAtlasUtilization {
  const available = pressures.filter((pressure): pressure is FleetAtlasPressure & Readonly<{ value: number }> => pressure.value != null);
  if (available.length === 0) {
    return { value: null, headroomToAttention: null, limitingResource: null, state: "unavailable", description: "Overall utilization unavailable; none of CPU, memory, or root disk reported a current percentage.", compactLabel: "Unavailable" };
  }
  const limiting = available.reduce((current, pressure) => pressure.value > current.value ? pressure : current);
  const value = limiting.value;
  const headroomToAttention = FLEET_UTILIZATION_ATTENTION_PERCENT - value;
  if (headroomToAttention > 0) {
    return {
      value,
      headroomToAttention,
      limitingResource: limiting.shortLabel,
      state: "below-attention",
      description: `Overall utilization ${value.toFixed(1)} percent from ${limiting.label}, ${headroomToAttention.toFixed(1)} percentage points below the ${FLEET_UTILIZATION_ATTENTION_PERCENT} percent attention target.`,
      compactLabel: `${headroomToAttention.toFixed(0)} pt · ${limiting.shortLabel}`,
    };
  }
  if (headroomToAttention === 0) {
    return {
      value,
      headroomToAttention,
      limitingResource: limiting.shortLabel,
      state: "attention",
      description: `Overall utilization ${value.toFixed(1)} percent from ${limiting.label}, at the ${FLEET_UTILIZATION_ATTENTION_PERCENT} percent attention target.`,
      compactLabel: `At target · ${limiting.shortLabel}`,
    };
  }
  return {
    value,
    headroomToAttention,
    limitingResource: limiting.shortLabel,
    state: "attention",
    description: `Overall utilization ${value.toFixed(1)} percent from ${limiting.label}, ${Math.abs(headroomToAttention).toFixed(1)} percentage points above the ${FLEET_UTILIZATION_ATTENTION_PERCENT} percent attention target.`,
    compactLabel: `${Math.abs(headroomToAttention).toFixed(0)} pt · ${limiting.shortLabel}`,
  };
}

function fleetAtlasPresentation(machine: FleetMachine): FleetAtlasPresentation {
  const pressures = [
    pressure(latestMetricValue(machine, "cpu.utilization.percent"), "cpu", "CPU utilization", "CPU"),
    pressure(percentageOf(latestMetricValue(machine, "memory.used.bytes"), latestMetricValue(machine, "memory.total.bytes")), "memory", "Memory utilization", "MEM"),
    pressure(percentageOf(latestMetricValue(machine, "disk.root.used.bytes"), latestMetricValue(machine, "disk.root.total.bytes")), "disk", "Root disk utilization", "DSK"),
  ] as const;
  const pressureLevel = pressures.reduce<FleetAtlasPressure["level"]>((current, value) => {
    const weight = { unavailable: 0, nominal: 1, elevated: 2, critical: 3 } as const;
    return weight[value.level] > weight[current] ? value.level : current;
  }, "unavailable");
  const utilization = fleetUtilization(pressures);
  const collectorState = machine.lastError != null
    || machine.warnings.some((warning) => warning.kind === "collector-error")
    ? "failure"
    : machine.warnings.length > 0 ? "warning" : "clear";
  if (machine.connection === "disconnected") {
    return { pressures, state: "disconnected", stateLabel: "Disconnected", glyph: "×", collectorState, pressureLevel, utilization, anomalous: true };
  }
  if (machine.freshness === "stale") {
    return { pressures, state: "stale", stateLabel: "Stale data", glyph: "~", collectorState, pressureLevel, utilization, anomalous: true };
  }
  if (collectorState === "failure") {
    return { pressures, state: "failure", stateLabel: "Collector failure", glyph: "!", collectorState, pressureLevel, utilization, anomalous: true };
  }
  if (collectorState === "warning") {
    return { pressures, state: "warning", stateLabel: "Collector warning", glyph: "!", collectorState, pressureLevel, utilization, anomalous: true };
  }
  if (pressureLevel === "critical" || pressureLevel === "elevated") {
    return { pressures, state: "pressure", stateLabel: `${pressureLevel === "critical" ? "Critical" : "Elevated"} resource pressure`, glyph: "↑", collectorState, pressureLevel, utilization, anomalous: true };
  }
  return { pressures, state: "current", stateLabel: "Current", glyph: "•", collectorState, pressureLevel, utilization, anomalous: false };
}

function displayMetric(value: number | null, unit: ReturnType<typeof metricCatalogEntry>["unit"]): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "bytes") return value >= 1_073_741_824 ? `${(value / 1_073_741_824).toFixed(1)} GiB` : `${(value / 1_048_576).toFixed(1)} MiB`;
  if (unit === "pages-per-second") return `${value.toFixed(value >= 10 ? 0 : 2)}/s`;
  return value.toFixed(value >= 10 ? 0 : 2);
}

function displayByteRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "No range trend";
  const direction = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${direction}${displayMetric(Math.abs(value), "bytes")}/day`;
}

function attentionDistance(value: number): string {
  const delta = FLEET_UTILIZATION_ATTENTION_PERCENT - value;
  return delta >= 0
    ? `${delta.toFixed(0)} points to attention`
    : `${Math.abs(delta).toFixed(0)} points over attention`;
}

type DashboardMetric = Readonly<{
  id: "cpu" | "memory" | "disk" | "load";
  label: string;
  value: string;
  detail: string;
  attention: boolean;
  unavailable: boolean;
}>;

function selectedMachineMetrics(machine: FleetMachine): readonly DashboardMetric[] {
  const cpu = machine.cpu5mPercent ?? latestMetricValue(machine, "cpu.utilization.percent");
  const memoryUsed = latestMetricValue(machine, "memory.used.bytes");
  const memoryTotal = latestMetricValue(machine, "memory.total.bytes");
  const diskUsed = latestMetricValue(machine, "disk.root.used.bytes");
  const diskTotal = latestMetricValue(machine, "disk.root.total.bytes");
  const memory = percentageOf(memoryUsed, memoryTotal);
  const disk = percentageOf(diskUsed, diskTotal);
  const load = latestMetricValue(machine, "load.5");
  return [
    {
      id: "cpu", label: "CPU (5 min)", value: displayMetric(cpu, "percent"),
      detail: cpu == null ? "No current five-minute average" : attentionDistance(cpu),
      attention: cpu != null && cpu >= FLEET_UTILIZATION_ATTENTION_PERCENT, unavailable: cpu == null,
    },
    {
      id: "memory", label: "Memory", value: displayMetric(memory, "percent"),
      detail: memoryUsed == null || memoryTotal == null || memory == null
        ? "Capacity unavailable"
        : `${displayMetric(memoryUsed, "bytes")} · ${attentionDistance(memory)}`,
      attention: memory != null && memory >= FLEET_UTILIZATION_ATTENTION_PERCENT, unavailable: memory == null,
    },
    {
      id: "disk", label: "Root disk", value: displayMetric(disk, "percent"),
      detail: diskUsed == null || diskTotal == null || disk == null
        ? "Capacity unavailable"
        : `${displayMetric(diskUsed, "bytes")} · ${attentionDistance(disk)}`,
      attention: disk != null && disk >= FLEET_UTILIZATION_ATTENTION_PERCENT, unavailable: disk == null,
    },
    {
      id: "load", label: "Load (5 min)", value: displayMetric(load, "load"),
      detail: load == null ? "No current five-minute average" : "Machine load average",
      attention: false, unavailable: load == null,
    },
  ];
}

function dashboardDirectories(timeline: MachineTimelineResult): readonly NonNullable<MachineTimelineResult["directories"]>[number][] {
  // Directory observations can cover bounded subtrees at different times than
  // the latest root-disk metric. Never manufacture an "Other /" remainder:
  // it would imply a complete, time-aligned filesystem breakdown we do not own.
  return [...(timeline.directories ?? [])]
    .filter((entry) => entry.onRootFilesystem)
    .sort((left, right) => right.bytes - left.bytes || left.label.localeCompare(right.label));
}

function latestTime(value: number | null): string {
  if (value == null) return "No collection yet";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}

function rangeLabel(hours: number): string {
  return hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"}` : hours < 168 ? `${hours / 24} days` : hours === 168 ? "7 days" : "30 days";
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function isFleetSignal(value: unknown): value is ReturnType<typeof fleetInvalidationSignalSchema.parse> {
  return fleetInvalidationSignalSchema.safeParse(value).success;
}

function sameTimelineRange(left: TimelineRange, right: TimelineRange): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

function useFleetMonitor() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const client = useRef(new FleetClient({
    readOverview: () => rpcRef.current.call("fleetOverview", { contractVersion: FLEET_CONTRACT_VERSION }),
    readTimeline: (request) => rpcRef.current.call("machineTimeline", request),
  })).current;
  const mounted = useRef(true);
  const overviewRef = useRef<FleetOverviewResult | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const rangeHoursRef = useRef<RangeHours>(24);
  const rangeRef = useRef<TimelineRange>(rangeFor(24, 0));
  const timelineViewRef = useRef<TimelineView>(null);
  /** The machine whose retained timeline was explicitly invalidated. */
  const selectedTimelineReconciliationKey = useRef<string | null>(null);
  const timelineToken = useRef(0);
  const overviewToken = useRef(0);
  const prefetch = useRef({ range: rangeKey(rangeRef.current), keys: new Set<string>() });
  const refreshOverviewRef = useRef<((changedMachine?: FleetMachineIdentity, rereadSelection?: boolean) => Promise<void>) | null>(null);

  const [overview, setOverview] = useState<FleetOverviewResult | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selectedMachineKey, setSelectedMachineKey] = useState<string | null>(null);
  const [rangeHours, setRangeHours] = useState<RangeHours>(24);
  const [range, setRange] = useState<TimelineRange>(rangeRef.current);
  const [timelineView, setTimelineView] = useState<TimelineView>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  // Static inventory is invalidated independently of rapidly changing metric
  // generations. Keeping a per-machine revision prevents every core sample
  // from causing a context RPC or temporarily removing its presentation.
  const [inventoryRevisions, setInventoryRevisions] = useState<ReadonlyMap<string, number>>(() => new Map());
  // A connection recovery can make a previously cached static profile stale
  // even when its persisted inventory digest did not change. This distinct
  // epoch makes the post-reconnect read deliberate without tying context to
  // every telemetry generation.
  const [inventoryReconnectEpoch, setInventoryReconnectEpoch] = useState(0);

  const invalidateInventory = useCallback((machine: FleetMachineIdentity) => {
    const key = machineIdentityKey(machine);
    setInventoryRevisions((previous) => {
      const next = new Map(previous);
      next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
  }, []);

  const commitTimelineView = useCallback((next: TimelineView) => {
    timelineViewRef.current = next;
    setTimelineView(next);
  }, []);

  const selectedMachine = useCallback((source = overviewRef.current, key = selectedKeyRef.current): FleetMachine | null => {
    if (source == null || key == null) return null;
    return source.machines.find((machine) => machineIdentityKey(machine.machine) === key) ?? null;
  }, []);

  const requestTimeline = useCallback((machine: FleetMachine, requestedRange: TimelineRange) => {
    const machineKey = machineIdentityKey(machine.machine);
    const expectedGeneration = machine.generation;
    const cached = client.getTimeline(machine.machine, requestedRange, expectedGeneration);
    const token = ++timelineToken.current;
    setTimelineError(null);
    if (cached != null) {
      commitTimelineView({ timeline: cached, stale: false });
      if (selectedTimelineReconciliationKey.current === machineKey) selectedTimelineReconciliationKey.current = null;
      setTimelineLoading(false);
      return;
    }

    const retained = timelineViewRef.current;
    if (retained != null) commitTimelineView({ timeline: retained.timeline, stale: true });
    setTimelineLoading(true);
    void client.readTimeline(machine.machine, requestedRange, expectedGeneration, { priority: "selected" }).then((result) => {
      if (!mounted.current || token !== timelineToken.current) return;
      const current = selectedMachine();
      if (current == null || machineIdentityKey(current.machine) !== machineKey || !sameTimelineRange(rangeRef.current, requestedRange)) return;
      if (!fleetGenerationMatches(current.generation, expectedGeneration)) return;
      if (!fleetGenerationMatches(result.generation, expectedGeneration)) {
        // The server observed a newer committed generation than our resident
        // overview. Reconcile first; the response is cached under its exact key.
        void refreshOverviewRef.current?.(machine.machine, true);
        return;
      }
      commitTimelineView({ timeline: result, stale: false });
      if (selectedTimelineReconciliationKey.current === machineKey) selectedTimelineReconciliationKey.current = null;
      setTimelineLoading(false);
      setTimelineError(null);
    }).catch((cause) => {
      if (!mounted.current || token !== timelineToken.current) return;
      const current = selectedMachine();
      if (current == null || machineIdentityKey(current.machine) !== machineKey || !sameTimelineRange(rangeRef.current, requestedRange)
        || !fleetGenerationMatches(current.generation, expectedGeneration)) return;
      setTimelineLoading(false);
      setTimelineError(errorText(cause, "Could not read this machine timeline."));
      const currentView = timelineViewRef.current;
      if (currentView != null) commitTimelineView({ timeline: currentView.timeline, stale: true });
    });
  }, [client, commitTimelineView, selectedMachine]);

  const commitOverview = useCallback((next: FleetOverviewResult): FleetOverviewResult => {
    const merged = mergeFleetOverview(overviewRef.current, next);
    client.setOverview(merged);
    overviewRef.current = merged;
    setOverview(merged);
    return merged;
  }, [client]);

  const refreshOverview = useCallback(async (changedMachine?: FleetMachineIdentity, rereadSelection = false) => {
    const token = ++overviewToken.current;
    if (overviewRef.current == null) setOverviewLoading(true);
    try {
      const next = await client.readOverview();
      if (!mounted.current || token !== overviewToken.current) return;
      const isInitialOverview = overviewRef.current == null;
      const merged = commitOverview(next);
      setOverviewLoading(false);
      setOverviewError(null);
      let selected = selectedMachine(merged);
      if (selected == null) {
        selected = merged.machines[0] ?? null;
        const nextKey = selected == null ? null : machineIdentityKey(selected.machine);
        selectedKeyRef.current = nextKey;
        setSelectedMachineKey(nextKey);
      }
      const selectedKey = selected == null ? null : machineIdentityKey(selected.machine);
      const visible = timelineViewRef.current;
      const visibleMatchesSelected = selected != null && visible != null
        && machineIdentityKey(visible.timeline.machine) === selectedKey
        && fleetGenerationMatches(visible.timeline.generation, selected.generation);
      const selectedWasInvalidated = selectedKey != null && selectedTimelineReconciliationKey.current === selectedKey;
      // The winning overview callback can describe B even if A was the
      // selected machine that began this coalesced reconciliation. Consult the
      // committed selected row and retained timeline, not just that callback's
      // signal, before deciding whether A needs a current-generation reread.
      const shouldRereadSelection = selected != null && (rereadSelection || selectedWasInvalidated || !visibleMatchesSelected);
      if (shouldRereadSelection) {
        // Advance only at an explicit reconciliation boundary. Ordinary machine
        // switching keeps the exact range stable, allowing a revision-current
        // cached selection to render without an RPC.
        const nextRange = (isInitialOverview || rereadSelection || selectedWasInvalidated || !visibleMatchesSelected)
          ? rangeFor(rangeHoursRef.current, merged.generatedAtMs)
          : rangeRef.current;
        if (!sameTimelineRange(rangeRef.current, nextRange)) {
          rangeRef.current = nextRange;
          prefetch.current = { range: rangeKey(nextRange), keys: new Set() };
          setRange(nextRange);
        }
        requestTimeline(selected!, nextRange);
      }
    } catch (cause) {
      if (!mounted.current || token !== overviewToken.current) return;
      setOverviewLoading(false);
      setOverviewError(errorText(cause, "Could not read the fleet overview."));
    }
  }, [client, commitOverview, requestTimeline, selectedMachine]);
  refreshOverviewRef.current = refreshOverview;

  const chooseMachine = useCallback((machine: FleetMachine) => {
    const key = machineIdentityKey(machine.machine);
    selectedKeyRef.current = key;
    setSelectedMachineKey(key);
    requestTimeline(machine, rangeRef.current);
  }, [requestTimeline]);

  const chooseRange = useCallback((hours: RangeHours) => {
    const nextRange = rangeFor(hours, overviewRef.current?.generatedAtMs ?? rangeRef.current.endMs);
    rangeRef.current = nextRange;
    prefetch.current = { range: rangeKey(nextRange), keys: new Set() };
    rangeHoursRef.current = hours;
    setRangeHours(hours);
    setRange(nextRange);
    const machine = selectedMachine();
    if (machine != null) requestTimeline(machine, nextRange);
  }, [requestTimeline, selectedMachine]);

  const prefetchMachine = useCallback((machine: FleetMachine) => {
    const activeRange = rangeRef.current;
    const activeRangeKey = rangeKey(activeRange);
    if (prefetch.current.range !== activeRangeKey) prefetch.current = { range: activeRangeKey, keys: new Set() };
    const key = `${machineIdentityKey(machine.machine)}|${machine.generation.dataRevision}:${machine.generation.settingsRevision}`;
    if (prefetch.current.keys.has(key) || prefetch.current.keys.size >= PREFETCH_LIMIT) return;
    if (client.getTimeline(machine.machine, activeRange, machine.generation) != null) return;
    prefetch.current.keys.add(key);
    void client.readTimeline(machine.machine, activeRange, machine.generation, { priority: "prefetch" }).catch(() => undefined);
  }, [client]);

  const canActivateEvent = useCallback((activation: TimelineEventActivation): boolean => {
    const machine = selectedMachine();
    const visible = timelineViewRef.current;
    return machine != null && visible != null && activation.bbReference != null
      && connection === "connected" && machine.freshness === "fresh" && !visible.stale
      && machineIdentityKey(activation.machine) === machineIdentityKey(visible.timeline.machine)
      && fleetGenerationMatches(machine.generation, activation.generation)
      && fleetGenerationMatches(visible.timeline.generation, activation.generation);
  }, [connection, selectedMachine]);

  useEffect(() => {
    mounted.current = true;
    client.activate();
    void refreshOverview();
    return () => {
      mounted.current = false;
      timelineToken.current += 1;
      overviewToken.current += 1;
      client.dispose();
    };
  }, [client, refreshOverview]);

  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection !== "connected") {
      const current = timelineViewRef.current;
      if (current != null) commitTimelineView({ timeline: current.timeline, stale: true });
    } else if (previousConnection.current !== "connected") {
      const selected = selectedMachine();
      if (selected != null) client.invalidateMachine(selected.machine);
      setInventoryReconnectEpoch((previous) => previous + 1);
      void refreshOverview(undefined, true);
    }
    previousConnection.current = connection;
  }, [client, commitTimelineView, connection, refreshOverview, selectedMachine]);

  const onFleetInvalidation = useCallback((payload: unknown) => {
    if (!isFleetSignal(payload)) return;
    client.invalidateMachine(payload.machine);
    if (payload.kinds.includes("inventory")) {
      invalidateInventory(payload.machine);
    }
    const changedSelected = selectedKeyRef.current === machineIdentityKey(payload.machine);
    if (changedSelected) {
      selectedTimelineReconciliationKey.current = selectedKeyRef.current;
      // The overview reconciliation is asynchronous. Fence the selected view
      // now so a response started before this signal cannot briefly regain
      // current-generation status or re-enable an event action.
      timelineToken.current += 1;
      setTimelineLoading(true);
    }
    if (changedSelected && timelineViewRef.current != null) {
      commitTimelineView({ timeline: timelineViewRef.current.timeline, stale: true });
    }
    void refreshOverviewRef.current?.(payload.machine, changedSelected);
  }, [client, commitTimelineView, invalidateInventory]);
  useRealtime("machine-monitor-fleet", onFleetInvalidation);

  // A one-shot idle opportunity warms at most two nearby rows. There is no
  // polling timer and the global prefetch budget prevents a 256-machine burst.
  useEffect(() => {
    if (overview == null || selectedMachineKey == null) return;
    const candidates = overview.machines.filter((machine) => machineIdentityKey(machine.machine) !== selectedMachineKey).slice(0, 2);
    if (candidates.length === 0) return;
    const work = () => candidates.forEach(prefetchMachine);
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(work, { timeout: 1_200 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(work, 0);
    return () => window.clearTimeout(timer);
  }, [overview, prefetchMachine, selectedMachineKey, range]);

  return {
    connection,
    overview,
    overviewLoading,
    overviewError,
    selectedMachineKey,
    rangeHours,
    range,
    timelineView,
    timelineLoading,
    timelineError,
    inventoryRevision: selectedMachineKey == null
      ? `0:${inventoryReconnectEpoch}`
      : `${inventoryRevisions.get(selectedMachineKey) ?? 0}:${inventoryReconnectEpoch}`,
    chooseMachine,
    chooseRange,
    prefetchMachine,
    selectedMachine,
    canActivateEvent,
  };
}

const FleetPickerRow = memo(function FleetPickerRow({ machine, selected, onSelect, onIntent }: {
  machine: FleetMachine;
  selected: boolean;
  onSelect: (machine: FleetMachine) => void;
  onIntent: (machine: FleetMachine) => void;
}) {
  const descriptionId = useId();
  const atlas = fleetAtlasPresentation(machine);
  const description = [
    `${connectionText(machine)}. ${atlas.stateLabel}.`,
    machine.lastError == null ? `${machine.warnings.length} collector warning${machine.warnings.length === 1 ? "" : "s"}.` : `Collector failure: ${machine.lastError}.`,
    atlas.utilization.description,
    ...atlas.pressures.map(pressureText),
    selected ? "Selected; its full timeline inspector is shown below." : "Press to show this machine's full timeline inspector.",
  ].join(" ");
  const [cpu, memory, disk] = atlas.pressures;
  const atlasBackgroundStyle = {
    "--machine-monitor-cpu-pressure": `${cpu?.value ?? 0}%`,
    "--machine-monitor-memory-pressure": `${memory?.value ?? 0}%`,
    "--machine-monitor-disk-pressure": `${disk?.value ?? 0}%`,
  } as CSSProperties;
  return <li>
    <button
      className="machine-monitor__atlas-button"
      type="button"
      aria-pressed={selected}
      aria-label={`${machine.label}. ${machine.connection}. ${machine.freshness}. ${atlas.stateLabel}. ${atlas.utilization.value == null ? "Overall utilization unavailable." : `Overall utilization ${atlas.utilization.value.toFixed(1)} percent.`}`}
      aria-describedby={descriptionId}
      data-connection={machine.connection}
      data-freshness={machine.freshness}
      data-collector={atlas.collectorState}
      data-pressure={atlas.pressureLevel}
      data-utilization={atlas.utilization.state}
      data-anomalous={atlas.anomalous || undefined}
      data-selected={selected || undefined}
      style={atlasBackgroundStyle}
      onClick={() => onSelect(machine)}
      onFocus={() => onIntent(machine)}
    >
      <span className="machine-monitor__atlas-identity" aria-hidden="true">
        <b>{atlas.glyph}</b>
        <span><strong>{machine.label}</strong><small>{selected ? "Inspecting" : atlas.stateLabel}</small></span>
      </span>
      <span className="machine-monitor__atlas-score" aria-hidden="true">
        <strong>{atlas.utilization.value == null ? "—" : `${atlas.utilization.value.toFixed(1)}%`}</strong><small>{atlas.utilization.compactLabel}</small>
      </span>
      <span className="machine-monitor__atlas-metrics" aria-hidden="true">
        {atlas.pressures.map((value) => <span
          className="machine-monitor__atlas-metric"
          data-level={value.level}
          data-available={value.value != null || undefined}
          key={value.key}
          style={{ "--machine-monitor-pressure": `${value.value ?? 0}%` } as CSSProperties}
        >
          <b>{value.shortLabel}</b><i><i /></i>
        </span>)}
      </span>
    </button>
    <span id={descriptionId} className="machine-monitor__visually-hidden">{description}</span>
  </li>;
});

function FleetPicker({ overview, selectedMachineKey, onSelect, onIntent }: {
  overview: FleetOverviewResult;
  selectedMachineKey: string | null;
  onSelect: (machine: FleetMachine) => void;
  onIntent: (machine: FleetMachine) => void;
}) {
  const utilizationAttentionCount = overview.machines.filter((machine) => fleetAtlasPresentation(machine).utilization.state === "attention").length;
  const healthAttentionCount = overview.machines.filter((machine) => {
    const atlas = fleetAtlasPresentation(machine);
    return atlas.anomalous && atlas.utilization.state !== "attention";
  }).length;
  const utilizationMachines = useMemo(() => overview.machines.map((machine) => {
    const atlas = fleetAtlasPresentation(machine);
    const status: FleetUtilizationDatum["status"] = atlas.utilization.value == null
      ? "unavailable"
      : machine.connection === "disconnected"
        ? "disconnected"
        : machine.freshness === "stale" ? "stale" : "current";
    return {
      machineKey: machineIdentityKey(machine.machine),
      label: machine.label,
      // A stale or disconnected observation can remain useful in its native
      // card, but must not become a bar that looks like a current low value.
      utilization: status === "current" ? atlas.utilization.value : null,
      headroomToAttention: status === "current" ? atlas.utilization.headroomToAttention : null,
      status,
      statusLabel: atlas.stateLabel,
      selected: machineIdentityKey(machine.machine) === selectedMachineKey,
    };
  }), [overview.machines, selectedMachineKey]);
  const selectUtilizationMachine = useCallback((machineKey: string) => {
    const machine = overview.machines.find((candidate) => machineIdentityKey(candidate.machine) === machineKey);
    if (machine != null) onSelect(machine);
  }, [onSelect, overview.machines]);
  return <section className="machine-monitor__fleet-picker" data-inspecting={selectedMachineKey != null || undefined} aria-labelledby="machine-monitor-fleet-title">
    <header>
      <div>
        <h2 id="machine-monitor-fleet-title">Fleet overview</h2>
        <p>{`${overview.machines.length} source${overview.machines.length === 1 ? "" : "s"} · utilization, health, and switching in one view`}</p>
      </div>
      <span className="machine-monitor__fleet-generation">{utilizationAttentionCount > 0 ? `${utilizationAttentionCount} at ≥${FLEET_UTILIZATION_ATTENTION_PERCENT}%` : "Utilization below 70%"}{healthAttentionCount > 0 ? ` · ${healthAttentionCount} health signal${healthAttentionCount === 1 ? "" : "s"}` : ""}</span>
    </header>
    {overview.machines.length > 0 && <FleetUtilizationChart className="machine-monitor__fleet-utilization" machines={utilizationMachines} onSelectMachine={selectUtilizationMachine} />}
    {overview.machines.length === 0 ? <p className="machine-monitor__empty">No machines are registered yet.</p> : <ol>
      {overview.machines.map((machine) => <FleetPickerRow
        key={machineIdentityKey(machine.machine)}
        machine={machine}
        selected={machineIdentityKey(machine.machine) === selectedMachineKey}
        onSelect={onSelect}
        onIntent={onIntent}
      />)}
    </ol>}
  </section>;
}

const DashboardMetricCard = memo(function DashboardMetricCard({ metric }: { metric: DashboardMetric }) {
  return <article data-attention={metric.attention || undefined} data-unavailable={metric.unavailable || undefined}>
    <span>{metric.label}</span>
    <strong>{metric.value}</strong>
    <small>{metric.detail}</small>
  </article>;
});

const RootDiskBreakdown = memo(function RootDiskBreakdown({ timeline }: { timeline: MachineTimelineResult }) {
  const directories = useMemo(() => dashboardDirectories(timeline), [timeline]);
  const largest = directories[0]?.bytes ?? 0;
  return <section className="machine-monitor__directories" aria-labelledby="machine-monitor-root-disk-title">
    <h2 id="machine-monitor-root-disk-title">Root disk breakdown</h2>
    <p>Ranked root-filesystem directory observations only. Nested measurements are exclusive; partial and range-derived entries are labeled.</p>
    {directories.length === 0 ? <p className="machine-monitor__empty">No retained directory measurements are available for this range.</p> : <ol>
      {directories.map((directory) => <li key={directory.id} data-derived={directory.derived || undefined} data-partial={directory.partial || undefined} style={{ "--machine-monitor-directory-rank": `${largest <= 0 ? 0 : directory.bytes / largest * 100}%` } as CSSProperties}>
        <span>{directory.label}</span>
        <strong>{displayMetric(directory.bytes, "bytes")}</strong>
        <i aria-hidden="true"><i /></i>
        <small>{directory.partial ? "Partial measurement" : directory.derived ? "Range-derived measurement" : displayByteRate(directory.growthBytesPerDay)}</small>
      </li>)}
    </ol>}
  </section>;
});

const MachineContext = memo(function MachineContext({ inventory, loading, error }: {
  inventory: MachineInventoryResult | null;
  loading: boolean;
  error: string | null;
}) {
  if (inventory == null) {
    return <section className="machine-monitor__machine-context" aria-labelledby="machine-monitor-context-title" aria-busy={loading} data-loading={loading || undefined}>
      <header><div><h2 id="machine-monitor-context-title">Machine context</h2><p>Daemon-visible hardware and operating-system facts are collected separately from live telemetry.</p></div></header>
      <p className="machine-monitor__timeline-status" role="status">{loading ? "Loading machine context…" : error == null ? "Machine context has not been collected yet." : `Machine context could not be read: ${error}`}</p>
    </section>;
  }
  const snapshot = inventory.inventory;
  if (snapshot == null) {
    return <section className="machine-monitor__machine-context" aria-labelledby="machine-monitor-context-title" aria-busy={loading} data-loading={loading || undefined}>
      <header><div><h2 id="machine-monitor-context-title">Machine context</h2><p>Daemon-visible hardware and operating-system facts are collected separately from live telemetry.</p></div><span>{loading ? "Refreshing" : "Unavailable"}</span></header>
      <p className="machine-monitor__timeline-status" role="status">{inventory.lastError ?? "No inventory snapshot has been retained for this machine yet."}</p>
    </section>;
  }
  const logicalCores = snapshot.cpu.logicalCores;
  const physicalCores = snapshot.cpu.observedPhysicalCores;
  const packages = snapshot.cpu.observedPackages;
  const cpuDescription = logicalCores == null
    ? snapshot.cpu.availability.reason ?? "CPU inventory is unavailable."
    : `${logicalCores} logical core${logicalCores === 1 ? "" : "s"}${physicalCores == null ? "" : `; ${physicalCores} observed physical core${physicalCores === 1 ? "" : "s"}`}${packages == null ? "" : ` across ${packages} observed package${packages === 1 ? "" : "s"}`}.`;
  const speed = snapshot.cpu.speedMHz == null ? null : snapshot.cpu.speedMHz >= 1_000
    ? `${(snapshot.cpu.speedMHz / 1_000).toFixed(snapshot.cpu.speedMHz % 1_000 === 0 ? 0 : 1)} GHz`
    : `${snapshot.cpu.speedMHz.toFixed(0)} MHz`;
  const model = [snapshot.cpu.model, speed].filter((value): value is string => value != null).join(" · ") || "Unavailable";
  const ram = snapshot.memory.usableBytes == null ? "Unavailable" : displayMetric(snapshot.memory.usableBytes, "bytes");
  const os = [snapshot.os.name, snapshot.os.version, snapshot.os.kernel == null ? null : `kernel ${snapshot.os.kernel}`, snapshot.os.architecture].filter((value): value is string => value != null).join(" · ");
  const locationDescription = "Location is not operator-reported and is never inferred from IPs or cloud metadata.";
  const raidDescription = snapshot.raid.reason ?? "Linux md status only; hardware RAID, LVM, and ZFS are not inferred.";
  const raid = snapshot.raid.state === "available" ? `${snapshot.raid.arrays.length} md` : snapshot.raid.state === "not-detected" ? "None detected" : "Unavailable";
  const receipt = inventory.receivedAtMs == null ? "Server receipt time unavailable." : `Server received this profile ${latestTime(inventory.receivedAtMs)}.`;
  return <section className="machine-monitor__machine-context" aria-labelledby="machine-monitor-context-title" data-visibility={snapshot.visibility} aria-busy={loading}>
    <header>
      <div><h2 id="machine-monitor-context-title">Machine context</h2><p>{`${snapshot.visibility === "guest-visible" ? "Guest-visible" : snapshot.visibility === "host-visible" ? "Daemon-visible" : "Visibility unknown"} · host-reported observed ${latestTime(snapshot.observedAtMs)}`}</p></div>
      <span>{loading ? "Refreshing" : inventory.lastError == null ? "Static profile" : "Refresh failed"}</span>
    </header>
    <dl className="machine-monitor__machine-facts">
      <div><dt>CPU</dt><dd className="machine-monitor__core-count" aria-label={cpuDescription}>{logicalCores == null ? "Unavailable" : <><span><strong>{logicalCores}</strong><abbr title="Logical CPU cores">L</abbr></span>{physicalCores != null && <span><strong>{physicalCores}</strong><abbr title="Observed physical CPU cores">P</abbr></span>}{packages != null && <span><strong>{packages}</strong><abbr title="Observed CPU packages">S</abbr></span>}</>}</dd></div>
      <div className="machine-monitor__machine-fact--wrap"><dt>CPU spec</dt><dd>{model}</dd></div>
      <div><dt>Visible RAM</dt><dd title={ram}>{ram}</dd></div>
      <div className="machine-monitor__machine-fact--wrap"><dt>Operating system</dt><dd>{os || "Unavailable"}</dd></div>
      <div><dt>Location</dt><dd aria-label={locationDescription}>Not set</dd></div>
      <div><dt>Linux md RAID</dt><dd aria-label={raidDescription}>{raid}</dd></div>
    </dl>
    <details className="machine-monitor__context-definitions">
      <summary>Full facts and definitions</summary>
      <dl>
        <div><dt>CPU labels</dt><dd>{`${cpuDescription} `}<abbr title="Logical CPU cores">L</abbr> is runtime-visible; <abbr title="Observed physical CPU cores">P</abbr> and <abbr title="Observed CPU packages">S</abbr> are best-effort observed topology.</dd></div>
        <div><dt>CPU spec</dt><dd>{snapshot.cpu.availability.state === "available" ? `${model}. Model and nominal speed come from the daemon runtime; they are not a benchmark.` : snapshot.cpu.availability.reason}</dd></div>
        <div><dt>Visible RAM</dt><dd>{snapshot.memory.availability.state === "available" ? `${ram} usable memory is visible to this daemon, not a DIMM inventory.` : snapshot.memory.availability.reason}</dd></div>
        <div><dt>Operating system</dt><dd>{`${os || "Unavailable"}. `}{snapshot.visibility === "guest-visible" ? "This is the WSL/VM guest view, not the Windows host." : "Kernel and architecture are reported by the daemon."}</dd></div>
        <div><dt>Receipt and refresh</dt><dd>{`${receipt} ${inventory.lastError == null ? "Last profile refresh succeeded." : `Last profile refresh failed ${inventory.lastErrorAtMs == null ? "at an unknown time" : latestTime(inventory.lastErrorAtMs)}: ${inventory.lastError}`}`}</dd></div>
        <div><dt>Location and RAID</dt><dd>{`${locationDescription} ${raidDescription}`}</dd></div>
      </dl>
    </details>
    <details className="machine-monitor__inventory-disclosure">
      <summary>Disks and inventory limits <span>{snapshot.disksAvailability.state === "available" ? `${snapshot.disks.length} visible disk${snapshot.disks.length === 1 ? "" : "s"}` : snapshot.disksAvailability.state}</span></summary>
      <div>
        {snapshot.disks.length === 0 ? <p>{snapshot.disksAvailability.reason}</p> : <ol>{snapshot.disks.map((disk) => <li key={disk.id}><strong>{displayMetric(disk.sizeBytes, "bytes")}</strong><span>{disk.model ?? "Model unavailable"}</span><small>{`${disk.kind}${disk.rotational == null ? "" : disk.rotational ? " · rotational" : " · solid-state"}${disk.readOnly == null ? "" : disk.readOnly ? " · read-only" : ""}`}</small></li>)}</ol>}
        {snapshot.raid.arrays.length > 0 && <p>{snapshot.raid.arrays.map((array) => `${array.name}: ${array.status}`).join(" · ")}</p>}
        {snapshot.limitations.length > 0 && <ul>{snapshot.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>}
      </div>
    </details>
  </section>;
});

function timelineBucketAverage(timeline: MachineTimelineResult, metricId: FleetMetricId, index: number): number | null {
  const value = timeline.metrics.find((metric) => metric.metricId === metricId)?.buckets[index]?.average;
  return value == null || !Number.isFinite(value) ? null : value;
}

const HistoryDataDisclosure = memo(function HistoryDataDisclosure({ timeline }: { timeline: MachineTimelineResult }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => {
    if (!open) return [];
    return Array.from({ length: timeline.bucket.count }, (_, index) => {
      const cpu = timelineBucketAverage(timeline, "cpu.utilization.percent", index);
      const memory = percentageOf(
        timelineBucketAverage(timeline, "memory.used.bytes", index),
        timelineBucketAverage(timeline, "memory.total.bytes", index),
      );
      const disk = percentageOf(
        timelineBucketAverage(timeline, "disk.root.used.bytes", index),
        timelineBucketAverage(timeline, "disk.root.total.bytes", index),
      );
      const load = timelineBucketAverage(timeline, "load.5", index);
      return {
        atMs: timeline.range.startMs + index * timeline.bucket.widthMs,
        cpu,
        memory,
        disk,
        load,
      };
    });
  }, [open, timeline]);
  const gapSummary = timeline.gaps.length === 0
    ? "No unavailable metric gaps are reported."
    : `${timeline.gaps.length} unavailable metric gap${timeline.gaps.length === 1 ? "" : "s"} are reported below.`;
  return <details className="machine-monitor__history-data" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>History data <span>{`${timeline.bucket.count} exact buckets`}</span></summary>
    {open && <div className="machine-monitor__history-data-body">
      <p>{coverageText(timeline)} {gapSummary}</p>
      <div className="machine-monitor__history-data-table" tabIndex={0} aria-label="Exact plotted history data">
        <table>
          <thead><tr><th scope="col">Time</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Root disk</th><th scope="col">Load (5 min)</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.atMs}>
            <td>{latestTime(row.atMs)}</td><td>{row.cpu == null ? "—" : displayMetric(row.cpu, "percent")}</td><td>{row.memory == null ? "—" : displayMetric(row.memory, "percent")}</td><td>{row.disk == null ? "—" : displayMetric(row.disk, "percent")}</td><td>{row.load == null ? "—" : displayMetric(row.load, "load")}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {timeline.gaps.length > 0 && <ul className="machine-monitor__history-gaps" aria-label="Unavailable history gaps">
        {timeline.gaps.map((gap) => <li key={`${gap.metricId}:${gap.startMs}:${gap.endMs}`}>{`${metricCatalogEntry(gap.metricId).label}: ${latestTime(gap.startMs)}–${latestTime(gap.endMs)} · ${gap.reason}`}</li>)}
      </ul>}
    </div>}
  </details>;
});

function coverageText(timeline: MachineTimelineResult): string {
  if (timeline.coverage.state === "complete") return "Coverage is complete for the requested bounded range.";
  if (timeline.coverage.state === "empty") return "No observations are retained for the requested range.";
  return `Coverage is partial${timeline.coverage.firstObservedAtMs == null ? "." : `; observations run from ${latestTime(timeline.coverage.firstObservedAtMs)} to ${latestTime(timeline.coverage.lastObservedAtMs)}.`}`;
}

function selectedMachineStatus(machine: FleetMachine): string {
  const asOf = latestTime(machine.latestCollectedAtMs);
  if (machine.connection === "disconnected") return `Disconnected · last observed ${asOf}`;
  if (machine.freshness === "stale") return `Stale · last observed ${asOf}`;
  return `Current · as of ${asOf}`;
}

const MachineNoticeRail = memo(function MachineNoticeRail({ machine, connection, chartProvenance, timelineLoading, timelineError }: {
  machine: FleetMachine;
  connection: string;
  chartProvenance: string | null;
  timelineLoading: boolean;
  timelineError: string | null;
}) {
  const hasNotices = machine.lastError != null
    || machine.warnings.length > 0
    || machine.connection === "disconnected"
    || machine.freshness === "stale"
    || chartProvenance != null
    || timelineLoading
    || timelineError != null;
  if (!hasNotices) return null;
  return <aside className="machine-monitor__notice-rail" aria-label="Machine notices">
    {machine.lastError != null && <p className="machine-monitor__error" role="alert">Collector error: {machine.lastError}</p>}
    {machine.warnings.length > 0 && <ul className="machine-monitor__warnings" aria-label="Machine warnings">
      {machine.warnings.map((warning, index) => <li key={`${warning.kind}:${warning.metricId ?? "machine"}:${index}`}><strong>{warning.kind}</strong><span>{warning.message}</span></li>)}
    </ul>}
    {machine.connection === "disconnected" && <p className="machine-monitor__timeline-status" role="status">Machine is disconnected. Retained history remains available when the local server can read it.</p>}
    {machine.freshness === "stale" && <p className="machine-monitor__timeline-status" role="status">Machine data is stale; the latest retained history is labeled below.</p>}
    {chartProvenance != null && <p className="machine-monitor__timeline-status" role="status">{chartProvenance}</p>}
    {timelineLoading && <p className="machine-monitor__timeline-status" role="status">Loading timeline for {machine.label}…</p>}
    {timelineError != null && <p className="machine-monitor__error" role="alert">Timeline refresh error: {timelineError}</p>}
    {connection !== "connected" && <p className="machine-monitor__timeline-status" role="status">Realtime transport is {connection}; the timeline will reconcile when it reconnects.</p>}
  </aside>;
});

const SelectedMachineOverview = memo(function SelectedMachineOverview({ machine, rangeHours, timelineView, timelineLoading, timelineError, inventory, inventoryLoading, inventoryError, connection, onRange, onActivateEvent }: {
  machine: FleetMachine;
  rangeHours: RangeHours;
  timelineView: TimelineView;
  timelineLoading: boolean;
  timelineError: string | null;
  inventory: MachineInventoryResult | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  connection: string;
  onRange: (hours: RangeHours) => void;
  onActivateEvent: (activation: TimelineEventActivation) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const visibleMachineKey = timelineView == null ? null : machineIdentityKey(timelineView.timeline.machine);
  const selectedMachineKey = machineIdentityKey(machine.machine);
  const retainedForOtherMachine = visibleMachineKey != null && visibleMachineKey !== selectedMachineKey;
  const matchingCurrentGeneration = timelineView != null
    && !retainedForOtherMachine
    && fleetGenerationMatches(timelineView.timeline.generation, machine.generation);
  const historyStale = timelineView?.stale === true || connection !== "connected" || machine.freshness !== "fresh";
  const retainedPriorGeneration = timelineView != null && !retainedForOtherMachine && !fleetGenerationMatches(timelineView.timeline.generation, machine.generation);
  const chartProvenance = retainedForOtherMachine
    ? `Showing retained timeline for ${timelineView?.timeline.machine.machineId}; ${machine.label} is loading.`
    : retainedPriorGeneration ? "Stale: showing a retained prior generation." : null;
  const eventActivationAllowed = matchingCurrentGeneration && !historyStale;
  const dashboardMetrics = useMemo(() => selectedMachineMetrics(machine), [machine]);
  const visibleTimeline = timelineView?.timeline ?? null;
  const visibleSelectedTimeline = timelineView != null && !retainedForOtherMachine ? timelineView.timeline : null;
  const eventSummary = visibleSelectedTimeline == null ? null : `${visibleSelectedTimeline.events.totalCount} exact event${visibleSelectedTimeline.events.totalCount === 1 ? "" : "s"}`;
  return <section className="machine-monitor__selected-machine" data-stale={historyStale || undefined} aria-labelledby="machine-monitor-selected-title">
    <header>
      <div>
        <h1 id="machine-monitor-selected-title">{machine.label}</h1>
        <p>{`${connectionText(machine)} · ${generationText(machine)}`}</p>
      </div>
      <div className="machine-monitor__selected-controls">
        <span className="machine-monitor__selected-status" data-state={machine.connection === "disconnected" ? "disconnected" : machine.freshness === "stale" ? "stale" : "current"}>{selectedMachineStatus(machine)}</span>
        <label>
          <span>History</span>
          <select value={rangeHours} onChange={(event) => onRange(Number(event.target.value) as RangeHours)}>
            {RANGES.map((hours) => <option key={hours} value={hours}>{rangeLabel(hours)}</option>)}
          </select>
        </label>
      </div>
    </header>
    <section className="machine-monitor__metrics" aria-label={`Operational summary for ${machine.label}`}>
      {dashboardMetrics.map((metric) => <DashboardMetricCard key={metric.id} metric={metric} />)}
    </section>
    <section className="machine-monitor__timeline" aria-labelledby="machine-monitor-history-title">
      <header><div><h2 id="machine-monitor-history-title">Operational history</h2><p>{`CPU, memory, and root disk share a ${FLEET_UTILIZATION_ATTENTION_PERCENT}% attention line.`}</p></div><span>{rangeLabel(rangeHours)}</span></header>
      {visibleTimeline == null ? <><p className="machine-monitor__empty">No retained timeline is available yet.</p><MachineNoticeRail machine={machine} connection={connection} chartProvenance={chartProvenance} timelineLoading={timelineLoading} timelineError={timelineError} /><MachineContext inventory={inventory} loading={inventoryLoading} error={inventoryError} /></> : <>
        <MachineDashboardChart className="machine-monitor__dashboard-chart" timeline={visibleTimeline} stale={historyStale || retainedForOtherMachine} />
        <MachineNoticeRail machine={machine} connection={connection} chartProvenance={chartProvenance} timelineLoading={timelineLoading} timelineError={timelineError} />
        <MachineContext inventory={inventory} loading={inventoryLoading} error={inventoryError} />
        {!retainedForOtherMachine && visibleSelectedTimeline != null && <RootDiskBreakdown timeline={visibleSelectedTimeline} />}
        {!retainedForOtherMachine && visibleSelectedTimeline != null && <HistoryDataDisclosure timeline={visibleSelectedTimeline} />}
        {!retainedForOtherMachine && visibleSelectedTimeline != null && <details className="machine-monitor__full-timeline" open={detailOpen} onToggle={(event) => setDetailOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>Full metric timeline and events <span>{eventSummary}</span></summary>
          {detailOpen && <MachineTimelineChart
            className="machine-monitor__timeline-chart"
            timeline={visibleSelectedTimeline}
            stale={historyStale}
            refreshing={timelineLoading}
            activationDisabled={!eventActivationAllowed}
            onActivateEvent={onActivateEvent}
          />}
        </details>}
      </>}
    </section>
  </section>;
});

function MachineMonitorPanel() {
  const navigate = useBbNavigate();
  const fleet = useFleetMonitor();
  const activateEvent = useCallback((activation: TimelineEventActivation) => {
    if (activation.bbReference == null || !fleet.canActivateEvent(activation)) return;
    navigate.toThread(activation.bbReference.threadId);
  }, [fleet.canActivateEvent, navigate]);
  const selected = fleet.selectedMachine();
  const inventory = useMachineInventory(selected, fleet.inventoryRevision);

  return <main className="machine-monitor">
    <header className="machine-monitor__page-header">
      <div><h1>Machine Monitor</h1><p>Fleet atlas and machine history.</p></div>
      <span role="status">Realtime {fleet.connection}</span>
    </header>
    {fleet.overviewLoading && fleet.overview == null && <p className="machine-monitor__empty" role="status">Loading the fleet overview…</p>}
    {selected != null && <SelectedMachineOverview
      machine={selected}
      rangeHours={fleet.rangeHours}
      timelineView={fleet.timelineView}
      timelineLoading={fleet.timelineLoading}
      timelineError={fleet.timelineError}
      inventory={inventory.value}
      inventoryLoading={inventory.loading}
      inventoryError={inventory.error}
      connection={fleet.connection}
      onRange={fleet.chooseRange}
      onActivateEvent={activateEvent}
    />}
    {fleet.overview != null && <FleetPicker overview={fleet.overview} selectedMachineKey={fleet.selectedMachineKey} onSelect={fleet.chooseMachine} onIntent={fleet.prefetchMachine} />}
    {fleet.overviewError != null && <aside className="machine-monitor__page-notices" aria-label="Fleet notices"><p className="machine-monitor__error" role="alert">{fleet.overviewError}</p></aside>}
    <MachineMonitorReferences />
  </main>;
}

function SidebarHealthAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [health, setHealth] = useState<MachineMonitorHealth | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(() => {
    void rpc.call("health").then((next) => {
      if (mounted.current) setHealth(next);
    }).catch(() => {
      if (mounted.current) setHealth(null);
    });
  }, [rpc]);
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  const prior = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && prior.current !== "connected") refresh();
    prior.current = connection;
  }, [connection, refresh]);
  useRealtime("machine-monitor-fleet", refresh);
  const warnings = health?.warnings ?? [];
  if (warnings.length === 0) return null;
  return <span className="machine-monitor__sidebar-warning" role="img" aria-label={`Machine health warning: ${warnings.join(", ")}`} title={`Machine health warning: ${warnings.join(", ")}`} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "machine-monitor",
    title: "Machine Monitor",
    icon: "Activity",
    path: "machine-monitor",
    component: MachineMonitorPanel,
    experimental_sidebarAccessory: SidebarHealthAccessory,
  });
});
