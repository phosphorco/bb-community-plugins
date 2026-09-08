import type { AnalyticsFormat, AnalyticsVisualization } from "./bundle-contract.ts";

export type AnalyticsScalar = string | number | boolean | null;
export type AnalyticsRow = Readonly<Record<string, AnalyticsScalar>>;

export type AnalyticalColumn = Readonly<{
  name: string;
  logicalType: string;
  nullable: boolean;
}>;

export type QueryResultExtent =
  | Readonly<{ kind: "exact"; rows: number }>
  | Readonly<{ kind: "lower-bound"; rows: number }>;

export type CanonicalQueryResult = Readonly<{
  id: string;
  generation: string;
  generationId: number | null;
  columns: readonly AnalyticalColumn[];
  rows: readonly AnalyticsRow[];
  datumKeys: readonly string[];
  parameters: Readonly<{ rangeDays: number; maxRows: number }>;
  extent: QueryResultExtent;
  elapsedMs: number;
  truncated: boolean;
  cached: boolean;
}>;

export type ChartVisualization = Extract<AnalyticsVisualization, { kind: "bar" | "line" }>;

export type AnalyticsChartTheme = Readonly<{
  foreground: string;
  muted: string;
  border: string;
  surface: string;
  series: string;
}>;

export type ChartComponentFamily = "aria" | "dataset" | "grid" | "series" | "tooltip" | "xAxis" | "yAxis";

export type InteractiveDatumMeta = Readonly<{
  datumKey: string;
  semanticKey?: string;
  dataIndex: number;
  label: string;
  value: AnalyticsScalar;
  row: AnalyticsRow;
  predicate: Readonly<{ field: string; operator: "eq"; value: AnalyticsScalar }>;
}>;

export type CompiledFigure<Option = unknown> = Readonly<{
  visualization: ChartVisualization;
  option: Option;
  renderer: "svg";
  instanceKey: string;
  structuralSignature: string;
  componentTopology: Readonly<Record<ChartComponentFamily, readonly string[]>>;
  datumIndex: ReadonlyMap<string, InteractiveDatumMeta>;
  dataIndex: ReadonlyMap<number, InteractiveDatumMeta>;
  semanticIndex: ReadonlyMap<string, readonly string[]>;
  plottedRows: readonly AnalyticsRow[];
  plottedDatumKeys: readonly string[];
  plottedCount: number;
  total: QueryResultExtent;
  accessibleData: readonly AnalyticsRow[];
  exportData: readonly AnalyticsRow[];
  format: AnalyticsFormat;
}>;

export type ChartHitTarget =
  | Readonly<{ kind: "datum"; datum: InteractiveDatumMeta }>
  | Readonly<{ kind: "figure" }>;

export type ChartIntent = Readonly<{
  kind: "open-context-menu";
  figureId: string;
  clientX: number;
  clientY: number;
  target: ChartHitTarget;
  source: "pointer" | "keyboard";
}>;

export type FigureRuntimeController = Readonly<{
  exportSvg(): Promise<string | null>;
}>;

export function createResultGeneration(
  generationId: number | null,
  _queryId: string,
  sql: string,
  rangeDays: number,
): string {
  return `analytics:${generationId ?? "cold"}:${rangeDays}:${stableHash(sql)}`;
}

export function createDatumKeys(generation: string, rows: readonly AnalyticsRow[]): string[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const encoded = stableRow(row);
    const occurrence = occurrences.get(encoded) ?? 0;
    occurrences.set(encoded, occurrence + 1);
    return `${generation}:${stableHash(encoded)}:${occurrence}`;
  });
}

export function stableRow(row: AnalyticsRow): string {
  return JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]));
}

export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
