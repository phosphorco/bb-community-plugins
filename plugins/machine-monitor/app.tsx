import { Component, lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
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
import {
  DEFAULT_MACHINE_SECTIONS,
  orderMachinesBySections,
  parseMachineSections,
  sectionMembership,
  type MachineSection,
} from "./machine-sections.ts";
import type { MachineMonitorHealth, rpcContract } from "./rpc-contract.ts";
import { FLEET_UTILIZATION_ATTENTION_PERCENT } from "./fleet-contract.ts";
import type { FleetUtilizationDatum } from "./timeline-chart.tsx";
import type { TimelineEventActivation } from "./timeline-compiler.ts";
import "./app.css";

// The native fleet controls and exact retained-event disclosures stay in the
// entry artifact. ECharts is requested only by the chart surface a person has
// opened; artifact-format-v2 emits each of these imports as an integrity-bound
// chunk rather than folding the renderer back into app.js.
const FleetUtilizationChart = lazy(async () => {
  const module = await import("./timeline-chart.tsx");
  return { default: module.FleetUtilizationChart };
});
const MachineDashboardChart = lazy(async () => {
  const module = await import("./timeline-chart.tsx");
  return { default: module.MachineDashboardChart };
});
const MachineTimelineChart = lazy(async () => {
  const module = await import("./timeline-chart.tsx");
  return { default: module.MachineTimelineChart };
});

class ChartChunkBoundary extends Component<Readonly<{ children: ReactNode; label: string }>, Readonly<{ failed: boolean }>> {
  state = { failed: false };

  static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <p className="machine-monitor__chart-loading" role="status">
        {this.props.label} could not load. <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      </p>;
    }
    return <Suspense fallback={<p className="machine-monitor__chart-loading" role="status">Preparing {this.props.label}…</p>}>
      {this.props.children}
    </Suspense>;
  }
}

const RANGES = [1, 6, 24, 24 * 7, 24 * 30] as const;
type RangeHours = typeof RANGES[number];
type FleetMachine = FleetOverviewResult["machines"][number];
type TimelineView = Readonly<{ timeline: MachineTimelineResult; stale: boolean }> | null;
type InventoryView = Readonly<{ key: string | null; value: MachineInventoryResult | null; loading: boolean; error: string | null }>;

const PREFETCH_LIMIT = 6;
const INVENTORY_CACHE_LIMIT = 64;
const PANEL_PATH = "machine-monitor";

/**
 * The panel owns two kinds of page: a compact list for one configured
 * section (the default page is the first section) and the single-machine
 * inspector. A machine route without a key opens the first machine.
 */
type MonitorRoute = Readonly<{ kind: "section"; slug: string | null }> | Readonly<{ kind: "machine"; key: string | null }>;

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseRoute(subPath: string): MonitorRoute {
  const [head = "", ...rest] = subPath.replace(/^\/+|\/+$/g, "").split("/");
  const tail = rest.length === 0 ? null : decodeSegment(rest.join("/"));
  if (head === "machine") return { kind: "machine", key: tail };
  if (head === "section") return { kind: "section", slug: tail };
  return { kind: "section", slug: null };
}

// Logical subpaths: `toPluginPanel` encodes each segment itself, so only
// hand-built hrefs apply encodeURIComponent.
function sectionSubPath(slug: string): string {
  return `section/${slug}`;
}

function machineSubPath(key: string): string {
  return `machine/${key}`;
}

