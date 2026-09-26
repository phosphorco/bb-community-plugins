import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runSupervisedNode } from "../supervised-node.mjs";

const bindingRoot = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(bindingRoot, "../../../..");
const communityRoot = resolve(analyticsRoot, "../..");
const vitestCli = resolve(communityRoot, "node_modules/vitest/vitest.mjs");
const componentConfig = "test/architecture/browser/ui/vitest.config.ts";
const staleEventDriver = "test/architecture/browser/ui/stale-event.browser.mjs";
const capturedSvgDriver = "test/architecture/browser/ui/captured-svg.browser.mjs";
const staleEventPrefix = "@@bb-analytics-stale-event-parent@@";
const capturedSvgPrefix = "@@bb-analytics-captured-svg-parent@@";

function text(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

function bounded(value, maximum = 1_200) {
  const rendered = String(value);
  return rendered.length <= maximum ? rendered : `${rendered.slice(0, maximum)}…[truncated]`;
}

function requireCleanExit(label, result) {
  if (result.closeObserved !== true || result.exitObserved !== true || result.reason != null || result.code !== 0 || result.signal != null) {
    throw new Error(`${label} did not complete cleanly: ${bounded(JSON.stringify({
      code: result.code,
      signal: result.signal,
      reason: result.reason,
      closeObserved: result.closeObserved,
      exitObserved: result.exitObserved,
      stderr: text(result.stderr),
    }))}`);
  }
}

function parsePrefixedReceipt(label, stdout, prefix) {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line == null) throw new Error(`${label} did not emit its bounded parent receipt.`);
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch (error) {
    throw new Error(`${label} emitted malformed parent receipt: ${bounded(error)}`);
  }
}

async function runNode(label, args, timeoutMs, outputCapBytes) {
  const result = await runSupervisedNode({
    args,
    cwd: analyticsRoot,
    timeoutMs,
    outputCapBytes,
    killGraceMs: 1_000,
    closeGraceMs: 1_000,
  });
  requireCleanExit(label, result);
  return text(result.stdout);
}

async function runComponentFixture() {
  const stdout = await runNode(
    "execution-backed component fixture",
    [vitestCli, "run", "--config", componentConfig, "--reporter=json"],
    30_000,
    16 * 1024,
  );
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`execution-backed component fixture emitted malformed JSON: ${bounded(error)}`);
  }
  if (
    report?.success !== true ||
    report.numTotalTests !== 14 ||
    report.numPassedTests !== 14 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0
  ) {
    throw new Error(`execution-backed component fixture did not prove all expected cases: ${bounded(JSON.stringify(report))}`);
  }
  return Object.freeze({ tests: report.numPassedTests, suites: report.numPassedTestSuites });
}

async function runBrowserFixture(label, driver, prefix) {
  const stdout = await runNode(label, [driver], 30_000, 16 * 1024);
  const receipt = parsePrefixedReceipt(label, stdout, prefix);
  const child = receipt?.child;
  if (
    receipt?.status !== "pass" ||
    child?.status !== "pass" ||
    receipt?.supervisor?.exitObserved !== true ||
    receipt?.supervisor?.closeObserved !== true ||
    child?.cleanup?.errors?.length !== 0
  ) {
    throw new Error(`${label} rejected its own browser, cleanup, or provenance witness: ${bounded(JSON.stringify(receipt))}`);
  }
  const cases = Array.isArray(child.cases) ? child.cases : [];
  if (cases.length === 0 || cases.some((item) => item?.status !== "pass" && item?.status !== "observed")) {
    throw new Error(`${label} emitted invalid case evidence: ${bounded(JSON.stringify(cases))}`);
  }
  return Object.freeze({ cases: cases.length, cleanup: child.cleanup });
}

/**
 * Runs the actual jsdom component fixture plus the two live Chromium fixtures.
 * Their own drivers retain process, import, provenance, and cleanup assertions;
 * this bridge only validates and relays their bounded receipts to the suite.
 */
export async function bindProduction({ signal } = {}) {
  if (signal?.aborted === true) throw new Error("UI browser binding was aborted before fixtures started.");
  return Object.freeze({
    identity: Object.freeze({
      kind: "production",
      sourceFiles: Object.freeze([
        "app.tsx",
        "analytics-model.ts",
        "analytics-export.ts",
        "analytics-status.ts",
        "echarts-figure.tsx",
        "echarts-options.ts",
        "echarts-update-policy.ts",
        "chart-environment.ts",
        "test/architecture/suites/ui.mjs",
        "test/architecture/browser/bindings/ui.mjs",
        "test/architecture/browser/ui/execution-backed-ui.test.tsx",
        "test/architecture/browser/ui/execution-backed-ui.fixture.tsx",
        "test/architecture/browser/ui/stale-event.browser.mjs",
        "test/architecture/browser/ui/captured-svg.browser.mjs",
      ]),
    }),
    async run() {
      if (signal?.aborted === true) throw new Error("UI browser binding was aborted before fixtures ran.");
      const component = await runComponentFixture();
      const staleEvent = await runBrowserFixture("stale-event browser fixture", staleEventDriver, staleEventPrefix);
      const capturedSvg = await runBrowserFixture("captured-SVG browser fixture", capturedSvgDriver, capturedSvgPrefix);
      return Object.freeze({ component, staleEvent, capturedSvg });
    },
  });
}
