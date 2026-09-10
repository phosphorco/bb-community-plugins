import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

import type { AnalyticsBundle, AnalyticsVisualization } from "./bundle-contract.ts";
import {
  getBrowserAnalyticsEngine,
  type BrowserDashboardResult,
  type BrowserQueryResult,
} from "./browser-engine.ts";
import type { AnalyticsBundleResponse, AnalyticsCatalogResponse, rpcContract } from "./rpc-contract.ts";
import type { ExecutionDefinition, ExecutionLocator, ExecutionResult } from "./execution-contract.ts";
import { ChartPaintingAnimation } from "./chart-painting-animation.tsx";
import { EChartsFigure } from "./echarts-figure.tsx";
import { compileEChartsFigure, type AnalyticsCompiledFigure } from "./echarts-options.ts";
import { useAnalyticsChartEnvironment } from "./chart-environment.ts";
import {
  CAPTURED_SVG_DEFAULT_HEIGHT,
  CAPTURED_SVG_DEFAULT_WIDTH,
  createCapturedFigureExport,
  downloadDataUrl,
  downloadText,
  rowsToCsv,
  type CapturedFigureExport,
} from "./analytics-export.ts";
import { formatAnalyticsValue } from "./formatting.ts";
import { describeIndexStatus } from "./analytics-status.ts";
import {
  executionResultForRendering,
  parseAnalyticsExecutionLocator,
  parseAnalyticsExecutionQueryResponse,
  parseAnalyticsExecutionReferenceRequest,
  parseAnalyticsExecutionReferenceResponse,
  type AnalyticsExecutionClient,
  type AnalyticsExecutionQueryResult,
  type ChartIntent,
  type FigureRuntimeController,
  type InteractiveDatumMeta,
  type AnalyticsChartTheme,
  type QueryResultExtent,
} from "./analytics-model.ts";
import "./app.css";

type LegacyAnalyticsDashboard = AnalyticsBundleResponse & BrowserDashboardResult & Readonly<{
  kind: "legacy";
}>;
type ExecutionAnalyticsDashboard = AnalyticsBundleResponse & Readonly<{
  kind: "execution";
  results: readonly QueryResult[];
  executionResults: readonly AnalyticsExecutionQueryResult[];
  captures: readonly ExecutionCapture[];
  captureMode: "shared" | "separate";
  queryMs: number;
  generationId: null;
  asOf: number | null;
  rangeDays: number | null;
}>;
type AnalyticsDashboard = LegacyAnalyticsDashboard | ExecutionAnalyticsDashboard;
type QueryResult = BrowserQueryResult;
type QueryRow = QueryResult["rows"][number];

type ExecutionCapture = Readonly<{
  queryId: ExecutionResult["resolved"]["query"]["id"];
  version: ExecutionResult["resolved"]["snapshot"]["version"];
  scopeKey: ExecutionResult["resolved"]["snapshot"]["sourceScope"]["scopeKey"];
  snapshotId: ExecutionResult["resolved"]["snapshot"]["snapshotId"];
  frozenRange: ExecutionResult["resolved"]["snapshot"]["frozenRange"];
  projectionGeneration: ExecutionResult["resolved"]["snapshot"]["coverage"]["observed"]["projectionGeneration"];
  capturedAtMs: ExecutionResult["resolved"]["snapshot"]["capturedAtMs"];
  coverage: ExecutionResult["coverage"];
  rangeDays: number;
}>;

const RANGE_OPTIONS = [
  { value: 1, label: "24 hours" },
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

function AnalyticsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [catalog, setCatalog] = useState<AnalyticsCatalogResponse | null>(null);
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [bundleId, setBundleId] = useState("tool-reliability");
  const [rangeDays, setRangeDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  const loadCatalog = useCallback(async () => {
    const next = await rpc.call("catalog");
    setCatalog(next);
    setBundleId((current) => next.bundles.some((bundle) => bundle.id === current)
      ? current
      : next.bundles[0]?.id ?? "tool-reliability");
    return next;
  }, [rpc]);

  const loadDashboard = useCallback(async (
    selectedBundleId = bundleId,
    selectedRangeDays = rangeDays,
    selectedIndex = catalog?.index,
  ) => {
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(null);
    try {
      const selected = await rpc.call("getBundle", { bundleId: selectedBundleId });
      const engine = await getBrowserAnalyticsEngine();
      const result = await engine.loadAndRun(selected.bundle, selectedRangeDays, {
        generationId: selectedIndex?.generationId ?? null,
        asOf: indexAsOf(selectedIndex),
        signal: controller.signal,
      });
      if (sequence === requestSequence.current) setDashboard({ kind: "legacy", ...selected, ...result });
    } catch (cause) {
      if (sequence === requestSequence.current && !isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "Analytics could not run this dashboard.");
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
      if (requestController.current === controller) requestController.current = null;
    }
  }, [bundleId, catalog, rangeDays, rpc]);

  useEffect(() => {
    // Analytics was explicitly opened, so overlap lazy worker startup with
    // catalog loading while every other BB surface remains idle.
    void getBrowserAnalyticsEngine().catch(() => {
      // loadDashboard owns the user-visible retry/error state.
    });
    void loadCatalog()
      .then((next) => loadDashboard(next.bundles[0]?.id ?? bundleId, rangeDays, next.index))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Analytics could not load.");
        setLoading(false);
      });
  }, [loadCatalog]);

  useRealtime("analytics-index-changed", useCallback(() => {
    void loadCatalog().then((next) => {
      setRefreshing(next.index.status === "indexing");
      if (next.index.status === "ready") void loadDashboard(bundleId, rangeDays, next.index);
    }).catch((cause) => {
      setRefreshing(false);
      setError(cause instanceof Error ? cause.message : "Analytics could not refresh its catalog.");
    });
  }, [loadCatalog, loadDashboard]));

  useRealtime("analytics-bundles-changed", useCallback(() => {
    void loadCatalog().then((next) => {
      const nextBundleId = next.bundles.some((bundle) => bundle.id === bundleId)
        ? bundleId
        : next.bundles[0]?.id ?? "tool-reliability";
      if (nextBundleId !== bundleId) setBundleId(nextBundleId);
      void loadDashboard(nextBundleId, rangeDays, next.index);
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Analytics could not reload its dashboards.");
    });
  }, [bundleId, loadCatalog, loadDashboard, rangeDays]));

  useEffect(() => {
    if (connection === "connected") return;
    setRefreshing(false);
  }, [connection]);

  useEffect(() => () => requestController.current?.abort(), []);

  const selectBundle = (nextId: string) => {
    setBundleId(nextId);
    void loadDashboard(nextId, rangeDays, catalog?.index);
  };

  const selectRange = (nextRange: number) => {
    setRangeDays(nextRange);
    void loadDashboard(bundleId, nextRange, catalog?.index);
  };

  const refreshIndex = async () => {
    if (refreshing || index?.status === "indexing") return;
    setRefreshing(true);
    try {
      const index = await rpc.call("requestRefresh");
      setCatalog((current) => current == null ? current : { ...current, index });
    } catch (cause) {
      setRefreshing(false);
      setError(cause instanceof Error ? cause.message : "Could not request a refresh.");
    }
  };

  const shownDashboard = dashboard?.bundle.id === bundleId ? dashboard : null;
  const index = catalog?.index ?? null;
  const indexRefreshing = refreshing || index?.status === "indexing";
  const coldState = index != null
    && index.generationId === 0
    && index.snapshotUpdatedAt == null
    && (index.status === "empty" || index.status === "indexing");

  return (
    <main className="analytics-shell">
      <div className="analytics-toolbar">
        <label className="analytics-field">
          <span>Dashboard</span>
          <select value={bundleId} onChange={(event) => selectBundle(event.target.value)}>
            {(catalog?.bundles ?? []).map((bundle) => (
              <option key={bundle.id} value={bundle.id}>{bundle.title}{bundle.builtin ? "" : " · authored"}</option>
            ))}
          </select>
        </label>
        <label className="analytics-field">
          <span>Range</span>
          <select value={rangeDays} onChange={(event) => selectRange(Number(event.target.value))}>
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="analytics-refresh"
          disabled={indexRefreshing}
          aria-busy={indexRefreshing}
          onClick={() => void refreshIndex()}
        >
          <RefreshIcon spinning={indexRefreshing} />
          <span>Refresh</span>
        </button>
      </div>

      <IndexStatus index={index} connection={connection} refreshing={indexRefreshing} />

      {error != null && shownDashboard == null ? (
        <EmptyState title="Analytics could not load" detail={error} action={() => void loadDashboard(bundleId, rangeDays, index ?? undefined)} />
      ) : coldState ? (
        index?.status === "indexing" ? (
          <LoadingState
            title="Painting your first dashboard…"
            detail="Building the bounded capability snapshot."
          />
        ) : (
          <EmptyState
            title="No capability snapshot yet"
            detail="Analytics is waiting for its first bounded snapshot."
            action={() => void refreshIndex()}
          />
        )
      ) : shownDashboard == null ? (
        <LoadingState title="Painting your dashboard…" detail="Opening the bounded capability snapshot." />
      ) : (
        <>
          {error != null && (
            <div className="analytics-dashboard-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void loadDashboard(bundleId, rangeDays, index ?? undefined)}>Try again</button>
            </div>
          )}
          <Dashboard dashboard={shownDashboard} loading={loading} refreshing={indexRefreshing} />
        </>
      )}
    </main>
  );
}