function panelHref(pluginId: string, subPath: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/${PANEL_PATH}/${subPath.split("/").map(encodeURIComponent).join("/")}`;
}

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

/** Recency against server time, so a skewed browser clock cannot misreport it. */
function recencyText(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, (nowMs - atMs) / 1_000);
  if (seconds < 60) return "Now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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

function useFleetMonitor(route: MonitorRoute) {
  const rpc = useRpc<typeof rpcContract>();
  const routeRef = useRef(route);
  routeRef.current = route;
  /** True while an explicit machine route is shown as another machine. */
  const fallbackSelectionRef = useRef(false);
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

  const anchorRange = useCallback((serverNowMs: number) => {
    const nextRange = rangeFor(rangeHoursRef.current, serverNowMs);
    if (sameTimelineRange(rangeRef.current, nextRange)) return;
    rangeRef.current = nextRange;
    prefetch.current = { range: rangeKey(nextRange), keys: new Set() };
    setRange(nextRange);
  }, []);

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
      const activeRoute = routeRef.current;
      const routed = activeRoute.kind === "machine" && activeRoute.key != null
        ? merged.machines.find((machine) => machineIdentityKey(machine.machine) === activeRoute.key)
        : undefined;
      // A section page inspects no machine, so it reads no timeline; it still
      // anchors the range to server time for the first machine it opens.
      if (activeRoute.kind === "section" && isInitialOverview) anchorRange(merged.generatedAtMs);
      // An explicitly routed machine that appears later replaces a fallback.
      if (activeRoute.kind === "machine" && (selected == null || (fallbackSelectionRef.current && routed != null))) {
        selected = routed ?? selected ?? merged.machines[0] ?? null;
        fallbackSelectionRef.current = routed == null && activeRoute.key != null;
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
  }, [anchorRange, client, commitOverview, requestTimeline, selectedMachine]);
  refreshOverviewRef.current = refreshOverview;

  const chooseMachine = useCallback((machine: FleetMachine) => {
    const key = machineIdentityKey(machine.machine);
    fallbackSelectionRef.current = false;
    selectedKeyRef.current = key;
    setSelectedMachineKey(key);
    requestTimeline(machine, rangeRef.current);
  }, [requestTimeline]);

  // Follow route changes (links, the switcher, browser history). Selection
  // made inside the inspector updates the route with `replace`, so the route
  // key then already matches and this is a no-op.
  const routeKey = route.kind === "machine" ? route.key : null;
  useEffect(() => {
    if (route.kind === "section") {
      if (selectedKeyRef.current == null) return;
      selectedKeyRef.current = null;
      setSelectedMachineKey(null);
      timelineToken.current += 1;
      setTimelineLoading(false);
      return;
    }
    const source = overviewRef.current;
    if (source == null) return;
    const routed = routeKey == null ? undefined : source.machines.find((machine) => machineIdentityKey(machine.machine) === routeKey);
    const target = routed ?? selectedMachine() ?? source.machines[0];
    if (target == null) return;
    if (machineIdentityKey(target.machine) !== selectedKeyRef.current) {
      // Entering from a section: history should end at the latest overview.
      if (selectedKeyRef.current == null) anchorRange(source.generatedAtMs);
      chooseMachine(target);
    }
    // Mark the fallback even when the shown machine is unchanged (A → absent
    // B keeps A) so B's later arrival still replaces it.
    fallbackSelectionRef.current = routed == null && routeKey != null;
  }, [anchorRange, chooseMachine, route.kind, routeKey, selectedMachine]);

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
    {overview.machines.length > 0 && <ChartChunkBoundary label="fleet utilization chart"><FleetUtilizationChart className="machine-monitor__fleet-utilization" machines={utilizationMachines} onSelectMachine={selectUtilizationMachine} /></ChartChunkBoundary>}
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

const SelectedMachineOverview = memo(function SelectedMachineOverview({ machine, machines, sections, sectionCounts, rangeHours, timelineView, timelineLoading, timelineError, inventory, inventoryLoading, inventoryError, connection, onSwitch, onRange, onActivateEvent }: {
  machine: FleetMachine;
  machines: readonly FleetMachine[];
  sections: readonly MachineSection[];
  sectionCounts: readonly number[];
  rangeHours: RangeHours;
  timelineView: TimelineView;
  timelineLoading: boolean;
  timelineError: string | null;
  inventory: MachineInventoryResult | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  connection: string;
  onSwitch: (target: SwitchTarget) => void;
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
  return <section className="machine-monitor__selected-machine" data-stale={historyStale || undefined} aria-labelledby="machine-monitor-selected-heading">
    <header>
      <div>
        <h2 id="machine-monitor-selected-heading" className="machine-monitor__visually-hidden">{machine.label}</h2>
        <MachineSwitcher label="Selected machine" value={`machine:${selectedMachineKey}`} machines={machines} sections={sections} counts={sectionCounts} onSwitch={onSwitch} />
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
        <ChartChunkBoundary label="machine history chart"><MachineDashboardChart className="machine-monitor__dashboard-chart" timeline={visibleTimeline} stale={historyStale || retainedForOtherMachine} /></ChartChunkBoundary>
        <MachineNoticeRail machine={machine} connection={connection} chartProvenance={chartProvenance} timelineLoading={timelineLoading} timelineError={timelineError} />
        <MachineContext inventory={inventory} loading={inventoryLoading} error={inventoryError} />
        {!retainedForOtherMachine && visibleSelectedTimeline != null && <RootDiskBreakdown timeline={visibleSelectedTimeline} />}
        {!retainedForOtherMachine && visibleSelectedTimeline != null && <HistoryDataDisclosure timeline={visibleSelectedTimeline} />}
        {!retainedForOtherMachine && visibleSelectedTimeline != null && <details className="machine-monitor__full-timeline" open={detailOpen} onToggle={(event) => setDetailOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>Full metric timeline and events <span>{eventSummary}</span></summary>
          {detailOpen && <ChartChunkBoundary label="full metric timeline"><MachineTimelineChart
              className="machine-monitor__timeline-chart"
              timeline={visibleSelectedTimeline}
              stale={historyStale}
              refreshing={timelineLoading}
              activationDisabled={!eventActivationAllowed}
              onActivateEvent={onActivateEvent}
            /></ChartChunkBoundary>}
        </details>}
      </>}
    </section>
  </section>;
});

type SwitchTarget = Readonly<{ kind: "section"; section: MachineSection }> | Readonly<{ kind: "machine"; machine: FleetMachine }>;

type SectionMembership = Readonly<{
  /** Membership per section in configuration order. */
  of: (machine: FleetMachine) => readonly boolean[];
  counts: readonly number[];
}>;

const MEMBERSHIP_CACHE_LIMIT = 1_024;

/**
 * Overviews arrive every collection while names and sections rarely change,
 * so membership is matched once per (sections, name, ID) and shared by the
 * ordering, switcher counts, and section table.
 */
function useSectionMembership(sections: readonly MachineSection[], machines: readonly FleetMachine[]): SectionMembership {
  const cache = useRef<{ sections: readonly MachineSection[]; rows: Map<string, readonly boolean[]> }>({ sections, rows: new Map() });
  if (cache.current.sections !== sections || cache.current.rows.size > MEMBERSHIP_CACHE_LIMIT) cache.current = { sections, rows: new Map() };
  const rows = cache.current.rows;
  return useMemo(() => {
    const of = (machine: FleetMachine) => {
      const key = `${machine.label}\u0000${machine.machine.machineId}`;
      let row = rows.get(key);
      if (row == null) {
        row = sectionMembership(sections, machine);
        rows.set(key, row);
      }
      return row;
    };
    return { of, counts: sections.map((_, index) => machines.filter((machine) => of(machine)[index]).length) };
  }, [machines, rows, sections]);
}

/** One control for both page kinds: configured sections, then machines. */
const MachineSwitcher = memo(function MachineSwitcher({ label, value, machines, sections, counts, onSwitch }: {
  label: string;
  value: string;
  machines: readonly FleetMachine[];
  sections: readonly MachineSection[];
  counts: readonly number[];
  onSwitch: (target: SwitchTarget) => void;
}) {
  const change = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const [kind, ...rest] = event.target.value.split(":");
    const id = rest.join(":");
    if (kind === "section") {
      const section = sections.find((candidate) => candidate.slug === id);
      if (section != null) onSwitch({ kind: "section", section });
      return;
    }
    const machine = machines.find((candidate) => machineIdentityKey(candidate.machine) === id);
    if (machine != null) onSwitch({ kind: "machine", machine });
  }, [machines, onSwitch, sections]);
  return <label className="machine-monitor__selected-machine-picker">
    <span className="machine-monitor__visually-hidden">{label}</span>
    <select id="machine-monitor-selected-title" value={value} onChange={change}>
      <optgroup label="Sections">
        {sections.map((section, index) => <option key={section.slug} value={`section:${section.slug}`}>{`${section.title} (${counts[index] ?? 0})`}</option>)}
      </optgroup>
      <optgroup label="Machines">
        {machines.map((candidate) => <option key={machineIdentityKey(candidate.machine)} value={`machine:${machineIdentityKey(candidate.machine)}`}>{candidate.label}</option>)}
      </optgroup>
    </select>
  </label>;
});

const CompactPressure = memo(function CompactPressure({ value }: { value: FleetAtlasPressure }) {
  return <td className="machine-monitor__compact-pressure" data-level={value.level} aria-label={pressureText(value)}>
    <i aria-hidden="true" style={{ "--machine-monitor-pressure": `${value.value ?? 0}%` } as CSSProperties}><i /></i>
    <span>{value.value == null ? "—" : `${value.value.toFixed(0)}%`}</span>
  </td>;
});

const CompactMachineRow = memo(function CompactMachineRow({ machine, recency, href, onOpen, onIntent }: {
  machine: FleetMachine;
  recency: string;
  href: string;
  onOpen: (machine: FleetMachine) => void;
  onIntent: (machine: FleetMachine) => void;
}) {
  const atlas = fleetAtlasPresentation(machine);
  const load = latestMetricValue(machine, "load.5");
  const detailsId = useId();
  // Freshness outranks collector state in the atlas label; a compact row
  // still reports a concurrent collector failure or warning.
  const collectorNote = atlas.collectorState !== "clear" && atlas.state !== "failure" && atlas.state !== "warning"
    ? ` · collector ${atlas.collectorState}` : "";
  const details = [
    machine.lastError == null ? null : `Collector failure: ${machine.lastError}.`,
    ...machine.warnings.map((warning) => `${warning.kind}: ${warning.message}`),
  ].filter((value): value is string => value != null).join(" ");
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // Keep modified clicks native so a machine can open in a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(machine);
  };
  return <tr data-state={atlas.state} data-anomalous={atlas.anomalous || undefined}>
    <th scope="row">
      <a href={href} onClick={open} onFocus={() => onIntent(machine)} onPointerEnter={() => onIntent(machine)} aria-describedby={details.length > 0 ? detailsId : undefined}>
        <b aria-hidden="true">{atlas.glyph}</b>{machine.label}
      </a>
    </th>
    <td className="machine-monitor__compact-state" title={details || undefined}>
      {`${atlas.stateLabel}${collectorNote}`}
      {details.length > 0 && <span id={detailsId} className="machine-monitor__visually-hidden">{details}</span>}
    </td>
    {atlas.pressures.map((value) => <CompactPressure key={value.key} value={value} />)}
    <td className="machine-monitor__compact-number">{load == null ? "—" : displayMetric(load, "load")}</td>
    <td className="machine-monitor__compact-seen">{machine.latestCollectedAtMs == null ? "—" : <time dateTime={new Date(machine.latestCollectedAtMs).toISOString()} title={latestTime(machine.latestCollectedAtMs)}>{recency}</time>}</td>
  </tr>;
});

function MachineSectionsEditor({ text, storedErrors, sections, counts, machines }: {
  text: string;
  storedErrors: readonly string[];
  sections: readonly MachineSection[];
  counts: readonly number[];
  machines: readonly FleetMachine[];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const helpId = useId();
  const errorsId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const [status, setStatus] = useState<Readonly<{ saving: boolean; message: string | null; error: boolean }>>({ saving: false, message: null, error: false });
  const savedText = useRef(text);
  const saveToken = useRef(0);
  // Adopt the authoritative text unless this draft has local edits.
  useEffect(() => {
    setDraft((current) => current === savedText.current ? text : current);
    savedText.current = text;
  }, [text]);
  const preview = useMemo(() => parseMachineSections(draft), [draft]);
  const dirty = draft !== text;
  const save = () => {
    if (status.saving) return;
    const token = ++saveToken.current;
    const submitted = draft;
    setStatus({ saving: true, message: null, error: false });
    void rpc.call("saveMachineSections", { text: submitted }).then((result) => {
      if (token !== saveToken.current) return;
      // Treat the acknowledged value as the baseline; the draft adopts it
      // only if nothing was typed while the save was in flight.
      setDraft((current) => current === submitted ? result.text : current);
      savedText.current = result.text;
      setStatus({ saving: false, message: "Saved for everyone.", error: false });
    }).catch((cause) => {
      if (token === saveToken.current) setStatus({ saving: false, message: errorText(cause, "Could not save sections."), error: true });
    });
  };
  // Matching a draft costs one pass per machine, so only while it is shown.
  const previewCounts = useMemo(() => !open ? [] : dirty
    ? preview.sections.map((_, index) => machines.filter((machine) => sectionMembership(preview.sections, machine)[index]).length)
    : counts, [counts, dirty, machines, open, preview.sections]);
  const previewSections = dirty ? preview.sections : sections;
  const invalid = preview.errors.length > 0;
  const storedInvalid = storedErrors.length > 0 && !dirty;
  return <details className="machine-monitor__sections-editor" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>Edit sections <span>{`${sections.length} section${sections.length === 1 ? "" : "s"} · shared with everyone`}</span></summary>
    <div>
      <p id={helpId}>One section per line: a name pattern, then a quoted title. <code>*</code> and <code>?</code> are wildcards and <code>{"{a,b}"}</code> matches either name; patterns match machine names or IDs, ignoring case. The first section is the default page.</p>
      <textarea aria-label="Machine sections" aria-invalid={invalid || undefined} aria-describedby={invalid || storedInvalid ? `${helpId} ${errorsId}` : helpId} spellCheck={false} rows={Math.min(12, Math.max(4, draft.split("\n").length + 1))} value={draft} onChange={(event) => { setDraft(event.target.value); setStatus((current) => ({ ...current, message: null, error: false })); }} />
      <div id={errorsId} role="alert">
        {storedInvalid && <p className="machine-monitor__sections-errors">{`The saved sections are invalid, so the default "All" section is shown until they are fixed. ${storedErrors.join(" ")}`}</p>}
        {invalid && <ul className="machine-monitor__sections-errors">{preview.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      </div>
      <ul className="machine-monitor__sections-preview" aria-label="Section matches">
        {open && previewSections.map((section, index) => <li key={section.slug}><strong>{section.title}</strong><code>{section.pattern}</code><span>{`${previewCounts[index] ?? 0} machines`}</span></li>)}
      </ul>
      <div className="machine-monitor__sections-actions">
        <button type="button" disabled={!dirty || status.saving || invalid} onClick={save}>{status.saving ? "Saving…" : "Save sections"}</button>
        <button type="button" disabled={!dirty || status.saving} onClick={() => setDraft(text)}>Discard</button>
        <button type="button" disabled={status.saving || draft === DEFAULT_MACHINE_SECTIONS} onClick={() => setDraft(DEFAULT_MACHINE_SECTIONS)}>Use default</button>
        {status.message != null && <span role={status.error ? "alert" : "status"} data-error={status.error || undefined}>{status.message}</span>}
      </div>
    </div>
  </details>;
}

const MachineSectionView = memo(function MachineSectionView({ section, sections, membership, sectionsText, storedErrors, machines, nowMs, onSwitch, onIntent }: {
  section: MachineSection;
  membership: SectionMembership;
  storedErrors: readonly string[];
  nowMs: number;
  sections: readonly MachineSection[];
  sectionsText: string;
  machines: readonly FleetMachine[];
  onSwitch: (target: SwitchTarget) => void;
  onIntent: (machine: FleetMachine) => void;
}) {
  const pluginId = experimental_usePluginId();
  const sectionIndex = sections.indexOf(section);
  const members = useMemo(() => machines.filter((machine) => membership.of(machine)[sectionIndex]), [machines, membership, sectionIndex]);
  const attention = members.filter((machine) => fleetAtlasPresentation(machine).utilization.state === "attention").length;
  const measured = members.filter((machine) => fleetAtlasPresentation(machine).utilization.state !== "unavailable").length;
  const signals = members.filter((machine) => {
    const atlas = fleetAtlasPresentation(machine);
    return atlas.anomalous && atlas.utilization.state !== "attention";
  }).length;
  const openMachine = useCallback((machine: FleetMachine) => onSwitch({ kind: "machine", machine }), [onSwitch]);
  return <section className="machine-monitor__section" aria-labelledby="machine-monitor-section-heading">
    <header>
      <div>
        <h2 id="machine-monitor-section-heading" className="machine-monitor__visually-hidden">{section.title}</h2>
        <MachineSwitcher label="Machine Monitor view" value={`section:${section.slug}`} machines={machines} sections={sections} counts={membership.counts} onSwitch={onSwitch} />
        <p>{`${members.length} machine${members.length === 1 ? "" : "s"} matching ${section.pattern}`}</p>
      </div>
      <span className="machine-monitor__fleet-generation">{members.length === 0 ? "No matching machines" : attention > 0 ? `${attention} at ≥${FLEET_UTILIZATION_ATTENTION_PERCENT}%` : measured === 0 ? "Utilization unavailable" : `Utilization below ${FLEET_UTILIZATION_ATTENTION_PERCENT}%${measured < members.length ? ` · ${members.length - measured} unmeasured` : ""}`}{signals > 0 ? ` · ${signals} health signal${signals === 1 ? "" : "s"}` : ""}</span>
    </header>
    {members.length === 0 ? <p className="machine-monitor__empty">{`No machines match ${section.pattern}.`}</p> : <div className="machine-monitor__compact-table">
      <table aria-label={`${section.title} machines`}>
        <thead><tr><th scope="col">Machine</th><th scope="col">State</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Root disk</th><th scope="col">Load (5 min)</th><th scope="col">Last seen</th></tr></thead>
        <tbody>{members.map((machine) => {
          const key = machineIdentityKey(machine.machine);
          return <CompactMachineRow key={key} machine={machine} recency={machine.latestCollectedAtMs == null ? "" : recencyText(machine.latestCollectedAtMs, nowMs)} href={panelHref(pluginId, machineSubPath(key))} onOpen={openMachine} onIntent={onIntent} />;
        })}</tbody>
      </table>
    </div>}
    <MachineSectionsEditor text={sectionsText} storedErrors={storedErrors} sections={sections} counts={membership.counts} machines={machines} />
  </section>;
});

/**
 * Sections are one shared plugin setting. A save or another user's change
 * arrives on the realtime channel before the settings snapshot refreshes.
 */
function useMachineSections(): Readonly<{ text: string; sections: readonly MachineSection[]; storedErrors: readonly string[] }> {
  const { values } = useSettings();
  const configured = typeof values?.machineSections === "string" ? values.machineSections : DEFAULT_MACHINE_SECTIONS;
  const [pushed, setPushed] = useState<Readonly<{ base: string; text: string }> | null>(null);
  useRealtime("machine-monitor-sections", useCallback((payload: unknown) => {
    const text = (payload as { text?: unknown } | null)?.text;
    if (typeof text === "string") setPushed({ base: configured, text });
  }, [configured]));
  // Retire the overlay once settings catch up, so a later authoritative
  // value (for example after a missed reconnect signal) always wins.
  useEffect(() => {
    if (pushed != null && (configured === pushed.text || configured !== pushed.base)) setPushed(null);
  }, [configured, pushed]);
  const text = pushed != null && pushed.base === configured ? pushed.text : configured;
  // Stored text bypassed validation somehow: never activate part of it.
  return useMemo(() => {
    const parsed = parseMachineSections(text);
    if (parsed.errors.length === 0 && parsed.sections.length > 0) return { text, sections: parsed.sections, storedErrors: [] };
    return { text, sections: parseMachineSections(DEFAULT_MACHINE_SECTIONS).sections, storedErrors: parsed.errors.length > 0 ? parsed.errors : ["No sections are configured."] };
  }, [text]);
}

const NO_MACHINES: readonly FleetMachine[] = [];

function MachineMonitorPanel({ subPath = "" }: { subPath?: string }) {
  const navigate = useBbNavigate();
  const route = useMemo(() => parseRoute(subPath), [subPath]);
  const fleet = useFleetMonitor(route);
  const { text: sectionsText, sections, storedErrors } = useMachineSections();
  // Every list (section table, switcher, atlas) shares one section-derived
  // order; rows keep their identity so memoized rows still skip renders.
  const overview = fleet.overview;
  const membership = useSectionMembership(sections, overview?.machines ?? NO_MACHINES);
  const orderedOverview = useMemo(() => overview == null ? null : { ...overview, machines: orderMachinesBySections(overview.machines, sections, membership.of) }, [membership, overview, sections]);
  const activateEvent = useCallback((activation: TimelineEventActivation) => {
    if (activation.bbReference == null || !fleet.canActivateEvent(activation)) return;
    navigate.toThread(activation.bbReference.threadId);
  }, [fleet.canActivateEvent, navigate]);
  const selected = route.kind === "machine" ? fleet.selectedMachine() : null;
  const inventory = useMachineInventory(selected, fleet.inventoryRevision);
  const section = route.kind === "section"
    ? sections.find((candidate) => candidate.slug === route.slug) ?? sections[0]!
    : null;
  const { chooseMachine } = fleet;
  // A route change can unmount the focused link or switcher; hand focus to
  // the destination view's switcher instead of dropping it on the body.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!restoreFocus.current) return;
    const active = document.activeElement;
    if (active != null && active !== document.body && active.isConnected) {
      restoreFocus.current = false;
      return;
    }
    // The destination may mount a render later (a machine is selected
    // after the route changes), so keep the request until it exists.
    const switcher = document.getElementById("machine-monitor-selected-title");
    if (switcher == null) return;
    restoreFocus.current = false;
    switcher.focus();
  }, [subPath, selected != null]);
  const switchView = useCallback((target: SwitchTarget) => {
    restoreFocus.current = true;
    if (target.kind === "section") {
      navigate.toPluginPanel(PANEL_PATH, { subPath: sectionSubPath(target.section.slug) });
      return;
    }
    const key = machineIdentityKey(target.machine.machine);
    // Switching between machines replaces the entry so Back returns to the
    // section list rather than walking every inspected machine.
    navigate.toPluginPanel(PANEL_PATH, { subPath: machineSubPath(key), replace: route.kind === "machine" });
    if (route.kind === "machine") chooseMachine(target.machine);
  }, [chooseMachine, navigate, route.kind]);
  const pickAtlasMachine = useCallback((machine: FleetMachine) => switchView({ kind: "machine", machine }), [switchView]);

  return <main className="machine-monitor">
    <header className="machine-monitor__page-header">
      <div><h1>Machine Monitor</h1><p>Fleet atlas and machine history.</p></div>
      <span role="status">Realtime {fleet.connection}</span>
    </header>
    {fleet.overviewLoading && fleet.overview == null && <p className="machine-monitor__empty" role="status">Loading the fleet overview…</p>}
    {section != null && orderedOverview != null && <MachineSectionView
      section={section}
      sections={sections}
      membership={membership}
      sectionsText={sectionsText}
      storedErrors={storedErrors}
      machines={orderedOverview.machines}
      nowMs={orderedOverview.generatedAtMs}
      onSwitch={switchView}
      onIntent={fleet.prefetchMachine}
    />}
    {selected != null && <SelectedMachineOverview
      machine={selected}
      machines={orderedOverview?.machines ?? [selected]}
      sections={sections}
      sectionCounts={membership.counts}
      rangeHours={fleet.rangeHours}
      timelineView={fleet.timelineView}
      timelineLoading={fleet.timelineLoading}
      timelineError={fleet.timelineError}
      inventory={inventory.value}
      inventoryLoading={inventory.loading}
      inventoryError={inventory.error}
      connection={fleet.connection}
      onSwitch={switchView}
      onRange={fleet.chooseRange}
      onActivateEvent={activateEvent}
    />}
    {route.kind === "machine" && orderedOverview != null && <FleetPicker overview={orderedOverview} selectedMachineKey={fleet.selectedMachineKey} onSelect={pickAtlasMachine} onIntent={fleet.prefetchMachine} />}
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

function MachineMonitorIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="m6 13 3-3 3 2 3-5 3 2M12 17v4m-4 0h8" />
  </svg>;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "machine-monitor/fleet-health", component: MachineMonitorIcon });
  app.slots.navPanel({
    id: "machine-monitor",
    title: "Machine Monitor",
    icon: "machine-monitor/fleet-health",
    path: "machine-monitor",
    component: MachineMonitorPanel,
    experimental_sidebarAccessory: SidebarHealthAccessory,
  });
});
