#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const CHILD_PREFIX = "@@bb-analytics-captured-svg@@";
const PARENT_PREFIX = "@@bb-analytics-captured-svg-parent@@";
const CHILD_TIMEOUT_MS = 60_000;
const OUTPUT_CAP_BYTES = 16 * 1024;
const KILL_GRACE_MS = 1_000;
const CLOSE_GRACE_MS = 1_000;
const LOOPBACK = "127.0.0.1";
const ENTRY_PATH = "/test/architecture/browser/ui/captured-svg.browser-entry.tsx";
const HTML_PATH = "/__bb_analytics_captured_svg__.html";
const PLAYWRIGHT_BROWSERS_PATH = "0";
const MAX_OBSERVATIONS = 64;
const MAX_CASES = 16;
const MAX_SVG_BYTES = 1_048_576;
const MAX_LINEAGE_BYTES = 64 * 1024;
const CONSUMER_MAX_SVG_BYTES = 1_000_000;
const OLD_EXECUTION_ID = "analytics-exec_captured_a";
const NEW_EXECUTION_ID = "analytics-exec_captured_b";
const BOUNDARY_EXECUTION_ID = "analytics-exec_captured_boundary";
const OLD_REVISION = "a".repeat(64);
const BOUNDARY_REVISION = "c".repeat(64);
const OLD_SQL = "SELECT capability_key, failures FROM tool_execution_fact_v1";
const OLD_LABELS = ["old-failures", "old-retries", "old-timeouts", "old-cancellations"];
const NEW_LABELS = ["new-failures", "new-retries", "new-timeouts", "new-cancellations"];
const MAX_DOWNLOAD_ATTEMPTS = 4;
const MAX_DOWNLOAD_AGGREGATE_BYTES = MAX_SVG_BYTES + MAX_LINEAGE_BYTES;
const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
const EMERGENCY_ACQUISITION_TIMEOUT_MS = 2_000;
const EMERGENCY_KILL_TIMEOUT_MS = 2_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 2_000;
const DOWNLOAD_OPERATION_TIMEOUT_MS = 10_000;
const DOWNLOAD_STREAM_TIMEOUT_MS = 5_000;
const DOWNLOAD_SETTLE_TIMEOUT_MS = 750;
const OLD_THEME = Object.freeze({
  foreground: "rgb(28, 31, 38)",
  muted: "rgb(92, 100, 114)",
  border: "rgb(200, 205, 214)",
  surface: "rgb(255, 255, 255)",
  series: "rgb(35, 99, 235)",
});
const NEW_THEME = Object.freeze({
  foreground: "rgb(242, 245, 249)",
  muted: "rgb(170, 181, 196)",
  border: "rgb(74, 87, 105)",
  surface: "rgb(30, 39, 54)",
  series: "rgb(96, 165, 250)",
});
const RANGE = Object.freeze({
  startInclusiveMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_086_400_000,
});
const PARAMETERS = Object.freeze([
  { name: "include_retries", logicalType: "boolean", value: true },
  { name: "range_days", logicalType: "integer", value: 1 },
]);
const OLD_COLUMNS = Object.freeze([
  { name: "capability_key", logicalType: "utf8", nullable: false },
  { name: "failures", logicalType: "integer", nullable: false },
]);
const SDK_ALIASES = Object.freeze([
  { find: "@bb/plugin-sdk/app", replacement: "@get-bb/plugin-sdk/app" },
  { find: "@bb/plugin-sdk", replacement: "@get-bb/plugin-sdk" },
]);
const HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Captured SVG browser proof</title></head>
  <body><script type="module" src="${ENTRY_PATH}"></script></body>
