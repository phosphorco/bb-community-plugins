import { createElement } from "react";
import {
  installTestPluginRuntime,
  renderSlot,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";

import type {
  AnalyticsCreateExecutionReferenceResponse,
  AnalyticsExecuteQueryResponse,
} from "../../../../rpc-contract.ts";
import {
  executeQueryResponseSchema,
  type CreateExecutionReferenceRequest,
  type ExecutionLocator,
} from "../../../../execution-contract.ts";
import {
  parseAnalyticsExecutionReferenceRequest,
  parseAnalyticsExecutionReferenceResponse,
  type AnalyticsExecutionClient,
} from "../../../../analytics-model.ts";
import type {
  ExecutionBackedDashboardProps,
} from "../../../../app.tsx";
import { echarts } from "../../../../echarts-registry.ts";
import type { StaleEventRevision } from "./stale-event.browser-data.ts";

const MAX_CHARTS = 16;
const MAX_RAW_EVENTS = 32;
const MAX_SET_OPTION_CALLS = 32;
const MAX_REQUESTS = 16;
const MAX_REFERENCES = 16;
const WAIT_MS = 5_000;

type EChartsInstance = ReturnType<typeof echarts.init>;

export type StaleEventRawEvent = Readonly<{
  phase: string;
  chartId: string;
  seriesId: string | null;
  dataIndex: number | null;
  nativeEventId: number | null;
  nativeEventMatched: boolean;
  nativeTargetMatched: boolean;
  nativeDispatched: boolean;
}>;

export type StaleEventChartObservation = Readonly<{
  id: string;
  ssr: boolean;
  disposed: boolean;
  registered: boolean;
}>;

export type StaleEventObservationSet = Readonly<{
  observedCount: number;
  overflow: boolean;
  charts: readonly StaleEventChartObservation[];
  rawEvents: readonly StaleEventRawEvent[];
  setOptionCalls: readonly StaleEventSetOptionCall[];
  cleanupErrors: readonly string[];
}>;

export type StaleEventSetOptionCall = Readonly<{
  sequence: number;
  phase: "ordinary" | "B" | "C";
  incoming: Readonly<{
    seriesId: string;
    kind: "bar" | "line";
    rows: readonly Readonly<{ capability_key: string; failures: number }>[];
  }> | null;
  chartId: string;
  argumentCount: number;
  lazyUpdate: boolean | null;
  notMerge: boolean | null;
  replaceMerge: readonly string[] | null;
  result: "returned" | "threw";
  threw: boolean;
}>;

export type StaleEventReferenceObservation = Readonly<{
  executionId: string;
  visualizationId: string;
  targetDatumKey?: string;
}>;

export type StaleEventMenuObservation = Readonly<{
  open: boolean;
  label: string | null;
  referenceRequests: readonly StaleEventReferenceObservation[];
  referenceOverflow: boolean;
  lastMentionId: string | null;
}>;

export type StaleEventBoundaryObservation = Readonly<{
  phase: "B" | "C";
  dispatched: boolean;
  oldMark: Readonly<{
    targetTag: string;
    bounds: Readonly<{ left: number; top: number; width: number; height: number }>;
    point: Readonly<{ x: number; y: number }>;
    connectedBefore: boolean;
  }>;
  nativeEvent: Readonly<{
    id: number;
    setOptionSequence: number;
    targetTag: string;
    bounds: Readonly<{ left: number; top: number; width: number; height: number }>;
    point: Readonly<{ x: number; y: number }>;
    connected: boolean;
    matchedEvent: boolean;
    eventTargetMatched: boolean;
  }> | null;
  menu: StaleEventMenuObservation;
  reference: StaleEventReferenceObservation | null;
  rawEvents: readonly StaleEventRawEvent[];
  setOptionCall: StaleEventSetOptionCall;
}>;

export type StaleEventUpdateObservation = Readonly<{
  phase: "B" | "C";
  boundary: StaleEventBoundaryObservation;
  after: StaleEventMenuObservation;
  referenceCountBeforeBoundary: number;
  requests: readonly StaleEventRequestObservation[];
  requestOverflow: boolean;
  visibleText: string;
}>;

export type StaleEventRequestObservation = Readonly<{
  locator: ExecutionLocator;
  settled: boolean;
  aborted: boolean;
  signalAborted: boolean;
}>;

export type StaleEventClient = AnalyticsExecutionClient & Readonly<{
  requests(): readonly StaleEventRequestObservation[];
  referenceRequests(): readonly StaleEventReferenceObservation[];
  observationState(): Readonly<{ requestOverflow: boolean; referenceOverflow: boolean }>;
  setRevision(revision: StaleEventRevision): void;
}>;

export type MountedStaleEventSession = Readonly<{
  root: HTMLElement;
  inspection: RenderedSlot["inspection"];
  client: StaleEventClient;
  ready(): Promise<StaleEventObservationSet>;
  pointerReference(): Promise<Readonly<{
    menu: StaleEventMenuObservation;
    observation: StaleEventObservationSet;
    requests: readonly StaleEventRequestObservation[];
    requestOverflow: boolean;
  }>>;
  tableReference(): Promise<StaleEventReferenceObservation>;
  focusFigureKeyboardAction(): Promise<void>;
  completeFigureKeyboardReference(): Promise<StaleEventReferenceObservation>;
  updateWithBoundary(
    phase: "B" | "C",
    revision: StaleEventRevision,
  ): Promise<StaleEventUpdateObservation>;
  unmount(): Promise<StaleEventObservationSet>;
}>;

type PendingRequest = {
  locator: ExecutionLocator;
  signal: AbortSignal | undefined;
  settled: boolean;
  aborted: boolean;
  resolve: (response: AnalyticsExecuteQueryResponse) => void;
  reject: (cause: unknown) => void;
  removeAbortListener: (() => void) | null;
};

type Boundary = {
  phase: "B" | "C";
  oldMark: SVGGraphicsElement;
  target: LiveTarget;
  dispatched: boolean;
  dispatchingNative: boolean;
  nativeEvent: MouseEvent | null;
  nativeEventId: number | null;
  nativeEventMatched: boolean;
  nativeTargetMatched: boolean;
  matchedCall: StaleEventSetOptionCall | null;
  expected: Readonly<{
    seriesId: string;
    kind: "bar" | "line";
    rows: readonly Readonly<{ capability_key: string; failures: number }>[];
  }>;
};

type Tracker = Readonly<{
  armBoundary(boundary: Boundary): void;
  disarmBoundary(): Boundary | null;
  locateFirstDatum(revision: StaleEventRevision): LiveTarget;
  snapshot(): StaleEventObservationSet;
  close(): StaleEventObservationSet;
  acceptChart(chart: EChartsInstance): void;
}>;

let activeTracker: Tracker | null = null;
let postInitInstalled = false;

type LiveTarget = Readonly<{
  element: SVGGraphicsElement;
  targetTag: string;
  bounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  point: Readonly<{ x: number; y: number }>;
  connected: boolean;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function optionBoolean(value: unknown, key: "lazyUpdate" | "notMerge"): boolean | null {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : null;
}

function boundedPush<T>(values: T[], value: T, maximum: number, label: string): void {
  if (values.length >= maximum) throw new Error(`Stale event fixture ${label} overflowed its bounded observer.`);
  values.push(value);
}

function createNativeContextMenu(target: LiveTarget): MouseEvent {
  if (!target.connected || !target.element.isConnected) throw new Error("Stale event fixture cannot dispatch against a detached chart mark.");
  const hit = document.elementFromPoint(target.point.x, target.point.y);
  if (hit !== target.element) throw new Error("Stale event fixture converted point no longer hits its captured SVG mark.");
  return new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: target.point.x,
    clientY: target.point.y,
    button: 2,
  });
}

