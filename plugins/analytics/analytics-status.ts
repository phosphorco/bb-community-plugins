export type AnalyticsIndexStatusTone = "neutral" | "ready" | "indexing" | "error" | "attention";

export interface AnalyticsIndexStatusInput {
  status: "empty" | "indexing" | "ready" | "error";
  refreshing: boolean;
  degraded: boolean;
  lastError: string | null;
  connection: "connected" | "connecting" | "reconnecting";
  freshnessLabel: string;
}

export interface AnalyticsIndexStatusView {
  tone: AnalyticsIndexStatusTone;
  headline: string;
  note: string | null;
  errorText: string | null;
}

/**
 * Collapse index status, refresh activity, degraded coverage, and realtime
 * connection into the single highest-priority line the topbar shows, so the
 * refresh button and the status strip never narrate the same state twice.
 */
export function describeIndexStatus(input: AnalyticsIndexStatusInput): AnalyticsIndexStatusView {
  if (input.status === "error") {
    return { tone: "error", headline: "Data unavailable", note: input.freshnessLabel, errorText: input.lastError };
  }
  if (input.refreshing || input.status === "indexing") {
    return { tone: "indexing", headline: "Refreshing…", note: input.freshnessLabel, errorText: null };
  }
  if (input.status === "empty") {
    return { tone: "neutral", headline: "No data yet", note: null, errorText: null };
  }
  if (input.degraded) {
    return { tone: "attention", headline: input.freshnessLabel, note: "Partial data coverage", errorText: null };
  }
  if (input.connection !== "connected") {
    return {
      tone: "attention",
      headline: input.freshnessLabel,
      note: input.connection === "connecting" ? "Connecting…" : "Reconnecting…",
      errorText: null,
    };
  }
  return { tone: "ready", headline: input.freshnessLabel, note: null, errorText: null };
}
