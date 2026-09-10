import { createElement } from "react";
import {
  installTestPluginRuntime,
  renderSlot,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";

import type { AnalyticsBundleResponse } from "../../../../rpc-contract.ts";
import {
  executeQueryResponseSchema,
  executionResultSchema,
  type ExecutionDefinition,
  type CreateExecutionReferenceRequest,
  type ExecutionLocator,
  type ExecutionResult,
} from "../../../../execution-contract.ts";
import {
  parseAnalyticsExecutionLocator,
  parseAnalyticsExecutionQueryResponse,
  parseAnalyticsExecutionReferenceRequest,
  parseAnalyticsExecutionReferenceResponse,
  type AnalyticsExecutionClient,
} from "../../../../analytics-model.ts";
import type {
  AnalyticsCreateExecutionReferenceResponse,
  AnalyticsExecuteQueryResponse,
} from "../../../../rpc-contract.ts";
import type {
  ExecutionBackedDashboardProps,
  ExecutionLocatorSource,
} from "../../../../app.tsx";

type ControlledExecutionRequest = Readonly<{
  locator: ExecutionLocator;
  signal: AbortSignal | undefined;
  abortObserved: boolean;
  listenerAttached: boolean;
  settled: boolean;
}>;

type PendingExecutionRequest = {
  locator: ExecutionLocator;
  signal: AbortSignal | undefined;
  resolve: (response: AnalyticsExecuteQueryResponse) => void;
  reject: (cause: unknown) => void;
  abortObserved: boolean;
  settled: boolean;
  removeAbortListener: (() => void) | null;
};

export type ControlledExecutionResult = Readonly<{
  execution: ExecutionResult;
  definition: ExecutionDefinition;
}>;

export type ControlledExecutionClient = AnalyticsExecutionClient & Readonly<{
  requests(): readonly ControlledExecutionRequest[];
  referenceRequests(): readonly CreateExecutionReferenceRequest[];
  resolve(index: number, value: ControlledExecutionResult): void;
  reject(index: number, response: AnalyticsExecuteQueryResponse): void;
  rejectAbort(index: number): void;
  settleAborted(): void;
}>;

export type MountedExecutionDashboard = Readonly<{
  container: HTMLElement;
  client: ControlledExecutionClient;
  inspection: RenderedSlot["inspection"];
  rerender(input: Readonly<{
    bundle: AnalyticsBundleResponse;
    locators: ExecutionLocatorSource;
    rangeDays: number;
  }>): void;
  unmount(): void;
}>;

export type CapturedDownload = Readonly<{
  filename: string;
  type: string;
  blob: Blob;
}>;

type DownloadRecorder = Readonly<{
  downloads: CapturedDownload[];
  restore(): void;
}>;

function cancellationResponse(): AnalyticsExecuteQueryResponse {
  return executeQueryResponseSchema.parse({
    kind: "error",
    error: {
      code: "cancelled",
      retryable: false,
      message: "controlled caller cancellation",
    },
  });
}

export function createControlledExecutionClient(
  referenceResponse: AnalyticsCreateExecutionReferenceResponse,
): ControlledExecutionClient {
  const requests: PendingExecutionRequest[] = [];
  const references: CreateExecutionReferenceRequest[] = [];
  const publicClient: AnalyticsExecutionClient = {
    executeQuery(locator, options) {
      return new Promise((resolve, reject) => {
        const pending: PendingExecutionRequest = {
          locator,
          signal: options?.signal,
          resolve,
          reject,
          abortObserved: false,
          settled: false,
          removeAbortListener: null,
        };
        const abort = () => {
          pending.abortObserved = true;
          // A controlled transport may observe caller cancellation without
          // releasing host work; leave the response pending so supersession
          // can resolve the stale response after the newer one.
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => options?.signal?.removeEventListener("abort", abort);
        requests.push(pending);
      });
    },
    createExecutionReference(request) {
      const parsedRequest = parseAnalyticsExecutionReferenceRequest(request);
      references.push(parsedRequest);
      return Promise.resolve(parseAnalyticsExecutionReferenceResponse(referenceResponse));
    },
  };
  return {
    ...publicClient,
    requests: () => requests.map((pending) => ({
      locator: pending.locator,
      signal: pending.signal,
      abortObserved: pending.abortObserved,
      listenerAttached: pending.removeAbortListener != null,
      settled: pending.settled,
    })),
    referenceRequests: () => [...references],
    resolve(index, value) {
      const pending = requests[index];
      if (pending == null || pending.settled) throw new Error(`Execution request ${index} is not pending.`);
      pending.settled = true;
      pending.resolve(executeQueryResponseSchema.parse({
        kind: "success",
        result: executionResultSchema.parse(value.execution),
        definition: value.definition,
      }));
      pending.removeAbortListener?.();
      pending.removeAbortListener = null;
    },
    rejectAbort(index) {
      const pending = requests[index];
      if (pending == null || pending.settled) throw new Error(`Execution request ${index} is not pending.`);
      pending.settled = true;
      pending.reject(new DOMException("controlled abort", "AbortError"));
      pending.removeAbortListener?.();
      pending.removeAbortListener = null;
    },
    reject(index, response) {
      const pending = requests[index];
      if (pending == null || pending.settled) throw new Error(`Execution request ${index} is not pending.`);
      pending.settled = true;
      pending.resolve(executeQueryResponseSchema.parse(response));
      pending.removeAbortListener?.();
      pending.removeAbortListener = null;
    },
    settleAborted() {
      for (const pending of requests) {
        if (pending.settled) continue;
        pending.settled = true;
        pending.resolve(cancellationResponse());
        pending.removeAbortListener?.();
        pending.removeAbortListener = null;
      }
    },
  };
}

export type MountExecutionDashboardInput = Readonly<{
  bundle: AnalyticsBundleResponse;
  locators: ExecutionLocatorSource;
  rangeDays: number;
  client: ControlledExecutionClient;
}>;

/**
 * Existing public SDK test seam, kept as a fixture operation rather than a
 * production registration. The app module is loaded only after the runtime
 * installer, then renderSlot supplies the public SlotEnvContext around an
 * ordinary test-only wrapper for the named execution component.
 */
export async function mountExecutionBackedDashboard(
  input: MountExecutionDashboardInput,
): Promise<MountedExecutionDashboard> {
  installTestPluginRuntime();
  const module = await import("../../../../app.tsx");
  const Component = module.ExecutionBackedDashboard;
  const TestExecutionSlot = (props: ExecutionBackedDashboardProps) => createElement(Component, props);
  const propsFor = (next: Readonly<{
    bundle: AnalyticsBundleResponse;
    locators: ExecutionLocatorSource;
    rangeDays: number;
  }>): ExecutionBackedDashboardProps => ({
      bundle: next.bundle,
      client: input.client,
      locators: next.locators,
      rangeDays: next.rangeDays,
    });
  const slot: RenderedSlot = renderSlot(
    { component: TestExecutionSlot },
    propsFor(input),
  );
  let unmounted = false;
  return {
    container: slot.container,
    client: input.client,
    inspection: slot.inspection,
    rerender(next) {
      slot.lifecycle.rerender(createElement(TestExecutionSlot, propsFor(next)));
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      slot.lifecycle.unmount();
      input.client.settleAborted();
    },
  };
}

export async function waitForDom(
  container: HTMLElement,
  predicate: (container: HTMLElement) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate(container)) {
    if (performance.now() >= deadline) throw new Error("Controlled UI fixture timed out waiting for the DOM.");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function yieldToReact(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function clickButton(container: HTMLElement, name: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name);
  if (button == null) throw new Error(`Controlled UI fixture could not find button ${name}.`);
  button.click();
}

function installDownloadRecorder(): DownloadRecorder {
  const downloads: CapturedDownload[] = [];
  const urls = new Map<string, Blob>();
  const previousCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const previousRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const previousClick = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "click");
  let nextUrl = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:controlled-analytics-${nextUrl++}`;
      urls.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLAnchorElement.prototype, "click", {
    configurable: true,
    value(this: HTMLAnchorElement) {
      const href = this.getAttribute("href") ?? this.href;
      const blob = urls.get(href) ?? urls.get(this.href);
      if (blob != null) {
        downloads.push({ filename: this.download, type: blob.type, blob });
      }
    },
  });
  return {
    downloads,
    restore() {
      if (previousCreate == null) Reflect.deleteProperty(URL, "createObjectURL");
      else Object.defineProperty(URL, "createObjectURL", previousCreate);
      if (previousRevoke == null) Reflect.deleteProperty(URL, "revokeObjectURL");
      else Object.defineProperty(URL, "revokeObjectURL", previousRevoke);
      if (previousClick == null) Reflect.deleteProperty(HTMLAnchorElement.prototype, "click");
      else Object.defineProperty(HTMLAnchorElement.prototype, "click", previousClick);
    },
  };
}

async function readDownloads(recorder: DownloadRecorder): Promise<readonly {
  filename: string;
  type: string;
  text: string;
}[]> {
  return Promise.all(recorder.downloads.map(async (download) => ({
    filename: download.filename,
    type: download.type,
    text: await readBlobText(download.blob),
  })));
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      if (typeof result !== "string") {
        reject(new Error("Controlled download did not produce bounded text."));
      } else {
        resolve(result);
      }
    };
    reader.onerror = () => {
      const error = reader.error;
      cleanup();
      reject(error ?? new Error("Controlled download text read failed."));
    };
    reader.onabort = () => {
      cleanup();
      reject(new Error("Controlled download text read was aborted."));
    };
    try {
      reader.readAsText(blob);
    } catch (cause) {
      cleanup();
      reject(cause instanceof Error ? cause : new Error("Controlled download text read failed."));
    }
  });
}

export function openChartData(container: HTMLElement): void {
  const summary = [...container.querySelectorAll("summary")]
    .find((candidate) => candidate.textContent?.startsWith("Exact plotted data") === true);
  if (summary == null) throw new Error("Controlled UI fixture could not find chart data disclosure.");
  summary.click();
}

export function capturedReferenceRequests(
  client: ControlledExecutionClient,
): readonly CreateExecutionReferenceRequest[] {
  return client.referenceRequests();
}

/** Resolve the newer request first, then the stale request, to witness fencing. */
export function resolveSupersession(
  client: ControlledExecutionClient,
  newerIndex: number,
  newerResult: ControlledExecutionResult,
  staleIndex: number,
  staleResult: ControlledExecutionResult,
): void {
  client.resolve(newerIndex, newerResult);
  client.resolve(staleIndex, staleResult);
}

function mustReject(label: string, operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`Controlled UI fixture accepted ${label}.`);
}

function isExecutionLocatorMap(source: ExecutionLocatorSource): source is ReadonlyMap<string, ExecutionLocator> {
  return "get" in source && typeof source.get === "function";
}

function authoredLocatorFor(source: ExecutionLocatorSource, queryId: string): ExecutionLocator | null {
  if (isExecutionLocatorMap(source)) return source.get(queryId) ?? null;
  if (!Object.prototype.hasOwnProperty.call(source, queryId)) return null;
  return source[queryId] ?? null;
}

function assertDispatchedLocator(
  bundle: AnalyticsBundleResponse,
  locators: ExecutionLocatorSource,
  actual: ExecutionLocator,
): void {
  const expected = authoredLocatorFor(locators, actual.queryId);
  const query = bundle.bundle.queries.find((candidate) => candidate.id === actual.queryId);
  if (expected == null || query == null) {
    throw new Error(`Controlled UI fixture dispatched an un-authored query locator: ${actual.queryId}.`);
  }
  const parsedExpected = parseAnalyticsExecutionLocator(expected, {
    bundleId: bundle.bundle.id,
    queryId: query.id,
  });
  if (
    actual.bundleId !== parsedExpected.bundleId ||
    actual.queryId !== parsedExpected.queryId ||
    actual.range.startInclusiveMs !== parsedExpected.range.startInclusiveMs ||
    actual.range.endExclusiveMs !== parsedExpected.range.endExclusiveMs ||
    JSON.stringify(actual.parameters) !== JSON.stringify(parsedExpected.parameters)
  ) {
    throw new Error(`Controlled UI fixture dispatched a locator different from the authored ${query.id} locator.`);
  }
}

/** Source-level negative controls for locator ownership and frozen execution scope. */
export function assertLocatorAndScopeNegatives(
  execution: ExecutionResult,
  definition: ExecutionDefinition,
  locator: ExecutionLocator,
): void {
  const validLocator = parseAnalyticsExecutionLocator(locator, {
    bundleId: locator.bundleId,
    queryId: locator.queryId,
  });
  const validResponse = parseAnalyticsExecutionQueryResponse({ kind: "success", result: execution, definition }, validLocator);
  if (validResponse.kind !== "success") throw new Error("Controlled UI fixture rejected a valid execution response.");
  const mismatchedBundleId = locator.bundleId === "other-bundle" ? "different-bundle" : "other-bundle";
  const mismatchedQueryId = locator.queryId === "other-query" ? "different-query" : "other-query";
  const mismatchedLocator = {
    ...locator,
    bundleId: mismatchedBundleId,
    queryId: mismatchedQueryId,
  };
  mustReject("a locator owned by another bundle/query", () => parseAnalyticsExecutionLocator(mismatchedLocator, {
    bundleId: locator.bundleId,
    queryId: locator.queryId,
  }));
  if (execution.resolved.query.parameters.length > 1) {
    const reorderedParameters = [...execution.resolved.query.parameters].reverse();
    const reordered = {
      ...execution,
      resolved: {
        ...execution.resolved,
        query: {
          ...execution.resolved.query,
          parameters: reorderedParameters,
        },
      },
    };
    const reorderedDefinition = {
      ...definition,
      query: { ...definition.query, parameters: reorderedParameters },
    };
    executeQueryResponseSchema.parse({ kind: "success", result: reordered, definition: reorderedDefinition });
    const orderIndependentResponse = parseAnalyticsExecutionQueryResponse({ kind: "success", result: reordered, definition: reorderedDefinition }, validLocator);
    if (orderIndependentResponse.kind !== "success") throw new Error("Controlled UI fixture rejected declaration-order variation.");
  }
  const rangeMismatch = {
    kind: "success",
    result: {
      ...execution,
      resolved: {
        ...execution.resolved,
        snapshot: {
          ...execution.resolved.snapshot,
          frozenRange: {
            ...execution.resolved.snapshot.frozenRange,
            startInclusiveMs: execution.resolved.snapshot.frozenRange.startInclusiveMs + 1,
          },
        },
      },
    },
    definition,
  } as const;
  executeQueryResponseSchema.parse(rangeMismatch);
  mustReject("a response with the same IDs but a different frozen range", () => parseAnalyticsExecutionQueryResponse(rangeMismatch, validLocator));
  const parameter = execution.resolved.query.parameters[0];
  if (parameter == null) throw new Error("Controlled UI fixture requires one typed execution parameter.");
  const changedValue = parameter.logicalType === "utf8"
    ? parameter.value === "alternate" ? "different" : "alternate"
    : parameter.logicalType === "integer" || parameter.logicalType === "timestamp_utc_ms"
      ? parameter.value === 1 ? 2 : 1
      : parameter.logicalType === "decimal"
        ? parameter.value === "1" ? "2" : "1"
        : parameter.logicalType === "float64"
          ? parameter.value === 1 ? 2 : 1
          : parameter.logicalType === "boolean"
            ? !parameter.value
            : parameter.logicalType === "date_utc"
              ? parameter.value === "2020-01-01" ? "2020-01-02" : "2020-01-01"
              : null;
  if (changedValue === null) throw new Error("Controlled UI fixture requires a parameter type with a valid alternate value.");
  const parameterMismatch = {
    kind: "success",
    result: {
      ...execution,
      resolved: {
        ...execution.resolved,
        query: {
          ...execution.resolved.query,
          parameters: [{ ...parameter, value: changedValue }, ...execution.resolved.query.parameters.slice(1)],
        },
      },
    },
    definition: {
      ...definition,
      query: {
        ...definition.query,
        parameters: [{ ...parameter, value: changedValue }, ...definition.query.parameters.slice(1)],
      },
    },
  } as const;
  executeQueryResponseSchema.parse(parameterMismatch);
  mustReject("a response with the same IDs/range but a different typed parameter value", () => parseAnalyticsExecutionQueryResponse(parameterMismatch, validLocator));

  const definitionQueryMismatch = {
    kind: "success",
    result: execution,
    definition: {
      ...definition,
      query: { ...definition.query, title: definition.query.title === "alternate" ? "changed" : "alternate" },
    },
  } as const;
  mustReject("a schema-valid response with a mismatched captured query definition", () =>
    executeQueryResponseSchema.parse(definitionQueryMismatch),
  );
  const figure = definition.figures[0];
  if (figure == null) throw new Error("Controlled UI fixture requires a captured figure.");
  const plottedMismatch = {
    kind: "success",
    result: execution,
    definition: {
      ...definition,
      figures: [{ ...figure, plotted: { ...figure.plotted, plottedRows: figure.plotted.plottedRows + 1 } }, ...definition.figures.slice(1)],
    },
  } as const;
  mustReject("a schema-valid response with mismatched plotted metadata", () =>
    executeQueryResponseSchema.parse(plottedMismatch),
  );
}

export type ExerciseExecutionDashboardInput = MountExecutionDashboardInput & Readonly<{
  results: ReadonlyMap<string, ControlledExecutionResult>;
  visibleDatumText: string;
  expectedDatumKey: string;
  expectedReferenceId: string;
  expectedReferenceToken: string;
  expectedResultStatus?: string;
}>;

/**
 * Bounded real-component operation: mount, release canonical results, observe
 * rendered content, open the existing chart menu, and observe the ordinary
 * v2 reference command. It returns observations for a browser binding to
 * assert; it never emits acceptance status or fabricates product results.
 */
export async function exerciseExecutionBackedDashboard(
  input: ExerciseExecutionDashboardInput,
): Promise<Readonly<{
  renderedText: string;
  referenceRequests: readonly CreateExecutionReferenceRequest[];
  composerMentions: readonly unknown[];
  clipboardWrites: readonly string[];
}>> {
  const mounted = await mountExecutionBackedDashboard(input);
  const clipboardWrites: string[] = [];
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let clipboardInstalled = false;
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (token: string) => { clipboardWrites.push(token); } },
    });
    clipboardInstalled = true;
    await waitForDom(mounted.container, () => mounted.client.requests().length === input.bundle.bundle.queries.length);
    for (const [index, request] of mounted.client.requests().entries()) {
      assertDispatchedLocator(input.bundle, input.locators, request.locator);
      const result = input.results.get(request.locator.queryId);
      if (result == null) throw new Error(`Controlled UI fixture has no result for ${request.locator.queryId}.`);
      mounted.client.resolve(index, result);
    }
    await waitForDom(mounted.container, (container) => container.textContent?.includes("Exact plotted data") === true);
    openChartData(mounted.container);
    await waitForDom(mounted.container, (container) => container.textContent?.includes(input.visibleDatumText) === true);
    await waitForDom(mounted.container, (container) => [...container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Actions"));
    clickButton(mounted.container, "Actions");
    await waitForDom(mounted.container, (container) => container.querySelector('[role="menu"]') != null);
    clickButton(mounted.container, "Add reference to chat");
    await waitForDom(mounted.container, () => mounted.client.referenceRequests().length === 1);
    await waitForDom(mounted.container, () => mounted.inspection.composer.mentions.at(-1)?.id === input.expectedReferenceId);
    await waitForDom(mounted.container, (container) => container.querySelector('[role="menu"]') == null);
    clickButton(mounted.container, "Actions");
    await waitForDom(mounted.container, (container) => container.querySelector('[role="menu"]') != null);
    clickButton(mounted.container, "Copy reference token");
    await waitForDom(mounted.container, () => clipboardWrites.length === 1);
    if (clipboardWrites[0] !== input.expectedReferenceToken) {
      throw new Error("Controlled UI fixture did not propagate the reference token to clipboard.");
    }
    await waitForDom(mounted.container, () => mounted.client.referenceRequests().length === 2);
    const referenceRequests = mounted.client.referenceRequests();
    const expectedReference = {
      executionId: input.results.get("problem-tools")?.execution.executionId,
      visualizationId: "failures",
      targetDatumKey: input.expectedDatumKey,
    };
    if (
      referenceRequests.length !== 2 ||
      referenceRequests.some((request) =>
        request.executionId !== expectedReference.executionId ||
        request.visualizationId !== expectedReference.visualizationId ||
        request.targetDatumKey !== expectedReference.targetDatumKey)
    ) {
      throw new Error("Controlled UI fixture did not preserve exact captured reference identity for both operations.");
    }
    return {
      renderedText: mounted.container.textContent ?? "",
      referenceRequests,
      composerMentions: [...mounted.inspection.composer.mentions],
      clipboardWrites: [...clipboardWrites],
    };
  } finally {
    mounted.unmount();
    if (clipboardInstalled) {
      if (previousClipboard == null) Reflect.deleteProperty(navigator, "clipboard");
      else Object.defineProperty(navigator, "clipboard", previousClipboard);
    }
  }
}

/**
 * Menu capture is immutable: editing the currently selected bundle after the
 * menu opens must not retarget the reference to the newer execution/figure.
 */
export async function exerciseCapturedReferenceAfterBundleEdit(input: Readonly<{
  initial: ExerciseExecutionDashboardInput;
  edited: ExecutionDashboardRevision;
}>): Promise<Readonly<{ referenceRequest: CreateExecutionReferenceRequest }>> {
  const mounted = await mountExecutionBackedDashboard(input.initial);
  try {
    const initialCount = input.initial.bundle.bundle.queries.length;
    await waitForDom(mounted.container, () => mounted.client.requests().length === initialCount);
    for (let index = 0; index < initialCount; index += 1) {
      const request = mounted.client.requests()[index];
      assertDispatchedLocator(input.initial.bundle, input.initial.locators, request.locator);
      const value = input.initial.results.get(request.locator.queryId);
      if (value == null) throw new Error(`Controlled UI fixture has no initial result for ${request.locator.queryId}.`);
      mounted.client.resolve(index, value);
    }
    await waitForDom(mounted.container, (container) => container.textContent?.includes("Exact plotted data") === true);
    openChartData(mounted.container);
    await waitForDom(mounted.container, (container) => container.textContent?.includes(input.initial.visibleDatumText) === true);
    await waitForDom(mounted.container, (container) => [...container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Actions"));
    clickButton(mounted.container, "Actions");
    await waitForDom(mounted.container, (container) => container.querySelector('[role="menu"]') != null);
    if (!mounted.container.textContent?.includes("Returned result: 1 rows returned · exact result")) {
      throw new Error("Controlled UI fixture did not expose returned-result extent status.");
    }

    mounted.rerender(input.edited);
    const editedCount = input.edited.bundle.bundle.queries.length;
    await waitForDom(mounted.container, () => mounted.client.requests().length === initialCount + editedCount);
    for (let index = 0; index < editedCount; index += 1) {
      const requestIndex = initialCount + index;
      const request = mounted.client.requests()[requestIndex];
      assertDispatchedLocator(input.edited.bundle, input.edited.locators, request.locator);
      const value = input.edited.results.get(request.locator.queryId);
      if (value == null) throw new Error(`Controlled UI fixture has no edited result for ${request.locator.queryId}.`);
      mounted.client.resolve(requestIndex, value);
    }
    await waitForDom(mounted.container, (container) =>
      container.textContent?.includes(input.edited.visibleDatumText) === true &&
      container.querySelector('[role="menu"]') != null,
    );
    clickButton(mounted.container, "Add reference to chat");
    await waitForDom(mounted.container, () => mounted.client.referenceRequests().length === 1);
    const referenceRequest = mounted.client.referenceRequests()[0];
    if (referenceRequest == null || referenceRequest.executionId !== input.initial.results.get("problem-tools")?.execution.executionId) {
      throw new Error("Controlled UI fixture retargeted a captured menu to the edited execution.");
    }
    if (referenceRequest.targetDatumKey !== input.initial.expectedDatumKey) {
      throw new Error("Controlled UI fixture retargeted a captured datum key after bundle edit.");
    }
    return { referenceRequest };
  } finally {
    mounted.unmount();
  }
}

export async function exerciseCapturedDownloadAfterBundleEdit(input: Readonly<{
  initial: ExerciseExecutionDashboardInput;
  edited: ExecutionDashboardRevision;
  scope: "plotted" | "result";
}>): Promise<readonly Readonly<{ filename: string; type: string; text: string }>[]> {
  const recorder = installDownloadRecorder();
  let mounted: MountedExecutionDashboard | null = null;
  try {
    const dashboard = await mountExecutionBackedDashboard(input.initial);
    mounted = dashboard;
    const initialCount = input.initial.bundle.bundle.queries.length;
    await waitForDom(dashboard.container, () => dashboard.client.requests().length === initialCount);
    for (let index = 0; index < initialCount; index += 1) {
      const request = dashboard.client.requests()[index];
      assertDispatchedLocator(input.initial.bundle, input.initial.locators, request.locator);
      const value = input.initial.results.get(request.locator.queryId);
      if (value == null) throw new Error(`Controlled UI fixture has no initial result for ${request.locator.queryId}.`);
      dashboard.client.resolve(index, value);
    }
    await waitForDom(dashboard.container, (container) => container.textContent?.includes("Exact plotted data") === true);
    openChartData(dashboard.container);
    await waitForDom(dashboard.container, (container) => container.textContent?.includes(input.initial.visibleDatumText) === true);
    await waitForDom(dashboard.container, (container) => [...container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Actions"));
    clickButton(dashboard.container, "Actions");
    await waitForDom(dashboard.container, (container) => container.querySelector('[role="menu"]') != null);
    const expectedResultStatus = input.initial.expectedResultStatus ?? "Returned result: 1 rows returned · exact result";
    if (!dashboard.container.textContent?.includes(expectedResultStatus)) {
      throw new Error("Controlled UI fixture did not expose returned-result extent status.");
    }

    dashboard.rerender(input.edited);
    const editedCount = input.edited.bundle.bundle.queries.length;
    await waitForDom(dashboard.container, () => dashboard.client.requests().length === initialCount + editedCount);
    for (let index = 0; index < editedCount; index += 1) {
      const requestIndex = initialCount + index;
      const request = dashboard.client.requests()[requestIndex];
      assertDispatchedLocator(input.edited.bundle, input.edited.locators, request.locator);
      const value = input.edited.results.get(request.locator.queryId);
      if (value == null) throw new Error(`Controlled UI fixture has no edited result for ${request.locator.queryId}.`);
      dashboard.client.resolve(requestIndex, value);
    }
    await waitForDom(dashboard.container, (container) =>
      container.textContent?.includes(input.edited.visibleDatumText) === true &&
      container.querySelector('[role="menu"]') != null,
    );
    clickButton(dashboard.container, input.scope === "plotted" ? "Export plotted CSV" : "Export returned result CSV");
    await waitForDom(dashboard.container, () => recorder.downloads.length === 2);
    return await readDownloads(recorder);
  } finally {
    mounted?.unmount();
    recorder.restore();
  }
}

export async function exerciseCapturedExportFailureNoPartialDownload(
  input: ExerciseExecutionDashboardInput,
): Promise<readonly CapturedDownload[]> {
  const recorder = installDownloadRecorder();
  let mounted: MountedExecutionDashboard | null = null;
  try {
    const dashboard = await mountExecutionBackedDashboard(input);
    mounted = dashboard;
    await waitForDom(dashboard.container, () => dashboard.client.requests().length === input.bundle.bundle.queries.length);
    for (const [index, request] of dashboard.client.requests().entries()) {
      assertDispatchedLocator(input.bundle, input.locators, request.locator);
      const value = input.results.get(request.locator.queryId);
      if (value == null) throw new Error(`Controlled UI fixture has no failure result for ${request.locator.queryId}.`);
      dashboard.client.resolve(index, value);
    }
    await waitForDom(dashboard.container, (container) => container.textContent?.includes("Exact plotted data") === true);
    openChartData(dashboard.container);
    await waitForDom(dashboard.container, (container) => [...container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Actions"));
    clickButton(dashboard.container, "Actions");
    await waitForDom(dashboard.container, (container) => container.querySelector('[role="menu"]') != null);
    await waitForDom(dashboard.container, (container) => [...container.querySelectorAll('[role="note"]')]
      .some((note) => note.textContent?.includes("Captured") === true));
    const svgButton = [...dashboard.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.trim().startsWith("Export SVG + lineage") === true);
    if (svgButton == null || !svgButton.disabled) {
      throw new Error("Controlled UI fixture enabled SVG download after captured artifact creation failed.");
    }
    if (dashboard.container.querySelectorAll("[download]").length !== 0) {
      throw new Error("Controlled UI fixture produced a partial download after captured export failure.");
    }
    return [...recorder.downloads];
  } finally {
    mounted?.unmount();
    recorder.restore();
  }
}

export type ExecutionDashboardRevision = Readonly<{
  bundle: AnalyticsBundleResponse;
  locators: ExecutionLocatorSource;
  rangeDays: number;
  results: ReadonlyMap<string, ControlledExecutionResult>;
  visibleDatumText: string;
}>;

/**
 * Controlled real-component supersession: the first dashboard remains visible
 * while the next execution is pending, then the newer result is resolved
 * before the stale result. The stale completion must not overwrite the DOM.
 */
export async function exerciseSupersessionAndRetention(input: Readonly<{
  a: ExecutionDashboardRevision;
  b: ExecutionDashboardRevision;
  c: ExecutionDashboardRevision;
  client: ControlledExecutionClient;
}>): Promise<Readonly<{ duringPendingText: string; finalText: string }>> {
  const mounted = await mountExecutionBackedDashboard({
    bundle: input.a.bundle,
    locators: input.a.locators,
    rangeDays: input.a.rangeDays,
    client: input.client,
  });
  try {
    const aCount = input.a.bundle.bundle.queries.length;
    await waitForDom(mounted.container, () => mounted.client.requests().length === aCount);
    for (let index = 0; index < aCount; index += 1) {
      const request = mounted.client.requests()[index];
      assertDispatchedLocator(input.a.bundle, input.a.locators, request.locator);
      const result = input.a.results.get(request.locator.queryId);
      if (result == null) throw new Error(`Controlled UI fixture has no A result for ${request.locator.queryId}.`);
      mounted.client.resolve(index, result);
    }
    await waitForDom(mounted.container, (container) => container.textContent?.includes("Exact plotted data") === true);
    openChartData(mounted.container);
    await waitForDom(mounted.container, (container) => container.textContent?.includes(input.a.visibleDatumText) === true);

    mounted.rerender(input.b);
    const bCount = input.b.bundle.bundle.queries.length;
    await waitForDom(mounted.container, () => mounted.client.requests().length === aCount + bCount);
    const duringBText = mounted.container.textContent ?? "";
    if (!duringBText.includes(input.a.visibleDatumText)) {
      throw new Error("Controlled UI fixture cleared A while B was pending.");
    }

    mounted.rerender(input.c);
    const cCount = input.c.bundle.bundle.queries.length;
    await waitForDom(mounted.container, () => mounted.client.requests().length === aCount + bCount + cCount);
    const duringPendingText = mounted.container.textContent ?? "";
    if (!duringPendingText.includes(input.a.visibleDatumText)) {
      throw new Error("Controlled UI fixture cleared A while B and C were pending.");
    }

    for (let index = 0; index < cCount; index += 1) {
      const request = mounted.client.requests()[aCount + bCount + index];
      assertDispatchedLocator(input.c.bundle, input.c.locators, request.locator);
      const result = input.c.results.get(request.locator.queryId);
      if (result == null) throw new Error(`Controlled UI fixture has no C result for ${request.locator.queryId}.`);
      mounted.client.resolve(aCount + bCount + index, result);
    }
    await yieldToReact();
    await waitForDom(mounted.container, (container) =>
      container.textContent?.includes(input.c.visibleDatumText) === true &&
      !container.textContent?.includes(input.b.visibleDatumText) &&
      mounted.client.requests().slice(aCount, aCount + bCount).every((request) =>
        request.signal?.aborted === true && request.abortObserved === true),
    );

    for (let index = 0; index < bCount; index += 1) {
      const request = mounted.client.requests()[aCount + index];
      assertDispatchedLocator(input.b.bundle, input.b.locators, request.locator);
      const result = input.b.results.get(request.locator.queryId);
      if (result == null) throw new Error(`Controlled UI fixture has no stale B result for ${request.locator.queryId}.`);
      mounted.client.resolve(aCount + index, result);
    }
    await yieldToReact();
    await waitForDom(mounted.container, (container) =>
      container.textContent?.includes(input.c.visibleDatumText) === true &&
      !container.textContent?.includes(input.b.visibleDatumText),
    );
    return { duringPendingText: `${duringBText}\n${duringPendingText}`, finalText: mounted.container.textContent ?? "" };
  } finally {
    mounted.unmount();
  }
}

/** Unmount observes caller abort and settles every controlled promise. */
export async function exerciseAbortAndUnmount(
  input: MountExecutionDashboardInput,
): Promise<Readonly<{ aborted: boolean; pendingAfterUnmount: number }>> {
  const mounted = await mountExecutionBackedDashboard(input);
  try {
    await waitForDom(mounted.container, () => mounted.client.requests().length === input.bundle.bundle.queries.length);
    for (const request of mounted.client.requests()) {
      assertDispatchedLocator(input.bundle, input.locators, request.locator);
    }
    const signals = mounted.client.requests().map((request) => request.signal);
    mounted.unmount();
    const aborted = signals.every((signal) => signal?.aborted === true);
    const pendingAfterUnmount = mounted.client.requests().filter((request) => !request.settled).length;
    if (!aborted) throw new Error("Controlled UI fixture did not abort caller signals during unmount.");
    if (pendingAfterUnmount !== 0) throw new Error("Controlled UI fixture retained an unresolved request after unmount.");
    return { aborted, pendingAfterUnmount };
  } finally {
    mounted.unmount();
  }
}

/** An AbortError from one query must abort and settle its still-pending sibling. */
export async function exerciseAbortErrorWithPendingSibling(
  input: MountExecutionDashboardInput,
): Promise<Readonly<{
  siblingSignalAborted: boolean;
  siblingAbortObserved: boolean;
  siblingListenerAttachedAfterUnmount: boolean;
  pendingAfterUnmount: number;
}>> {
  const mounted = await mountExecutionBackedDashboard(input);
  try {
    const queryCount = input.bundle.bundle.queries.length;
    if (queryCount < 2) throw new Error("Controlled UI fixture requires at least two queries for sibling cancellation.");
    await waitForDom(mounted.container, () => mounted.client.requests().length === queryCount);
    for (const request of mounted.client.requests()) {
      assertDispatchedLocator(input.bundle, input.locators, request.locator);
    }
    mounted.client.rejectAbort(0);
    await waitForDom(mounted.container, () => mounted.client.requests()[1]?.abortObserved === true);
    const sibling = mounted.client.requests()[1];
    if (sibling == null || sibling.signal?.aborted !== true || sibling.abortObserved !== true) {
      throw new Error("Controlled UI fixture did not abort the pending sibling after AbortError.");
    }
    mounted.unmount();
    const afterUnmount = mounted.client.requests()[1];
    const pendingAfterUnmount = mounted.client.requests().filter((request) => !request.settled).length;
    if (afterUnmount?.listenerAttached !== false || pendingAfterUnmount !== 0) {
      throw new Error("Controlled UI fixture did not settle the sibling listener/request on unmount.");
    }
    return {
      siblingSignalAborted: sibling.signal?.aborted === true,
      siblingAbortObserved: sibling.abortObserved,
      siblingListenerAttachedAfterUnmount: afterUnmount?.listenerAttached ?? false,
      pendingAfterUnmount,
    };
  } finally {
    mounted.unmount();
  }
}
