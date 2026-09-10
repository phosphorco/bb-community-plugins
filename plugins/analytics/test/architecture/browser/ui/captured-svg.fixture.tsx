import { createElement } from "react";
import {
  installTestPluginRuntime,
  renderSlot,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";

import type { AnalyticsBundleResponse, AnalyticsCreateExecutionReferenceResponse, AnalyticsExecuteQueryResponse } from "../../../../rpc-contract.ts";
import {
  executeQueryResponseSchema,
  type CreateExecutionReferenceRequest,
  type ExecutionLocator,
} from "../../../../execution-contract.ts";
import {
  createCapturedFigureExport,
  type CapturedFigureExport,
  type CapturedFigureExportInput,
  type CapturedFigureSvgOptions,
  type CapturedSvgExport,
} from "../../../../analytics-export.ts";
import type {
  ExecutionBackedDashboardProps,
  ExecutionLocatorSource,
} from "../../../../app.tsx";
import type { AnalyticsExecutionClient, AnalyticsChartTheme } from "../../../../analytics-model.ts";
import { echarts } from "../../../../echarts-registry.ts";

const MAX_OBSERVED_CHARTS = 64;

export type CapturedSvgBrowserThemeName = "captured-svg-old" | "captured-svg-new";

export const CAPTURED_SVG_BROWSER_THEMES = Object.freeze({
  old: Object.freeze({
    name: "captured-svg-old" as const,
    tokens: Object.freeze({
      "--foreground": "rgb(28, 31, 38)",
      "--muted-foreground": "rgb(92, 100, 114)",
      "--border": "rgb(200, 205, 214)",
      "--chart-1": "rgb(35, 99, 235)",
      "--popover": "rgb(255, 255, 255)",
      "--background": "rgb(255, 255, 255)",
      "--card": "rgb(255, 255, 255)",
      "--primary": "rgb(35, 99, 235)",
    }),
  }),
  new: Object.freeze({
    name: "captured-svg-new" as const,
    tokens: Object.freeze({
      "--foreground": "rgb(242, 245, 249)",
      "--muted-foreground": "rgb(170, 181, 196)",
      "--border": "rgb(74, 87, 105)",
      "--chart-1": "rgb(96, 165, 250)",
      "--popover": "rgb(30, 39, 54)",
      "--background": "rgb(15, 23, 42)",
      "--card": "rgb(30, 39, 54)",
      "--primary": "rgb(96, 165, 250)",
    }),
  }),
});

type CapturedSvgBrowserThemeDefinition =
  (typeof CAPTURED_SVG_BROWSER_THEMES)[keyof typeof CAPTURED_SVG_BROWSER_THEMES];

export type CapturedSvgChartObservation = Readonly<{
  id: string;
  ssr: boolean;
  disposed: boolean;
  registered: boolean;
}>;

export type CapturedSvgChartObservationSet = Readonly<{
  observedCount: number;
  overflow: boolean;
  charts: readonly CapturedSvgChartObservation[];
}>;

export type CapturedSvgObservedOutput = Readonly<{
  text: string;
  byteLength: number;
  lineageText: string;
  lineageByteLength: number;
}>;

export type CapturedSvgAttempt =
  | Readonly<{ kind: "success"; output: CapturedSvgObservedOutput }>
  | Readonly<{ kind: "error"; name: string; code?: string; message: string }>;

function emptyObservations(): CapturedSvgChartObservationSet {
  return Object.freeze({ observedCount: 0, overflow: false, charts: [] });
}

export type CapturedSvgBrowserRevision = Readonly<{
  bundle: AnalyticsBundleResponse;
  locators: ExecutionLocatorSource;
  responses: ReadonlyMap<string, AnalyticsExecuteQueryResponse>;
  visibleDatumText: string;
}>;

export type CapturedSvgBrowserRequest = Readonly<{
  locator: ExecutionLocator;
  settled: boolean;
  aborted: boolean;
  signalAborted: boolean;
}>;

export type CapturedSvgBrowserClient = AnalyticsExecutionClient & Readonly<{
  requests(): readonly CapturedSvgBrowserRequest[];
  useRevision(revision: CapturedSvgBrowserRevision): void;
}>;

export type CapturedSvgBrowserInput = Readonly<{
  initial: CapturedSvgBrowserRevision;
  edited: CapturedSvgBrowserRevision;
  referenceResponse: AnalyticsCreateExecutionReferenceResponse;
}>;

export type CapturedSvgBrowserSession = Readonly<{
  root: HTMLElement;
  inspection: RenderedSlot["inspection"];
  client: CapturedSvgBrowserClient;
  ready(): Promise<Readonly<{
    text: string;
    datumText: string;
    resolvedTheme: AnalyticsChartTheme;
    observations: CapturedSvgChartObservationSet;
    requests: readonly CapturedSvgBrowserRequest[];
  }>>;
  update(revision: CapturedSvgBrowserRevision): Promise<Readonly<{ text: string; requests: readonly CapturedSvgBrowserRequest[] }>>;
  openMenu(): Promise<Readonly<{
    menuText: string;
    resolvedTheme: AnalyticsChartTheme;
    items: readonly Readonly<{ label: string; disabled: boolean }>[];
  }>>;
  changeTheme(themeName: CapturedSvgBrowserThemeName): Promise<Readonly<{
    themeName: CapturedSvgBrowserThemeName;
    capturedTheme: AnalyticsChartTheme;
    currentTheme: AnalyticsChartTheme;
    menuText: string;
  }>>;
  exportCapturedSvg(): Promise<Readonly<{
    menuText: string;
    statusText: string;
    capturedTheme: AnalyticsChartTheme | null;
    currentTheme: AnalyticsChartTheme;
    observedBefore: CapturedSvgChartObservationSet;
    observedAfter: CapturedSvgChartObservationSet;
  }>>;
  unmount(): Promise<CapturedSvgChartObservationSet>;
}>;

export type CapturedSvgDataLineage = Readonly<{
  text: string;
  byteLength: number;
}>;

type EChartsInstance = ReturnType<typeof echarts.init>;

type ChartObserver = Readonly<{
  snapshot(): CapturedSvgChartObservationSet;
  close(): CapturedSvgChartObservationSet;
}>;

function themeDefinition(name: CapturedSvgBrowserThemeName): CapturedSvgBrowserThemeDefinition {
  return name === CAPTURED_SVG_BROWSER_THEMES.old.name
    ? CAPTURED_SVG_BROWSER_THEMES.old
    : CAPTURED_SVG_BROWSER_THEMES.new;
}

function installFixtureThemes(initial: CapturedSvgBrowserThemeName): Readonly<{
  apply(name: CapturedSvgBrowserThemeName): void;
  restore(): void;
}> {
  const root = document.documentElement;
  const previous = root.getAttribute("data-theme");
  const style = document.createElement("style");
  style.textContent = Object.values(CAPTURED_SVG_BROWSER_THEMES)
    .map((definition) => `:root[data-theme="${definition.name}"] { ${Object.entries(definition.tokens)
      .map(([property, value]) => `${property}: ${value};`)
      .join(" ")} }`)
    .join("\n");
  document.head.append(style);
  const apply = (name: CapturedSvgBrowserThemeName) => {
    root.dataset.theme = themeDefinition(name).name;
  };
  apply(initial);
  let restored = false;
  return {
    apply,
    restore() {
      if (restored) return;
      restored = true;
      style.remove();
      if (previous == null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    },
  };
}

function registerChartObserver(): ChartObserver {
  const refs: EChartsInstance[] = [];
  let active = true;
  let observedCount = 0;
  let overflow = false;
  echarts.registerPostInit((chart) => {
    if (!active) return;
    observedCount += 1;
    if (refs.length >= MAX_OBSERVED_CHARTS) {
      overflow = true;
      return;
    }
    refs.push(chart);
  });
  const snapshot = (): CapturedSvgChartObservationSet => Object.freeze({
    observedCount,
    overflow,
    charts: refs.map((chart) => Object.freeze({
      id: chart.getId(),
      ssr: chart.isSSR(),
      disposed: chart.isDisposed(),
      registered: echarts.getInstanceById(chart.getId()) != null,
    })),
  });
  return {
    snapshot,
    close() {
      const result = snapshot();
      active = false;
      refs.splice(0, refs.length);
      return result;
    },
  };
}

function armAbortOnSsrAcquisition(controller: AbortController): () => void {
  let armed = true;
  echarts.registerPostInit((chart) => {
    if (!armed || !chart.isSSR()) return;
    armed = false;
    controller.abort();
  });
  return () => {
    armed = false;
  };
}

function errorCode(error: Error): string | undefined {
  if (!("code" in error) || typeof error.code !== "string") return undefined;
  return error.code;
}

function errorAttempt(error: unknown): CapturedSvgAttempt {
  if (!(error instanceof Error)) {
    return Object.freeze({ kind: "error", name: "UnknownError", message: String(error) });
  }
  const code = errorCode(error);
  return Object.freeze({
    kind: "error",
    name: error.name,
    ...(code == null ? {} : { code }),
    message: error.message,
  });
}

function observedOutput(output: CapturedSvgExport): CapturedSvgObservedOutput {
  return Object.freeze({
    text: output.text,
    byteLength: output.byteLength,
    lineageText: output.lineage.text,
    lineageByteLength: output.lineage.byteLength,
  });
}

function attemptSvg(
  artifact: CapturedFigureExport,
  options: CapturedFigureSvgOptions,
): CapturedSvgAttempt {
  try {
    return Object.freeze({ kind: "success", output: observedOutput(artifact.svg(options)) });
  } catch (error) {
    return errorAttempt(error);
  }
}

function successfulOutput(attempt: CapturedSvgAttempt): CapturedSvgObservedOutput {
  if (attempt.kind !== "success") throw new Error(`Captured SVG fixture expected success, got ${attempt.message}.`);
  return attempt.output;
}

function runObservedSvg(
  artifact: CapturedFigureExport,
  options: CapturedFigureSvgOptions,
  arm: ((observer: ChartObserver) => (() => void)) | undefined = undefined,
): Readonly<{ result: CapturedSvgAttempt; observations: CapturedSvgChartObservationSet }> {
  const observer = registerChartObserver();
  let disarm: () => void = () => undefined;
  try {
    if (arm != null) disarm = arm(observer);
    const result = attemptSvg(artifact, options);
    return Object.freeze({ result, observations: observer.snapshot() });
  } finally {
    disarm();
    observer.close();
  }
}

function resolvedChartTheme(root: HTMLElement): AnalyticsChartTheme {
  const probe = root.querySelector<HTMLElement>(".analytics-echart-theme-probe");
  if (probe == null) throw new Error("Captured SVG fixture could not find the chart theme probe.");
  const style = getComputedStyle(probe);
  return Object.freeze({
    foreground: style.color,
    muted: style.borderTopColor,
    border: style.borderRightColor,
    surface: style.backgroundColor,
    series: style.borderBottomColor,
  });
}

function sameTheme(left: AnalyticsChartTheme, right: AnalyticsChartTheme): boolean {
  return left.foreground === right.foreground &&
    left.muted === right.muted &&
    left.border === right.border &&
    left.surface === right.surface &&
    left.series === right.series;
}

export function createCapturedSvgBrowserClient(
  initial: CapturedSvgBrowserRevision,
  referenceResponse: AnalyticsCreateExecutionReferenceResponse,
): CapturedSvgBrowserClient {
  let revision = initial;
  const requests: Array<{
    locator: ExecutionLocator;
    signal: AbortSignal | undefined;
    settled: boolean;
    aborted: boolean;
  }> = [];
  const client: AnalyticsExecutionClient = {
    executeQuery(locator, options) {
      const request = { locator, signal: options?.signal, settled: false, aborted: false };
      requests.push(request);
      return new Promise<AnalyticsExecuteQueryResponse>((resolve, reject) => {
        const abort = () => {
          request.aborted = true;
          if (request.settled) return;
          request.settled = true;
          reject(new DOMException("captured fixture request aborted", "AbortError"));
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        queueMicrotask(() => {
          if (request.settled) return;
          request.settled = true;
          options?.signal?.removeEventListener("abort", abort);
          const response = revision.responses.get(locator.queryId);
          if (response == null) {
            reject(new Error(`No authored browser fixture response for ${locator.queryId}.`));
            return;
          }
          resolve(executeQueryResponseSchema.parse(response));
        });
      });
    },
    createExecutionReference(_request: CreateExecutionReferenceRequest) {
      return Promise.resolve(referenceResponse);
    },
  };
  return {
    ...client,
    requests: () => requests.map((request) => Object.freeze({
      locator: request.locator,
      settled: request.settled,
      aborted: request.aborted,
      signalAborted: request.signal?.aborted === true,
    })),
    useRevision(next) {
      revision = next;
    },
  };
}

export async function mountCapturedSvgFixture(
  input: CapturedSvgBrowserInput,
): Promise<CapturedSvgBrowserSession> {
  const observer = registerChartObserver();
  const themes = installFixtureThemes(CAPTURED_SVG_BROWSER_THEMES.old.name);
  try {
    installTestPluginRuntime();
    const module = await import("../../../../app.tsx");
    const Component = module.ExecutionBackedDashboard;
    const client = createCapturedSvgBrowserClient(input.initial, input.referenceResponse);
    const TestExecutionSlot = (props: ExecutionBackedDashboardProps) => createElement(Component, props);
    const propsFor = (revision: CapturedSvgBrowserRevision): ExecutionBackedDashboardProps => ({
      bundle: revision.bundle,
      client,
      locators: revision.locators,
      rangeDays: 7,
    });
    const slot = renderSlot({ component: TestExecutionSlot }, propsFor(input.initial));
    let currentRevision = input.initial;
    let capturedTheme: AnalyticsChartTheme | null = null;
    let unmounted = false;
    let finalObservations: CapturedSvgChartObservationSet | null = null;
    return {
      root: slot.container,
      inspection: slot.inspection,
      client,
      async ready() {
        if (unmounted) throw new Error("Captured SVG fixture session is unmounted.");
        await waitForText(slot.container, "Exact plotted data");
        const details = ensurePlottedDisclosureOpen(slot.container);
        await waitForText(slot.container, currentRevision.visibleDatumText);
        await waitForPredicate(() => [...details.querySelectorAll("tbody td")]
          .some((cell) => cell.textContent?.trim() === currentRevision.visibleDatumText));
        await waitForPredicate(() => client.requests().some((request) => request.settled && !request.aborted));
        const resolvedTheme = await waitForTheme(slot.container, CAPTURED_SVG_BROWSER_THEMES.old);
        await waitForPredicate(() => {
          const host = slot.container.querySelector<HTMLElement>(".analytics-echart");
          if (host == null) return false;
          const bounds = host.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
        await waitForPredicate(() => observer.snapshot().charts.some((chart) => !chart.ssr && !chart.disposed && chart.registered));
        const observations = observer.snapshot();
        if (observations.overflow || observations.charts.length === 0 || !observations.charts.some((chart) => !chart.ssr)) {
          throw new Error("Captured SVG fixture readiness did not observe a bounded live ECharts acquisition.");
        }
        return Object.freeze({
          text: slot.container.textContent ?? "",
          datumText: currentRevision.visibleDatumText,
          resolvedTheme,
          observations,
          requests: client.requests(),
        });
      },
      async update(revision) {
        if (unmounted) throw new Error("Captured SVG fixture session is unmounted.");
        currentRevision = revision;
        client.useRevision(revision);
        slot.lifecycle.rerender(createElement(TestExecutionSlot, propsFor(revision)));
        await waitForText(slot.container, revision.visibleDatumText);
        return Object.freeze({ text: slot.container.textContent ?? "", requests: client.requests() });
      },
      async openMenu() {
        if (unmounted) throw new Error("Captured SVG fixture session is unmounted.");
        await waitForText(slot.container, "Exact plotted data");
        ensurePlottedDisclosureOpen(slot.container);
        await waitForText(slot.container, currentRevision.visibleDatumText);
        const action = [...slot.container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Actions");
        if (action == null) throw new Error("Captured SVG fixture could not find the failures-series Actions button.");
        action.click();
        await waitForSelector(slot.container, '[role="menu"]');
        const menu = slot.container.querySelector('[role="menu"]');
        if (!(menu instanceof HTMLElement)) throw new Error("Captured SVG fixture menu is not an HTMLElement.");
        capturedTheme = resolvedChartTheme(slot.container);
        return Object.freeze({
          menuText: menu.textContent ?? "",
          resolvedTheme: capturedTheme,
          items: [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            .map((button) => Object.freeze({ label: button.textContent?.trim() ?? "", disabled: button.disabled })),
        });
      },
      async changeTheme(themeName) {
        if (unmounted) throw new Error("Captured SVG fixture session is unmounted.");
        const previousTheme = capturedTheme ?? resolvedChartTheme(slot.container);
        themes.apply(themeName);
        const currentTheme = await waitForTheme(slot.container, themeDefinition(themeName));
        const menu = slot.container.querySelector('[role="menu"]');
        return Object.freeze({
          themeName,
          capturedTheme: previousTheme,
          currentTheme,
          menuText: menu?.textContent ?? "",
        });
      },
      async exportCapturedSvg() {
        if (unmounted) throw new Error("Captured SVG fixture session is unmounted.");
        const menu = slot.container.querySelector('[role="menu"]');
        if (!(menu instanceof HTMLElement)) throw new Error("Captured SVG fixture requires an open menu.");
        const before = observer.snapshot();
        const button = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((candidate) => candidate.textContent?.trim() === "Export SVG + lineage");
        if (button == null) throw new Error("Captured SVG fixture could not find the SVG export command.");
        button.click();
        await waitForPredicate(() =>
          slot.container.querySelector('[role="menu"]') == null || slot.container.querySelector('[role="status"]') != null,
        );
        const after = observer.snapshot();
        return Object.freeze({
          menuText: slot.container.textContent ?? "",
          statusText: slot.container.querySelector('[role="status"]')?.textContent ?? "",
          capturedTheme,
          currentTheme: resolvedChartTheme(slot.container),
          observedBefore: before,
          observedAfter: after,
        });
      },
      async unmount() {
        if (finalObservations != null) return finalObservations;
        unmounted = true;
        try {
          slot.lifecycle.unmount();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        } finally {
          finalObservations = observer.close();
          themes.restore();
        }
        if (finalObservations == null) throw new Error("Captured SVG fixture cleanup did not produce observations.");
        return finalObservations;
      },
    };
  } catch (error) {
    observer.close();
    themes.restore();
    throw error;
  }
}

function setCapturedFixtureValue(target: object, property: PropertyKey, value: unknown, label: string): void {
  if (!Reflect.set(target, property, value)) throw new Error(`Captured fixture mutation did not apply: ${label}`);
}

function mutateCallerCaptureGraphs(input: CapturedFigureExportInput): void {
  setCapturedFixtureValue(input.execution, "executionId", `${input.execution.executionId}-mutated`, "execution ID");
  setCapturedFixtureValue(input.execution.resolved, "bundleId", `${input.execution.resolved.bundleId}-mutated`, "resolved bundle ID");
  setCapturedFixtureValue(input.execution.resolved.query, "title", "mutated resolved query", "resolved query title");
  setCapturedFixtureValue(input.execution.result, "resultTruncated", true, "execution result truncation");
  setCapturedFixtureValue(input.definition.query, "title", "mutated captured query", "query title");
  setCapturedFixtureValue(input.definition.bundle, "title", "mutated captured bundle", "bundle title");
  const definitionFigure = input.definition.figures[0];
  if (definitionFigure == null) throw new Error("Captured fixture mutation is missing the definition figure.");
  setCapturedFixtureValue(definitionFigure.visualization, "title", "mutated definition visualization", "definition visualization title");
  setCapturedFixtureValue(definitionFigure.plotted, "plottedRows", 0, "definition plotted rows");
  setCapturedFixtureValue(input.result, "generation", "mutated captured generation", "result generation");
  const firstRow = input.result.rows[0];
  const firstColumn = input.result.columns[0];
  if (firstRow != null && firstColumn != null) {
    setCapturedFixtureValue(firstRow, firstColumn.name, null, "first result cell");
  }
  setCapturedFixtureValue(input.figure, "plottedCount", 0, "plotted count");
  setCapturedFixtureValue(input.figure.visualization, "title", "mutated captured visualization", "visualization title");
  setCapturedFixtureValue(input.figure.option, "animation", true, "figure animation");
}

export function observeCapturedArtifactMutation(input: Readonly<{
  capture: CapturedFigureExportInput;
  options: CapturedFigureSvgOptions;
}>): Readonly<{
  before: CapturedSvgObservedOutput;
  after: CapturedSvgObservedOutput;
  observations: Readonly<{
    before: CapturedSvgChartObservationSet;
    after: CapturedSvgChartObservationSet;
  }>;
}> {
  const artifact = createCapturedFigureExport(input.capture);
  const beforeRun = runObservedSvg(artifact, input.options);
  mutateCallerCaptureGraphs(input.capture);
  const afterRun = runObservedSvg(artifact, input.options);
  return Object.freeze({
    before: successfulOutput(beforeRun.result),
    after: successfulOutput(afterRun.result),
    observations: Object.freeze({ before: beforeRun.observations, after: afterRun.observations }),
  });
}

export function observeCapturedSvgBudgets(input: Readonly<{
  capture: CapturedFigureExportInput;
  options: CapturedFigureSvgOptions;
  consumerMaxSvgBytes: number;
}>): Readonly<{
  production: CapturedSvgAttempt;
  consumer: CapturedSvgAttempt;
  tooSmall: CapturedSvgAttempt;
  observations: Readonly<{
    production: CapturedSvgChartObservationSet;
    consumer: CapturedSvgChartObservationSet;
    tooSmall: CapturedSvgChartObservationSet;
  }>;
}> {
  const productionRun = runObservedSvg(createCapturedFigureExport(input.capture), input.options);
  const consumerRun = runObservedSvg(
    createCapturedFigureExport(input.capture, { maxSvgBytes: input.consumerMaxSvgBytes }),
    input.options,
  );
  const tooSmallRun = runObservedSvg(
    createCapturedFigureExport(input.capture, { maxSvgBytes: 1 }),
    input.options,
  );
  return Object.freeze({
    production: productionRun.result,
    consumer: consumerRun.result,
    tooSmall: tooSmallRun.result,
    observations: Object.freeze({
      production: productionRun.observations,
      consumer: consumerRun.observations,
      tooSmall: tooSmallRun.observations,
    }),
  });
}

export function observeCapturedSvgAbort(input: Readonly<{
  capture: CapturedFigureExportInput;
  options: Omit<CapturedFigureSvgOptions, "signal">;
}>): Readonly<{
  pre: Readonly<{
    error: CapturedSvgAttempt;
    acquired: number;
    observations: CapturedSvgChartObservationSet;
  }>;
  post: Readonly<{
    error: CapturedSvgAttempt;
    aborted: boolean;
    observations: CapturedSvgChartObservationSet;
  }>;
}> {
  const artifact = createCapturedFigureExport(input.capture);
  const preController = new AbortController();
  preController.abort();
  const postController = new AbortController();
  const preRun = runObservedSvg(artifact, { ...input.options, signal: preController.signal });
  // runObservedSvg returns this snapshot before the post operation starts.
  const postRun = runObservedSvg(
    artifact,
    { ...input.options, signal: postController.signal },
    () => armAbortOnSsrAcquisition(postController),
  );
  return Object.freeze({
    pre: Object.freeze({
      error: preRun.result,
      acquired: preRun.observations.observedCount,
      observations: preRun.observations,
    }),
    post: Object.freeze({
      error: postRun.result,
      aborted: postController.signal.aborted,
      observations: postRun.observations,
    }),
  });
}

export function observeImageLineageFailure(input: Readonly<{
  capture: CapturedFigureExportInput;
  options: CapturedFigureSvgOptions;
}>): Readonly<{
  stage: "artifact-creation" | "data-lineage" | "post-render-lineage" | "svg-output" | "unexpected-success";
  error: CapturedSvgAttempt;
  observations: CapturedSvgChartObservationSet;
  dataLineage: Readonly<{
    plotted: CapturedSvgDataLineage;
    result: CapturedSvgDataLineage;
  }> | null;
}> {
  let artifact: CapturedFigureExport;
  try {
    artifact = createCapturedFigureExport(input.capture);
  } catch (error) {
    const failure = errorAttempt(error);
    return Object.freeze({ stage: "artifact-creation", error: failure, observations: emptyObservations(), dataLineage: null });
  }
  let dataLineage: Readonly<{ plotted: CapturedSvgDataLineage; result: CapturedSvgDataLineage }>;
  try {
    const plotted = artifact.lineage("plotted");
    const result = artifact.lineage("result");
    dataLineage = Object.freeze({
      plotted: Object.freeze({ text: plotted.text, byteLength: plotted.byteLength }),
      result: Object.freeze({ text: result.text, byteLength: result.byteLength }),
    });
  } catch (error) {
    return Object.freeze({ stage: "data-lineage", error: errorAttempt(error), observations: emptyObservations(), dataLineage: null });
  }
  const run = runObservedSvg(artifact, input.options);
  const result = run.result;
  const observations = run.observations;
  if (result.kind === "success") {
    return Object.freeze({ stage: "unexpected-success", error: result, observations, dataLineage });
  }
  return Object.freeze({
    stage: result.code === "lineage-too-large" ? "post-render-lineage" : "svg-output",
    error: result,
    observations,
    dataLineage,
  });
}

function themeFromDefinition(definition: CapturedSvgBrowserThemeDefinition): AnalyticsChartTheme {
  return Object.freeze({
    foreground: definition.tokens["--foreground"],
    muted: definition.tokens["--muted-foreground"],
    border: definition.tokens["--border"],
    surface: definition.tokens["--popover"],
    series: definition.tokens["--chart-1"],
  });
}

async function waitForTheme(
  root: HTMLElement,
  definition: CapturedSvgBrowserThemeDefinition,
): Promise<AnalyticsChartTheme> {
  const expected = themeFromDefinition(definition);
  await waitForPredicate(() => sameTheme(resolvedChartTheme(root), expected));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return resolvedChartTheme(root);
}

async function waitForSelector(root: HTMLElement, selector: string): Promise<void> {
  await waitForPredicate(() => root.querySelector(selector) != null);
}

function ensurePlottedDisclosureOpen(root: HTMLElement): HTMLDetailsElement {
  const summary = [...root.querySelectorAll("summary")]
    .find((candidate) => candidate.textContent?.startsWith("Exact plotted data") === true);
  if (!(summary instanceof HTMLElement)) throw new Error("Captured SVG fixture could not find the plotted disclosure.");
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Captured SVG fixture plotted disclosure has no details owner.");
  if (!details.open) summary.click();
  return details;
}

async function waitForPredicate(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Captured SVG browser fixture timed out waiting for the real component.");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function waitForText(root: HTMLElement, expected: string | ((text: string) => boolean)): Promise<void> {
  const predicate = typeof expected === "string" ? (text: string) => text.includes(expected) : expected;
  await waitForPredicate(() => predicate(root.textContent ?? ""));
}
