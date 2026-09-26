import type { AnalyticsBundle } from "./bundle-contract.ts";

export interface AnalyticsBundleVerification {
  bundleId: string;
  queryCount: number;
  visualizationCount: number;
}

/** Production verification remains unavailable until qualified execution exists. */
export async function verifyAnalyticsBundle(
  _bundle: AnalyticsBundle,
): Promise<AnalyticsBundleVerification> {
  throw new Error("Analytics bundle verification is unavailable until qualified isolated execution is installed.");
}