function dispatchNativeContextMenu(target: LiveTarget): MouseEvent {
  const event = createNativeContextMenu(target);
  target.element.dispatchEvent(event);
  return event;
}

function locateLiveTarget(chart: EChartsInstance, revision: StaleEventRevision): LiveTarget {
  if (typeof chart.isDisposed === "function" && chart.isDisposed()) throw new Error("Stale event fixture cannot locate a mark on a disposed chart.");
  if (typeof chart.isSSR === "function" && chart.isSSR() === true) throw new Error("Stale event fixture requires the live non-SSR chart for SVG targeting.");
  const chartDom = chart.getDom();
  if (!(chartDom instanceof HTMLElement)) throw new Error("Stale event fixture live chart did not expose an HTMLElement DOM root.");
  // renderSlot owns its body-mounted container; an earlier fixture element can
  // place it below the viewport. Native hit testing requires the live chart in view.
  chartDom.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const chartBounds = chartDom.getBoundingClientRect();
  if (![chartBounds.left, chartBounds.top, chartBounds.width, chartBounds.height].every(Number.isFinite) || chartBounds.width <= 0 || chartBounds.height <= 0) {
    throw new Error("Stale event fixture live chart has no bounded viewport.");
  }
  const row = revision.rows[0];
  if (row == null || row.failures <= 0 || !Number.isFinite(row.failures)) throw new Error("Stale event fixture first authored datum is not a positive finite value.");
  const coordinateValue = revision.kind === "bar" ? row.failures / 2 : row.failures;
  const converted = chart.convertToPixel({ seriesId: "series-failures" }, [row.capability_key, coordinateValue]);
  if (!Array.isArray(converted) || converted.length < 2 || typeof converted[0] !== "number" || typeof converted[1] !== "number" || !Number.isFinite(converted[0]) || !Number.isFinite(converted[1])) {
    throw new Error("Stale event fixture convertToPixel did not return a finite two-dimensional point.");
  }
  const point = Object.freeze({ x: chartBounds.left + converted[0], y: chartBounds.top + converted[1] });
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < chartBounds.left || point.x > chartBounds.right || point.y < chartBounds.top || point.y > chartBounds.bottom) {
    throw new Error("Stale event fixture converted point fell outside the live chart viewport.");
  }
  const chartSvg = chartDom.querySelector("svg");
  if (!(chartSvg instanceof SVGSVGElement)) throw new Error("Stale event fixture live chart did not expose an SVG root.");
  const element = document.elementFromPoint(point.x, point.y);
  if (!(element instanceof SVGGraphicsElement) || element === chartSvg || !element.isConnected || !chartDom.contains(element) || element.closest("svg") !== chartSvg) {
    throw new Error("Stale event fixture converted point did not identify a connected SVG graphics element inside the live chart.");
  }
  const bounds = element.getBoundingClientRect();
  if (![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("Stale event fixture located SVG graphics element has no positive bounding box.");
  }
  return Object.freeze({
    element,
    targetTag: element.tagName.toLowerCase(),
    bounds: Object.freeze({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }),
    point,
    connected: element.isConnected,
  });
}

