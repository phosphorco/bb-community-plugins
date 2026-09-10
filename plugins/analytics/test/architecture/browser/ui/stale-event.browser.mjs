#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { runSupervisedNode } from "../supervised-node.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const browserRoot = dirname(sourcePath);
const analyticsRoot = resolve(browserRoot, "../../../..");
const communityNodeModules = resolve(analyticsRoot, "../../node_modules");
const manifestPath = resolve(analyticsRoot, "package.json");
const requireFromAnalytics = createRequire(manifestPath);
const CHILD_ARGUMENT = "--child";
const CHILD_PREFIX = "@@bb-analytics-stale-event@@";
const PARENT_PREFIX = "@@bb-analytics-stale-event-parent@@";
const CHILD_TIMEOUT_MS = 60_000;
const OUTPUT_CAP_BYTES = 16 * 1024;
const KILL_GRACE_MS = 1_000;
const CLOSE_GRACE_MS = 1_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
const BROWSER_ACQUISITION_CLEANUP_TIMEOUT_MS = 2_000;
const LOOPBACK = "127.0.0.1";
const ENTRY_PATH = "/test/architecture/browser/ui/stale-event.browser-entry.tsx";
const HTML_PATH = "/__bb_analytics_stale_event__.html";
const PLAYWRIGHT_BROWSERS_PATH = "0";
const MAX_CASES = 16;
const MAX_OBSERVATIONS = 64;
const OLD_EXECUTION_ID = "analytics-exec_stale_a";
const B_EXECUTION_ID = "analytics-exec_stale_b";
const C_EXECUTION_ID = "analytics-exec_stale_c";
const EXPECTED_A_KEYS = ["analytics-datum_stale_a_0", "analytics-datum_stale_a_1"];
const EXPECTED_B_KEYS = ["analytics-datum_stale_b_0", "analytics-datum_stale_b_1"];
const EXPECTED_C_KEYS = ["analytics-datum_stale_c_0", "analytics-datum_stale_c_1"];
const EXPECTED_B_INCOMING = Object.freeze({
  seriesId: "series-failures",
  kind: "bar",
  rows: Object.freeze([
    Object.freeze({ capability_key: "B-second", failures: 8 }),
    Object.freeze({ capability_key: "B-first", failures: 7 }),
  ]),
});
const EXPECTED_C_INCOMING = Object.freeze({
  seriesId: "series-failures",
  kind: "line",
  rows: Object.freeze([
    Object.freeze({ capability_key: "C-first", failures: 13 }),
    Object.freeze({ capability_key: "C-second", failures: 11 }),
  ]),
});
const EXPECTED_A_LOCATOR = Object.freeze({
  bundleId: "stale-event-proof",
  queryId: "failures",
  range: Object.freeze({ startInclusiveMs: 1_700_000_000_000, endExclusiveMs: 1_700_086_400_000 }),
  parameters: Object.freeze([
    { name: "include_retries", logicalType: "boolean", value: true },
    { name: "range_days", logicalType: "integer", value: 1 },
  ]),
});
const EXPECTED_B_LOCATOR = Object.freeze({
  bundleId: "stale-event-proof",
  queryId: "failures",
  range: Object.freeze({ startInclusiveMs: 1_700_000_000_000, endExclusiveMs: 1_700_086_400_000 }),
  parameters: Object.freeze([
    { name: "include_retries", logicalType: "boolean", value: true },
    { name: "range_days", logicalType: "integer", value: 1 },
  ]),
});
const EXPECTED_C_LOCATOR = Object.freeze({
  bundleId: "stale-event-proof",
  queryId: "failures",
  range: Object.freeze({ startInclusiveMs: 1_700_000_000_000, endExclusiveMs: 1_700_086_400_000 }),
  parameters: Object.freeze([
    { name: "include_retries", logicalType: "boolean", value: true },
    { name: "range_days", logicalType: "integer", value: 1 },
  ]),
});
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stale event proof</title></head><body><script type="module" src="${ENTRY_PATH}"></script></body></html>`;
const SDK_ALIASES = Object.freeze([
  { find: "@bb/plugin-sdk/app", replacement: "@get-bb/plugin-sdk/app" },
  { find: "@bb/plugin-sdk", replacement: "@get-bb/plugin-sdk" },
]);

class BlockedError extends Error { constructor(message) { super(message); this.name = "BlockedError"; } }
class DriverError extends Error { constructor(message) { super(message); this.name = "DriverError"; } }
class ExpectedIdentityRegressionError extends Error { constructor(message) { super(message); this.name = "ExpectedIdentityRegressionError"; } }

function boundedText(value, maximum = 1_500) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
}

function isWithin(child, parent) {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative));
}

async function packageMetadata(resolvedEntry, packageName) {
  if (!isWithin(resolvedEntry, communityNodeModules)) throw new DriverError(`${packageName} resolved outside community node_modules: ${resolvedEntry}`);
  let current = dirname(resolvedEntry);
  for (let depth = 0; depth < 8 && isWithin(current, communityNodeModules); depth += 1) {
    const packageJson = resolve(current, "package.json");
    try {
      const metadata = JSON.parse(await readFile(packageJson, "utf8"));
      if (metadata?.name === packageName && typeof metadata.version === "string") return Object.freeze({ root: current, metadata });
    } catch (error) {
      if (error?.code !== "ENOENT") throw new DriverError(`malformed ${packageName} metadata: ${boundedText(error)}`);
    }
    current = dirname(current);
  }
  throw new DriverError(`could not find package metadata for ${packageName}`);
}

async function resolvePackage(name, version, specifier = name) {
  let entry;
  try { entry = await realpath(requireFromAnalytics.resolve(specifier)); }
  catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") throw new BlockedError(`missing browser package ${name}: ${boundedText(error)}`);
    throw new DriverError(`could not resolve ${name}: ${boundedText(error)}`);
  }
  const owner = await packageMetadata(entry, name);
  if (owner.metadata.version !== version) throw new DriverError(`${name} resolved ${owner.metadata.version}, expected ${version}`);
  return Object.freeze({ name, version, root: owner.root, entry });
}

async function resolveToolchain() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expected = { "@get-bb/plugin-sdk": "0.4.15", "@playwright/test": "1.63.0", vite: "8.2.2" };
  for (const [name, version] of Object.entries(expected)) {
    if (manifest.devDependencies?.[name] !== version) throw new DriverError(`${name} is not pinned to ${version}`);
  }
  const sdk = await resolvePackage("@get-bb/plugin-sdk", "0.4.15", "@get-bb/plugin-sdk/testing/app");
  const playwright = await resolvePackage("@playwright/test", "1.63.0");
  const playwrightCore = await resolvePackage("playwright-core", "1.63.0");
  const vite = await resolvePackage("vite", "8.2.2");
  const browsersPath = resolve(playwrightCore.root, "browsers.json");
  const browsers = JSON.parse(await readFile(browsersPath, "utf8"));
  const headless = browsers.browsers?.find((entry) => entry?.name === "chromium-headless-shell");
  if (headless?.revision !== "1243") throw new BlockedError("pinned Chromium headless-shell revision 1243 is unavailable");
  const browserRootPath = resolve(playwrightCore.root, ".local-browsers");
  const selectedBrowserRoot = await realpath(resolve(browserRootPath, "chromium_headless_shell-1243")).catch((error) => {
    if (error?.code === "ENOENT") throw new BlockedError(`package-local Chromium headless-shell 1243 is absent: ${browserRootPath}`);
    throw new DriverError(`Chromium headless-shell is unreadable: ${boundedText(error)}`);
  });
  if (!isWithin(selectedBrowserRoot, browserRootPath)) throw new DriverError(`selected Chromium is outside package-local root: ${selectedBrowserRoot}`);
  return Object.freeze({ sdk, playwright, playwrightCore, vite, browserRoot: selectedBrowserRoot });
}

function boundedPush(list, value, maximum, state, label) {
  if (list.length >= maximum) { state.overflow = true; throw new DriverError(`${label} observation overflow`); }
  list.push(value);
}

function staleEventPlugin() {
  return {
    name: "bb-analytics-stale-event-entry",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== HTML_PATH) return next();
        try {
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(await server.transformIndexHtml(HTML_PATH, HTML));
        } catch (error) { next(error); }
      });
    },
  };
}

function observationSummary(value) {
  assert.ok(value != null && typeof value === "object", "fixture observation must be an object");
  assert.equal(typeof value.observedCount, "number");
  assert.equal(typeof value.overflow, "boolean");
  assert.ok(Array.isArray(value.charts));
  assert.ok(value.charts.length <= MAX_OBSERVATIONS);
  assert.ok(Array.isArray(value.rawEvents));
  assert.ok(value.rawEvents.length <= MAX_OBSERVATIONS);
  assert.ok(Array.isArray(value.setOptionCalls));
  assert.ok(value.setOptionCalls.length <= MAX_OBSERVATIONS);
  return Object.freeze({
    observedCount: value.observedCount,
    overflow: value.overflow,
    charts: value.charts.map((chart) => ({ id: chart.id, ssr: chart.ssr, disposed: chart.disposed, registered: chart.registered })),
    rawEvents: value.rawEvents.map((event) => ({ phase: event.phase, chartId: event.chartId, seriesId: event.seriesId, dataIndex: event.dataIndex, nativeEventId: event.nativeEventId, nativeEventMatched: event.nativeEventMatched, nativeTargetMatched: event.nativeTargetMatched, nativeDispatched: event.nativeDispatched })),
    setOptionCalls: value.setOptionCalls.map((call) => ({ sequence: call.sequence, phase: call.phase, incoming: call.incoming, chartId: call.chartId, argumentCount: call.argumentCount, lazyUpdate: call.lazyUpdate, notMerge: call.notMerge, replaceMerge: call.replaceMerge, result: call.result, threw: call.threw })),
    cleanupErrors: [...value.cleanupErrors],
  });
}

function referenceSummary(value) {
  assert.ok(value != null && typeof value === "object");
  assert.ok(Array.isArray(value.referenceRequests));
  assert.equal(value.referenceOverflow, false, "reference observation overflow");
  return Object.freeze({
    open: value.open === true,
    label: typeof value.label === "string" ? value.label : null,
    references: value.referenceRequests.map((request) => ({
      executionId: request.executionId,
      visualizationId: request.visualizationId,
      ...(typeof request.targetDatumKey === "string" ? { targetDatumKey: request.targetDatumKey } : {}),
    })),
    lastMentionId: typeof value.lastMentionId === "string" ? value.lastMentionId : null,
  });
}

function exactLocator(locator, expected, label) {
  assert.deepEqual(locator, expected, `${label} locator drifted from its independently authored request`);
}

function exactReference(reference, executionId, targetDatumKey = undefined) {
  assert.equal(reference.executionId, executionId);
  assert.equal(reference.visualizationId, "failures");
  if (targetDatumKey == null) assert.equal("targetDatumKey" in reference, false);
  else assert.equal(reference.targetDatumKey, targetDatumKey);
}

function assertRawBoundary(boundary, phase, chartId) {
  assert.equal(typeof boundary.oldMark.targetTag, "string", `${phase} boundary target tag missing`);
  assert.ok(boundary.oldMark.targetTag.length > 0, `${phase} boundary target tag empty`);
  assert.equal(boundary.oldMark.connectedBefore, true, `${phase} boundary target was not connected before setOption`);
  assertTargetGeometry(boundary.oldMark, `${phase} old target`);
  assert.ok(boundary.nativeEvent != null, `${phase} did not retain the operation-local native event identity`);
  assert.equal(boundary.nativeEvent.targetTag, boundary.oldMark.targetTag, `${phase} native target tag drifted`);
  assert.deepEqual(boundary.nativeEvent.bounds, boundary.oldMark.bounds, `${phase} native target bounds drifted`);
  assert.deepEqual(boundary.nativeEvent.point, boundary.oldMark.point, `${phase} native target point drifted`);
  assert.equal(boundary.nativeEvent.connected, true, `${phase} native target was not connected`);
  const event = boundary.rawEvents.find((candidate) => candidate.phase === phase && candidate.nativeDispatched);
  assert.ok(event != null, `${phase} boundary did not observe the native ECharts event`);
  assert.equal(event.chartId, chartId);
  assert.equal(event.seriesId, "series-failures");
  assert.equal(event.dataIndex, 0);
  assert.equal(event.nativeEventId, boundary.nativeEvent.id, `${phase} raw event was not tied to the dispatched native event`);
  assert.equal(boundary.nativeEvent.matchedEvent, true, `${phase} ECharts event did not retain the exact dispatched MouseEvent identity`);
  assert.equal(boundary.nativeEvent.eventTargetMatched, true, `${phase} ECharts event did not retain the exact old SVG mark target`);
  assert.equal(event.nativeEventMatched, true, `${phase} raw observation did not match the dispatched MouseEvent`);
  assert.equal(event.nativeTargetMatched, true, `${phase} raw observation did not match the old SVG mark target`);
  assert.equal(boundary.setOptionCall.sequence, boundary.nativeEvent.setOptionSequence, `${phase} native event was not tied to the matched setOption call`);
}

function assertTargetGeometry(target, label) {
  for (const value of [target.bounds.left, target.bounds.top, target.bounds.width, target.bounds.height, target.point.x, target.point.y]) {
    assert.equal(Number.isFinite(value), true, `${label} geometry was not finite`);
  }
  assert.ok(target.bounds.width > 0 && target.bounds.height > 0, `${label} bounds were not positive`);
}

function assertNativePointer(observation, label) {
  const summary = observationSummary(observation);
  const event = [...summary.rawEvents].reverse().find((candidate) => candidate.phase === "ordinary" && candidate.nativeDispatched === false);
  assert.ok(event != null, `${label} did not observe its native ECharts pointer event`);
  assert.equal(event.seriesId, "series-failures", `${label} native event series identity drifted`);
  assert.equal(event.dataIndex, 0, `${label} native event datum identity drifted`);
  assert.equal(event.nativeEventId, null, `${label} ordinary pointer was incorrectly marked as an update-boundary event`);
}

function assertUpdatePolicy(boundary, phase, chartId) {
  const call = boundary.setOptionCall;
  assert.equal(Number.isInteger(call.sequence), true, `${phase} matched call sequence is not bounded`);
  assert.ok(call.sequence > 0, `${phase} matched call sequence is missing`);
  assert.equal(call.chartId, chartId, `${phase} matched the wrong chart call`);
  assert.equal(call.phase, phase, `${phase} matched call phase drifted`);
  assert.equal(call.result, "returned", `${phase} setOption did not complete successfully`);
  assert.equal(call.threw, false, `${phase} setOption threw`);
  assert.deepEqual(call.incoming, phase === "B" ? EXPECTED_B_INCOMING : EXPECTED_C_INCOMING, `${phase} semantic incoming option drifted`);
  assert.equal(call.lazyUpdate, false, `${phase} must publish synchronously with lazyUpdate=false`);
  if (phase === "B") {
    assert.equal(call.notMerge, false, "B must use same-series merge semantics");
    assert.equal(call.replaceMerge, null, "B must not replace structural families");
  } else {
    assert.equal(call.notMerge, true, "C must use same-ID full-replacement semantics");
    assert.equal(call.replaceMerge, null, "C full replacement must not use a family-only replacement");
  }
}

function assertCleanup(observation, label, expectedLiveIds = []) {
  const summary = observationSummary(observation);
  assert.equal(summary.overflow, false, `${label} observation overflow`);
  assert.deepEqual(summary.cleanupErrors, [], `${label} tracker cleanup errors`);
  assert.equal(summary.observedCount, summary.charts.length, `${label} observed-count mismatch`);
  assert.ok(summary.charts.length > 0, `${label} observed no chart instances`);
  for (const expectedId of expectedLiveIds) assert.ok(summary.charts.some((chart) => chart.id === expectedId), `${label} omitted preexisting live chart ${expectedId}`);
  assert.ok(summary.charts.every((chart) => chart.disposed && !chart.registered), `${label} retained a chart instance`);
  return summary;
}

async function pageOperation(page, name, argument = undefined) {
  return await page.evaluate(({ name: operationName, argument: operationArgument }) => {
    const api = globalThis.__bbStaleEventBrowser;
    if (api == null || typeof api[operationName] !== "function") throw new Error(`missing stale-event operation ${operationName}`);
    return operationArgument === undefined ? api[operationName]() : api[operationName](operationArgument);
  }, { name, argument });
}

function assertCurrentCase(caseName, value) {
  if (value?.boundary?.dispatched !== true) throw new DriverError(`${caseName} did not reach the host setOption boundary`);
  if (!Array.isArray(value?.after?.referenceRequests)) throw new DriverError(`${caseName} returned malformed post-update reference observations`);
  if (!Array.isArray(value?.requests) || value.requestOverflow !== false) throw new DriverError(`${caseName} returned malformed or overflowing query observations`);
  if (value.requests.length === 0 || value.requests.at(-1)?.settled !== true) throw new DriverError(`${caseName} query did not settle`);
}

async function runCases(page, cases) {
  let mounted = false;
  let chartId = null;
  let remountLiveId = null;
  const record = (name, status, facts) => {
    if (cases.length >= MAX_CASES) throw new DriverError("stale-event case receipt overflow");
    cases.push(Object.freeze({ name, status, facts }));
  };
  try {
    await pageOperation(page, "mount");
    mounted = true;
    const ready = observationSummary(await pageOperation(page, "ready"));
    assert.equal(ready.overflow, false, "initial chart observer overflow");
    assert.equal(ready.observedCount, ready.charts.length, "initial chart observed-count mismatch");
    const live = ready.charts.filter((chart) => !chart.ssr && !chart.disposed && chart.registered);
    assert.equal(live.length, 1, "initial readiness must expose exactly one live registered chart");
    chartId = live[0].id;
    const pointerPayload = await pageOperation(page, "pointerReference");
    assert.equal(pointerPayload.requestOverflow, false, "initial query observation overflow");
    const initialRequest = pointerPayload.requests?.[0];
    assert.ok(initialRequest != null, "initial query request observation is missing");
    exactLocator(initialRequest.locator, EXPECTED_A_LOCATOR, "A");
    assertNativePointer(pointerPayload.observation, "A");
    const pointer = referenceSummary(pointerPayload.menu);
    const pointerReference = pointer.references.at(-1);
    assert.ok(pointerReference != null, "native A pointer did not produce a reference");
    exactReference(pointerReference, OLD_EXECUTION_ID, EXPECTED_A_KEYS[0]);
    assert.equal(pointer.lastMentionId, "analytics-ref_stale_event_a");
    record("native-A-before-B-request-positive", "pass", { reference: pointerReference, charts: ready.charts, rawEvents: observationSummary(pointerPayload.observation).rawEvents });

    const tableReference = await pageOperation(page, "tableReference");
    exactReference(tableReference, OLD_EXECUTION_ID, EXPECTED_A_KEYS[0]);
    await pageOperation(page, "focusFigureKeyboardAction");
    await page.keyboard.press("Enter");
    const figureEnterReference = await pageOperation(page, "completeFigureKeyboardReference");
    exactReference(figureEnterReference, OLD_EXECUTION_ID);
    await pageOperation(page, "focusFigureKeyboardAction");
    await page.keyboard.press("Space");
    const figureSpaceReference = await pageOperation(page, "completeFigureKeyboardReference");
    exactReference(figureSpaceReference, OLD_EXECUTION_ID);
    record("keyboard-table-and-figure-reference-parity", "pass", { tableReference, figureEnterReference, figureSpaceReference });

    const b = await pageOperation(page, "update", "B");
    assertCurrentCase("B", b);
    exactLocator(b.requests.at(-1).locator, EXPECTED_B_LOCATOR, "B");
    const bBoundary = b.boundary;
    assertRawBoundary(bBoundary, "B", chartId);
    const bBoundarySummary = referenceSummary(bBoundary.menu);
    record("B-boundary-observation", "observed", {
      boundary: bBoundarySummary,
      reference: bBoundary.reference,
      nativeEvent: bBoundary.nativeEvent,
      oldMark: bBoundary.oldMark,
      rawEvents: bBoundary.rawEvents,
      setOptionCall: bBoundary.setOptionCall,
    });
    if (bBoundarySummary.references.length !== b.referenceCountBeforeBoundary) {
      throw new DriverError("B boundary reference count changed before ordinary boundary-menu inspection");
    }
    if (bBoundarySummary.open || bBoundary.reference != null) {
      if (bBoundary.reference == null) throw new DriverError("B boundary menu opened but ordinary reference collection did not settle");
      throw new ExpectedIdentityRegressionError("B native A-mark event during wrapped setOption opened a menu or reference instead of being rejected");
    }
    assertUpdatePolicy(bBoundary, "B", chartId);
    const bAfter = referenceSummary(b.after);
    const bReference = bAfter.references.at(-1);
    assert.ok(bReference != null, "B post-return pointer did not produce a reference");
    exactReference(bReference, B_EXECUTION_ID, EXPECTED_B_KEYS[0]);
    record("B-during-application-rejected-and-after-return-resolves-B", "pass", {
      boundary: bBoundarySummary,
      after: bAfter,
      visibleTextLength: b.visibleText.length,
    });

    const c = await pageOperation(page, "update", "C");
    assertCurrentCase("C", c);
    exactLocator(c.requests.at(-1).locator, EXPECTED_C_LOCATOR, "C");
    assertRawBoundary(c.boundary, "C", chartId);
    const cBoundarySummary = referenceSummary(c.boundary.menu);
    record("C-boundary-observation", "observed", {
      boundary: cBoundarySummary,
      reference: c.boundary.reference,
      nativeEvent: c.boundary.nativeEvent,
      oldMark: c.boundary.oldMark,
      rawEvents: c.boundary.rawEvents,
      setOptionCall: c.boundary.setOptionCall,
    });
    if (cBoundarySummary.references.length !== c.referenceCountBeforeBoundary) {
      throw new DriverError("C boundary reference count changed before ordinary boundary-menu inspection");
    }
    if (cBoundarySummary.open || c.boundary.reference != null) {
      if (c.boundary.reference == null) throw new DriverError("C boundary menu opened but ordinary reference collection did not settle");
      throw new ExpectedIdentityRegressionError("C native B-mark event during same-ID structural replacement opened a menu or reference instead of being rejected");
    }
    assertUpdatePolicy(c.boundary, "C", chartId);
    const cAfter = referenceSummary(c.after);
    const cReference = cAfter.references.at(-1);
    assert.ok(cReference != null, "C post-return pointer did not produce a reference");
    exactReference(cReference, C_EXECUTION_ID, EXPECTED_C_KEYS[0]);
    record("same-ID-structural-C-during-application-rejected-and-after-return-resolves-C", "pass", {
      boundary: cBoundarySummary,
      after: cAfter,
      visibleTextLength: c.visibleText.length,
    });
  } catch (error) {
    record("case-operation-failure", "fail", {
      failureClass: error instanceof ExpectedIdentityRegressionError ? "identity-regression" : "driver-or-lifecycle",
      failure: boundedText(error),
    });
    throw error;
  } finally {
    if (mounted) {
      const cleanup = observationSummary(await pageOperation(page, "unmount"));
      assertCleanup(cleanup, "initial session unmount", chartId == null ? [] : [chartId]);
      record("unmount-disposes-all-owned-instances", "pass", cleanup);
    }
  }

  await pageOperation(page, "mount");
  mounted = true;
  try {
    const remount = observationSummary(await pageOperation(page, "ready"));
    const remountLive = remount.charts.filter((chart) => !chart.ssr && !chart.disposed && chart.registered);
    assert.equal(remountLive.length, 1, "remount must create one live chart");
    remountLiveId = remountLive[0].id;
    assert.notEqual(remountLiveId, chartId, "remount must create a new chart identity");
    const remountCleanup = observationSummary(await pageOperation(page, "unmount"));
    mounted = false;
    assertCleanup(remountCleanup, "remount cleanup", [remountLiveId]);
    record("remount-creates-and-disposes-one-live-instance", "pass", remountCleanup);
  } finally {
    if (mounted) {
      try { const cleanup = observationSummary(await pageOperation(page, "unmount")); assertCleanup(cleanup, "late remount cleanup", remountLiveId == null ? [] : [remountLiveId]); }
      catch (error) { throw new DriverError(`remount cleanup failed: ${boundedText(error)}`); }
    }
  }
  return cases;
}

function observeProcess(child) {
  const observed = { pid: Number.isInteger(child?.pid) ? child.pid : null, spawnfile: typeof child?.spawnfile === "string" ? child.spawnfile : null, spawnfileRealpath: null, exitObserved: false, closeObserved: false, exitCode: null, exitSignal: null };
  let resolveClose;
  const closePromise = new Promise((resolvePromise) => { resolveClose = resolvePromise; });
  child.once("exit", (code, signal) => { observed.exitObserved = true; observed.exitCode = code; observed.exitSignal = signal; });
  child.once("close", (code, signal) => { observed.closeObserved = true; observed.exitCode = code; observed.exitSignal = signal; resolveClose(); });
  return { observed, closePromise };
}

async function awaitWithTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new DriverError(`${label} exceeded ${timeoutMs}ms`)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function waitForClose(promise, timeoutMs = CLEANUP_TIMEOUT_MS) {
  try { await awaitWithTimeout(promise, "process close", timeoutMs); return true; }
  catch { return false; }
}

function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" || url.hostname !== LOOPBACK || url.port === "") throw new DriverError(`non-loopback browser endpoint: ${endpoint}`);
  return Object.freeze({ protocol: url.protocol, host: url.hostname, port: Number(url.port) });
}

function parseProtocol(stdout, prefix, kind, version) {
  const lines = String(stdout ?? "").slice(0, OUTPUT_CAP_BYTES).split(/\r?\n/);
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) return { receipt: null, error: matches.length === 0 ? "missing child protocol receipt" : "duplicate child protocol receipts" };
  try {
    const receipt = JSON.parse(matches[0].slice(prefix.length));
    if (receipt?.kind !== kind || receipt?.version !== version) return { receipt: null, error: "child protocol kind/version mismatch" };
    return { receipt, error: null };
  } catch (error) { return { receipt: null, error: `malformed child protocol receipt: ${boundedText(error)}` }; }
}

async function runChild() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;
  let signalRequested = false;
  let temporaryDirectory = null;
  let viteServer = null;
  let httpServer = null;
  let browserServer = null;
  let browser = null;
  let context = null;
  let page = null;
  let launchPromise = null;
  let launchTimedOut = false;
  let lateLaunchKillObserved = false;
  let browserProcessObservation = null;
  let browserProcessClosePromise = null;
  let viteEvidence = null;
  const sockets = new Set();
  const pageErrors = [];
  const externalRequests = [];
  const cleanupErrors = [];
  const closeOutcomes = [];
  const observationState = { overflow: false };
  let viteCloseObserved = false;
  let contextCloseObserved = false;
  let browserServerCloseObserved = false;
  let connectionObserved = 0;
  let connectionOverflow = false;
  let browserServerKillCalled = false;
  let cleanupPromise = null;

  const recordCleanupError = (message) => {
    if (cleanupErrors.length >= MAX_OBSERVATIONS) {
      observationState.overflow = true;
      return;
    }
    cleanupErrors.push(message);
  };
  const recordCloseOutcome = (outcome) => {
    if (closeOutcomes.length >= MAX_OBSERVATIONS) {
      observationState.overflow = true;
      return;
    }
    closeOutcomes.push(Object.freeze(outcome));
  };
  const throwIfSignalRequested = (stage) => { if (signalRequested) throw new BlockedError(`supervisor requested SIGTERM before ${stage}`); };
  const attachBrowserServer = (server) => {
    if (browserServer != null) return;
    browserServer = server;
    browserServer.once("close", () => { browserServerCloseObserved = true; });
    const child = browserServer.process();
    if (child == null) throw new DriverError("Playwright BrowserServer exposed no public process");
    const observed = observeProcess(child);
    browserProcessObservation = observed.observed;
    browserProcessClosePromise = observed.closePromise;
  };
  const killBrowserServer = async () => {
    if (browserServer != null) {
      if (browserServerKillCalled) return true;
      browserServerKillCalled = true;
      try {
        await awaitWithTimeout(Promise.resolve(browserServer.kill()), "browserServer.kill", CLEANUP_TIMEOUT_MS);
        recordCloseOutcome({ label: "browserServer.kill", status: "completed" });
        return true;
      }
      catch (error) {
        recordCloseOutcome({ label: "browserServer.kill", status: "error", error: boundedText(error) });
        recordCleanupError(`browserServer.kill: ${boundedText(error)}`);
        return false;
      }
    }
    if (launchPromise == null) return false;
    try {
      const late = await awaitWithTimeout(launchPromise, "late browserServer acquisition", BROWSER_ACQUISITION_CLEANUP_TIMEOUT_MS);
      attachBrowserServer(late);
      return await killBrowserServer();
    } catch (error) {
      recordCleanupError(`late browserServer acquisition: ${boundedText(error)}`);
      return false;
    }
  };
  const cleanup = async (reason) => {
    if (cleanupPromise != null) return cleanupPromise;
    cleanupPromise = (async () => {
      const close = async (label, operation) => {
        if (operation == null) return;
        try {
          await awaitWithTimeout(Promise.resolve().then(operation), label, CLEANUP_TIMEOUT_MS);
          recordCloseOutcome({ label, status: "completed" });
        } catch (error) {
          const message = `${label}: ${boundedText(error)}`;
          recordCloseOutcome({ label, status: "error", error: boundedText(error) });
          recordCleanupError(message);
        }
      };
      if (reason === "sigterm" || signalRequested) await killBrowserServer();
      await close("page.close", async () => { if (page != null) await page.close(); });
      await close("context.close", async () => { if (context != null) await context.close(); });
      await close("browser.close", async () => { if (browser != null) await browser.close(); });
      if (reason !== "sigterm" && !signalRequested) await close("browserServer.close", async () => { if (browserServer != null) await browserServer.close(); });
      if (browserProcessClosePromise != null) {
        const processClosed = await waitForClose(browserProcessClosePromise);
        recordCloseOutcome({ label: "browserProcess.close", status: processClosed ? "completed" : "error", ...(processClosed ? {} : { error: "browser process close deadline" }) });
        if (!processClosed) recordCleanupError("browserProcess.close: deadline");
      }
      await close("vite.close", async () => { if (viteServer != null) await viteServer.close(); });
      if (httpServer != null) httpServer.removeAllListeners("connection");
      const openSockets = sockets.size;
      let temporaryDirectoryRemoved = temporaryDirectory == null;
      await close("temporaryDirectory.rm", async () => {
        if (temporaryDirectory == null) return;
        await rm(temporaryDirectory, { recursive: true, force: false });
        try {
          await realpath(temporaryDirectory);
          throw new DriverError(`temporary directory remains: ${temporaryDirectory}`);
        } catch (error) {
          if (error?.code === "ENOENT") temporaryDirectoryRemoved = true;
          else throw error;
        }
      });
      return Object.freeze({
        pageClosed: page == null || page.isClosed(),
        contextClosed: context == null || contextCloseObserved,
        browserConnectionClosed: browser == null || !browser.isConnected(),
        browserServerKillCalled,
        contextCloseObserved: context == null || contextCloseObserved,
        browserServerCloseObserved: browserServer == null || browserServerCloseObserved,
        browserProcessExitObserved: browserProcessObservation?.exitObserved === true,
        browserProcessCloseObserved: browserProcessObservation?.closeObserved === true,
        browserServerLaunchTimedOut: launchTimedOut,
        lateLaunchKillObserved,
        browserProcess: browserProcessObservation == null ? null : {
          pid: browserProcessObservation.pid,
          spawnfile: browserProcessObservation.spawnfile,
          spawnfileRealpath: browserProcessObservation.spawnfileRealpath,
          exitObserved: browserProcessObservation.exitObserved,
          closeObserved: browserProcessObservation.closeObserved,
          exitCode: browserProcessObservation.exitCode,
          exitSignal: browserProcessObservation.exitSignal,
        },
        vite: viteEvidence,
        temporaryDirectory,
        closeOutcomes: [...closeOutcomes],
        viteServerCloseObserved: viteCloseObserved || httpServer == null || httpServer.listening === false,
        openSockets,
        socketsClosed: openSockets === 0,
        temporaryDirectoryRemoved,
        errors: [...cleanupErrors],
      });
    })();
    return cleanupPromise;
  };
  const onSigterm = () => { signalRequested = true; void cleanup("sigterm").catch((error) => recordCleanupError(`signal cleanup: ${boundedText(error)}`)); };
  process.once("SIGTERM", onSigterm);
  let status = "pass";
  let failure = null;
  let failureClass = null;
  let cases = [];
  let toolchain = null;
  let cleanupResult = null;
  try {
    throwIfSignalRequested("toolchain resolution");
    toolchain = await resolveToolchain();
    throwIfSignalRequested("Playwright import");
    const { chromium } = await import("@playwright/test");
    throwIfSignalRequested("Vite import");
    const { createServer } = await import("vite");
    if (typeof chromium?.launchServer !== "function" || typeof createServer !== "function") throw new DriverError("required public browser/Vite API is unavailable");
    throwIfSignalRequested("temporary cache acquisition");
    temporaryDirectory = await mkdtemp(join(tmpdir(), "bb-analytics-stale-event-"));
    throwIfSignalRequested("Vite creation");
    viteServer = await createServer({
      root: analyticsRoot,
      cacheDir: temporaryDirectory,
      configFile: false,
      envDir: false,
      resolve: { alias: SDK_ALIASES },
      server: { host: LOOPBACK, port: 0, strictPort: true, watch: null, hmr: false },
      plugins: [staleEventPlugin()],
    });
    httpServer = viteServer.httpServer;
    if (httpServer == null) throw new DriverError("Vite did not expose its public HTTP server");
    httpServer.on("connection", (socket) => {
      if (connectionObserved >= MAX_OBSERVATIONS) {
        connectionOverflow = true;
        socket.destroy();
        return;
      }
      connectionObserved += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    httpServer.once("close", () => { viteCloseObserved = true; });
    throwIfSignalRequested("Vite listen");
    await viteServer.listen();
    throwIfSignalRequested("Vite listen completion");
    const address = httpServer.address();
    if (address == null || typeof address === "string" || address.address !== LOOPBACK || !Number.isInteger(address.port)) throw new DriverError("Vite did not bind an ephemeral loopback port");
    viteEvidence = Object.freeze({ protocol: "http:", host: address.address, port: address.port });
    throwIfSignalRequested("browser launch");
    launchPromise = Promise.resolve().then(() => chromium.launchServer({ headless: true, host: LOOPBACK, port: 0, timeout: BROWSER_LAUNCH_TIMEOUT_MS }));
    void launchPromise.then((server) => {
      attachBrowserServer(server);
      if (launchTimedOut || signalRequested) void killBrowserServer().then((killed) => { if (killed) lateLaunchKillObserved = true; }).catch((error) => recordCleanupError(`late launch kill: ${boundedText(error)}`));
    }, (error) => { if (launchTimedOut || signalRequested) recordCleanupError(`late launch rejection: ${boundedText(error)}`); });
    try { attachBrowserServer(await awaitWithTimeout(launchPromise, "browser server launch", BROWSER_LAUNCH_TIMEOUT_MS)); }
    catch (error) { launchTimedOut = true; await killBrowserServer(); throw error; }
    throwIfSignalRequested("browser server acquisition");
    if (browserServer == null || browserProcessObservation == null) throw new DriverError("browser server acquisition was incomplete");
    if (typeof browserProcessObservation.spawnfile !== "string") throw new DriverError("browser process did not expose a public spawnfile");
    browserProcessObservation.spawnfileRealpath = await realpath(browserProcessObservation.spawnfile);
    if (!isWithin(browserProcessObservation.spawnfileRealpath, toolchain.browserRoot)) throw new DriverError("browser process is outside selected package-local Chromium");
    const endpoint = validateEndpoint(browserServer.wsEndpoint());
    throwIfSignalRequested("browser connect");
    browser = await chromium.connect(browserServer.wsEndpoint());
    throwIfSignalRequested("browser connect completion");
    browserEvidence = {
      endpoint,
      version: browser.version(),
      pid: browserProcessObservation.pid,
      spawnfile: browserProcessObservation.spawnfile,
      executablePath: browserProcessObservation.spawnfileRealpath,
    };
    throwIfSignalRequested("browser context creation");
    context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    context.once("close", () => { contextCloseObserved = true; });
    throwIfSignalRequested("context route");
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.protocol !== "http:" || requestUrl.hostname !== LOOPBACK || requestUrl.port !== String(address.port)) await route.abort();
      else await route.continue();
    });
    throwIfSignalRequested("page creation");
    page = await context.newPage();
    throwIfSignalRequested("page creation completion");
    page.on("pageerror", (error) => boundedPush(pageErrors, boundedText(error), MAX_OBSERVATIONS, observationState, "page error"));
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.protocol !== "http:" || requestUrl.hostname !== LOOPBACK || requestUrl.port !== String(address.port)) boundedPush(externalRequests, request.url(), MAX_OBSERVATIONS, observationState, "external request");
    });
    throwIfSignalRequested("navigation");
    const response = await page.goto(`http://${LOOPBACK}:${address.port}${HTML_PATH}`, { waitUntil: "load", timeout: 10_000 });
    throwIfSignalRequested("navigation completion");
    if (response == null || response.status() >= 400) throw new DriverError(`stale-event entry did not load: ${response?.status() ?? "no response"}`);
    await page.locator("body[data-stale-event-ready=\"1\"]").waitFor({ state: "attached", timeout: 10_000 });
    throwIfSignalRequested("post-body readiness");
    if (pageErrors.length > 0) throw new DriverError(`browser page error: ${pageErrors.join("; ")}`);
    if (externalRequests.length > 0) throw new DriverError(`browser entry attempted external requests: ${externalRequests.join(", ")}`);
    if (connectionOverflow || observationState.overflow) throw new DriverError("bounded browser observation capacity overflowed");
    const caseReceipt = [];
    try {
      cases = await runCases(page, caseReceipt);
    } catch (error) {
      cases = caseReceipt;
      throw error;
    }
    throwIfSignalRequested("stale-event cases completion");
  } catch (error) {
    status = error instanceof BlockedError ? "blocked" : "fail";
    failureClass = error instanceof ExpectedIdentityRegressionError ? "identity-regression" : error instanceof BlockedError ? "blocked" : "driver-or-lifecycle";
    failure = boundedText(error);
  } finally {
    cleanupResult = await cleanup(signalRequested ? "sigterm" : "finally");
    if (signalRequested) { status = "blocked"; failureClass = "blocked"; failure = failure ?? "supervisor requested SIGTERM"; }
    const lifecycleProblems = [
      ...cleanupResult.errors,
      cleanupResult.pageClosed ? null : "page did not close",
      cleanupResult.contextClosed ? null : "context retained pages",
      cleanupResult.browserServerCloseObserved ? null : "BrowserServer close event was not observed",
      cleanupResult.browserConnectionClosed ? null : "browser connection did not close",
      cleanupResult.browserProcessExitObserved ? null : "browser process exit was not observed",
      cleanupResult.browserProcessCloseObserved ? null : "browser process close was not observed",
      cleanupResult.viteServerCloseObserved ? null : "Vite server did not close",
      cleanupResult.socketsClosed ? null : "loopback sockets remained open",
      cleanupResult.temporaryDirectoryRemoved ? null : "owned temporary directory remained",
      connectionOverflow ? "loopback connection observation overflow" : null,
      observationState.overflow ? "browser observation overflow" : null,
      pageErrors.length > 0 ? `page errors: ${pageErrors.join("; ")}` : null,
      externalRequests.length > 0 ? `external requests: ${externalRequests.join(", ")}` : null,
    ].filter((problem) => problem != null);
    if (lifecycleProblems.length > 0) {
      status = "fail";
      failureClass = "driver-or-lifecycle";
      failure = failure == null ? lifecycleProblems.join("; ") : `${failure}; ${lifecycleProblems.join("; ")}`;
    }
    process.off("SIGTERM", onSigterm);
  }
  return {
    kind: "analytics-stale-event-browser",
    version: 1,
    status,
    failure,
    failureClass,
    environment: { node: process.version, cwd: process.cwd(), playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH },
    toolchain,
    browser: browserEvidence ?? null,
    provenance: Object.freeze({
      executable: browserProcessObservation?.spawnfileRealpath ?? null,
      spawnfile: browserProcessObservation?.spawnfile ?? null,
      browserPid: browserProcessObservation?.pid ?? null,
      browserEndpoint: browserEvidence?.endpoint ?? null,
      vite: viteEvidence,
      temporaryDirectory,
      pageErrors,
      externalRequests,
      connectionObserved,
      connectionOverflow,
    }),
    witnessScope: Object.freeze({
      reducedMotion: "reduce",
      queuedOldEventIdentity: "unproven",
      animationIdentity: "unproven",
      concurrentAbandonedRender: "unproven",
    }),
    cases,
    pageErrors,
    externalRequests,
    cleanup: cleanupResult,
  };
}