export type ExecutionLocatorSource =
  | ReadonlyMap<string, ExecutionLocator>
  | Readonly<Record<string, ExecutionLocator>>;

export type ExecutionBackedDashboardProps = Readonly<{
  bundle: AnalyticsBundleResponse;
  client: AnalyticsExecutionClient;
  locators: ExecutionLocatorSource;
  rangeDays: number;
}>;

export type ExecutionDashboardState = Readonly<{
  dashboard: AnalyticsDashboard | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}>;

function isExecutionLocatorMap(source: ExecutionLocatorSource): source is ReadonlyMap<string, ExecutionLocator> {
  return "get" in source && typeof source.get === "function";
}

function locatorFor(source: ExecutionLocatorSource, queryId: string): ExecutionLocator | null {
  if (isExecutionLocatorMap(source)) return source.get(queryId) ?? null;
  if (!Object.prototype.hasOwnProperty.call(source, queryId)) return null;
  return source[queryId] ?? null;
}

function rangeDaysFor(range: ExecutionLocator["range"]): number {
  return Math.max(1, Math.ceil(
    (range.endExclusiveMs - range.startInclusiveMs) / (24 * 60 * 60 * 1_000),
  ));
}

function executionCaptureFor(execution: ExecutionResult): ExecutionCapture {
  const snapshot = execution.resolved.snapshot;
  return {
    queryId: execution.resolved.query.id,
    version: snapshot.version,
    scopeKey: snapshot.sourceScope.scopeKey,
    snapshotId: snapshot.snapshotId,
    frozenRange: snapshot.frozenRange,
    projectionGeneration: snapshot.coverage.observed.projectionGeneration,
    capturedAtMs: snapshot.capturedAtMs,
    coverage: execution.coverage,
    rangeDays: rangeDaysFor(snapshot.frozenRange),
  };
}

function executionCaptureIdentity(capture: ExecutionCapture): string {
  return JSON.stringify([
    capture.version,
    capture.scopeKey,
    capture.frozenRange.startInclusiveMs,
    capture.frozenRange.endExclusiveMs,
    capture.projectionGeneration,
    capture.coverage.coverageRevision,
    capture.coverage.observed.projectionRevision,
    capture.snapshotId,
    capture.capturedAtMs,
  ]);
}

function prepareExecutionQueries(
  bundle: AnalyticsBundleResponse,
  locators: ExecutionLocatorSource,
): readonly ExecutionLocator[] {
  let selectedRange: ExecutionLocator["range"] | null = null;
  return bundle.bundle.queries.map((query) => {
    const suppliedLocator = locatorFor(locators, query.id);
    if (suppliedLocator == null) throw new Error(`No execution locator was supplied for query ${query.id}.`);
    const locator = parseAnalyticsExecutionLocator(suppliedLocator, {
      bundleId: bundle.bundle.id,
      queryId: query.id,
    });
    if (
      selectedRange != null &&
      (locator.range.startInclusiveMs !== selectedRange.startInclusiveMs ||
        locator.range.endExclusiveMs !== selectedRange.endExclusiveMs)
    ) {
      throw new Error("Execution locators must share one selected frozen range before dispatch.");
    }
    selectedRange = locator.range;
    return locator;
  });
}

function executionDashboard(
  bundle: AnalyticsBundleResponse,
  results: readonly AnalyticsExecutionQueryResult[],
): ExecutionAnalyticsDashboard {
  const captures = results.map((entry) => executionCaptureFor(entry.execution));
  const captureIdentity = captures[0] == null ? null : executionCaptureIdentity(captures[0]);
  const sharedCapture = captureIdentity != null && captures.every((capture) => executionCaptureIdentity(capture) === captureIdentity);
  return {
    kind: "execution",
    ...bundle,
    captures,
    captureMode: sharedCapture ? "shared" : "separate",
    results: results.map((entry) => entry.result),
    executionResults: results,
    queryMs: results.reduce((total, entry) => total + entry.execution.elapsedMs, 0),
    generationId: null,
    asOf: sharedCapture ? captures[0]?.capturedAtMs ?? null : null,
    rangeDays: sharedCapture ? captures[0]?.rangeDays ?? null : null,
  };
}

