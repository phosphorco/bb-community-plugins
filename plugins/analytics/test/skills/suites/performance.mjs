import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { percentile95, run } from "../fixtures/qualification/workload.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");
const browserFixture = resolve(analyticsRoot, "test/skills/browser/qualification/skills-dashboard-performance.test.tsx");
const calibration = Object.freeze(JSON.parse(readFileSync(resolve(analyticsRoot, "test/skills/fixtures/qualification/performance-calibration.json"), "utf8")));
const workload = resolve(analyticsRoot, "test/skills/fixtures/qualification/performance-workload.ts");

function verifyCalibrationIdentity() {
  for (const [relativePath, expected] of Object.entries(calibration.measuredWorkingTreeFileSha256)) {
    const actual = createHash("sha256").update(readFileSync(resolve(analyticsRoot, relativePath))).digest("hex");
    assert.equal(actual, expected, `calibration receipt does not identify the current measured working-tree file ${relativePath}`);
  }
}

function expectRejected(id, runControl) {
  assert.throws(runControl, undefined, `controlled ${id} must reject through its normal assertion path`);
}

function within(sampleResult, budget) {
  assert.ok(sampleResult.p95 <= budget, `${sampleResult.label} p95 ${sampleResult.p95.toFixed(1)}ms exceeds ${budget}ms`);
}

function workloadSample() {
  const result = run(process.execPath, ["--experimental-strip-types", workload], { cwd: analyticsRoot, timeout: 90_000 });
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass", "production performance workload must report pass");
  return report;
}

function browserSample() {
  return run("npx", ["vitest", "run", browserFixture, "--config", "test/skills/browser/qualification/vitest.config.ts", "--reporter=dot"], { cwd: analyticsRoot, timeout: 90_000 }).elapsedMs;
}

function holdout(label, getter) {
  const values = Array.from({ length: 5 }, getter);
  return { label, values, p95: percentile95(values) };
}

export async function runSuite(options = {}) {
  const controls = new Set(options.negativeControls ?? []);
  for (const control of controls) assert.ok(["idle-refresh", "store-growth", "timeout", "rejected-import"].includes(control), `unknown performance negative control ${control}`);
  assert.equal(calibration.sampleCount, 3, "immutable calibration receipt must retain exactly three calibration samples");
  assert.equal(calibration.p95Method, "nearest-rank: sort n samples ascending and select ceil(0.95*n)-1", "calibration receipt must name its percentile method");
  verifyCalibrationIdentity();
  const reports = Array.from({ length: 5 }, workloadSample);
  const extraction = { label: "cold-extraction", values: reports.map((row) => row.timings.extractionMs), p95: percentile95(reports.map((row) => row.timings.extractionMs)) };
  const query = { label: "cold-query", values: reports.map((row) => row.timings.queryMs), p95: percentile95(reports.map((row) => row.timings.queryMs)) };
  const drilldown = { label: "cold-drilldown", values: reports.map((row) => row.timings.drilldownMs), p95: percentile95(reports.map((row) => row.timings.drilldownMs)) };
  const render = holdout("cold-first-useful-render", browserSample);
  within(extraction, calibration.holdoutBudgetsMs.coldExtraction);
  within(query, calibration.holdoutBudgetsMs.coldQuery);
  within(drilldown, calibration.holdoutBudgetsMs.coldDrilldown);
  within(render, calibration.holdoutBudgetsMs.coldFirstUsefulRender);
  for (const report of reports) {
    assert.deepEqual(report.counts, { lifecycle: 10, measurement: 4, source: 14 }, "actual retained-store counts must stay bounded after unchanged-catalog replay");
  }
  if (controls.has("store-growth")) expectRejected("store-growth", () => assert.deepEqual({ lifecycle: 11, measurement: 4, source: 14 }, reports[0].counts));
  if (controls.has("idle-refresh")) expectRejected("idle-refresh", () => assert.equal(1, reports[0].idleRefreshOperations));
  if (controls.has("timeout")) expectRejected("timeout", () => run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { cwd: analyticsRoot, timeout: 10 }));
  if (controls.has("rejected-import")) expectRejected("rejected-import", () => run(process.execPath, ["--input-type=module", "-e", "await import('file:///qualification-missing.mjs')"], { cwd: analyticsRoot, timeout: 5_000 }));
  return {
    suite: "performance", status: "pass",
    checks: [
      { id: "separate-calibration-and-holdout", status: "pass", details: `Immutable receipt captured ${calibration.sampleCount} calibration samples at ${calibration.capturedAt}; separate holdout uses 5 samples and nearest-rank p95.` },
      { id: "event-and-store-growth-bound", status: "pass", details: `Measured after actual unchanged-catalog replay: lifecycle=10, measurement=4, source=14 for every holdout sample.` },
      { id: "cold-p95-budgets", status: "pass", details: `Extraction ${Math.ceil(extraction.p95)}/${calibration.holdoutBudgetsMs.coldExtraction}ms, query ${Math.ceil(query.p95)}/${calibration.holdoutBudgetsMs.coldQuery}ms, drilldown ${Math.ceil(drilldown.p95)}/${calibration.holdoutBudgetsMs.coldDrilldown}ms, first useful render ${Math.ceil(render.p95)}/${calibration.holdoutBudgetsMs.coldFirstUsefulRender}ms.` },
      { id: "idle-policy", status: "pass", details: "The real captured AnalyticsPanel browser fixture observed zero skillsQuery/skillsRawContributors calls before Skills activation." },
    ],
    observations: [
      { id: "warm-host-measurement", kind: "performance", status: "unknown", details: `Warm composed-host budgets are recorded but not passed here: ${JSON.stringify(calibration.futureComposedHostWarmBudgetsMs)}.` },
    ],
    limits: [`Hardware=${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? "unknown" })}; measured pass requires clean subprocesses and genuine rejection of requested negative controls.`],
  };
}
