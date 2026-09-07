import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import type { AnalyticsFormat, AnalyticsVisualization } from "./bundle-contract.ts";
import {
  getBrowserAnalyticsEngine,
  type BrowserDashboardResult,
  type BrowserQueryResult,
} from "./browser-engine.ts";
import type { AnalyticsBundleResponse, AnalyticsCatalogResponse, rpcContract } from "./rpc-contract.ts";
import { ChartPaintingAnimation } from "./chart-painting-animation.tsx";
import { EChartsFigure } from "./echarts-figure.tsx";
import "./app.css";

type AnalyticsDashboard = AnalyticsBundleResponse & BrowserDashboardResult;
type QueryResult = BrowserQueryResult;
type QueryRow = QueryResult["rows"][number];
type IndexMetadata = {
  generationId?: number | null;
  snapshotUpdatedAt?: number | null;
  lastFullReconciliationAt?: number | null;
  degraded?: boolean;
  lastError?: string | null;
  error?: string | null;
};

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
        generationId: indexGeneration(selectedIndex),
        asOf: indexAsOf(selectedIndex),
        signal: controller.signal,
      });
      if (sequence === requestSequence.current) setDashboard({ ...selected, ...result });
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
        <label>
          <span>Dashboard</span>
          <select value={bundleId} onChange={(event) => selectBundle(event.target.value)}>
            {(catalog?.bundles ?? []).map((bundle) => (
              <option key={bundle.id} value={bundle.id}>{bundle.title}{bundle.builtin ? "" : " · authored"}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Range</span>
          <select value={rangeDays} onChange={(event) => selectRange(Number(event.target.value))}>
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className="analytics-refresh" disabled={indexRefreshing} onClick={() => void refreshIndex()}>
          {indexRefreshing ? "Refreshing…" : "Refresh data"}
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

const Dashboard = memo(function Dashboard({ dashboard, loading, refreshing }: { dashboard: AnalyticsDashboard; loading: boolean; refreshing: boolean }) {
  const resultsById = useMemo(
    () => new Map(dashboard.results.map((result) => [result.id, result])),
    [dashboard.results],
  );
  const visualizationsById = useMemo(
    () => new Map(dashboard.bundle.visualizations.map((visualization) => [visualization.id, visualization])),
    [dashboard.bundle.visualizations],
  );

  return (
    <div className="analytics-dashboard" aria-busy={loading}>
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
          <span className="analytics-query-health" title="Total worker time across this bundle's bounded DuckDB queries">
            {dashboard.queryMs.toLocaleString()} ms query time
          </span>
        </div>
      </header>

      <div className="analytics-grid">
        {dashboard.bundle.layout.map((item) => {
          const visualization = visualizationsById.get(item.visualizationId);
          if (visualization == null) return null;
          return (
            <VisualizationCard
              key={visualization.id}
              visualization={visualization}
              result={resultsById.get(visualization.queryId) ?? null}
              width={item.width}
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
          <span>DuckDB startup: {dashboard.startupMs.toLocaleString()} ms</span>
          <span>Fact load: {dashboard.loadMs.toLocaleString()} ms · {formatBytes(dashboard.factBytes)}{dashboard.materializationCached ? " · reused" : ""}</span>
          {dashboard.results.map((result) => (
            <span key={result.id}>{result.id}: {result.cached ? "reused" : `${result.elapsedMs.toLocaleString()} ms`}{result.truncated ? " · capped" : ""}</span>
          ))}
        </div>
      </details>
    </div>
  );
});

const VisualizationCard = memo(function VisualizationCard({
  visualization,
  result,
  width,
}: {
  visualization: AnalyticsVisualization;
  result: QueryResult | null;
  width: "third" | "half" | "full";
}) {
  const rows = result?.rows ?? [];
  return (
    <section className="analytics-card" data-width={width}>
      {visualization.kind === "metric" ? (
        <Metric visualization={visualization} row={rows[0] ?? null} />
      ) : (
        <>
          <header>
            <h2>{visualization.title}</h2>
            {result != null && <span>{result.cached ? "reused" : `${result.elapsedMs.toLocaleString()} ms`}</span>}
          </header>
          {rows.length === 0 ? (
            <p className="analytics-card-empty">No matching activity in this range.</p>
          ) : visualization.kind === "table" ? (
            <ResultTable visualization={visualization} rows={rows} />
          ) : (
            <EChartsFigure visualization={visualization} rows={rows} />
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
      <strong>{formatValue(row?.[visualization.value] ?? null, visualization.format)}</strong>
      {visualization.detail != null && <small>{String(row?.[visualization.detail] ?? "")}</small>}
    </div>
  );
}

function ResultTable({
  visualization,
  rows,
}: {
  visualization: Extract<AnalyticsVisualization, { kind: "table" }>;
  rows: QueryRow[];
}) {
  return (
    <div className="analytics-table-scroll">
      <table>
        <thead>
          <tr>{visualization.columns.map((column) => <th key={column.field} scope="col">{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${String(row[visualization.columns[0]?.field ?? ""] ?? "row")}:${index}`}>
              {visualization.columns.map((column) => (
                <td key={column.field}>{formatValue(row[column.field] ?? null, column.format)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IndexStatus({
  index,
  connection,
  refreshing,
}: {
  index: AnalyticsCatalogResponse["index"] | null;
  connection: string;
  refreshing: boolean;
}) {
  if (index == null) return null;
  const metadata = index as AnalyticsCatalogResponse["index"] & IndexMetadata;
  const asOf = indexAsOf(index);
  const error = metadata.lastError ?? metadata.error ?? null;
  const degraded = metadata.degraded === true || index.status === "error" || index.truncatedThreads > 0 || connection !== "connected";
  const freshness = asOf == null ? "No snapshot yet" : formatAsOf(asOf);
  return (
    <div className="analytics-index-status" data-state={index.status} data-degraded={degraded || undefined} role={error != null ? "alert" : undefined}>
      <span data-state={index.status} aria-hidden="true" />
      <strong>{refreshing || index.status === "indexing" ? "Refreshing capability snapshot" : index.status === "error" ? "Capability snapshot unavailable" : freshness}</strong>
      {(refreshing || index.status === "indexing" || index.status === "error") && <span>{freshness}</span>}
      <span>{index.factCount.toLocaleString()} facts · {index.loadedThreads.toLocaleString()} threads</span>
      {index.truncatedThreads > 0 && <span>{index.truncatedThreads} threads reached the 500-event coverage cap</span>}
      {metadata.degraded && <span>Degraded snapshot coverage</span>}
      {metadata.lastFullReconciliationAt != null && <span>Last full reconciliation: {formatAsOf(metadata.lastFullReconciliationAt)}</span>}
      {error != null && <span>{error}</span>}
      {connection !== "connected" && <span>Realtime disconnected</span>}
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

function formatValue(value: string | number | boolean | null, format: AnalyticsFormat): string {
  if (value == null || value === "") return "—";
  if (format === "text") return String(value);
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (format === "integer") return Math.round(number).toLocaleString();
  if (format === "percent") return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
  if (format === "duration") {
    if (number < 1_000) return `${Math.round(number)} ms`;
    if (number < 60_000) return `${(number / 1_000).toFixed(1)} s`;
    return `${(number / 60_000).toFixed(1)} min`;
  }
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function indexGeneration(index: AnalyticsCatalogResponse["index"] | null | undefined): number | null {
  const generationId = (index as (AnalyticsCatalogResponse["index"] & IndexMetadata) | null | undefined)?.generationId;
  return generationId != null && Number.isSafeInteger(generationId) && generationId >= 0 ? generationId : null;
}

function indexAsOf(index: AnalyticsCatalogResponse["index"] | null | undefined): number | null {
  const metadata = index as (AnalyticsCatalogResponse["index"] & IndexMetadata) | null | undefined;
  return metadata?.snapshotUpdatedAt ?? index?.completedAt ?? null;
}

function formatAsOf(timestamp: number | null): string {
  return timestamp == null
    ? "As of unavailable"
    : `As of ${new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}`;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
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