let browserEvidence = null;

function parseParent(stdout, stderr, supervised) {
  const protocol = parseProtocol(stdout, CHILD_PREFIX, "analytics-stale-event-browser", 1);
  const child = protocol.receipt;
  let status = "fail";
  let failure = protocol.error;
  if (supervised.reason === "deadline") { status = "blocked"; failure = "stale-event child exceeded the fixed 60-second deadline"; }
  else if (supervised.reason != null || supervised.code !== 0 || supervised.signal != null || supervised.exitObserved !== true || supervised.closeObserved !== true) {
    status = child?.status === "blocked" ? "blocked" : "fail";
    failure = child?.failure ?? `child did not close cleanly (code ${supervised.code}, signal ${supervised.signal}, reason ${supervised.reason})`;
  } else if (protocol.error == null && child != null) {
    status = ["pass", "blocked", "fail"].includes(child.status) ? child.status : "fail";
    failure = ["pass", "blocked", "fail"].includes(child.status) ? child.failure ?? null : "child returned an invalid status";
  }
  return {
    kind: "analytics-stale-event-browser-parent",
    version: 1,
    status,
    failure,
    child,
    supervisor: {
      code: supervised.code,
      signal: supervised.signal,
      reason: supervised.reason,
      terminationReason: supervised.terminationReason,
      exitObserved: supervised.exitObserved,
      closeObserved: supervised.closeObserved,
      capturedBytes: supervised.capturedBytes,
      receivedBytes: supervised.receivedBytes,
      stderr: boundedText(stderr),
    },
  };
}