export function useExecutionDashboard({
  bundle,
  client,
  locators,
}: ExecutionBackedDashboardProps): ExecutionDashboardState {
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(null);
    let prepared: readonly ExecutionLocator[];
    try {
      prepared = prepareExecutionQueries(bundle, locators);
    } catch (cause) {
      controller.abort();
      if (sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "Analytics execution locators could not be prepared.");
        setLoading(false);
      }
      if (requestController.current === controller) requestController.current = null;
      return;
    }
    void Promise.all(prepared.map(async (locator) => {
      const response = parseAnalyticsExecutionQueryResponse(
        await client.executeQuery(locator, { signal: controller.signal }),
        locator,
      );
      if (response.kind === "error") {
        throw new Error(`${response.error.code}: ${response.error.message}`);
      }
      return executionResultForRendering(response.result, response.definition);
    })).then((results) => {
      if (sequence === requestSequence.current) setDashboard(executionDashboard(bundle, results));
    }).catch((cause) => {
      controller.abort();
      if (sequence === requestSequence.current && !isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "Analytics execution could not load this dashboard.");
      }
    }).finally(() => {
      if (sequence === requestSequence.current) setLoading(false);
      if (requestController.current === controller) requestController.current = null;
    });
  }, [bundle, client, locators]);

  useEffect(() => {
    reload();
    return () => {
      requestSequence.current += 1;
      requestController.current?.abort();
      requestController.current = null;
    };
  }, [reload]);

  return { dashboard, loading, error, reload };
}

/**
 * Additive execution-backed consumer. It is not registered as the default
 * app entry: composition supplies an ordinary client and locator map later.
 * Rendering and menu ownership remain in the existing Dashboard tree.
 */
export function ExecutionBackedDashboard(props: ExecutionBackedDashboardProps) {
  const state = useExecutionDashboard(props);
  if (state.dashboard == null) {
    return state.error == null
      ? <LoadingState title="Painting your dashboard…" detail="Opening the bounded execution results." />
      : <EmptyState title="Analytics could not load" detail={state.error} action={state.reload} />;
  }
  return (
    <>
      {state.error != null && (
        <div className="analytics-dashboard-error" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={state.reload}>Try again</button>
        </div>
      )}
      <Dashboard dashboard={state.dashboard} loading={state.loading} refreshing={false} executionClient={props.client} />
    </>
  );
}

