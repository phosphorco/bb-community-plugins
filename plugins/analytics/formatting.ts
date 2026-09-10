import type { AnalyticsFormat } from "./bundle-contract.ts";
import type { AnalyticsScalar } from "./analytics-model.ts";

export function formatAnalyticsValue(value: AnalyticsScalar | undefined, format: AnalyticsFormat): string {
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