</html>`;

class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedError";
  }
}

class DriverError extends Error {
  constructor(message) {
    super(message);
    this.name = "DriverError";
  }
}

function boundedText(value, maximum = 1_500) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
}

function isWithin(child, parent) {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative));
}

async function packageMetadata(resolvedEntry, packageName) {
  if (!isWithin(resolvedEntry, communityNodeModules)) {
    throw new DriverError(`${packageName} resolved outside community node_modules: ${resolvedEntry}`);
  }
  let current = dirname(resolvedEntry);
  for (let depth = 0; depth < 8 && isWithin(current, communityNodeModules); depth += 1) {
    const packageJson = resolve(current, "package.json");
    try {
      const metadata = JSON.parse(await readFile(packageJson, "utf8"));
      if (metadata?.name === packageName && typeof metadata.version === "string") {
        return Object.freeze({ root: current, packageJson, metadata });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw new DriverError(`malformed package metadata for ${packageName}: ${boundedText(error)}`);
    }
    current = dirname(current);
  }
  throw new DriverError(`could not find package metadata for ${packageName}: ${resolvedEntry}`);
}

async function resolvePackage(packageName, expectedVersion, specifier = packageName) {
  let entry;
  try {
    entry = await realpath(requireFromAnalytics.resolve(specifier));
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new BlockedError(`missing browser package ${packageName}: ${boundedText(error)}`);
    }
    throw new DriverError(`could not resolve browser package ${packageName}: ${boundedText(error)}`);
  }
  const owner = await packageMetadata(entry, packageName);
  if (owner.metadata.version !== expectedVersion) {
    throw new DriverError(`${packageName} resolved version ${owner.metadata.version}, expected ${expectedVersion}`);
  }
  return Object.freeze({ name: packageName, version: owner.metadata.version, root: owner.root, entry });
}

async function resolveToolchain() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expectedDependencies = {
    "@get-bb/plugin-sdk": "0.4.15",
    "@playwright/test": "1.63.0",
    vite: "8.2.2",
  };
  for (const [name, version] of Object.entries(expectedDependencies)) {
    if (manifest.devDependencies?.[name] !== version) {
      throw new DriverError(`${name} is not pinned to ${version} in the Analytics manifest`);
    }
  }
  const sdk = await resolvePackage("@get-bb/plugin-sdk", "0.4.15", "@get-bb/plugin-sdk/testing/app");
  const playwright = await resolvePackage("@playwright/test", "1.63.0");
  const playwrightCore = await resolvePackage("playwright-core", "1.63.0");
  const vite = await resolvePackage("vite", "8.2.2");
  const browsersManifestPath = resolve(playwrightCore.root, "browsers.json");
  const browsersManifest = JSON.parse(await readFile(browsersManifestPath, "utf8"));
  const entries = Array.isArray(browsersManifest.browsers) ? browsersManifest.browsers : [];
  const headlessShell = entries.find((entry) => entry?.name === "chromium-headless-shell");
  if (headlessShell?.revision !== "1243") {
    throw new BlockedError("pinned Chromium headless-shell revision 1243 is unavailable");
  }
  const browserRootPath = resolve(playwrightCore.root, ".local-browsers");
  const selectedBrowserRoot = await realpath(resolve(browserRootPath, "chromium_headless_shell-1243"))
    .catch((error) => {
      if (error?.code === "ENOENT") throw new BlockedError(`package-local Chromium headless-shell 1243 is absent: ${browserRootPath}`);
      throw new DriverError(`package-local Chromium headless-shell is unreadable: ${boundedText(error)}`);
    });
  if (!isWithin(selectedBrowserRoot, browserRootPath)) {
    throw new DriverError(`selected Chromium is outside package-local browser root: ${selectedBrowserRoot}`);
  }
  return Object.freeze({
    sdk,
    playwright,
    playwrightCore,
    vite,
    browsers: Object.freeze({ manifest: browsersManifestPath, root: browserRootPath, selectedBrowserRoot, revision: headlessShell.revision }),
  });
}

function observeProcess(child) {
  const observed = {
    pid: Number.isInteger(child?.pid) ? child.pid : null,
    spawnfile: typeof child?.spawnfile === "string" ? child.spawnfile : null,
    spawnfileRealpath: null,
    exitObserved: false,
    closeObserved: false,
    exitCode: null,
    exitSignal: null,
  };
  let resolveClose;
  const closePromise = new Promise((resolveClosePromise) => { resolveClose = resolveClosePromise; });
  child.once("exit", (code, signal) => {
    observed.exitObserved = true;
    observed.exitCode = code;
    observed.exitSignal = signal;
  });
  child.once("close", (code, signal) => {
    observed.closeObserved = true;
    observed.exitCode = code;
    observed.exitSignal = signal;
    resolveClose();
  });
  return { observed, closePromise };
}

async function waitForClose(closePromise, timeoutMs = 3_000) {
  let timer;
  const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); });
  const closed = await Promise.race([closePromise.then(() => true), timeout]);
  clearTimeout(timer);
  return closed;
}

async function awaitWithTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DriverError(`${label} exceeded its ${timeoutMs}ms deadline`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function validateBrowserProcess(processObservation, selectedBrowserRoot) {
  if (processObservation == null || !Number.isInteger(processObservation.pid) || typeof processObservation.spawnfile !== "string") {
    throw new DriverError("Playwright browser process did not expose a public pid and spawnfile");
  }
  processObservation.spawnfileRealpath = await realpath(processObservation.spawnfile);
  if (!isWithin(processObservation.spawnfileRealpath, selectedBrowserRoot)) {
    throw new DriverError(`Playwright browser spawnfile resolved outside selected Chromium: ${processObservation.spawnfileRealpath}`);
  }
}

function validateLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new DriverError(`invalid Playwright WebSocket endpoint: ${boundedText(error)}`);
  }
  if (url.protocol !== "ws:" || url.hostname !== LOOPBACK || url.port === "") {
    throw new DriverError(`Playwright WebSocket endpoint is not loopback: ${endpoint}`);
  }
  return Object.freeze({ protocol: url.protocol, host: url.hostname, port: Number(url.port) });
}

function appendBounded(list, value, state) {
  if (list.length >= MAX_OBSERVATIONS) {
    state.overflow = true;
    return;
  }
  list.push(value);
}

function capturedSvgPlugin() {
  return {
    name: "bb-analytics-captured-svg-entry",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== HTML_PATH) return next();
        try {
          const html = await server.transformIndexHtml(HTML_PATH, HTML);
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function summarizeObservations(value) {
  assert.ok(value != null && typeof value === "object");
  assert.equal(typeof value.observedCount, "number");
  assert.equal(typeof value.overflow, "boolean");
  assert.ok(Array.isArray(value.charts));
  assert.ok(value.charts.length <= MAX_OBSERVATIONS);
  return Object.freeze({
    observedCount: value.observedCount,
    overflow: value.overflow,
    charts: value.charts.map((chart) => ({ id: chart.id, ssr: chart.ssr, disposed: chart.disposed, registered: chart.registered })),
  });
}

function summarizeAttempt(value) {
  if (value?.kind === "success") {
    return Object.freeze({
      kind: "success",
      svgBytes: value.output.byteLength,
      svgDigest: createHash("sha256").update(value.output.text, "utf8").digest("hex"),
      lineageBytes: value.output.lineageByteLength,
      lineageDigest: createHash("sha256").update(value.output.lineageText, "utf8").digest("hex"),
    });
  }
  return Object.freeze({ kind: value?.kind, name: value?.name, code: value?.code ?? null, message: boundedText(value?.message ?? "") });
}

function assertOwnTextBytes(text, reported, label) {
  assert.equal(Buffer.byteLength(text, "utf8"), reported, `${label} byteLength must measure its own UTF-8 text`);
}

function parseLineage(text, label) {
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_LINEAGE_BYTES, `${label} lineage exceeds the hard in-memory cap`);
  const value = JSON.parse(text);
  assert.equal(value.kind, "analytics-captured-data");
  return value;
}

function assertChartObservations(value, label, requireSsr = false) {
  const summary = summarizeObservations(value);
  assert.equal(summary.overflow, false, `${label} chart observation overflow`);
  assert.equal(summary.observedCount, summary.charts.length, `${label} observed count is inconsistent`);
  if (requireSsr) {
    assert.ok(summary.charts.some((chart) => chart.ssr), `${label} did not observe an SSR chart`);
  }
  return summary;
}

function assertDisposedSsr(value, label) {
  const summary = assertChartObservations(value, label, true);
  assert.ok(summary.charts.length > 0, `${label} observed no SSR chart`);
  assert.ok(summary.charts.every((chart) => chart.ssr && chart.disposed && !chart.registered), `${label} retained an SSR chart or non-SSR observation`);
  return summary;
}

function assertSessionExportDisposal(before, after, label) {
  const beforeSummary = assertChartObservations(before, `${label} before`);
  const afterSummary = assertChartObservations(after, `${label} after`);
  const beforeIds = new Set(beforeSummary.charts.map((chart) => chart.id));
  const afterById = new Map(afterSummary.charts.map((chart) => [chart.id, chart]));
  const liveBefore = beforeSummary.charts.filter((chart) => !chart.ssr && !chart.disposed && chart.registered);
  assert.ok(liveBefore.length > 0, `${label} started without a live registered chart`);
  for (const chart of liveBefore) {
    const same = afterById.get(chart.id);
    assert.ok(same != null, `${label} lost preexisting live chart ${chart.id}`);
    // ECharts 6.1 returns opts.ssr verbatim; an ordinary live init omits it.
    assert.ok(same.ssr === false || same.ssr === undefined, `${label} changed preexisting chart ${chart.id} into SSR`);
    // _disposed is likewise unset until ECharts.dispose() sets it to true.
    assert.ok(same.disposed === false || same.disposed === undefined, `${label} disposed preexisting live chart ${chart.id}`);
    assert.equal(same.registered, true, `${label} unregistered preexisting live chart ${chart.id}`);
  }
  const newlyObserved = afterSummary.charts.filter((chart) => !beforeIds.has(chart.id));
  assert.ok(newlyObserved.length > 0, `${label} acquired no SSR export chart`);
  assert.ok(newlyObserved.every((chart) => chart.ssr && chart.disposed && !chart.registered), `${label} retained an SSR export chart`);
  return afterSummary;
}

function assertSessionUnmountDisposal(value, label, requireOnlyLive = false) {
  const summary = assertChartObservations(value, label);
  assert.ok(summary.charts.length > 0, `${label} observed no chart instances`);
  assert.ok(summary.charts.every((chart) => chart.disposed && !chart.registered), `${label} retained a live or registered chart`);
  assert.ok(summary.charts.some((chart) => !chart.ssr), `${label} observed no live chart disposal`);
  if (requireOnlyLive) assert.ok(summary.charts.every((chart) => !chart.ssr), `${label} unexpectedly relied on an SSR chart`);
  return summary;
}

function assertSvgOutput(output, label, expectedLabels) {
  assertOwnTextBytes(output.text, output.byteLength, `${label} SVG`);
  assert.ok(output.byteLength > 0 && output.byteLength <= MAX_SVG_BYTES, `${label} SVG bytes are outside the hard cap`);
  assert.match(output.text, /^<svg\b/, `${label} must be an SVG root`);
  assert.match(output.text, /(?:width=["']960["']|viewBox=["']0 0 960 540["'])/, `${label} must carry the requested width`);
  assert.match(output.text, /(?:height=["']540["']|viewBox=["']0 0 960 540["'])/, `${label} must carry the requested height`);
  assertSemanticSvgMarks(output.text, label, expectedLabels.length);
  for (const labelText of expectedLabels) assert.ok(output.text.includes(labelText), `${label} omitted expected label ${labelText}`);
  assertOwnTextBytes(output.lineageText, output.lineageByteLength, `${label} image lineage`);
  const lineage = parseLineage(output.lineageText, `${label} image`);
  return lineage;
}

function assertSemanticSvgMarks(text, label, expectedCount) {
  const marks = [...text.matchAll(/<[^>]*>/g)]
    .map(([tag]) => ({
      series: tag.match(/\becmeta_series_index=["'](\d+)["']/)?.[1],
      data: tag.match(/\becmeta_data_index=["'](\d+)["']/)?.[1],
    }))
    .filter((mark) => mark.series != null && mark.data != null);
  assert.ok(marks.length > 0, `${label} contains no metadata-bearing ECharts marks`);
  assert.deepEqual([...new Set(marks.map((mark) => mark.series))], ["0"], `${label} must contain one authored series`);
  assert.deepEqual(
    [...new Set(marks.map((mark) => Number(mark.data)))].sort((left, right) => left - right),
    Array.from({ length: expectedCount }, (_, index) => index),
    `${label} metadata must identify every authored datum exactly once`,
  );
}

function assertExactLineage(lineage, expectedExecutionId, expectedKeys, expectedTheme) {
  const executionTag = expectedExecutionId === OLD_EXECUTION_ID ? "captured_a" : expectedExecutionId === NEW_EXECUTION_ID ? "captured_b" : "captured_boundary";
  const generation = executionTag.length;
  const capturedAtMs = RANGE.endExclusiveMs + executionTag.length;
  assert.equal(lineage.execution.executionId, expectedExecutionId);
  assert.equal(lineage.execution.bundleId, "captured-svg-proof");
  assert.equal(lineage.execution.bundleRevision, OLD_REVISION);
  assert.deepEqual(lineage.execution.snapshot, {
    version: 2,
    snapshotId: `analytics-snapshot_${executionTag}`,
    sourceScope: {
      scopeKey: `analytics-scope_${executionTag}`,
      projection: "tool_execution_fact_v1",
      storage: "plugin-owned-sqlite",
    },
    frozenRange: RANGE,
    capturedAtMs,
    coverage: expectedCoverage(generation, OLD_REVISION, capturedAtMs),
  });
  assert.deepEqual(lineage.execution.coverage, expectedCoverage(generation, OLD_REVISION, capturedAtMs));
  assert.equal(lineage.definition.bundle.id, "captured-svg-proof");
  assert.equal(lineage.definition.query.id, "failures");
  assert.equal(lineage.definition.query.revision, OLD_REVISION);
  assert.deepEqual(lineage.definition.query.parameters, PARAMETERS);
  assert.equal(lineage.definition.bundle.revision, OLD_REVISION);
  assert.equal(lineage.definition.bundle.title, "Captured SVG A");
  assert.equal(lineage.definition.query.title, "Old captured failures");
  assert.equal(lineage.definition.query.sql, OLD_SQL);
  assert.equal(lineage.definition.query.maxRows, 24);
  assert.equal(lineage.definition.figures[0]?.visualization.title, "Old failures");
  assert.equal(lineage.definition.figures[0]?.visualization.id, "failures");
  assert.equal(lineage.definition.figures[0]?.visualization.queryId, "failures");
  assert.equal(lineage.definition.figures[0]?.visualization.kind, "bar");
  assert.equal(lineage.definition.figures[0]?.visualization.x, "capability_key");
  assert.equal(lineage.definition.figures[0]?.visualization.y, "failures");
  assert.equal(lineage.definition.figures[0]?.visualization.format, "integer");
  assert.deepEqual(lineage.definition.figures[0]?.plotted, {
    plottedRows: expectedKeys.length,
    total: { kind: "exact", rows: expectedKeys.length },
    reduction: "none",
  });
  assert.deepEqual(lineage.figure.visualization, lineage.definition.figures[0]?.visualization);
  assert.deepEqual(lineage.figure.plotted, lineage.definition.figures[0]?.plotted);
  assert.deepEqual(lineage.result.columns, OLD_COLUMNS);
  assert.deepEqual(lineage.result.extent, { kind: "exact", rows: expectedKeys.length });
  assert.equal(lineage.result.truncated, false);
  assert.deepEqual(lineage.datumKeys, expectedKeys);
  assert.deepEqual(lineage.image.theme, expectedTheme);
  assert.deepEqual({
    width: lineage.image.width,
    height: lineage.image.height,
    devicePixelRatio: lineage.image.devicePixelRatio,
    renderer: lineage.image.renderer,
    animation: lineage.image.animation,
    viewportPolicy: lineage.image.viewportPolicy,
  }, {
    width: 960,
    height: 540,
    devicePixelRatio: 1,
    renderer: "svg",
    animation: "off",
    viewportPolicy: "full-canonical-plot",
  });
  assert.equal(typeof lineage.image.svgByteLength, "number");
}

function assertBoundaryDataLineage(lineage, scope, calibration) {
  const executionTag = "captured_boundary";
  const generation = executionTag.length;
  const capturedAtMs = RANGE.endExclusiveMs + executionTag.length;
  const expectedKeys = Array.from({ length: 24 }, (_, index) => `analytics-datum_${executionTag}_${index}`);
  assert.equal(lineage.scope, scope);
  assert.equal(lineage.execution.executionId, BOUNDARY_EXECUTION_ID);
  assert.equal(lineage.execution.bundleId, "captured-svg-proof");
  assert.equal(lineage.execution.bundleRevision, BOUNDARY_REVISION);
  assert.deepEqual(lineage.execution.snapshot.frozenRange, RANGE);
  assert.deepEqual(lineage.execution.coverage, expectedCoverage(generation, BOUNDARY_REVISION, capturedAtMs));
  assert.equal(lineage.definition.bundle.revision, BOUNDARY_REVISION);
  assert.equal(lineage.definition.query.id, "failures");
  assert.equal(lineage.definition.query.revision, BOUNDARY_REVISION);
  assert.equal(lineage.definition.query.title, "Boundary captured failures");
  assert.equal(lineage.definition.query.sql, `SELECT capability_key, failures FROM tool_execution_fact_v1 /*${"x".repeat(calibration.sqlCommentBytes)}*/`);
  assert.equal(lineage.definition.query.maxRows, 24);
  assert.deepEqual(lineage.definition.query.parameters, PARAMETERS);
  assert.equal(lineage.definition.figures[0]?.visualization.id, "failures");
  assert.equal(lineage.definition.figures[0]?.visualization.queryId, "failures");
  assert.equal(lineage.definition.figures[0]?.visualization.kind, "bar");
  assert.equal(lineage.definition.figures[0]?.visualization.x, "capability_key");
  assert.equal(lineage.definition.figures[0]?.visualization.y, "failures");
  assert.equal(lineage.definition.figures[0]?.visualization.format, "integer");
  assert.equal(lineage.definition.figures[0]?.visualization.title, "Boundary failures");
  assert.deepEqual(lineage.definition.figures[0]?.plotted, {
    plottedRows: expectedKeys.length,
    total: { kind: "exact", rows: expectedKeys.length },
    reduction: "none",
  });
  assert.equal(lineage.result.extent.kind, "exact");
  assert.equal(lineage.result.extent.rows, expectedKeys.length);
  assert.equal(lineage.result.truncated, false);
  assert.deepEqual(lineage.result.columns, [
    { name: "capability_key", logicalType: "utf8", nullable: false },
    { name: "failures", logicalType: "integer", nullable: false },
    ...Array.from({ length: calibration.extraColumnCount }, (_, index) => ({
      name: `boundary_${String(index).padStart(2, "0")}_${"x".repeat(58)}`,
      logicalType: "utf8",
      nullable: true,
    })),
  ]);
  assert.deepEqual(lineage.figure.plotted, lineage.definition.figures[0]?.plotted);
  assert.deepEqual(lineage.datumKeys, expectedKeys);
  assert.equal(lineage.nullCells.length, expectedKeys.length * calibration.extraColumnCount);
  assert.equal("image" in lineage, false);
}

async function pageOperation(page, name, argument = undefined) {
  return page.evaluate(async ({ name: operation, argument: value }) => {
    const api = globalThis.__bbCapturedSvgBrowser;
    if (api == null || typeof api[operation] !== "function") throw new Error(`Missing browser fixture operation ${operation}`);
    return await api[operation](value);
  }, { name, argument });
}

async function installNativeDownloadObserver(page) {
  return page.evaluate((maximumAttempts) => {
    const prototype = HTMLAnchorElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "click");
    let nativeDescriptor = descriptor;
    let owner = Object.getPrototypeOf(prototype);
    for (let depth = 0; nativeDescriptor == null && owner != null && depth < 8; depth += 1) {
      nativeDescriptor = Object.getOwnPropertyDescriptor(owner, "click");
      owner = Object.getPrototypeOf(owner);
    }
    if (nativeDescriptor == null || typeof nativeDescriptor.value !== "function") {
      throw new Error("native HTMLAnchorElement.click descriptor is unavailable");
    }
    const observation = { attempts: [], overflow: false };
    const nativeClick = nativeDescriptor.value;
    Object.defineProperty(prototype, "click", {
      ...nativeDescriptor,
      configurable: true,
      value: function observedNativeClick(...args) {
        if (observation.attempts.length >= maximumAttempts) {
          observation.overflow = true;
        } else {
          observation.attempts.push({
            href: this.href,
            download: this.getAttribute("download"),
          });
        }
        return Reflect.apply(nativeClick, this, args);
      },
    });
    globalThis.__bbCapturedSvgNativeDownloadObserver = { descriptor, observation };
    return true;
  }, MAX_DOWNLOAD_ATTEMPTS);
}

async function restoreNativeDownloadObserver(page) {
  return page.evaluate(() => {
    const state = globalThis.__bbCapturedSvgNativeDownloadObserver;
    if (state == null) throw new Error("native download observer was not installed");
    const facts = Object.freeze({
      attempts: state.observation.attempts.map((attempt) => Object.freeze({ ...attempt })),
      overflow: state.observation.overflow,
    });
    try {
      if (state.descriptor == null) {
        if (!Reflect.deleteProperty(HTMLAnchorElement.prototype, "click")) {
          throw new Error("could not restore inherited native anchor click");
        }
      } else {
        Object.defineProperty(HTMLAnchorElement.prototype, "click", state.descriptor);
      }
      return facts;
    } finally {
      delete globalThis.__bbCapturedSvgNativeDownloadObserver;
    }
  });
}

async function cancelReadable(stream, label) {
  if (stream == null) return;
  try {
    if (typeof stream.destroy === "function") {
      stream.destroy();
    } else if (typeof stream.cancel === "function") {
      await awaitWithTimeout(Promise.resolve(stream.cancel()), label, EMERGENCY_KILL_TIMEOUT_MS);
    }
  } catch {
    // The original stream failure or deadline remains the authoritative error.
  }
}

async function cancelDownload(download, label) {
  if (download == null || typeof download.cancel !== "function") return;
  await awaitWithTimeout(Promise.resolve(download.cancel()), label, EMERGENCY_KILL_TIMEOUT_MS);
}

async function readDownload(download, aggregateState) {
  const filename = download.suggestedFilename();
  const cap = filename.endsWith(".svg") ? MAX_SVG_BYTES : MAX_LINEAGE_BYTES;
  let stream = null;
  let reservedBytes = 0;
  try {
    const streamPromise = Promise.resolve().then(() => download.createReadStream());
    void streamPromise.catch(() => undefined);
    stream = await awaitWithTimeout(streamPromise, `${filename} stream acquisition`, DOWNLOAD_STREAM_TIMEOUT_MS);
    if (stream == null) throw new DriverError(`download stream unavailable for ${filename}`);
    const chunks = [];
    let total = 0;
    const consume = (async () => {
      for await (const chunk of stream) {
        const chunkBytes = chunk?.byteLength;
        if (!Number.isInteger(chunkBytes) || chunkBytes < 0) throw new DriverError(`invalid byte chunk from ${filename}`);
        if (total + chunkBytes > cap) throw new DriverError(`${filename} exceeded its ${cap}-byte in-memory read cap`);
        if (aggregateState.reservedBytes + chunkBytes > MAX_DOWNLOAD_AGGREGATE_BYTES) {
          throw new DriverError(`download aggregate exceeded its ${MAX_DOWNLOAD_AGGREGATE_BYTES}-byte cap`);
        }
        aggregateState.reservedBytes += chunkBytes;
        reservedBytes += chunkBytes;
        total += chunkBytes;
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, total);
      return Object.freeze({
        filename,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        text: bytes.toString("utf8"),
      });
    })();
    void consume.catch(() => undefined);
    return await awaitWithTimeout(consume, `${filename} stream completion`, DOWNLOAD_STREAM_TIMEOUT_MS);
  } catch (error) {
    await cancelReadable(stream, `${filename} stream cancellation`);
    try {
      await cancelDownload(download, `${filename} download cancellation`);
    } catch {
      // Preserve the first stream, cap, or deadline failure.
    }
    aggregateState.reservedBytes -= reservedBytes;
    throw error;
  }
}

async function captureDownloads(page, operation, expectedDownloads) {
  const pending = [];
  const observedDownloads = [];
  const aggregateState = { reservedBytes: 0 };
  let attempts = 0;
  let firstFailure = null;
  let nativeObservation = null;
  const rememberFailure = (error) => {
    firstFailure ??= error;
  };
  await installNativeDownloadObserver(page);
  const listener = (download) => {
    attempts += 1;
    if (attempts > MAX_DOWNLOAD_ATTEMPTS) {
      rememberFailure(new DriverError(`download attempt count exceeded ${MAX_DOWNLOAD_ATTEMPTS}`));
      page.off("download", listener);
      void cancelDownload(download, "overflow download cancellation").catch(rememberFailure);
      void awaitWithTimeout(page.close(), "overflow download page teardown", CLEANUP_OPERATION_TIMEOUT_MS).catch(rememberFailure);
      return;
    }
    observedDownloads.push(download);
    const observed = readDownload(download, aggregateState).catch((error) => {
      rememberFailure(error);
      throw error;
    });
    pending.push(observed);
    void observed.catch(() => undefined);
  };
  page.on("download", listener);
  let result;
  let failure = null;
  try {
    const operationDeadline = Date.now() + DOWNLOAD_OPERATION_TIMEOUT_MS;
    const operationPromise = Promise.resolve().then(operation);
    void operationPromise.catch(() => undefined);
    result = await awaitWithTimeout(operationPromise, "download operation", DOWNLOAD_OPERATION_TIMEOUT_MS);
    const eventDeadline = operationDeadline;
    while (pending.length < expectedDownloads && Date.now() < eventDeadline) {
      await page.waitForTimeout(25);
    }
    if (pending.length < expectedDownloads) {
      throw new DriverError(`expected ${expectedDownloads} download events before the operation deadline`);
    }
    if (expectedDownloads > 0) {
      const completion = Promise.all(pending);
      void completion.catch(() => undefined);
      await awaitWithTimeout(completion, "download stream completion set", Math.max(1, eventDeadline - Date.now()));
    } else {
      await page.waitForTimeout(DOWNLOAD_SETTLE_TIMEOUT_MS);
    }
  } catch (error) {
    failure = error;
    await page.waitForTimeout(DOWNLOAD_SETTLE_TIMEOUT_MS);
  } finally {
    page.off("download", listener);
    const pendingCompletion = Promise.allSettled(pending);
    void pendingCompletion.catch(() => undefined);
    try {
      await awaitWithTimeout(pendingCompletion, "download cleanup", DOWNLOAD_SETTLE_TIMEOUT_MS);
    } catch (error) {
      rememberFailure(error);
      const cancellation = Promise.allSettled(observedDownloads.map((download) => cancelDownload(download, "download cleanup cancellation").catch(rememberFailure)));
      void cancellation.catch(() => undefined);
      try {
        await awaitWithTimeout(cancellation, "download cleanup cancellation", EMERGENCY_KILL_TIMEOUT_MS);
      } catch (cancellationError) {
        rememberFailure(cancellationError);
      }
    }
    try {
      nativeObservation = await restoreNativeDownloadObserver(page);
    } catch (error) {
      rememberFailure(error);
    }
  }
  if (failure != null) throw failure;
  if (firstFailure != null) throw firstFailure;
  if (attempts !== expectedDownloads) {
    throw new DriverError(`expected ${expectedDownloads} download attempts, observed ${attempts}`);
  }
  const downloads = await Promise.all(pending);
  return Object.freeze({
    result,
    downloads,
    nativeDownloadAttempts: nativeObservation?.attempts ?? [],
    nativeDownloadOverflow: nativeObservation?.overflow === true,
  });
}

function expectedCoverage(generation, revision, capturedAtMs) {
  return {
    coverageRevision: generation,
    retention: {
      startInclusiveMs: RANGE.startInclusiveMs,
      earliestVerifiedRetainedInclusiveMs: RANGE.startInclusiveMs,
      endExclusiveMs: capturedAtMs,
      policyDays: 90,
    },
    observed: {
      earliestFactMs: RANGE.startInclusiveMs,
      latestFactMs: RANGE.endExclusiveMs,
      asOfMs: capturedAtMs,
      projectionGeneration: generation,
      projectionRevision: revision,
    },
    population: {
      candidateThreads: 4,
      selectedThreads: 4,
      loadedThreads: 4,
      retainedFacts: 4,
      cappedThreads: 0,
      listPages: 1,
      eventPages: 1,
      eventBytes: 256,
      safeFailureCount: 0,
      lastSafeFailureAtMs: null,
      candidateThreadLimit: 200,
      threadPageLimit: 200,
      eventPageLimit: 100,
      maxEventsPerThread: 500,
      maxEventBytes: 1_000,
    },
    mode: "partial-retained-projection",
    incompleteReasons: ["backfill-in-progress"],
    backfill: { state: "partial", direction: "newest-to-oldest", completeRange: null, resumable: true },
    reconciliation: {
      observedAsOfMs: capturedAtMs,
      lastFullReconciliationAtMs: null,
      deletionConfirmation: "pending-retry",
      sourceSemantics: "eventually-reconciled-observed-as-of",
    },
    degraded: false,
  };
}

function assertDownloadPair(downloads, expectedExecutionId, expectedKeys, expectedTheme) {
  assert.equal(downloads.length, 2, "successful menu export must create exactly SVG and lineage downloads");
  const svg = downloads.find((download) => download.filename.endsWith(".svg"));
  const lineageDownload = downloads.find((download) => download.filename.endsWith("-lineage.json"));
  assert.ok(svg != null && lineageDownload != null, "successful menu export must contain the SVG/lineage pair");
  assert.ok(svg.byteLength <= MAX_SVG_BYTES);
  assert.ok(lineageDownload.byteLength <= MAX_LINEAGE_BYTES);
  const lineage = assertSvgOutput({
    text: svg.text,
    byteLength: svg.byteLength,
    lineageText: lineageDownload.text,
    lineageByteLength: lineageDownload.byteLength,
  }, "menu export", expectedLabelsForExecution(expectedExecutionId));
  assert.equal(lineage.image.svgByteLength, svg.byteLength);
  assertExactLineage(lineage, expectedExecutionId, expectedKeys, expectedTheme);
  assert.ok(!svg.text.includes(expectedExecutionId), "SVG must not embed execution identity");
  assert.ok(!svg.text.includes("SELECT capability_key"), "SVG must not embed SQL");
  for (const key of expectedKeys) assert.ok(!svg.text.includes(key), `SVG must not embed datum key ${key}`);
  return Object.freeze({
    svgBytes: svg.byteLength,
    svgDigest: svg.sha256,
    lineageBytes: lineageDownload.byteLength,
    lineageDigest: lineageDownload.sha256,
  });
}

function expectedLabelsForExecution(executionId) {
  return executionId === OLD_EXECUTION_ID ? OLD_LABELS : executionId === NEW_EXECUTION_ID ? NEW_LABELS : [];
}

function assertExactRequests(requests, expectedCount, label) {
  assert.equal(requests.length, expectedCount, `${label} dispatched an unexpected number of queries`);
  requests.forEach((request, index) => {
    assert.deepEqual(request.locator, {
      bundleId: "captured-svg-proof",
      queryId: "failures",
      range: RANGE,
      parameters: PARAMETERS,
    }, `${label} locator ${index} drifted from the authored request`);
    assert.equal(request.settled, true, `${label} request ${index} did not settle`);
    assert.equal(request.aborted, false, `${label} request ${index} was aborted`);
    assert.equal(request.signalAborted, false, `${label} request ${index} signal remained aborted`);
  });
}

function assertNativeDownloadAttempts(value, expectedCount, label) {
  assert.equal(value.nativeDownloadOverflow, false, `${label} native anchor observation overflowed`);
  assert.equal(value.nativeDownloadAttempts.length, expectedCount, `${label} observed an unexpected number of native anchor downloads`);
}

function assertAttemptSuccess(attempt, label) {
  assert.equal(attempt.kind, "success", `${label} must succeed: ${attempt.message ?? ""}`);
  return attempt.output;
}

async function runCases(page) {
  const cases = [];
  const record = (name, facts) => {
    if (cases.length >= MAX_CASES) throw new DriverError("captured SVG case receipt overflow");
    cases.push(Object.freeze({ name, status: "pass", facts }));
  };

  const budget = await pageOperation(page, "standalone", "budgets");
  const productionOutput = assertAttemptSuccess(budget.production, "production SVG");
  const consumerOutput = assertAttemptSuccess(budget.consumer, "fixed consumer SVG");
  assertSvgOutput(productionOutput, "production SVG", OLD_LABELS);
  assertSvgOutput(consumerOutput, "fixed consumer SVG", OLD_LABELS);
  assert.ok(consumerOutput.byteLength <= CONSUMER_MAX_SVG_BYTES, "fixed consumer SVG exceeded its stricter quota");
  assert.equal(budget.tooSmall.kind, "error");
  assert.equal(budget.tooSmall.code, "svg-too-large");
  assertDisposedSsr(budget.observations.production, "production budget");
  assertDisposedSsr(budget.observations.consumer, "consumer budget");
  assertDisposedSsr(budget.observations.tooSmall, "too-small budget");
  record("production-and-fixed-consumer-quota-plus-too-small", {
    production: summarizeAttempt(budget.production),
    consumer: summarizeAttempt(budget.consumer),
    tooSmall: summarizeAttempt(budget.tooSmall),
  });

  const mutation = await pageOperation(page, "standalone", "mutation");
  const before = assertSvgOutput(mutation.before, "mutation before", OLD_LABELS);
  const after = assertSvgOutput(mutation.after, "mutation after", OLD_LABELS);
  assertExactLineage(before, OLD_EXECUTION_ID, OLD_LABELS.map((_, index) => `analytics-datum_captured_a_${index}`), OLD_THEME);
  assertExactLineage(after, OLD_EXECUTION_ID, OLD_LABELS.map((_, index) => `analytics-datum_captured_a_${index}`), OLD_THEME);
  assertDisposedSsr(mutation.observations.before, "mutation before");
  assertDisposedSsr(mutation.observations.after, "mutation after");
  record("same-artifact-after-caller-graph-mutation", {
    before: { svgBytes: mutation.before.byteLength, lineageBytes: mutation.before.lineageByteLength },
    after: { svgBytes: mutation.after.byteLength, lineageBytes: mutation.after.lineageByteLength },
  });

  const abort = await pageOperation(page, "standalone", "abort");
  assert.equal(abort.pre.error.kind, "error");
  assert.equal(abort.pre.error.code, "aborted");
  assert.equal(abort.pre.acquired, 0);
  assert.equal(abort.pre.observations.observedCount, 0);
  assert.equal(abort.post.error.kind, "error");
  assert.equal(abort.post.error.code, "aborted");
  assert.equal(abort.post.aborted, true);
  assertDisposedSsr(abort.post.observations, "actual post-acquisition abort");
  record("pre-abort-zero-acquisition-and-post-init-abort-disposal", {
    preAcquired: abort.pre.acquired,
    post: summarizeObservations(abort.post.observations),
  });

  const lineageFailure = await pageOperation(page, "standalone", "lineage-failure");
  assert.ok(lineageFailure.boundaryCalibration != null, "boundary lineage case omitted independent calibration");
  assert.ok(lineageFailure.dataLineage != null, "boundary lineage case did not produce data lineages before SVG rendering");
  const boundaryCalibration = lineageFailure.boundaryCalibration;
  const boundaryDataLineage = lineageFailure.dataLineage;
  assert.equal(boundaryDataLineage.plotted.byteLength, Buffer.byteLength(boundaryDataLineage.plotted.text, "utf8"));
  assert.equal(boundaryDataLineage.result.byteLength, Buffer.byteLength(boundaryDataLineage.result.text, "utf8"));
  assert.equal(boundaryDataLineage.plotted.byteLength, boundaryCalibration.plottedDataLineageBytes);
  assert.equal(boundaryDataLineage.result.byteLength, boundaryCalibration.resultDataLineageBytes);
  assert.ok(boundaryDataLineage.plotted.byteLength < MAX_LINEAGE_BYTES, "boundary plotted data lineage must fit the hard cap");
  assert.ok(boundaryDataLineage.result.byteLength < MAX_LINEAGE_BYTES, "boundary result data lineage must fit the hard cap");
  assert.ok(boundaryCalibration.imageLineageMinimumBytes > MAX_LINEAGE_BYTES, "boundary image manifest arithmetic must cross the hard cap");
  assertBoundaryDataLineage(parseLineage(boundaryDataLineage.plotted.text, "boundary plotted data"), "plotted", boundaryCalibration);
  assertBoundaryDataLineage(parseLineage(boundaryDataLineage.result.text, "boundary result data"), "result", boundaryCalibration);
  assert.equal(lineageFailure.stage, "post-render-lineage");
  assert.equal(lineageFailure.error.kind, "error");
  assert.equal(lineageFailure.error.code, "lineage-too-large");
  assertDisposedSsr(lineageFailure.observations, "standalone post-render lineage failure");
  record("post-render-image-lineage-failure", {
    stage: lineageFailure.stage,
    errorCode: lineageFailure.error.code,
    observations: summarizeObservations(lineageFailure.observations),
  });

  await pageOperation(page, "mount", "normal");
  const ready = await pageOperation(page, "ready");
  assert.equal(ready.datumText, OLD_LABELS[0]);
  assert.deepEqual(ready.resolvedTheme, OLD_THEME);
  assertChartObservations(ready.observations, "normal readiness");
  assert.ok(ready.observations.charts.some((chart) => !chart.ssr && !chart.disposed && chart.registered), "normal readiness lacked a live registered chart");
  assertExactRequests(ready.requests, 1, "normal readiness");
  const host = await page.locator(".analytics-echart").first().boundingBox();
  assert.ok(host != null && host.width > 0 && host.height > 0, "real chart host did not have nonzero dimensions");
  const opened = await pageOperation(page, "openMenu");
  const svgMenu = opened.items.find((item) => item.label === "Export SVG + lineage");
  assert.ok(svgMenu != null && svgMenu.disabled === false, "normal SVG menu item was not enabled");
  const themed = await pageOperation(page, "changeTheme", "captured-svg-new");
  assert.deepEqual(themed.capturedTheme, OLD_THEME);
  assert.deepEqual(themed.currentTheme, NEW_THEME);
  const edited = await pageOperation(page, "updateEdited");
  assert.ok(edited.text.includes("new-failures"), "edited browser revision did not commit its new label");
  assertExactRequests(edited.requests, 2, "edited revision");
  const normalExport = await captureDownloads(page, () => pageOperation(page, "exportCapturedSvg"), 2);
  assertNativeDownloadAttempts(normalExport, 2, "successful menu export");
  assert.equal(normalExport.result.statusText, "");
  assert.deepEqual(normalExport.result.capturedTheme, OLD_THEME);
  assert.deepEqual(normalExport.result.currentTheme, NEW_THEME);
  const downloadFacts = assertDownloadPair(normalExport.downloads, OLD_EXECUTION_ID, OLD_LABELS.map((_, index) => `analytics-datum_captured_a_${index}`), OLD_THEME);
  assertSessionExportDisposal(normalExport.result.observedBefore, normalExport.result.observedAfter, "successful menu SSR export");
  record("old-menu-capture-survives-bundle-result-theme-edit", {
    capturedTheme: normalExport.result.capturedTheme,
    currentTheme: normalExport.result.currentTheme,
    downloads: downloadFacts,
  });
  const normalUnmount = await pageOperation(page, "unmount");
  assertSessionUnmountDisposal(normalUnmount, "normal unmount");
  record("normal-unmount-cleanup", summarizeObservations(normalUnmount));

  await pageOperation(page, "mount", "boundary");
  const boundaryReady = await pageOperation(page, "ready");
  assert.equal(boundaryReady.datumText, "boundary-00");
  assert.deepEqual(boundaryReady.resolvedTheme, OLD_THEME);
  assertChartObservations(boundaryReady.observations, "boundary readiness");
  assert.ok(boundaryReady.observations.charts.some((chart) => !chart.ssr && !chart.disposed && chart.registered), "boundary readiness lacked a live registered chart");
  assertExactRequests(boundaryReady.requests, 1, "boundary readiness");
  const boundaryMenu = await pageOperation(page, "openMenu");
  const boundarySvgMenu = boundaryMenu.items.find((item) => item.label === "Export SVG + lineage");
  assert.ok(boundarySvgMenu != null && boundarySvgMenu.disabled === false, "boundary SVG menu was disabled before rendering");
  const boundaryExport = await captureDownloads(page, () => pageOperation(page, "exportCapturedSvg"), 0);
  assertNativeDownloadAttempts(boundaryExport, 0, "post-render lineage failure");
  assert.equal(boundaryExport.downloads.length, 0, "post-render lineage failure must produce no partial downloads");
  assert.match(boundaryExport.result.statusText, /lineage/i);
  assertSessionExportDisposal(boundaryExport.result.observedBefore, boundaryExport.result.observedAfter, "menu post-render lineage failure");
  record("menu-post-render-image-lineage-failure-zero-downloads", {
    statusText: boundaryExport.result.statusText,
    observations: summarizeObservations(boundaryExport.result.observedAfter),
  });
  const boundaryUnmount = await pageOperation(page, "unmount");
  assertSessionUnmountDisposal(boundaryUnmount, "boundary unmount");

  await pageOperation(page, "mount", "normal");
  const remountReady = await pageOperation(page, "ready");
  assert.equal(remountReady.datumText, OLD_LABELS[0]);
  assert.deepEqual(remountReady.resolvedTheme, OLD_THEME);
  assertChartObservations(remountReady.observations, "remount readiness");
  assert.ok(remountReady.observations.charts.some((chart) => !chart.ssr && !chart.disposed && chart.registered), "remount readiness lacked a live registered chart");
  assertExactRequests(remountReady.requests, 1, "remount readiness");
  const remountUnmount = await pageOperation(page, "unmount");
  assertSessionUnmountDisposal(remountUnmount, "remount cleanup", true);
  record("unmount-remount-cleanup", summarizeObservations(remountUnmount));

  return cases;
}

async function runChild() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;
  let viteServer = null;
  let httpServer = null;
  let browserServer = null;
  let browser = null;
  let context = null;
  let page = null;
  let temporaryDirectory = null;
  let temporaryDirectoryRemoved = false;
  let viteCloseObserved = false;
  let browserServerCloseObserved = false;
  let browserServerKillCalled = false;
  let browserProcessObservation = null;
  let browserProcessClosePromise = null;
  let browserServerLaunchPromise = null;
  let browserServerKillPromise = null;
  let browserServerKillInFlight = null;
  let browserServerAttached = false;
  let browserLaunchTimedOut = false;
  let browserLaunchLateKillObserved = false;
  let browserLaunchLateKillError = null;
  let browserLaunchAcquisitionWaitTimedOut = false;
  let serverEvidence = null;
  let browserEvidence = null;
  let cleanupPromise = null;
  let signalRequested = false;
  let signalCleanupError = null;
  let acquisitionsStoppedResolve;
  const acquisitionsStopped = new Promise((resolveAcquisitionsStopped) => { acquisitionsStoppedResolve = resolveAcquisitionsStopped; });
  let acquisitionsStoppedCalled = false;
  const sockets = new Set();
  const cleanupErrors = [];
  let connectionObserved = 0;
  let connectionOverflow = false;
  const browserObservationState = { overflow: false };

  const markAcquisitionsStopped = () => {
    if (acquisitionsStoppedCalled) return;
    acquisitionsStoppedCalled = true;
    acquisitionsStoppedResolve();
  };
  const throwIfSignalRequested = (stage) => {
    if (signalRequested) throw new BlockedError(`supervisor requested SIGTERM before ${stage}`);
  };
  const attachBrowserServer = (server) => {
    if (browserServerAttached) return;
    browserServer = server;
    browserServerAttached = true;
    browserServer.once("close", () => { browserServerCloseObserved = true; });
    const browserProcess = browserServer.process();
    if (browserProcess == null) {
      cleanupErrors.push("Playwright BrowserServer exposed no public process");
      return;
    }
    ({ observed: browserProcessObservation, closePromise: browserProcessClosePromise } = observeProcess(browserProcess));
  };
  const killAttachedBrowserServer = () => {
    if (browserServer == null) return Promise.resolve(false);
    if (browserServerKillCalled) return Promise.resolve(true);
    if (browserServerKillInFlight != null) return browserServerKillInFlight;
    const server = browserServer;
    browserServerKillInFlight = (async () => {
      browserServerKillCalled = true;
      try {
        await awaitWithTimeout(Promise.resolve(server.kill()), "browserServer.kill", EMERGENCY_KILL_TIMEOUT_MS);
        return true;
      } catch (error) {
        cleanupErrors.push(`browserServer.kill: ${boundedText(error)}`);
        return false;
      } finally {
        browserServerKillInFlight = null;
      }
    })();
    return browserServerKillInFlight;
  };
  const killBrowserServer = () => {
    if (browserServerKillPromise != null) return browserServerKillPromise;
    if (browserServer != null) return killAttachedBrowserServer();
    if (browserServerLaunchPromise == null) return Promise.resolve(false);
    const launch = browserServerLaunchPromise;
    browserServerKillPromise = (async () => {
      let server;
      try {
        server = await awaitWithTimeout(launch, "browser server acquisition for cleanup", EMERGENCY_ACQUISITION_TIMEOUT_MS);
      } catch (error) {
        browserLaunchAcquisitionWaitTimedOut = error instanceof DriverError
          && error.message.includes("browser server acquisition for cleanup exceeded");
        cleanupErrors.push(`browserServer acquisition cleanup: ${boundedText(error)}`);
        return false;
      }
      attachBrowserServer(server);
      return await killAttachedBrowserServer();
    })();
    return browserServerKillPromise;
  };
  const requestCleanup = (reason) => {
    if (cleanupPromise != null) return cleanupPromise;
    cleanupPromise = (async () => {
      const close = async (label, operation) => {
        if (operation == null) return;
        try {
          const closePromise = Promise.resolve().then(operation);
          void closePromise.catch(() => undefined);
          await awaitWithTimeout(closePromise, label, CLEANUP_OPERATION_TIMEOUT_MS);
        } catch (error) {
          cleanupErrors.push(`${label}: ${boundedText(error)}`);
        }
      };
      const emergency = reason === "sigterm" || signalRequested;
      if (emergency) {
        await close("browserServer.kill", killBrowserServer);
        if (browserProcessClosePromise != null) await waitForClose(browserProcessClosePromise);
      }
      await acquisitionsStopped;
      const cleanup = {
        reason,
        pageClosed: false,
        contextClosed: false,
        browserConnectionClosed: false,
        browserServerKillCalled: false,
        browserServerCloseObserved: false,
        browserProcessExitObserved: false,
        browserProcessCloseObserved: false,
        browserLaunchTimedOut,
        browserLaunchAcquisitionWaitTimedOut,
        browserLaunchLateKillObserved,
        browserLaunchLateKillError,
        viteServerCloseObserved: false,
        viteListeningAfterClose: false,
        connectionObserved,
        connectionOverflow,
        browserObservationOverflow: browserObservationState.overflow,
        openSocketsAfterClose: null,
        socketCleanupObserved: false,
        temporaryDirectory,
        temporaryDirectoryRemoved: false,
        errors: cleanupErrors,
      };
      await close("page.close", async () => {
        if (page == null) return;
        await page.close();
        cleanup.pageClosed = page.isClosed();
      });
      await close("context.close", async () => {
        if (context == null) return;
        await context.close();
        cleanup.contextClosed = true;
      });
      await close("browser.close", async () => {
        if (browser == null) return;
        await browser.close();
        cleanup.browserConnectionClosed = !browser.isConnected();
      });
      if (!emergency && browserServerKillPromise == null) await close("browserServer.close", async () => {
        if (browserServer == null) return;
        await browserServer.close();
      });
      if (browserProcessClosePromise != null) await waitForClose(browserProcessClosePromise);
      cleanup.browserServerKillCalled = browserServerKillCalled;
      cleanup.browserServerCloseObserved = browserServerCloseObserved;
      cleanup.browserProcessExitObserved = browserProcessObservation?.exitObserved === true;
      cleanup.browserProcessCloseObserved = browserProcessObservation?.closeObserved === true;
      await close("vite.close", async () => {
        if (viteServer == null) return;
        await viteServer.close();
      });
      cleanup.viteServerCloseObserved = viteCloseObserved;
      cleanup.viteListeningAfterClose = httpServer != null && httpServer.listening === false;
      cleanup.openSocketsAfterClose = sockets.size;
      cleanup.socketCleanupObserved = httpServer != null && cleanup.viteListeningAfterClose && sockets.size === 0;
      if (httpServer != null) httpServer.removeAllListeners("connection");
      await close("temporaryDirectory.rm", async () => {
        if (temporaryDirectory == null) return;
        await rm(temporaryDirectory, { recursive: true, force: false });
        try {
          await realpath(temporaryDirectory);
          throw new DriverError(`temporary Vite cache directory still exists: ${temporaryDirectory}`);
        } catch (error) {
          if (error?.code === "ENOENT") {
            temporaryDirectoryRemoved = true;
            cleanup.temporaryDirectoryRemoved = true;
            return;
          }
          throw error;
        }
      });
      cleanup.temporaryDirectoryRemoved = temporaryDirectoryRemoved;
      return cleanup;
    })();
    return cleanupPromise;
  };
  const onSigterm = () => {
    signalRequested = true;
    void killBrowserServer().catch((error) => { signalCleanupError = boundedText(error); });
    void requestCleanup("sigterm").catch((error) => { signalCleanupError = boundedText(error); });
  };
  process.once("SIGTERM", onSigterm);

  let status = "pass";
  let failure = null;
  let toolchain = null;
  let cases = [];
  let pageErrors = [];
  let externalRequests = [];
  try {
    throwIfSignalRequested("toolchain resolution");
    toolchain = await resolveToolchain();
    throwIfSignalRequested("Playwright import");
    const { chromium } = await import("@playwright/test");
    throwIfSignalRequested("Vite import");
    const { createServer } = await import("vite");
    throwIfSignalRequested("Vite creation");
    if (typeof chromium?.launchServer !== "function") throw new DriverError("public chromium.launchServer() is unavailable");
    if (typeof createServer !== "function") throw new DriverError("public Vite createServer() is unavailable");
    throwIfSignalRequested("temporary cache acquisition");
    temporaryDirectory = await mkdtemp(join(tmpdir(), "bb-analytics-captured-svg-"));
    throwIfSignalRequested("temporary cache acquisition completion");
    throwIfSignalRequested("Vite creation");
    viteServer = await createServer({
      root: analyticsRoot,
      cacheDir: temporaryDirectory,
      configFile: false,
      envDir: false,
      resolve: { alias: SDK_ALIASES },
      server: { host: LOOPBACK, port: 0, strictPort: true, watch: null, hmr: false },
      plugins: [capturedSvgPlugin()],
    });
    throwIfSignalRequested("Vite creation completion");
    httpServer = viteServer.httpServer;
    if (httpServer == null) throw new DriverError("Vite did not expose its public HTTP server");
    httpServer.on("connection", (socket) => {
      if (connectionObserved >= MAX_OBSERVATIONS) connectionOverflow = true;
      else connectionObserved += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    httpServer.once("close", () => { viteCloseObserved = true; });
    throwIfSignalRequested("Vite listen");
    await viteServer.listen();
    throwIfSignalRequested("Vite listen completion");
    throwIfSignalRequested("Vite address acquisition");
    const address = httpServer.address();
    if (address == null || typeof address === "string" || address.address !== LOOPBACK || !Number.isInteger(address.port) || address.port <= 0) {
      throw new DriverError("Vite did not bind a loopback ephemeral port");
    }
    serverEvidence = Object.freeze({
      root: analyticsRoot,
      cacheDir: temporaryDirectory,
      configFile: false,
      envDir: false,
      aliases: SDK_ALIASES,
      host: address.address,
      port: address.port,
      watch: null,
      hmr: false,
      listening: httpServer.listening,
      fixtureUrl: `http://${LOOPBACK}:${address.port}${HTML_PATH}`,
      connectionObserved,
      connectionOverflow,
    });
    throwIfSignalRequested("browser launch");
    const launchPromise = Promise.resolve().then(() => chromium.launchServer({
      headless: true, host: LOOPBACK, port: 0, timeout: BROWSER_LAUNCH_TIMEOUT_MS,
    }));
    browserServerLaunchPromise = launchPromise;
    void launchPromise.then((server) => {
      attachBrowserServer(server);
      if (browserLaunchTimedOut || signalRequested) {
        void killAttachedBrowserServer().then((killed) => {
          if (killed) browserLaunchLateKillObserved = true;
        }).catch((error) => {
          browserLaunchLateKillError = boundedText(error);
          cleanupErrors.push(`late browserServer.kill: ${browserLaunchLateKillError}`);
        });
      }
    }, (error) => {
      if (browserLaunchTimedOut || signalRequested) cleanupErrors.push(`late browserServer.launch: ${boundedText(error)}`);
    });
    try {
      attachBrowserServer(await awaitWithTimeout(launchPromise, "browser server launch", BROWSER_LAUNCH_TIMEOUT_MS));
      browserServerLaunchPromise = null;
    } catch (error) {
      if (error instanceof DriverError && error.message.includes("browser server launch exceeded")) {
        browserLaunchTimedOut = true;
        cleanupErrors.push(`browserServer.launch timeout: ${error.message}`);
        await killBrowserServer();
      }
      throw error;
    } finally {
      if (!browserLaunchTimedOut && browserServer != null) browserServerLaunchPromise = null;
    }
    if (signalRequested) await killBrowserServer();
    throwIfSignalRequested("browser server acquisition");
    if (browserServer == null || browserProcessObservation == null) throw new DriverError("Playwright BrowserServer acquisition was incomplete");
    await validateBrowserProcess(browserProcessObservation, toolchain.browsers.selectedBrowserRoot);
    throwIfSignalRequested("browser process validation completion");
    const wsEndpoint = validateLoopbackEndpoint(browserServer.wsEndpoint());
    browserEvidence = {
      headless: true,
      version: null,
      executablePath: browserProcessObservation.spawnfileRealpath,
      process: browserProcessObservation,
      webSocketEndpoint: wsEndpoint,
      connectionEndpointUsed: false,
    };
    throwIfSignalRequested("browser connect");
    browser = await chromium.connect(browserServer.wsEndpoint());
    throwIfSignalRequested("browser connect completion");
    browserEvidence = { ...browserEvidence, version: browser.version(), connectionEndpointUsed: true };
    throwIfSignalRequested("browser context creation");
    context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
    throwIfSignalRequested("browser context creation completion");
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.protocol !== "http:" || requestUrl.hostname !== LOOPBACK || requestUrl.port !== String(address.port)) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    throwIfSignalRequested("browser page creation");
    page = await context.newPage();
    throwIfSignalRequested("browser page creation completion");
    page.on("pageerror", (error) => appendBounded(pageErrors, boundedText(error), browserObservationState));
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.protocol !== "http:" || requestUrl.hostname !== LOOPBACK || requestUrl.port !== String(address.port)) {
        appendBounded(externalRequests, request.url(), browserObservationState);
      }
    });
    throwIfSignalRequested("browser navigation");
    const response = await page.goto(`http://${LOOPBACK}:${address.port}${HTML_PATH}`, { waitUntil: "load", timeout: 10_000 });
    throwIfSignalRequested("browser navigation completion");
    if (response == null || response.status() >= 400) throw new DriverError(`captured SVG entry did not load: ${response?.status() ?? "no response"}`);
    await page.locator("body[data-captured-svg-ready=\"1\"]").waitFor({ state: "attached", timeout: 10_000 });
    throwIfSignalRequested("post-body readiness");
    if (browserObservationState.overflow) throw new DriverError("bounded browser observation capacity overflowed");
    if (externalRequests.length > 0) throw new DriverError(`browser entry attempted external requests: ${externalRequests.join(", ")}`);
    if (pageErrors.length > 0) throw new DriverError(`browser entry page error: ${pageErrors.join("; ")}`);
    cases = await runCases(page);
    throwIfSignalRequested("captured SVG cases completion");
  } catch (error) {
    status = error instanceof BlockedError ? "blocked" : "fail";
    failure = boundedText(error);
  } finally {
    markAcquisitionsStopped();
    const cleanup = await requestCleanup(signalRequested ? "sigterm" : "finally");
    if (signalCleanupError != null) cleanupErrors.push(`signal cleanup: ${signalCleanupError}`);
    if (signalRequested) {
      status = "blocked";
      failure = failure ?? "supervisor requested SIGTERM";
    } else if (status === "pass" && (pageErrors.length > 0 || externalRequests.length > 0 || browserObservationState.overflow)) {
      status = "fail";
      failure = pageErrors.length > 0
        ? `browser page error: ${pageErrors.join("; ")}`
        : externalRequests.length > 0
          ? `browser entry attempted external requests: ${externalRequests.join(", ")}`
          : "bounded browser observation capacity overflowed";
    } else if (status === "pass" && (
      cleanup.pageClosed !== true
      || cleanup.contextClosed !== true
      || cleanup.browserConnectionClosed !== true
      || cleanup.browserServerCloseObserved !== true
      || cleanup.browserProcessExitObserved !== true
      || cleanup.browserProcessCloseObserved !== true
      || cleanup.viteServerCloseObserved !== true
      || cleanup.viteListeningAfterClose !== true
      || cleanup.socketCleanupObserved !== true
      || cleanup.connectionOverflow === true
      || cleanup.browserObservationOverflow === true
      || cleanup.temporaryDirectoryRemoved !== true
      || cleanup.errors.length > 0
    )) {
      status = "fail";
      failure = "owned browser/Vite cleanup was not fully observed";
    }
    process.off("SIGTERM", onSigterm);
    return {
      kind: "analytics-captured-svg-browser",
      version: 1,
      status,
      failure,
      environment: { node: process.version, cwd: process.cwd(), playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH },
      toolchain,
      browser: browserEvidence,
      cases,
      externalRequests,
      pageErrors,
      observationOverflow: browserObservationState.overflow,
      server: serverEvidence == null ? null : { ...serverEvidence, connectionObserved, connectionOverflow },
      cleanup,
    };
  }
}

