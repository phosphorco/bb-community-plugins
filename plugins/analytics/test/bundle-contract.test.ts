import assert from "node:assert/strict";
import test from "node:test";

import {
  analyticsBundleSchema,
  DEFAULT_LOADER_MAX_AGE_MS,
  MAX_LOADER_MAX_AGE_MS,
  MIN_LOADER_MAX_AGE_MS,
  parseBundleSource,
  validateQueryText,
} from "../bundle-contract.ts";
import { BUILTIN_BUNDLES } from "../builtin-bundles.ts";

test("built-in dashboard bundles satisfy the public bundle contract", () => {
  assert.equal(BUILTIN_BUNDLES.length, 2);
  for (const bundle of BUILTIN_BUNDLES) {
    assert.deepEqual(analyticsBundleSchema.parse(bundle), bundle);
    assert.equal(bundle.loader.maxAgeMs, DEFAULT_LOADER_MAX_AGE_MS);
    assert.equal(bundle.loader.staleWhileRefresh, true);
  }
});

test("loader policy has bounded values and compatible defaults", () => {
  const legacy = structuredClone(BUILTIN_BUNDLES[0]);
  const parsedLegacy = analyticsBundleSchema.parse({
    ...legacy,
    loader: { id: legacy.loader.id, label: legacy.loader.label },
  });
  assert.equal(parsedLegacy.loader.maxAgeMs, DEFAULT_LOADER_MAX_AGE_MS);
  assert.equal(parsedLegacy.loader.staleWhileRefresh, true);

  const withMaxAge = (maxAgeMs: unknown) => analyticsBundleSchema.parse({
    ...BUILTIN_BUNDLES[0],
    loader: { ...BUILTIN_BUNDLES[0].loader, maxAgeMs },
  });
  assert.equal(withMaxAge(MIN_LOADER_MAX_AGE_MS).loader.maxAgeMs, MIN_LOADER_MAX_AGE_MS);
  assert.equal(withMaxAge(MAX_LOADER_MAX_AGE_MS).loader.maxAgeMs, MAX_LOADER_MAX_AGE_MS);
  assert.throws(() => withMaxAge(MIN_LOADER_MAX_AGE_MS - 1), /too_small|Too small|>=/);
  assert.throws(() => withMaxAge(MAX_LOADER_MAX_AGE_MS + 1), /too_big|Too big|<=/);
  assert.throws(() => withMaxAge(1.5), /expected int|integer/);
});

test("loader policy remains strict", () => {
  assert.throws(() => analyticsBundleSchema.parse({
    ...BUILTIN_BUNDLES[0],
    loader: { ...BUILTIN_BUNDLES[0].loader, unexpected: true },
  }), /unexpected|Unrecognized key/);
  assert.throws(() => analyticsBundleSchema.parse({
    ...BUILTIN_BUNDLES[0],
    loader: { ...BUILTIN_BUNDLES[0].loader, staleWhileRefresh: "true" },
  }), /boolean/);
});

test("bundle references are validated", () => {
  const invalid = structuredClone(BUILTIN_BUNDLES[0]);
  invalid.visualizations[0] = { ...invalid.visualizations[0], queryId: "missing" };
  assert.throws(() => analyticsBundleSchema.parse(invalid), /unknown query missing/);
});

test("bundle source is bounded and rejects invalid JSON", () => {
  assert.throws(() => parseBundleSource("{"), /not valid JSON/);
  assert.throws(() => parseBundleSource(`"${"x".repeat(300_000)}"`), /exceeds/);
});

test("query text rejects mutation, external reads, and multiple statements", () => {
  assert.doesNotThrow(() => validateQueryText("WITH facts AS (SELECT * FROM tool_execution_fact_v1) SELECT * FROM facts"));
  assert.throws(() => validateQueryText("DELETE FROM tool_execution_fact_v1"), /start with SELECT or WITH/);
  assert.throws(() => validateQueryText("SELECT * FROM read_parquet('secret.parquet')"), /curated capability/);
  assert.throws(() => validateQueryText("SELECT 1; SELECT 2"), /exactly one statement/);
});
