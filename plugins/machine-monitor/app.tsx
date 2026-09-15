import { memo, useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
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
  type MachineTimelineResult,
} from "./fleet-contract.ts";
import type { MachineMonitorHealth, rpcContract } from "./rpc-contract.ts";
import { MachineTimelineChart } from "./timeline-chart.tsx";
import type { TimelineEventActivation } from "./timeline-compiler.ts";
import "./app.css";

const RANGES = [1, 6, 24, 24 * 7, 24 * 30] as const;
type RangeHours = typeof RANGES[number];
type FleetMachine = FleetOverviewResult["machines"][number];
type TimelineView = Readonly<{ timeline: MachineTimelineResult; stale: boolean }> | null;

const PREFETCH_LIMIT = 6;

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

type FleetAtlasPresentation = Readonly<{
  pressures: readonly FleetAtlasPressure[];
  state: "current" | "stale" | "disconnected" | "failure" | "warning" | "pressure";
  stateLabel: string;
  glyph: string;
  collectorState: "clear" | "warning" | "failure";
  pressureLevel: FleetAtlasPressure["level"];
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

function fleetAtlasPresentation(machine: FleetMachine): FleetAtlasPresentation {
  const memoryPressure = latestMetricValue(machine, "memory.pressure.full.percent")
    ?? latestMetricValue(machine, "memory.pressure.some.percent")
    ?? percentageOf(latestMetricValue(machine, "memory.used.bytes"), latestMetricValue(machine, "memory.total.bytes"));
  const pressures = [
    pressure(latestMetricValue(machine, "cpu.utilization.percent"), "cpu", "CPU utilization", "CPU"),
    pressure(memoryPressure, "memory", "Memory pressure", "MEM"),
    pressure(percentageOf(latestMetricValue(machine, "disk.root.used.bytes"), latestMetricValue(machine, "disk.root.total.bytes")), "disk", "Root disk pressure", "DSK"),
  ] as const;
  const pressureLevel = pressures.reduce<FleetAtlasPressure["level"]>((current, value) => {
    const weight = { unavailable: 0, nominal: 1, elevated: 2, critical: 3 } as const;
    return weight[value.level] > weight[current] ? value.level : current;
  }, "unavailable");
  const collectorState = machine.lastError != null
    || machine.warnings.some((warning) => warning.kind === "collector-error")
    ? "failure"
    : machine.warnings.length > 0 ? "warning" : "clear";
  if (machine.connection === "disconnected") {
    return { pressures, state: "disconnected", stateLabel: "Disconnected", glyph: "×", collectorState, pressureLevel, anomalous: true };
  }
  if (machine.freshness === "stale") {
    return { pressures, state: "stale", stateLabel: "Stale data", glyph: "~", collectorState, pressureLevel, anomalous: true };
  }
  if (collectorState === "failure") {
    return { pressures, state: "failure", stateLabel: "Collector failure", glyph: "!", collectorState, pressureLevel, anomalous: true };
  }
  if (collectorState === "warning") {
    return { pressures, state: "warning", stateLabel: "Collector warning", glyph: "!", collectorState, pressureLevel, anomalous: true };
  }
  if (pressureLevel === "critical" || pressureLevel === "elevated") {
    return { pressures, state: "pressure", stateLabel: `${pressureLevel === "critical" ? "Critical" : "Elevated"} resource pressure`, glyph: "↑", collectorState, pressureLevel, anomalous: true };
  }
  return { pressures, state: "current", stateLabel: "Current", glyph: "•", collectorState, pressureLevel, anomalous: false };
}

function displayMetric(value: number | null, unit: ReturnType<typeof metricCatalogEntry>["unit"]): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "bytes") return value >= 1_073_741_824 ? `${(value / 1_073_741_824).toFixed(1)} GiB` : `${(value / 1_048_576).toFixed(1)} MiB`;
  if (unit === "pages-per-second") return `${value.toFixed(value >= 10 ? 0 : 2)}/s`;
  return value.toFixed(value >= 10 ? 0 : 2);
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
      void refreshOverview(undefined, true);
    }
    previousConnection.current = connection;
  }, [client, commitTimelineView, connection, refreshOverview, selectedMachine]);

  const onFleetInvalidation = useCallback((payload: unknown) => {
    if (!isFleetSignal(payload)) return;
    client.invalidateMachine(payload.machine);
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
  }, [client, commitTimelineView]);
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
      aria-label={`${machine.label}. ${machine.connection}. ${machine.freshness}. ${atlas.stateLabel}.`}
      aria-describedby={descriptionId}
      data-connection={machine.connection}
      data-freshness={machine.freshness}
      data-collector={atlas.collectorState}
      data-pressure={atlas.pressureLevel}
      data-anomalous={atlas.anomalous || undefined}
      data-selected={selected || undefined}
      style={atlasBackgroundStyle}
      onClick={() => onSelect(machine)}
      onFocus={() => onIntent(machine)}
      onPointerEnter={() => onIntent(machine)}
    >
      <span className="machine-monitor__atlas-state" aria-hidden="true"><b>{atlas.glyph}</b><span>{atlas.stateLabel}</span></span>
      <strong><span>{machine.label}</span>{selected && <small>Inspecting</small>}</strong>
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
  const attentionCount = overview.machines.filter((machine) => fleetAtlasPresentation(machine).anomalous).length;
  return <section className="machine-monitor__fleet-picker" data-inspecting={selectedMachineKey != null || undefined} aria-labelledby="machine-monitor-fleet-title">
    <header>
      <div>
        <h2 id="machine-monitor-fleet-title">Fleet atlas</h2>
        <p>{`${overview.machines.length} source${overview.machines.length === 1 ? "" : "s"} · source order is preserved for keyboard navigation`}</p>
      </div>
      <span className="machine-monitor__fleet-generation">{attentionCount === 0 ? "All current" : `${attentionCount} need attention`}</span>
    </header>
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