async function runParent() {
  const supervised = await runSupervisedNode({ args: [sourcePath, CHILD_ARGUMENT], cwd: analyticsRoot, timeoutMs: CHILD_TIMEOUT_MS, outputCapBytes: OUTPUT_CAP_BYTES, killGraceMs: KILL_GRACE_MS, closeGraceMs: CLOSE_GRACE_MS });
  const stdout = Buffer.isBuffer(supervised.stdout) ? supervised.stdout.toString("utf8") : String(supervised.stdout ?? "");
  const stderr = Buffer.isBuffer(supervised.stderr) ? supervised.stderr.toString("utf8") : String(supervised.stderr ?? "");
  return parseParent(stdout, stderr, supervised);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === CHILD_ARGUMENT) {
  try {
    const result = await runChild();
    process.stdout.write(`${CHILD_PREFIX}${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
  } catch (error) {
    process.stdout.write(`${CHILD_PREFIX}${JSON.stringify({ kind: "analytics-stale-event-browser", version: 1, status: error instanceof BlockedError ? "blocked" : "fail", failureClass: "driver-or-lifecycle", failure: boundedText(error), cases: [] })}\n`);
    process.exitCode = error instanceof BlockedError ? 2 : 1;
  }
} else if (args.length === 0) {
  const result = await runParent();
  process.stdout.write(`${PARENT_PREFIX}${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
} else {
  process.stderr.write("usage: stale-event.browser.mjs [--child]\n");
  process.exitCode = 2;
}
