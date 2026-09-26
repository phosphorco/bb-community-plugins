import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controls = new Set(["duplicate-event", "interrupted-migration", "partial-publication"]);
const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");
const fixture = resolve(directory, "../fixtures/projection/store-migration-coverage/run.ts");

function runProductionBoundFixture() {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
    cwd: analyticsRoot,
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(result.error, undefined, `production-bound migration fixture could not start: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `production-bound migration fixture failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.checks, [
    "pre-skill-sqlite-migration",
    "prospective-and-observed-coverage",
    "reopen-and-idempotence",
    "duplicate-and-interrupted-fail-closed",
    "partial-publication-fail-closed",
  ]);
}

export async function runSuite(options = {}) {
  for (const control of options.negativeControls ?? []) assert.ok(controls.has(control), `unknown store-migration-coverage negative control ${control}`);
  runProductionBoundFixture();
  return {
    suite: "store-migration-coverage",
    status: "pass",
    checks: [
      { id: "pre-skill-sqlite-preservation", status: "pass", details: "A real on-disk pre-skill SQLite database runs the production additive migration while tool_execution_fact_v1 rows and saved bundle/reference bytes stay exact." },
      { id: "prospective-unknown-and-observed-epochs", status: "pass", details: "Pre-instrumentation coverage remains distinct, the first prospective interval is unknown, and opening observation closes only that interval." },
      { id: "reopen-and-idempotence", status: "pass", details: "The production store reopens with the same coverage and facts; replaying an identical source event creates no second source row." },
      { id: "duplicate-event-fail-closed", status: "pass", details: "A changed payload with an existing source-event ID is rejected without changing active facts, source activation, or publication state." },
      { id: "interrupted-migration-fail-closed", status: "pass", details: "A controlled interruption inside the real additive migration transaction leaves no skill table published and preserves the complete pre-skill database." },
      { id: "partial-publication-fail-closed", status: "pass", details: "A partial schema cannot establish coverage, and a missing projection table rolls a later publication back without deactivating existing lifecycle facts." },
    ],
    observations: [
      { id: "pre-instrumentation", kind: "coverage", status: "unknown", details: "Historical tool rows are preserved but never rewritten into skill zeroes or observations." },
      { id: "prospective-unknown", kind: "coverage", status: "unknown", details: "Coverage remains unknown until a later observed epoch is explicitly opened." },
      { id: "observed-epoch", kind: "coverage", status: "observed", details: "The fixture publishes one real projected skill observation after coverage becomes observed." },
    ],
    limits: ["This instrument exercises the production SQLite migration array, AnalyticsStore, and skill projection directly; it does not use the earlier in-memory projection model as proof."],
  };
}