function parseProtocol(stdout, prefix, expectedKind, expectedVersion) {
  const lines = String(stdout ?? "").slice(0, OUTPUT_CAP_BYTES).split(/\r?\n/);
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length === 0) return { receipt: null, error: "missing child protocol receipt" };
  if (matches.length !== 1) return { receipt: null, error: "duplicate child protocol receipts" };
  let receipt;
  try {
    receipt = JSON.parse(matches[0].slice(prefix.length));
  } catch (error) {
    return { receipt: null, error: `malformed child protocol receipt: ${boundedText(error)}` };
  }
  if (receipt?.kind !== expectedKind || receipt?.version !== expectedVersion) {
    return { receipt: null, error: `child protocol kind/version mismatch: ${boundedText(receipt)}` };
  }
  return { receipt, error: null };
}

async function runParent() {
  const supervised = await runSupervisedNode({
    args: [sourcePath, CHILD_ARGUMENT],
    cwd: analyticsRoot,
    timeoutMs: CHILD_TIMEOUT_MS,
    outputCapBytes: OUTPUT_CAP_BYTES,
    killGraceMs: KILL_GRACE_MS,
    closeGraceMs: CLOSE_GRACE_MS,
  });
  const stdout = Buffer.isBuffer(supervised.stdout) ? supervised.stdout.toString("utf8") : String(supervised.stdout ?? "");
  const stderr = Buffer.isBuffer(supervised.stderr) ? supervised.stderr.toString("utf8") : String(supervised.stderr ?? "");
  const protocol = parseProtocol(stdout, CHILD_PREFIX, "analytics-captured-svg-browser", 1);
  const child = protocol.receipt;
  let status = "pass";
  let failure = null;
  if (supervised.reason === "deadline") {
    status = "blocked";
    failure = "captured SVG child exceeded the fixed 60-second deadline";
  } else if (supervised.reason != null || supervised.code !== 0 || supervised.signal != null || supervised.exitObserved !== true || supervised.closeObserved !== true) {
    status = child?.status === "blocked" ? "blocked" : "fail";
    failure = child?.failure ?? `child did not close cleanly (code ${supervised.code}, signal ${supervised.signal}, reason ${supervised.reason})`;
  } else if (protocol.error != null) {
    status = "fail";
    failure = protocol.error;
  } else if (!["pass", "blocked", "fail"].includes(child.status)) {
    status = "fail";
    failure = "child returned an invalid captured SVG status";
  } else {
    status = child.status;
    failure = child.failure ?? null;
  }
  return {
    kind: "analytics-captured-svg-browser-parent",
    version: 1,
    status,
    failure,
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
    child,
  };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === CHILD_ARGUMENT) {
  try {
    const result = await runChild();
    process.stdout.write(`${CHILD_PREFIX}${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
  } catch (error) {
    process.stdout.write(`${CHILD_PREFIX}${JSON.stringify({ kind: "analytics-captured-svg-browser", version: 1, status: error instanceof BlockedError ? "blocked" : "fail", failure: boundedText(error) })}\n`);
    process.exitCode = error instanceof BlockedError ? 2 : 1;
  }
} else if (args.length === 0) {
  const result = await runParent();
  process.stdout.write(`${PARENT_PREFIX}${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
} else {
  process.stderr.write("usage: captured-svg.browser.mjs [--child]\n");
  process.exitCode = 2;
}