const Dashboard = memo(function Dashboard({ dashboard, loading, refreshing, executionClient }: {
  dashboard: AnalyticsDashboard;
  loading: boolean;
  refreshing: boolean;
  executionClient?: AnalyticsExecutionClient;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const chartEnvironment = useAnalyticsChartEnvironment();
  const [figureMenu, setFigureMenu] = useState<FigureMenuState | null>(null);
  const resultsById = useMemo(
    () => new Map(dashboard.results.map((result) => [result.id, result])),
    [dashboard.results],
  );
  const visualizationsById = useMemo(
    () => new Map(dashboard.bundle.visualizations.map((visualization) => [visualization.id, visualization])),
    [dashboard.bundle.visualizations],
  );
  const queriesById = useMemo(
    () => new Map(dashboard.bundle.queries.map((query) => [query.id, query])),
    [dashboard.bundle.queries],
  );
  const executionBacked = dashboard.kind === "execution";

  const createReference = useCallback(async (state: FigureMenuState) => {
    if (state.execution != null) {
      if (executionClient == null) throw new Error("Execution reference client is unavailable.");
      const capturedFigure = state.definition?.figures.find(
        (figure) => figure.visualization.id === state.visualization.id,
      );
      if (
        state.definition == null ||
        capturedFigure == null ||
        capturedFigure.visualization.id !== state.visualization.id
      ) {
        throw new Error("The captured execution definition is not available for this figure.");
      }
      const request = parseAnalyticsExecutionReferenceRequest({
        executionId: state.execution.executionId,
        visualizationId: state.visualization.id,
        ...(state.datum == null ? {} : { targetDatumKey: state.datum.datumKey }),
      });
      if (
        request.targetDatumKey != null &&
        !state.execution.result.datumKeys.includes(request.targetDatumKey)
      ) {
        throw new Error("The selected datum is not part of the captured execution.");
      }
      return parseAnalyticsExecutionReferenceResponse(
        await executionClient.createExecutionReference(request),
      );
    }
    if (dashboard.kind !== "legacy") {
      throw new Error("Legacy reference lineage is unavailable for an execution-backed dashboard.");
    }
    return rpc.call("createReference", {
      bundleId: dashboard.bundle.id,
      queryId: state.visualization.queryId,
      visualizationId: state.visualization.id,
      resultGeneration: state.result.generation,
      snapshotGenerationId: dashboard.generationId,
      snapshotUpdatedAt: dashboard.asOf,
      rangeDays: dashboard.rangeDays,
      coverage: state.result.extent,
      selection: state.datum == null ? null : {
        datumKey: state.datum.datumKey,
        label: state.datum.label,
        row: {
          [state.visualization.x]: state.datum.row[state.visualization.x] ?? null,
          [state.visualization.y]: state.datum.row[state.visualization.y] ?? null,
        },
        predicate: state.datum.predicate,
      },
    });
  }, [dashboard, executionClient, rpc]);

  const menuLineage: FigureLineage | null = figureMenu == null
    ? null
    : dashboard.kind === "legacy"
      ? {
          kind: "legacy",
          bundleId: dashboard.bundle.id,
          snapshotGenerationId: dashboard.generationId,
          snapshotUpdatedAt: dashboard.asOf,
          rangeDays: dashboard.rangeDays,
        }
      : figureMenu.execution == null
        ? null
        : {
            kind: "execution",
            bundleId: figureMenu.execution.resolved.bundleId,
            executionId: figureMenu.execution.executionId,
            snapshotId: figureMenu.execution.resolved.snapshot.snapshotId,
            frozenRange: figureMenu.execution.resolved.snapshot.frozenRange,
            capturedAtMs: figureMenu.execution.resolved.snapshot.capturedAtMs,
            queryId: figureMenu.query.id,
            querySql: figureMenu.query.sql,
            visualizationId: figureMenu.visualization.id,
            resultGeneration: figureMenu.result.generation,
            coverage: figureMenu.result.extent,
            plottedRows: figureMenu.figure.plottedCount,
          };

  return (
    <div className="analytics-dashboard" aria-busy={loading}>
      <span ref={chartEnvironment.probeRef} className="analytics-echart-theme-probe" aria-hidden="true" />
      <header className="analytics-dashboard-heading">
        <div>
          <div className="analytics-title-line">
            <h1>{dashboard.bundle.title}</h1>
            {!dashboard.builtin && <span>Authored bundle</span>}
          </div>
          <p>{dashboard.bundle.description}</p>
        </div>
        <div className="analytics-dashboard-meta">
          <span>{loading || refreshing ? `Refreshing dashboard · ${formatAsOf(dashboard.asOf)}` : formatAsOf(dashboard.asOf)}</span>
          <span
            className="analytics-query-health"
            title={executionBacked ? "Total time reported by the bounded execution results" : "Total worker time across this bundle's bounded DuckDB queries"}
          >
            {dashboard.queryMs.toLocaleString()} ms query time
          </span>
        </div>
      </header>

      <div className="analytics-grid">
        {dashboard.bundle.layout.map((item) => {
          const visualization = visualizationsById.get(item.visualizationId);
          if (visualization == null) return null;
          const executionEntry = dashboard.kind === "execution"
            ? dashboard.executionResults.find((entry) => entry.result.id === visualization.queryId) ?? null
            : null;
          if (dashboard.kind === "execution" && executionEntry == null) {
            return (
              <section key={visualization.id} className="analytics-card" data-width={item.width}>
                <p className="analytics-card-empty">The captured execution does not include the selected dashboard query.</p>
              </section>
            );
          }
          const capturedFigure = executionEntry?.definition.figures.find(
            (figure) => figure.visualization.id === visualization.id,
          ) ?? null;
          return (
            <VisualizationCard
              key={visualization.id}
              visualization={visualization}
              result={executionEntry?.result ?? resultsById.get(visualization.queryId) ?? null}
              execution={executionEntry?.execution ?? null}
              definition={executionEntry?.definition ?? null}
              capturedFigure={capturedFigure}
              query={executionEntry?.definition.query ?? queriesById.get(visualization.queryId) ?? null}
              width={item.width}
              chartTheme={chartEnvironment.theme}
              reducedMotion={chartEnvironment.reducedMotion}
              onOpenMenu={setFigureMenu}
            />
          );
        })}
      </div>

      <details className="analytics-diagnostics">
        <summary>Bundle and query diagnostics</summary>
        <div>
          <span>Loader: {dashboard.bundle.loader.label}</span>
          <span>{dashboard.bundle.queries.length} queries</span>
          <span>{dashboard.bundle.visualizations.length} visualizations</span>
          {dashboard.kind === "execution" ? (
            <>
              <span>Execution-backed results retain server-owned snapshot, coverage, and datum identity.</span>
              {dashboard.captureMode === "shared" ? (
                <span>Queries share one captured snapshot identity and as-of.</span>
              ) : (
                <span>Queries were captured separately; each query retains its own as-of, range, and coverage.</span>
              )}
              {dashboard.captures.map((capture) => (
                <span key={capture.queryId}>
                  {capture.queryId}: {formatAsOf(capture.capturedAtMs)} · {formatExecutionRange(capture.frozenRange)} · coverage {capture.coverage.mode}
                </span>
              ))}
            </>
          ) : (
            <>
              <span>DuckDB startup: {dashboard.startupMs.toLocaleString()} ms</span>
              <span>Fact load: {dashboard.loadMs.toLocaleString()} ms · {formatBytes(dashboard.factBytes)}{dashboard.materializationCached ? " · reused" : ""}</span>
            </>
          )}
          {dashboard.results.map((result) => (
            <span key={result.id}>{result.id}: {result.cached ? "reused" : `${result.elapsedMs.toLocaleString()} ms`}{result.truncated ? " · capped" : ""}</span>
          ))}
        </div>
      </details>
      {figureMenu != null && menuLineage == null && (
        <p className="analytics-dashboard-error" role="alert">
          The captured menu lineage is unavailable for this dashboard.
        </p>
      )}
      {figureMenu != null && menuLineage != null && (
        <FigureContextMenu
          state={figureMenu}
          lineage={menuLineage}
          onClose={() => setFigureMenu(null)}
          onCopyReference={async () => {
            const reference = await createReference(figureMenu);
            await navigator.clipboard.writeText(reference.token);
            return `Copied ${reference.token}`;
          }}
          onAddToChat={async () => {
            const reference = await createReference(figureMenu);
            composer.insertMention({
              provider: "analytics-reference",
              id: reference.id,
              label: `Analytics: ${reference.label}`,
            });
            composer.focus();
            setFigureMenu(null);
          }}
        />
      )}
    </div>
  );
});

type CapturedVisualization = ExecutionDefinition["figures"][number]["visualization"];

function isRenderableCapturedVisualization(
  value: CapturedVisualization,
): value is CapturedVisualization & AnalyticsVisualization {
  return value.kind === "table" || value.format !== "text";
}

function renderableCapturedVisualization(value: CapturedVisualization): AnalyticsVisualization | null {
  return isRenderableCapturedVisualization(value) ? value : null;
}

const VisualizationCard = memo(function VisualizationCard({
  visualization,
  result,
  execution,
  definition,
  capturedFigure,
  query,
  width,
  chartTheme,
  reducedMotion,
  onOpenMenu,
}: {
  visualization: AnalyticsVisualization;
  result: QueryResult | null;
  execution: ExecutionResult | null;
  definition: ExecutionDefinition | null;
  capturedFigure: ExecutionDefinition["figures"][number] | null;
  query: AnalyticsBundle["queries"][number] | null;
  width: "third" | "half" | "full";
  chartTheme: ReturnType<typeof useAnalyticsChartEnvironment>["theme"];
  reducedMotion: boolean;
  onOpenMenu: (menu: FigureMenuState) => void;
}) {
  const rows = result?.rows ?? [];
  const capturedVisualization = execution == null || capturedFigure == null
    ? null
    : renderableCapturedVisualization(capturedFigure.visualization);
  const activeVisualization = execution == null ? visualization : capturedVisualization;
  const activeQuery = execution == null ? query : definition?.query ?? null;
  const captureError = execution == null || (definition != null && capturedFigure != null && capturedVisualization != null && activeQuery != null)
    ? null
    : capturedFigure != null && capturedVisualization == null
      ? "The captured figure visualization format is unsupported by this renderer."
      : "The captured execution definition does not include this dashboard figure.";
  const chartVisualization = activeVisualization?.kind === "bar" || activeVisualization?.kind === "line"
    ? activeVisualization
    : null;
  const compilation = useMemo(() => {
    if (captureError != null) return { figure: null, error: captureError };
    if (result == null || activeVisualization == null) return { figure: null, error: null };
    try {
      const figure = chartVisualization == null
        ? null
        : compileEChartsFigure(chartVisualization, result, chartTheme, reducedMotion);
      if (execution != null && capturedFigure != null) {
        const actualTotal = figure?.total ?? result.extent;
        if (JSON.stringify(capturedFigure.plotted.total) !== JSON.stringify(actualTotal)) {
          throw new Error("Captured figure total does not match the canonical result extent.");
        }
        if (capturedFigure.plotted.reduction !== "none") {
          throw new Error(`Captured figure reduction ${capturedFigure.plotted.reduction} is not supported by this renderer.`);
        }
        const actualPlottedRows = figure?.plottedCount ?? result.rows.length;
        if (capturedFigure.plotted.plottedRows !== actualPlottedRows || actualPlottedRows !== result.rows.length) {
          throw new Error("Captured figure plotted rows do not match the compiled figure.");
        }
      }
      return { figure, error: null };
    } catch (cause) {
      return { figure: null, error: cause instanceof Error ? cause.message : "This result cannot be plotted." };
    }
  },
  [activeVisualization, captureError, capturedFigure, chartTheme, chartVisualization, execution, reducedMotion, result]);
  const figure = compilation.figure;
  const controller = useRef<FigureRuntimeController | null>(null);
  const openMenu = useCallback((intent: ChartIntent, restoreTo?: HTMLElement | null) => {
    if (figure == null || result == null || activeQuery == null || activeVisualization == null) return;
    let capturedExport: CapturedFigureExport | null = null;
    let capturedExportError: string | null = null;
    if (execution != null && definition != null) {
      try {
        capturedExport = createCapturedFigureExport({ execution, definition, result, figure });
      } catch (cause) {
        capturedExportError = cause instanceof Error
          ? cause.message
          : "The captured figure cannot be exported.";
      }
    }
    onOpenMenu({
      figure,
      result,
      chartTheme: Object.freeze({ ...chartTheme }),
      visualization: figure.visualization,
      query: activeQuery,
      datum: intent.target.kind === "datum" ? intent.target.datum : null,
      execution,
      definition: execution == null ? null : definition,
      capturedExport,
      capturedExportError,
      clientX: intent.clientX,
      clientY: intent.clientY,
      controller: controller.current,
      restoreTo: restoreTo ?? null,
    });
  }, [activeQuery, activeVisualization, chartTheme, definition, execution, figure, onOpenMenu, result]);
  return (
    <section className="analytics-card" data-width={width}>
      {activeVisualization == null || activeQuery == null ? (
        <p className="analytics-card-empty">{captureError ?? "This captured figure is unavailable."}</p>
      ) : activeVisualization.kind === "metric" ? (
        <Metric visualization={activeVisualization} row={rows[0] ?? null} />
      ) : (
        <>
          <header>
            <h2>{activeVisualization.title}</h2>
            <div className="analytics-card-heading-actions">
              {figure != null && result != null && activeQuery != null && (
                <button
                  type="button"
                  aria-label={`Actions for ${activeVisualization.title}`}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    openMenu({
                      kind: "open-context-menu",
                      figureId: activeVisualization.id,
                      clientX: bounds.right,
                      clientY: bounds.bottom,
                      target: { kind: "figure" },
                      source: "keyboard",
                    }, event.currentTarget);
                  }}
                >•••</button>
              )}
              {result != null && <span>{result.cached ? "reused" : `${result.elapsedMs.toLocaleString()} ms`}</span>}
            </div>
          </header>
          {compilation.error != null ? (
            <p className="analytics-card-empty">{compilation.error}</p>
          ) : rows.length === 0 ? (
            <p className="analytics-card-empty">No matching activity in this range.</p>
          ) : activeVisualization.kind === "table" ? (
            result != null && <ResultTable visualization={activeVisualization} result={result} />
          ) : (
            figure != null && (
              <>
                <EChartsFigure figure={figure} onIntent={openMenu} onController={(next) => { controller.current = next; }} />
                <ChartDataDisclosure figure={figure} onOpenMenu={openMenu} />
              </>
            )
          )}
        </>
      )}
    </section>
  );
});