function registerTracker(): Tracker {
  if (activeTracker != null) throw new Error("Stale event fixture already has an active ECharts tracker.");
  if (!postInitInstalled) {
    echarts.registerPostInit((chart) => activeTracker?.acceptChart(chart));
    postInitInstalled = true;
  }
  const bindings: Array<{
    chart: EChartsInstance;
    originalSetOption: EChartsInstance["setOption"];
    originalSetOptionDescriptor: PropertyDescriptor | undefined;
    onContextMenu: (parameters: unknown) => void;
    onFinished: () => void;
  }> = [];
  const rawEvents: StaleEventRawEvent[] = [];
  const setOptionCalls: StaleEventSetOptionCall[] = [];
  let active = true;
  let observedCount = 0;
  let overflow = false;
  let boundary: Boundary | null = null;
  let setOptionSequence = 0;
  let nativeEventSequence = 0;
  const cleanupErrors: string[] = [];

  const captureIncomingOption = (value: unknown): Boundary["expected"] | null => {
    if (!isRecord(value)) return null;
    const series = Array.isArray(value.series) ? value.series : [];
    const firstSeries = series[0];
    const dataset = isRecord(value.dataset) ? value.dataset : null;
    const source = dataset != null && Array.isArray(dataset.source) ? dataset.source : [];
    const seriesId = isRecord(firstSeries) ? firstSeries.id : null;
    const kind = isRecord(firstSeries) ? firstSeries.type : null;
    if (
      !isRecord(firstSeries) ||
      typeof seriesId !== "string" ||
      (kind !== "bar" && kind !== "line") ||
      source.length > 24
    ) return null;
    const rows: Array<Readonly<{ capability_key: string; failures: number }>> = [];
    for (const row of source) {
      if (!isRecord(row) || typeof row.capability_key !== "string" || typeof row.failures !== "number" || !Number.isFinite(row.failures)) return null;
      rows.push(Object.freeze({ capability_key: row.capability_key, failures: row.failures }));
    }
    return Object.freeze({ seriesId, kind, rows });
  };

  const matchesExpectedOption = (incoming: Boundary["expected"] | null, expected: Boundary["expected"]): boolean => {
    if (incoming == null || incoming.seriesId !== expected.seriesId || incoming.kind !== expected.kind || incoming.rows.length !== expected.rows.length) return false;
    return incoming.rows.every((row, index) => {
      const expectedRow = expected.rows[index];
      return expectedRow != null && row.capability_key === expectedRow.capability_key && row.failures === expectedRow.failures;
    });
  };

  const rememberCleanupError = (error: unknown): void => {
    if (cleanupErrors.length < 8) cleanupErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    else overflow = true;
  };

  const pushRawEvent = (event: StaleEventRawEvent): void => {
    try {
      boundedPush(rawEvents, event, MAX_RAW_EVENTS, "raw event");
    } catch (error) {
      overflow = true;
      throw error;
    }
  };
  const pushSetOptionCall = (call: StaleEventSetOptionCall): void => {
    try {
      boundedPush(setOptionCalls, call, MAX_SET_OPTION_CALLS, "setOption");
    } catch (error) {
      overflow = true;
      throw error;
    }
  };

  const acceptChart = (chart: EChartsInstance): void => {
    if (!active || (typeof chart.isDisposed === "function" && chart.isDisposed())) return;
    observedCount += 1;
    if (bindings.length >= MAX_CHARTS) {
      overflow = true;
      return;
    }
    const onContextMenu = (parameters: unknown): void => {
      if (!active || (typeof chart.isDisposed === "function" && chart.isDisposed())) return;
      const record = isRecord(parameters) ? parameters : {};
      const seriesId = typeof record.seriesId === "string" ? record.seriesId : null;
      const dataIndex = typeof record.dataIndex === "number" ? record.dataIndex : null;
      const eventPacket = isRecord(record.event) ? record.event : null;
      const rawEvent = eventPacket?.event instanceof MouseEvent ? eventPacket.event : null;
      const trackedBoundary = boundary?.dispatchingNative === true ? boundary : null;
      const nativeEventMatched = trackedBoundary != null && rawEvent === trackedBoundary.nativeEvent;
      const nativeTargetMatched = nativeEventMatched && rawEvent?.target === trackedBoundary?.target.element;
      if (trackedBoundary != null) {
        trackedBoundary.nativeEventMatched = nativeEventMatched;
        trackedBoundary.nativeTargetMatched = nativeTargetMatched;
      }
      pushRawEvent(Object.freeze({
        phase: boundary?.phase ?? "ordinary",
        chartId: chart.getId(),
        seriesId,
        dataIndex,
        nativeEventId: boundary?.dispatchingNative ? boundary.nativeEventId : null,
        nativeEventMatched,
        nativeTargetMatched,
        nativeDispatched: boundary?.dispatchingNative === true,
      }));
    };
    const onFinished = (): void => {
      if (!active || (typeof chart.isDisposed === "function" && chart.isDisposed())) return;
      pushRawEvent(Object.freeze({
        phase: "finished",
        chartId: chart.getId(),
        seriesId: null,
        dataIndex: null,
        nativeEventId: null,
        nativeEventMatched: false,
        nativeTargetMatched: false,
        nativeDispatched: false,
      }));
    };
    const originalSetOptionDescriptor = Object.getOwnPropertyDescriptor(chart, "setOption");
    const originalSetOption = chart.setOption;
    chart.on("contextmenu", onContextMenu);
    chart.on("finished", onFinished);
    chart.setOption = function wrappedSetOption(
      this: EChartsInstance,
      ...args: Parameters<typeof originalSetOption>
    ): ReturnType<typeof originalSetOption> {
      if (!active || (typeof chart.isDisposed === "function" && chart.isDisposed())) return Reflect.apply(originalSetOption, this, args);
      const options = args[1];
      const sequence = setOptionSequence + 1;
      setOptionSequence = sequence;
      const incoming = captureIncomingOption(args[0]);
      const currentBoundary = boundary;
      const phase: StaleEventSetOptionCall["phase"] = currentBoundary?.phase ?? "ordinary";
      let dispatchedEventId: number | null = null;
      const call = {
        sequence,
        phase,
        incoming,
        chartId: chart.getId(),
        argumentCount: args.length,
        lazyUpdate: optionBoolean(options, "lazyUpdate"),
        notMerge: optionBoolean(options, "notMerge"),
        replaceMerge: isRecord(options) && Array.isArray(options.replaceMerge) && options.replaceMerge.every((item) => typeof item === "string")
          ? options.replaceMerge
          : null,
        result: "returned" as "returned" | "threw",
        threw: false,
      };
      if (currentBoundary != null && !currentBoundary.dispatched && currentBoundary.oldMark.isConnected && matchesExpectedOption(incoming, currentBoundary.expected)) {
        currentBoundary.dispatched = true;
        dispatchedEventId = nativeEventSequence + 1;
        nativeEventSequence = dispatchedEventId;
        currentBoundary.nativeEventId = dispatchedEventId;
        const nativeEvent = createNativeContextMenu(currentBoundary.target);
        currentBoundary.nativeEvent = nativeEvent;
        currentBoundary.dispatchingNative = true;
        try {
          currentBoundary.oldMark.dispatchEvent(nativeEvent);
        } finally {
          currentBoundary.dispatchingNative = false;
        }
      }
      try {
        const result = Reflect.apply(originalSetOption, this, args);
        call.result = "returned";
        const frozenCall = Object.freeze(call);
        pushSetOptionCall(frozenCall);
        if (dispatchedEventId != null && currentBoundary?.nativeEventId === dispatchedEventId && currentBoundary.matchedCall == null) currentBoundary.matchedCall = frozenCall;
        return result;
      } catch (error) {
        call.threw = true;
        call.result = "threw";
        const frozenCall = Object.freeze(call);
        pushSetOptionCall(frozenCall);
        if (dispatchedEventId != null && currentBoundary?.nativeEventId === dispatchedEventId && currentBoundary.matchedCall == null) currentBoundary.matchedCall = frozenCall;
        throw error;
      }
    } as typeof originalSetOption;
    bindings.push({ chart, originalSetOption, originalSetOptionDescriptor, onContextMenu, onFinished });
  };

  const restore = (): void => {
    for (const binding of bindings) {
      try {
        binding.chart.off("contextmenu", binding.onContextMenu);
      } catch (error) {
        rememberCleanupError(error);
      }
      try {
        binding.chart.off("finished", binding.onFinished);
      } catch (error) {
        rememberCleanupError(error);
      }
      try {
        if (binding.originalSetOptionDescriptor == null) Reflect.deleteProperty(binding.chart, "setOption");
        else Object.defineProperty(binding.chart, "setOption", binding.originalSetOptionDescriptor);
      } catch (error) {
        rememberCleanupError(error);
      }
    }
  };

  const snapshot = (): StaleEventObservationSet => Object.freeze({
    observedCount,
    overflow,
    charts: bindings.map(({ chart }) => Object.freeze({
      id: chart.getId(),
      ssr: typeof chart.isSSR === "function" ? chart.isSSR() : false,
      disposed: typeof chart.isDisposed === "function" ? chart.isDisposed() : false,
      registered: echarts.getInstanceById(chart.getId()) != null,
    })),
    rawEvents: [...rawEvents],
    setOptionCalls: [...setOptionCalls],
    cleanupErrors: [...cleanupErrors],
  });
  const tracker: Tracker = {
    armBoundary(next) {
      if (boundary != null) throw new Error("Stale event fixture already has an armed update boundary.");
      boundary = next;
    },
    disarmBoundary() {
      const current = boundary;
      boundary = null;
      return current;
    },
    locateFirstDatum(revision) {
      const liveBindings = bindings.filter(({ chart }) => (
        !(typeof chart.isDisposed === "function" && chart.isDisposed())
        && !(typeof chart.isSSR === "function" && chart.isSSR() === true)
        && chart.getDom() instanceof HTMLElement
      ));
      if (liveBindings.length !== 1) throw new Error(`Stale event fixture expected exactly one live non-SSR chart, found ${liveBindings.length}.`);
      const binding = liveBindings[0];
      if (binding == null) throw new Error("Stale event fixture lost its live chart binding.");
      return locateLiveTarget(binding.chart, revision);
    },
    snapshot,
    close() {
      active = false;
      boundary = null;
      try {
        restore();
        return Object.freeze({ ...snapshot(), cleanupErrors: [...cleanupErrors] });
      } finally {
        if (activeTracker === tracker) activeTracker = null;
        bindings.splice(0, bindings.length);
        rawEvents.splice(0, rawEvents.length);
        setOptionCalls.splice(0, setOptionCalls.length);
      }
    },
    acceptChart,
  };
  activeTracker = tracker;
  return tracker;
}

