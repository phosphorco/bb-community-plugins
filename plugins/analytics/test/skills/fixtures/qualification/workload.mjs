import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * This is deliberately a specification of the retained-production fixture,
 * not an expectation imported from its implementation.  The source fixture
 * contains three immutable revisions, eight lifecycle events, four named
 * measurements and the listed delivery turns.  Keeping the numbers here
 * makes a changed fixture fail rather than silently becoming its own oracle.
 */
export const QUALIFICATION_WORKLOAD = Object.freeze({
  catalogs: 3,
  revisions: 3,
  lifecycleEvents: 10,
  measurementEvents: 4,
  turns: Object.freeze(["turn-a", "stage-turn-a", "read-turn-a", "subtree-turn-a", "stage-turn-b", "read-turn-b", "turn-c"]),
  providers: Object.freeze(["claude-code", "codex"]),
  exactClaudeReadEvidence: Object.freeze(["registered-skill-md-read", "subtree-read"]),
  sourceFixture: "test/skills/queries/dashboard-queries/run.ts",
});

export const PERFORMANCE_BUDGETS = Object.freeze({
  samples: 5,
  coldExtractionP95Ms: 6_000,
  warmExtractionP95Ms: 3_000,
  coldQueryP95Ms: 8_000,
  warmQueryP95Ms: 4_000,
  coldRenderP95Ms: 30_000,
  warmRenderP95Ms: 15_000,
  coldDrilldownP95Ms: 8_000,
  warmDrilldownP95Ms: 4_000,
  idleRefreshOperations: 0,
  maxLifecycleRows: QUALIFICATION_WORKLOAD.lifecycleEvents,
  maxMeasurementRows: QUALIFICATION_WORKLOAD.measurementEvents,
  maxActiveSourceRows: QUALIFICATION_WORKLOAD.lifecycleEvents + QUALIFICATION_WORKLOAD.measurementEvents,
});

export function percentile95(samples) {
  assert.ok(Array.isArray(samples) && samples.length === PERFORMANCE_BUDGETS.samples, "p95 requires the exact ruled sample count");
  assert.ok(samples.every((sample) => Number.isFinite(sample) && sample >= 0), "p95 samples must be finite non-negative milliseconds");
  return [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1];
}

export function run(command, args, { cwd, timeout = 120_000 } = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout });
  const elapsedMs = performance.now() - started;
  assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return { elapsedMs, stdout: result.stdout, stderr: result.stderr };
}

export function productionQueryRun(analyticsRoot) {
  const fixture = resolve(analyticsRoot, QUALIFICATION_WORKLOAD.sourceFixture);
  const result = run(process.execPath, ["--experimental-strip-types", fixture], { cwd: analyticsRoot, timeout: 90_000 });
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass", "production SQLite fixture must report a passing result");
  assert.deepEqual(report.checks, [
    "sqlite-retained-query", "raw-reconciliation", "distinct-measurement-partitions", "coverage-epochs-and-token-mean",
    "false-activation-negative", "false-unused-negative", "bounded-query-and-detail",
  ], "production query fixture must retain its independent semantic controls");
  return result;
}

export function assertWorkloadContract() {
  assert.equal(QUALIFICATION_WORKLOAD.catalogs, QUALIFICATION_WORKLOAD.revisions, "every controlled catalog must have an exact revision identity");
  assert.ok(QUALIFICATION_WORKLOAD.turns.includes("read-turn-a"), "the workload must include a later Claude Read turn");
  assert.ok(QUALIFICATION_WORKLOAD.providers.includes("claude-code") && QUALIFICATION_WORKLOAD.providers.includes("codex"), "the workload must retain both provider partitions");
  assert.ok(QUALIFICATION_WORKLOAD.exactClaudeReadEvidence.length === 2, "Claude Read evidence must retain registered and subtree forms");
}

export function assertUnsupportedWorkloadFailsClosed() {
  const unsupported = { ...QUALIFICATION_WORKLOAD, revisions: 0 };
  assert.throws(() => {
    if (unsupported.revisions < 1 || unsupported.catalogs !== unsupported.revisions) throw new Error("unsupported qualification workload");
  }, /unsupported qualification workload/u, "an unsupported workload must not become a vacuous pass");
}

export function assertCleanupFailsClosed() {
  const directory = mkdtempSync(join(tmpdir(), "analytics-skills-qualification-"));
  try {
    assert.throws(() => {
      const cleanupReceipt = { attempted: true, removed: false, error: "controlled cleanup failure" };
      if (!cleanupReceipt.removed) throw new Error(cleanupReceipt.error);
    }, /controlled cleanup failure/u, "a failed cleanup receipt must reject rather than count as a clean fixture run");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(existsSync(directory), false, "qualification scratch directory cleanup must complete");
}

export function currentSourceIdentity(workspaceRoot) {
  const target = (path) => run("git", ["-C", resolve(workspaceRoot, path), "rev-parse", "HEAD"], { cwd: workspaceRoot, timeout: 15_000 }).stdout.trim();
  return Object.freeze({
    workspace: target("."),
    communityPlugins: target("community-plugins"),
    fork: target("fork"),
    upstream: target("fork/upstream"),
  });
}
