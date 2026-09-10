import { createHash } from "node:crypto";
import { analyticsMigrations } from "../../../../store.ts";
import { analyticsBundleSchema } from "../../../../bundle-contract.ts";
import { decodeLegacyStoredReferenceCapsule } from "../../../../execution-contract.ts";
import { migrationFixture } from "./fixtures.mjs";

// Freeze the actual pre-command-analysis schema, including the reference table.
export function createMigrationFixture() {
  const priorSql = analyticsMigrations.slice(0, 14);
  if (createHash("sha256").update(JSON.stringify(priorSql)).digest("hex") !== "20d8ed4fd27ce0b3b7f9a3a728fd70ab0ad36a3c5f1adc513c3a57f065b6b016")
    throw new Error("Historical migration prefix changed; do not rewrite the baseline.");
  const bundle = structuredClone(migrationFixture.legacyBundle);
  bundle.queries[0].sql = "SELECT capability_key, count(*) AS failures FROM tool_execution_fact_v1 GROUP BY capability_key";
  delete bundle.loader.maxAgeMs;
  delete bundle.loader.staleWhileRefresh;
  analyticsBundleSchema.parse(bundle);
  const reference = structuredClone(migrationFixture.legacyReference);
  const legacyResolution = decodeLegacyStoredReferenceCapsule(reference);
  const fact = structuredClone(migrationFixture.priorStore.rows.tool_execution_facts_v1[0]);
  return {
    priorSql, priorMigrationCount: 14, targetMigrationCount: analyticsMigrations.length,
    fact, factColumns: Object.keys(fact), bundleId: bundle.id, referenceId: reference.id,
    bundleSourceJson: JSON.stringify(bundle), referenceCapsuleJson: JSON.stringify(reference), legacyResolution,
  };
}
