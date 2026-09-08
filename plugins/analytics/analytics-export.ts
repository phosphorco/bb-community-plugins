import type { AnalyticsRow } from "./analytics-model.ts";

export function rowsToCsv(rows: readonly AnalyticsRow[], fields?: readonly string[]): string {
  const columns = fields == null
    ? [...new Set(rows.flatMap((row) => Object.keys(row)))].sort()
    : [...fields];
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column] ?? null)).join(",")),
  ].join("\r\n");
}

export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Neutralize spreadsheet formula execution while keeping the visible value.
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