function createClient(initial: StaleEventRevision, referenceResponse: AnalyticsCreateExecutionReferenceResponse): StaleEventClient {
  let current = initial;
  const requests: PendingRequest[] = [];
  const references: StaleEventReferenceObservation[] = [];
  let requestOverflow = false;
  let referenceOverflow = false;
  const publicClient: AnalyticsExecutionClient = {
    executeQuery(locator, options) {
      return new Promise<AnalyticsExecuteQueryResponse>((resolve, reject) => {
        if (requests.length >= MAX_REQUESTS) {
          requestOverflow = true;
          reject(new Error("Stale event fixture query observation overflowed its bounded observer."));
          return;
        }
        const pending: PendingRequest = {
          locator,
          signal: options?.signal,
          settled: false,
          aborted: false,
          resolve,
          reject,
          removeAbortListener: null,
        };
        const abort = () => {
          pending.aborted = true;
          if (pending.settled) return;
          pending.settled = true;
          pending.reject(new DOMException("stale event fixture request aborted", "AbortError"));
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => options?.signal?.removeEventListener("abort", abort);
        requests.push(pending);
        queueMicrotask(() => {
          if (pending.settled) return;
          pending.settled = true;
          pending.removeAbortListener?.();
          pending.removeAbortListener = null;
          const response = current.responses.get(locator.queryId);
          if (response == null) {
            pending.reject(new Error(`No authored stale-event response for ${locator.queryId}.`));
            return;
          }
          pending.resolve(executeQueryResponseSchema.parse(response));
        });
      });
    },
    createExecutionReference(request) {
      const parsed = parseAnalyticsExecutionReferenceRequest(request);
      if (references.length >= MAX_REFERENCES) {
        referenceOverflow = true;
        return Promise.reject(new Error("Stale event fixture reference observation overflowed its bounded observer."));
      }
      references.push(Object.freeze(parsed));
      return Promise.resolve(parseAnalyticsExecutionReferenceResponse(referenceResponse));
    },
  };
  return {
    ...publicClient,
    requests: () => requests.map((request) => Object.freeze({
      locator: request.locator,
      settled: request.settled,
      aborted: request.aborted,
      signalAborted: request.signal?.aborted === true,
    })),
    referenceRequests: () => [...references],
    observationState: () => Object.freeze({ requestOverflow, referenceOverflow }),
    setRevision(revision) {
      current = revision;
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + WAIT_MS;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Stale event fixture timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function settleReact(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

function clickMenuItem(root: HTMLElement, label: string): void {
  const item = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (item == null) throw new Error(`Stale event fixture could not find menu item ${label}.`);
  item.click();
}

async function closeMenu(root: HTMLElement): Promise<void> {
  const menu = root.querySelector<HTMLElement>('[role="menu"]');
  if (menu == null) return;
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settleReact();
  if (root.querySelector('[role="menu"]') != null) {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await settleReact();
  }
  if (root.querySelector('[role="menu"]') != null) throw new Error("Stale event fixture could not close the menu before the next operation.");
}

function menuObservation(root: HTMLElement, client: StaleEventClient, inspection: RenderedSlot["inspection"]): StaleEventMenuObservation {
  const menu = root.querySelector<HTMLElement>('[role="menu"]');
  return Object.freeze({
    open: menu != null,
    label: menu?.querySelector("strong")?.textContent?.trim() ?? null,
    referenceRequests: client.referenceRequests(),
    referenceOverflow: client.observationState().referenceOverflow,
    lastMentionId: inspection.composer.mentions.at(-1)?.id ?? null,
  });
}

function expectedBoundary(revision: StaleEventRevision): Boundary["expected"] {
  return Object.freeze({
    seriesId: "series-failures",
    kind: revision.kind,
    rows: revision.rows,
  });
}

function assertRequestShape(request: StaleEventRequestObservation, revision: StaleEventRevision): void {
  const expected = revision.locators.failures;
  if (expected == null || JSON.stringify(request.locator) !== JSON.stringify(expected)) {
    throw new Error("Stale event fixture dispatched a locator different from the authored revision.");
  }
}

function disclosure(root: HTMLElement): HTMLDetailsElement {
  const summary = [...root.querySelectorAll("summary")]
    .find((candidate) => candidate.textContent?.startsWith("Exact plotted data") === true);
  if (!(summary instanceof HTMLElement) || !(summary.parentElement instanceof HTMLDetailsElement)) {
    throw new Error("Stale event fixture could not find the exact plotted data disclosure.");
  }
  const details = summary.parentElement;
  if (!details.open) summary.click();
  return details;
}

async function openNativeReference(
  root: HTMLElement,
  client: StaleEventClient,
  inspection: RenderedSlot["inspection"],
  target: LiveTarget,
): Promise<StaleEventMenuObservation> {
  const before = client.referenceRequests().length;
  dispatchNativeContextMenu(target);
  await waitFor(() => root.querySelector('[role="menu"]') != null, "native context menu");
  clickMenuItem(root, "Add reference to chat");
  await waitFor(() => client.referenceRequests().length === before + 1, "native reference request");
  await waitFor(() => root.querySelector('[role="menu"]') == null, "native menu close");
  return menuObservation(root, client, inspection);
}

export async function mountStaleEventFixture(
  initial: StaleEventRevision,
  referenceResponse: AnalyticsCreateExecutionReferenceResponse,
): Promise<MountedStaleEventSession> {
  const tracker = registerTracker();
  let slot: RenderedSlot | null = null;
  let currentRevision = initial;
  let unmounted = false;
  let finalObservation: StaleEventObservationSet | null = null;
  const client = createClient(initial, referenceResponse);
  try {
    installTestPluginRuntime();
    const module = await import("../../../../app.tsx");
    const Component = module.ExecutionBackedDashboard;
    const TestExecutionSlot = (props: ExecutionBackedDashboardProps) => createElement(Component, props);
    const propsFor = (revision: StaleEventRevision): ExecutionBackedDashboardProps => ({
      bundle: revision.bundle,
      client,
      locators: revision.locators,
      rangeDays: 1,
    });
    slot = renderSlot({ component: TestExecutionSlot }, propsFor(initial));
    const mountedSlot = slot;
    const root = mountedSlot.container;
    const inspection = mountedSlot.inspection;
    return {
      root,
      inspection,
      client,
      async ready() {
        if (unmounted) throw new Error("Stale event fixture is unmounted.");
        await waitFor(() => client.requests().length === 1, "initial query request");
        await waitFor(() => client.requests()[0]?.settled === true, "initial query settlement");
        assertRequestShape(client.requests()[0] as StaleEventRequestObservation, currentRevision);
        await waitFor(() => root.textContent?.includes("Exact plotted data") === true, "initial dashboard");
        disclosure(root);
        await waitFor(() => root.textContent?.includes(currentRevision.visibleDatumText) === true, "initial authored datum");
        await waitFor(() => root.querySelector<HTMLElement>(".analytics-echart")?.getBoundingClientRect().width! > 0, "nonzero chart host");
        await waitFor(() => tracker.snapshot().charts.some((chart) => !chart.ssr && !chart.disposed && chart.registered), "live ECharts instance");
        let locatorFailure = "no target attempt";
        try {
          await waitFor(() => {
            try {
              tracker.locateFirstDatum(currentRevision);
              return true;
            } catch (error) {
              locatorFailure = String(error).slice(0, 500);
              return false;
            }
          }, "initial public SVG target");
        } catch (error) {
          throw new Error(`${String(error).slice(0, 500)} Last locator failure: ${locatorFailure}`);
        }
        return tracker.snapshot();
      },
      async pointerReference() {
        if (unmounted) throw new Error("Stale event fixture is unmounted.");
        const menu = await openNativeReference(root, client, inspection, tracker.locateFirstDatum(currentRevision));
        const state = client.observationState();
        return Object.freeze({
          menu,
          observation: tracker.snapshot(),
          requests: client.requests(),
          requestOverflow: state.requestOverflow,
        });
      },
      async tableReference() {
        if (unmounted) throw new Error("Stale event fixture is unmounted.");
        const details = disclosure(root);
        await waitFor(() => details.querySelector("button") != null, "table row action");
        const action = [...details.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Actions");
        if (action == null) throw new Error("Stale event fixture could not find the exact-table Actions control.");
        const before = client.referenceRequests().length;
        action.click();
        await waitFor(() => root.querySelector('[role="menu"]') != null, "table context menu");
        clickMenuItem(root, "Add reference to chat");
        await waitFor(() => client.referenceRequests().length === before + 1, "table reference request");
        const request = client.referenceRequests().at(-1);
        if (request == null) throw new Error("Stale event fixture lost the table reference request.");
        await closeMenu(root);
        return request;
      },
      async focusFigureKeyboardAction() {
        if (unmounted) throw new Error("Stale event fixture is unmounted.");
        await closeMenu(root);
        const action = [...root.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.getAttribute("aria-label")?.startsWith("Actions for") === true);
        if (action == null) throw new Error("Stale event fixture could not find the figure keyboard Actions control.");
        action.focus();
        await waitFor(() => document.activeElement === action, "figure keyboard Actions focus");
      },
      async completeFigureKeyboardReference() {
        if (unmounted) throw new Error("Stale event fixture is unmounted.");
        const before = client.referenceRequests().length;
        await waitFor(() => root.querySelector('[role="menu"]') != null, "figure keyboard context menu");
        clickMenuItem(root, "Add reference to chat");
        await waitFor(() => client.referenceRequests().length === before + 1, "figure keyboard reference request");
        const request = client.referenceRequests().at(-1);
        if (request == null) throw new Error("Stale event fixture lost the figure reference request.");
        await closeMenu(root);
        return request;
      },
      async updateWithBoundary(phase, revision) {
        if (unmounted) throw new Error("Stale event fixture is unmounted.");
        await closeMenu(root);
        const referenceCountBeforeBoundary = client.referenceRequests().length;
        const oldTarget = tracker.locateFirstDatum(currentRevision);
        const oldMark = oldTarget.element;
        const oldMarkObservation = Object.freeze({
          targetTag: oldTarget.targetTag,
          bounds: oldTarget.bounds,
          point: oldTarget.point,
          connectedBefore: oldTarget.connected && oldMark.isConnected,
        });
        const beforeRequestCount = client.requests().length;
        tracker.armBoundary({ phase, oldMark, target: oldTarget, dispatched: false, dispatchingNative: false, nativeEvent: null, nativeEventId: null, nativeEventMatched: false, nativeTargetMatched: false, matchedCall: null, expected: expectedBoundary(revision) });
        currentRevision = revision;
        client.setRevision(revision);
        let armed: Boundary | null = null;
        try {
          mountedSlot.lifecycle.rerender(createElement(TestExecutionSlot, propsFor(revision)));
          await waitFor(() => client.requests().length === beforeRequestCount + 1, `${phase} query request`);
          await waitFor(() => client.requests().at(-1)?.settled === true, `${phase} query settlement`);
          const request = client.requests().at(-1);
          if (request == null) throw new Error(`${phase} query request disappeared.`);
          assertRequestShape(request, revision);
          await settleReact();
        } finally {
          armed = tracker.disarmBoundary();
          if (armed == null || !armed.dispatched || armed.matchedCall == null || armed.nativeEventId == null) throw new Error(`${phase} update boundary was not observed before setOption.`);
        }
        if (armed == null || armed.matchedCall == null || armed.nativeEventId == null) throw new Error(`${phase} update boundary lost its matched public call.`);
        const boundaryEvents = tracker.snapshot().rawEvents.filter((event) => event.nativeEventId === armed?.nativeEventId);
        const boundaryMenu = menuObservation(root, client, inspection);
        let boundaryReference: StaleEventReferenceObservation | null = null;
        if (boundaryMenu.open) {
          clickMenuItem(root, "Add reference to chat");
          await waitFor(() => client.referenceRequests().length === referenceCountBeforeBoundary + 1, `${phase} boundary reference request`);
          boundaryReference = client.referenceRequests().at(-1) ?? null;
          if (boundaryReference == null) throw new Error(`${phase} boundary reference request disappeared.`);
          await closeMenu(root);
        }
        const boundary: StaleEventBoundaryObservation = Object.freeze({
          phase,
          dispatched: true,
          oldMark: oldMarkObservation,
          nativeEvent: Object.freeze({
            id: armed.nativeEventId,
            setOptionSequence: armed.matchedCall.sequence,
            targetTag: armed.target.targetTag,
            bounds: armed.target.bounds,
            point: armed.target.point,
            // createNativeContextMenu revalidated the exact connected target at
            // dispatch; a successful structural update may since have removed it.
            connected: armed.target.connected,
            matchedEvent: armed.nativeEventMatched,
            eventTargetMatched: armed.nativeTargetMatched,
          }),
          menu: boundaryMenu,
          reference: boundaryReference,
          rawEvents: boundaryEvents,
          setOptionCall: armed.matchedCall,
        });
        await closeMenu(root);
        await waitFor(() => root.textContent?.includes(revision.visibleDatumText) === true, `${phase} authored datum`);
        let postTarget: LiveTarget | null = null;
        await waitFor(() => {
          try {
            postTarget = tracker.locateFirstDatum(currentRevision);
            return true;
          } catch {
            return false;
          }
        }, `${phase} public SVG target`);
        await settleReact();
        if (postTarget == null) throw new Error(`${phase} lost its public SVG target after readiness.`);
        const post = await openNativeReference(root, client, inspection, postTarget);
        return Object.freeze({
          phase,
          boundary,
          after: post,
          referenceCountBeforeBoundary,
          requests: client.requests(),
          requestOverflow: client.observationState().requestOverflow,
          visibleText: root.textContent ?? "",
        });
      },
      async unmount() {
        if (finalObservation != null) return finalObservation;
        unmounted = true;
        try {
          mountedSlot.lifecycle.unmount();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        } finally {
          tracker.disarmBoundary();
          finalObservation = tracker.close();
        }
        return finalObservation;
      },
    };
  } catch (error) {
    if (slot != null) slot.lifecycle.unmount();
    tracker.close();
    throw error;
  }
}