const FleetMetric = memo(function FleetMetric({ observation }: { observation: FleetMachine["latestMetrics"][number] }) {
  const catalog = metricCatalogEntry(observation.metricId);
  const unavailable = observation.availability.state !== "available";
  return <article data-unavailable={unavailable || undefined}>
    <span>{catalog.label}</span>
    <strong>{displayMetric(observation.value, catalog.unit)}</strong>
    <small>{unavailable ? observation.availability.reason ?? observation.availability.state : catalog.unit}</small>
  </article>;
});

const SelectedMachineOverview = memo(function SelectedMachineOverview({ machine, rangeHours, timelineView, timelineLoading, timelineError, connection, onRange, onActivateEvent }: {
  machine: FleetMachine;
  rangeHours: RangeHours;
  timelineView: TimelineView;
  timelineLoading: boolean;
  timelineError: string | null;
  connection: string;
  onRange: (hours: RangeHours) => void;
  onActivateEvent: (activation: TimelineEventActivation) => void;
}) {
  const visibleMachineKey = timelineView == null ? null : machineIdentityKey(timelineView.timeline.machine);
  const selectedMachineKey = machineIdentityKey(machine.machine);
  const retainedForOtherMachine = visibleMachineKey != null && visibleMachineKey !== selectedMachineKey;
  const matchingCurrentGeneration = timelineView != null
    && !retainedForOtherMachine
    && fleetGenerationMatches(timelineView.timeline.generation, machine.generation);
  const historyStale = timelineView?.stale === true || connection !== "connected" || machine.freshness !== "fresh";
  const eventActivationAllowed = matchingCurrentGeneration && !historyStale;
  return <section className="machine-monitor__selected-machine" data-stale={historyStale || undefined} aria-labelledby="machine-monitor-selected-title">
    <header>
      <div>
        <h1 id="machine-monitor-selected-title">{machine.label}</h1>
        <p>{`${connectionText(machine)} · ${generationText(machine)}`}</p>
      </div>
      <label>
        <span>History</span>
        <select value={rangeHours} onChange={(event) => onRange(Number(event.target.value) as RangeHours)}>
          {RANGES.map((hours) => <option key={hours} value={hours}>{rangeLabel(hours)}</option>)}
        </select>
      </label>
    </header>
    <div className="machine-monitor__machine-facts">
      <p><strong>Latest collection:</strong> {latestTime(machine.latestCollectedAtMs)}</p>
      <p><strong>Connection:</strong> {machine.connection}</p>
      <p><strong>Freshness:</strong> {machine.freshness}</p>
      <p><strong>Capabilities:</strong> {machine.capabilities.length === 0 ? "None reported" : machine.capabilities.join(", ")}</p>
    </div>
    {machine.lastError != null && <p className="machine-monitor__error" role="alert">Collector error: {machine.lastError}</p>}
    {machine.warnings.length > 0 && <ul className="machine-monitor__warnings" aria-label="Machine warnings">
      {machine.warnings.map((warning, index) => <li key={`${warning.kind}:${warning.metricId ?? "machine"}:${index}`}><strong>{warning.kind}</strong><span>{warning.message}</span></li>)}
    </ul>}
    <section className="machine-monitor__metrics" aria-label={`Latest summary metrics for ${machine.label}`}>
      {machine.latestMetrics.length === 0 ? <p className="machine-monitor__empty">No latest metrics have been collected.</p> : machine.latestMetrics.map((observation) => <FleetMetric key={observation.metricId} observation={observation} />)}
    </section>
    <section className="machine-monitor__timeline" aria-labelledby="machine-monitor-timeline-title">
      <header><h2 id="machine-monitor-timeline-title">Machine timeline</h2><span>{rangeLabel(rangeHours)}</span></header>
      {machine.connection === "disconnected" && <p className="machine-monitor__timeline-status" role="status">Machine is disconnected. Retained history remains available when the local server can read it.</p>}
      {machine.freshness === "stale" && <p className="machine-monitor__timeline-status" role="status">Machine data is stale; the latest retained history is labeled below.</p>}
      {timelineLoading && <p className="machine-monitor__timeline-status" role="status">Loading timeline for {machine.label}…</p>}
      {retainedForOtherMachine && <p className="machine-monitor__timeline-status" role="status">Showing retained timeline for {timelineView?.timeline.machine.machineId}; {machine.label} is loading.</p>}
      {timelineError != null && <p className="machine-monitor__error" role="alert">Timeline refresh error: {timelineError}</p>}
      {timelineView == null ? <p className="machine-monitor__empty">No retained timeline is available yet.</p> : <MachineTimelineChart
        className="machine-monitor__timeline-chart"
        timeline={timelineView.timeline}
        stale={historyStale}
        refreshing={timelineLoading}
        activationDisabled={!eventActivationAllowed}
        onActivateEvent={onActivateEvent}
      />}
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

  return <main className="machine-monitor">
    <header className="machine-monitor__page-header">
      <div><h1>Machine Monitor</h1><p>Fleet atlas and machine history.</p></div>
      <span role="status">Realtime {fleet.connection}</span>
    </header>
    {fleet.overviewError != null && <p className="machine-monitor__error" role="alert">{fleet.overviewError}</p>}
    {fleet.overviewLoading && fleet.overview == null && <p className="machine-monitor__empty" role="status">Loading the fleet overview…</p>}
    {fleet.overview != null && <FleetPicker overview={fleet.overview} selectedMachineKey={fleet.selectedMachineKey} onSelect={fleet.chooseMachine} onIntent={fleet.prefetchMachine} />}
    {selected != null && <SelectedMachineOverview
      machine={selected}
      rangeHours={fleet.rangeHours}
      timelineView={fleet.timelineView}
      timelineLoading={fleet.timelineLoading}
      timelineError={fleet.timelineError}
      connection={fleet.connection}
      onRange={fleet.chooseRange}
      onActivateEvent={activateEvent}
    />}
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