function Metric({ visualization, row }: {
  visualization: Extract<AnalyticsVisualization, { kind: "metric" }>;
  row: QueryRow | null;
}) {
  return (
    <div className="analytics-metric">
      <span>{visualization.title}</span>
      <strong>{formatAnalyticsValue(row?.[visualization.value] ?? null, visualization.format)}</strong>
      {visualization.detail != null && <small>{String(row?.[visualization.detail] ?? "")}</small>}
    </div>
  );
}

function ResultTable({
  visualization,
  result,
}: {
  visualization: Extract<AnalyticsVisualization, { kind: "table" }>;
  result: QueryResult;
}) {
  if (visualization.id === "native-command-outcomes-table") {
    return <CommandOutcomesTable result={result} />;
  }
  return (
    <div className="analytics-table-scroll">
      <table>
        <thead>
          <tr>{visualization.columns.map((column) => <th key={column.field} scope="col">{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={result.datumKeys[index]}>
              {visualization.columns.map((column) => (
                <td key={column.field}>{formatAnalyticsValue(row[column.field] ?? null, column.format)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CommandInvestigationLevel = "binary" | "argument-1" | "signature";
type CommandInvestigationSlice = "all" | "eligible" | "help" | "observed-not-attributed" | "shell-wrapped" | "composite";
type CommandInvestigationSort = "calls" | "eligible" | "attributed" | "rate" | "help" | "observed" | "notAttributed";

type CommandInvestigationRow = Readonly<{
  key: string;
  label: string;
  calls: number;
  eligible: number;
  attributed: number;
  help: number;
  observed: number;
  notAttributed: number;
  shellWrapped: number;
  composite: number;
}>;

const COMMAND_LEVEL_LABELS: Readonly<Record<CommandInvestigationLevel, string>> = {
  binary: "Binary",
  "argument-1": "Binary + argument 1",
  signature: "Full safe signature",
};

const COMMAND_SLICE_LABELS: Readonly<Record<CommandInvestigationSlice, string>> = {
  all: "All executions",
  eligible: "Eligible direct",
  help: "Contains --help",
  "observed-not-attributed": "Observed, not attributed",
  "shell-wrapped": "Shell wrapped",
  composite: "Composite or unparsed",
};

const COMMAND_SORT_LABELS: Readonly<Record<CommandInvestigationSort, string>> = {
  calls: "Calls",
  eligible: "Eligible direct",
  attributed: "Attributed failures",
  rate: "Attributed rate",
  help: "Help",
  observed: "Observed failed/nonzero",
  notAttributed: "Observed, not attributed",
};

function CommandOutcomesTable({ result }: { result: QueryResult }) {
  const [level, setLevel] = useState<CommandInvestigationLevel>("signature");
  const [slice, setSlice] = useState<CommandInvestigationSlice>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CommandInvestigationSort>("calls");
  const [direction, setDirection] = useState<"ascending" | "descending">("descending");
  const rows = useMemo(() => commandInvestigationRows(result.rows, level), [level, result.rows]);
  const displayedRows = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return rows
      .filter((row) => {
        if (normalizedSearch !== "" && !row.label.toLocaleLowerCase().includes(normalizedSearch)) return false;
        if (slice === "eligible") return row.eligible > 0;
        if (slice === "help") return row.help > 0;
        if (slice === "observed-not-attributed") return row.notAttributed > 0;
        if (slice === "shell-wrapped") return row.shellWrapped > 0;
        if (slice === "composite") return row.composite > 0;
        return true;
      })
      .toSorted((left, right) => {
        const order = direction === "descending" ? -1 : 1;
        const delta = commandSortValue(left, sort) - commandSortValue(right, sort);
        return delta === 0 ? left.label.localeCompare(right.label) : order * delta;
      });
  }, [direction, rows, search, slice, sort]);
  const setSortColumn = useCallback((next: CommandInvestigationSort) => {
    if (next === sort) setDirection((current) => current === "descending" ? "ascending" : "descending");
    else {
      setSort(next);
      setDirection("descending");
    }
  }, [sort]);
  const reset = useCallback(() => {
    setLevel("signature");
    setSlice("all");
    setSearch("");
    setSort("calls");
    setDirection("descending");
  }, []);
  const resultScope = result.extent.kind === "exact"
    ? `${result.extent.rows.toLocaleString()} signature rows`
    : `the first ${result.rows.length.toLocaleString()} of at least ${result.extent.rows.toLocaleString()} signature rows`;

  return (
    <div className="analytics-command-investigation">
      <p className="analytics-command-investigation__description">
        Frequency-first investigation index. Attributed rates use only eligible, direct executions; composite, wrapped, help, and unparsed failures are observed but not attributed to the displayed first segment.
      </p>
      <div className="analytics-command-investigation__controls">
        <label>
          <span>Group by</span>
          <select value={level} onChange={(event) => setLevel(event.target.value as CommandInvestigationLevel)}>
            {Object.entries(COMMAND_LEVEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Slice</span>
          <select value={slice} onChange={(event) => setSlice(event.target.value as CommandInvestigationSlice)}>
            {Object.entries(COMMAND_SLICE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="analytics-command-investigation__search">
          <span>Find binary or safe argument</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="e.g. rg or --help" />
        </label>
        <button type="button" onClick={reset}>Reset</button>
      </div>
      <div className="analytics-table-scroll">
        <table>
          <caption>Showing {displayedRows.length.toLocaleString()} grouped rows from {resultScope}; source ranking is Calls descending.</caption>
          <thead>
            <tr>
              <th scope="col">{COMMAND_LEVEL_LABELS[level]}</th>
              <CommandSortHeader column="calls" active={sort} direction={direction} onSort={setSortColumn} />
              <CommandSortHeader column="eligible" active={sort} direction={direction} onSort={setSortColumn} />
              <CommandSortHeader column="attributed" active={sort} direction={direction} onSort={setSortColumn} />
              <CommandSortHeader column="rate" active={sort} direction={direction} onSort={setSortColumn} />
              <CommandSortHeader column="help" active={sort} direction={direction} onSort={setSortColumn} />
              <CommandSortHeader column="observed" active={sort} direction={direction} onSort={setSortColumn} />
              <CommandSortHeader column="notAttributed" active={sort} direction={direction} onSort={setSortColumn} />
              <th scope="col">Context</th>
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{formatAnalyticsValue(row.calls, "integer")}</td>
                <td>{formatAnalyticsValue(row.eligible, "integer")}</td>
                <td>{row.eligible === 0 ? "—" : `${formatAnalyticsValue(row.attributed, "integer")} / ${formatAnalyticsValue(row.eligible, "integer")}`}</td>
                <td>{row.eligible === 0 ? "—" : formatAnalyticsValue(100 * row.attributed / row.eligible, "percent")}</td>
                <td>{formatAnalyticsValue(row.help, "integer")}</td>
                <td>{formatAnalyticsValue(row.observed, "integer")}</td>
                <td>{formatAnalyticsValue(row.notAttributed, "integer")}</td>
                <td>{commandContext(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CommandSortHeader({
  column,
  active,
  direction,
  onSort,
}: {
  column: CommandInvestigationSort;
  active: CommandInvestigationSort;
  direction: "ascending" | "descending";
  onSort: (column: CommandInvestigationSort) => void;
}) {
  const isActive = column === active;
  return (
    <th scope="col" aria-sort={isActive ? direction : "none"}>
      <button type="button" onClick={() => onSort(column)}>
        {COMMAND_SORT_LABELS[column]}{isActive ? direction === "descending" ? " ↓" : " ↑" : ""}
      </button>
    </th>
  );
}

function commandInvestigationRows(source: readonly QueryRow[], level: CommandInvestigationLevel): CommandInvestigationRow[] {
  const groups = new Map<string, CommandInvestigationRow>();
  for (const row of source) {
    const binary = commandText(row.command_binary);
    const argument1 = commandText(row.command_argument_1);
    const argument2 = commandText(row.command_argument_2);
    const label = level === "binary"
      ? binary
      : level === "argument-1"
        ? `${binary} ${argument1}`
        : `${binary} ${argument1}${argument2 === "—" ? "" : ` ${argument2}`}`;
    const existing = groups.get(label);
    const next: CommandInvestigationRow = existing ?? {
      key: label,
      label,
      calls: 0,
      eligible: 0,
      attributed: 0,
      help: 0,
      observed: 0,
      notAttributed: 0,
      shellWrapped: 0,
      composite: 0,
    };
    const merged = {
      ...next,
      calls: next.calls + commandNumber(row.calls),
      eligible: next.eligible + commandNumber(row.eligible_executions),
      attributed: next.attributed + commandNumber(row.attributed_actual_failures),
      help: next.help + commandNumber(row.contains_help_calls),
      observed: next.observed + commandNumber(row.observed_failed_or_nonzero_executions),
      notAttributed: next.notAttributed + commandNumber(row.observed_not_attributed_executions),
      shellWrapped: next.shellWrapped + commandNumber(row.shell_wrapped_executions),
      composite: next.composite + commandNumber(row.composite_or_unparsed_executions),
    };
    groups.set(label, merged);
  }
  return [...groups.values()];
}

function commandSortValue(row: CommandInvestigationRow, sort: CommandInvestigationSort): number {
  if (sort === "calls") return row.calls;
  if (sort === "eligible") return row.eligible;
  if (sort === "attributed") return row.attributed;
  if (sort === "rate") return row.eligible === 0 ? -1 : row.attributed / row.eligible;
  if (sort === "help") return row.help;
  if (sort === "observed") return row.observed;
  return row.notAttributed;
}

function commandContext(row: CommandInvestigationRow): string {
  const context = [
    row.eligible === row.calls ? "direct eligible" : null,
    row.help > 0 ? `${row.help} help` : null,
    row.shellWrapped > 0 ? `${row.shellWrapped} shell wrapped` : null,
    row.composite > 0 ? `${row.composite} composite/unparsed` : null,
  ].filter((value): value is string => value != null);
  return context.length === 0 ? "—" : context.join(" · ");
}

function commandText(value: QueryRow[string]): string {
  return typeof value === "string" && value !== "" ? value : "—";
}

function commandNumber(value: QueryRow[string]): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type FigureMenuState = {
  figure: AnalyticsCompiledFigure;
  result: QueryResult;
  chartTheme: AnalyticsChartTheme;
  execution: ExecutionResult | null;
  definition: ExecutionDefinition | null;
  capturedExport: CapturedFigureExport | null;
  capturedExportError: string | null;
  visualization: Extract<AnalyticsVisualization, { kind: "bar" | "line" }>;
  query: AnalyticsBundle["queries"][number];
  datum: InteractiveDatumMeta | null;
  clientX: number;
  clientY: number;
  controller: FigureRuntimeController | null;
  restoreTo: HTMLElement | null;
};

type FigureLineage =
  | Readonly<{
      kind: "legacy";
      bundleId: AnalyticsBundle["id"];
      snapshotGenerationId: number | null;
      snapshotUpdatedAt: number | null;
      rangeDays: number;
    }>
  | Readonly<{
      kind: "execution";
      bundleId: ExecutionResult["resolved"]["bundleId"];
      executionId: ExecutionResult["executionId"];
      snapshotId: ExecutionResult["resolved"]["snapshot"]["snapshotId"];
      frozenRange: ExecutionResult["resolved"]["snapshot"]["frozenRange"];
      capturedAtMs: ExecutionResult["resolved"]["snapshot"]["capturedAtMs"];
      queryId: ExecutionResult["resolved"]["query"]["id"];
      querySql: ExecutionResult["resolved"]["query"]["sql"];
      visualizationId: AnalyticsVisualization["id"];
      resultGeneration: QueryResult["generation"];
      coverage: QueryResultExtent;
      plottedRows: number;
    }>;

function ChartDataDisclosure({
  figure,
  onOpenMenu,
}: {
  figure: AnalyticsCompiledFigure;
  onOpenMenu: (intent: ChartIntent, restoreTo?: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = figure.total.kind === "exact"
    ? `${figure.total.rows.toLocaleString()}`
    : `at least ${figure.total.rows.toLocaleString()}`;
  return (
    <details className="analytics-chart-data" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Exact plotted data · showing {figure.plottedCount.toLocaleString()} of {total}</summary>
      {open && <div className="analytics-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{figure.visualization.x}</th>
              <th scope="col">{figure.visualization.y}</th>
              <th scope="col"><span className="analytics-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {figure.plottedRows.map((row, index) => {
              const datum = figure.dataIndex.get(index);
              return (
                <tr key={figure.plottedDatumKeys[index]}>
                  <td>{String(row[figure.visualization.x] ?? "—")}</td>
                  <td>{formatAnalyticsValue(row[figure.visualization.y], figure.format)}</td>
                  <td>
                    {datum != null && (
                      <button
                        type="button"
                        onClick={(event) => {
                          const bounds = event.currentTarget.getBoundingClientRect();
                          onOpenMenu({
                            kind: "open-context-menu",
                            figureId: figure.visualization.id,
                            clientX: bounds.right,
                            clientY: bounds.bottom,
                            target: { kind: "datum", datum },
                            source: "keyboard",
                          }, event.currentTarget);
                        }}
                      >Actions</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
    </details>
  );
}

function FigureContextMenu({
  state,
  lineage,
  onClose,
  onCopyReference,
  onAddToChat,
}: {
  state: FigureMenuState;
  lineage: FigureLineage;
  onClose: () => void;
  onCopyReference: () => Promise<string>;
  onAddToChat: () => Promise<void>;
}) {
  const menu = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const target = menu.current;
    const first = target?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    const dismiss = (event: PointerEvent) => {
      if (target != null && !target.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      if (state.restoreTo?.isConnected) state.restoreTo.focus();
    };
  }, [onClose, state.restoreTo]);

  const run = async (action: () => Promise<string | void>) => {
    setPending(true);
    setMessage(null);
    try {
      const next = await action();
      if (typeof next === "string") setMessage(next);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "That action could not be completed.");
    } finally {
      setPending(false);
    }
  };
  const filename = safeFilename(`${state.visualization.id}-${state.datum?.label ?? "figure"}`);
  const left = Math.max(8, Math.min(state.clientX, window.innerWidth - 248));
  const top = Math.max(8, Math.min(state.clientY, window.innerHeight - 300));
  const svgUnavailableReason = state.execution == null
    ? null
    : state.capturedExportError ?? (state.capturedExport == null
      ? "SVG export is unavailable for this captured execution."
      : null);
  const capturedExportUnavailableReason = state.execution == null
    ? null
    : state.capturedExportError ?? (state.capturedExport == null
      ? "Captured data export is unavailable for this execution."
      : null);
  const returnedResultStatus = state.execution == null
    ? null
    : state.result.extent.kind === "exact"
      ? `${state.result.rows.length.toLocaleString()} rows returned · exact result`
      : `${state.result.rows.length.toLocaleString()} rows returned · lower-bound extent (${state.result.extent.rows.toLocaleString()}+) · truncated`;
  const resultExportLabel = state.execution == null
    ? "Export complete bounded result CSV"
    : "Export returned result CSV";
  const legacyLineage = lineage.kind === "legacy" ? lineage : null;
  const exportCapturedData = async (scope: "plotted" | "result"): Promise<void> => {
    if (state.execution == null) {
      downloadText(
        `${filename}-${scope}.csv`,
        rowsToCsv(scope === "plotted" ? state.figure.accessibleData : state.figure.exportData),
        "text/csv;charset=utf-8",
      );
      onClose();
      return;
    }
    if (state.capturedExport == null) {
      throw new Error(capturedExportUnavailableReason ?? "Captured data export is unavailable for this execution.");
    }
    const csv = state.capturedExport.csv(scope);
    const lineageExport = state.capturedExport.lineage(scope);
    downloadText(`${filename}-${scope}.csv`, csv.text, "text/csv;charset=utf-8");
    downloadText(`${filename}-${scope}-lineage.json`, lineageExport.text, "application/json;charset=utf-8");
    onClose();
  };
  return (
    <div
      ref={menu}
      className="analytics-context-menu"
      role="menu"
      aria-label={`Actions for ${state.datum?.label ?? state.visualization.title}`}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        items[(current + direction + items.length) % items.length]?.focus();
      }}
    >
      <strong>{state.datum?.label ?? state.visualization.title}</strong>
      {state.datum != null && <span>{formatAnalyticsValue(state.datum.value, state.visualization.format)}</span>}
      <button role="menuitem" type="button" disabled={pending} onClick={() => void run(onAddToChat)}>Add reference to chat</button>
      <button role="menuitem" type="button" disabled={pending} onClick={() => void run(onCopyReference)}>Copy reference token</button>
      <button
        role="menuitem"
        type="button"
        disabled={state.execution != null && state.capturedExport == null}
        title={capturedExportUnavailableReason ?? undefined}
        onClick={() => void run(() => exportCapturedData("plotted"))}
      >Export plotted CSV</button>
      <button
        role="menuitem"
        type="button"
        disabled={state.execution != null && state.capturedExport == null}
        title={capturedExportUnavailableReason ?? undefined}
        onClick={() => void run(() => exportCapturedData("result"))}
      >{resultExportLabel}</button>
      <button
        role="menuitem"
        type="button"
        disabled={pending || (state.execution != null && state.capturedExport == null) || (state.execution == null && state.controller == null)}
        title={svgUnavailableReason ?? undefined}
        onClick={() => void run(async () => {
          if (state.execution != null) {
            if (state.capturedExport == null) {
              throw new Error(svgUnavailableReason ?? "SVG export is unavailable for this captured execution.");
            }
            const captured = state.capturedExport.svg({
              width: CAPTURED_SVG_DEFAULT_WIDTH,
              height: CAPTURED_SVG_DEFAULT_HEIGHT,
              theme: state.chartTheme,
            });
            downloadText(`${filename}.svg`, captured.text, "image/svg+xml;charset=utf-8");
            downloadText(`${filename}-lineage.json`, captured.lineage.text, "application/json;charset=utf-8");
            onClose();
            return;
          }
          if (legacyLineage == null) throw new Error("SVG export is unavailable for the legacy chart.");
          const svg = await state.controller?.exportSvg();
          if (svg == null) throw new Error("The chart renderer is not ready to export.");
          downloadDataUrl(`${filename}.svg`, svg);
          downloadText(`${filename}-lineage.json`, JSON.stringify({
            version: 1,
            exportedAt: new Date().toISOString(),
            bundleId: legacyLineage.bundleId,
            snapshotGenerationId: legacyLineage.snapshotGenerationId,
            snapshotUpdatedAt: legacyLineage.snapshotUpdatedAt,
            rangeDays: legacyLineage.rangeDays,
            queryId: state.query.id,
            querySql: state.query.sql,
            visualizationId: state.visualization.id,
            resultGeneration: state.result.generation,
            coverage: state.result.extent,
            plottedRows: state.figure.plottedCount,
          }, null, 2), "application/json;charset=utf-8");
          onClose();
        })}
      >{svgUnavailableReason == null ? "Export SVG + lineage" : "Export SVG + lineage unavailable"}</button>
      {capturedExportUnavailableReason != null && <p role="note">{capturedExportUnavailableReason}</p>}
      {returnedResultStatus != null && <p role="note">Returned result: {returnedResultStatus}</p>}
      {svgUnavailableReason != null && <p role="note">{svgUnavailableReason}</p>}
      {message != null && <p role="status">{message}</p>}
    </div>
  );
}

function safeFilename(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "analytics";
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className={spinning ? "analytics-refresh-icon is-spinning" : "analytics-refresh-icon"}
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.89" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.5 2.3v3.9h-3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IndexStatus({
  index,
  connection,
  refreshing,
}: {
  index: AnalyticsCatalogResponse["index"] | null;
  connection: PluginRealtimeConnectionState;
  refreshing: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (index == null) return null;
  const view = describeIndexStatus({
    status: index.status,
    refreshing,
    degraded: index.degraded,
    lastError: index.lastError,
    connection,
    freshnessLabel: formatAsOf(indexAsOf(index)),
  });
  const hasDetails = index.factCount > 0 || index.loadedThreads > 0 || index.lastFullReconciliationAt != null;
  return (
    <div className="analytics-index-status" data-tone={view.tone} role={view.errorText != null ? "alert" : undefined}>
      <span className="analytics-index-status-dot" data-tone={view.tone} aria-hidden="true" />
      <strong>{view.headline}</strong>
      {view.note != null && <span className="analytics-index-status-note">{view.note}</span>}
      {view.errorText != null && <span className="analytics-index-status-error">{view.errorText}</span>}
      {hasDetails && (
        <button
          type="button"
          className="analytics-index-status-toggle"
          aria-expanded={detailsOpen}
          aria-controls="analytics-index-status-detail"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? "Hide details" : "Details"}
        </button>
      )}
      {hasDetails && detailsOpen && (
        <div id="analytics-index-status-detail" className="analytics-index-status-detail">
          <span>{index.factCount.toLocaleString()} facts · {index.loadedThreads.toLocaleString()} threads</span>
          {index.truncatedThreads > 0 && <span>{index.truncatedThreads.toLocaleString()} threads capped at 500 events</span>}
          {index.lastFullReconciliationAt != null && <span>Last full reconciliation {formatAsOf(index.lastFullReconciliationAt)}</span>}
        </div>
      )}
    </div>
  );
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: () => void }) {
  return (
    <div className="analytics-empty">
      <strong>{title}</strong>
      <p>{detail}</p>
      {action != null && <button type="button" onClick={action}>Try again</button>}
    </div>
  );
}

function LoadingState({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="analytics-loading" aria-busy="true">
      <ChartPaintingAnimation />
      <strong>{title}</strong>
      <p>{detail}</p>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function indexAsOf(index: AnalyticsCatalogResponse["index"] | null | undefined): number | null {
  return index?.snapshotUpdatedAt ?? index?.completedAt ?? null;
}

function formatAsOf(timestamp: number | null): string {
  return timestamp == null
    ? "As of unavailable"
    : `As of ${new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}`;
}

function formatExecutionRange(range: ExecutionLocator["range"]): string {
  return `range ${new Date(range.startInclusiveMs).toLocaleDateString()}–${new Date(range.endExclusiveMs).toLocaleDateString()}`;
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === "AbortError")
    || (cause instanceof Error && cause.name === "AbortError");
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "analytics",
    title: "Analytics",
    icon: "ChartNoAxesColumnIncreasing",
    path: "analytics",
    component: AnalyticsPanel,
  });
});
