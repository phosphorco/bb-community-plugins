import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "vite";

import {
  FLEET_PERFORMANCE_BOOTSTRAP,
  FLEET_PERFORMANCE_INSTRUMENTATION_VERSION,
} from "./fixtures/fleet-performance-bootstrap.ts";
import {
  FLEET_PERFORMANCE_BUCKETS_PER_TRACK,
  FLEET_PERFORMANCE_CORE_TRACKS,
  FLEET_PERFORMANCE_FIXTURE_FINGERPRINT,
  FLEET_PERFORMANCE_FIXTURE_VERSION,
  FLEET_PERFORMANCE_MACHINE_COUNT,
  FLEET_PERFORMANCE_SELECTED_EVENT_COUNT,
} from "./fixtures/fleet-performance.fixture.ts";

const testDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pluginDirectory = resolve(testDirectory, "..");
const fixtureDirectory = join(testDirectory, "fixtures");
const samplesPerDistribution = 12;
const atlasP95RegressionCeilings = {
  // The prior published production receipt was 33.8ms cached and 83.6ms
  // warm-uncached. These ceilings allow normal Chromium scheduling variance
  // while rejecting a navigator-induced tail regression before its broader
  // 50ms/250ms interaction budgets are reached.
  cached: 45,
  uncached: 110,
} as const;

type BrowserMeasurement = {
  id: string;
  usefulPaintMs: number;
  usefulDomMs: number;
  overviewRetained: boolean;
  chartRetainedAtInput: boolean;
  staleContentVisible: boolean;
  retainedContentBeforeResponse: boolean;
  counterDelta: {
    rpc: Record<string, number>;
    hostCalls: number;
    chartInit: number;
    chartDispose: number;
    chartUpdate: number;
    setIntervalCalls: number;
    activeIntervals: number;
    domMutations: number;
    idleCallbacks: number;
  };
  longTasks: Array<{ startTime: number; duration: number }>;
  heap: null | { usedJSHeapSize: number; totalJSHeapSize: number };
};

function percentile95(values: readonly number[]): number {
  assert.ok(values.length > 0, "p95 needs at least one sample");
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!;
}

function measurementSummary(values: readonly BrowserMeasurement[]) {
  return {
    count: values.length,
    p95UsefulPaintMs: percentile95(values.map((value) => value.usefulPaintMs)),
    maxUsefulPaintMs: Math.max(...values.map((value) => value.usefulPaintMs)),
    maxLongTaskMs: Math.max(0, ...values.flatMap((value) => value.longTasks.map((task) => task.duration))),
  };
}

async function productionBundle(): Promise<Readonly<{ directory: string; bundleSha256: string }>> {
  const directory = await mkdtemp(join(tmpdir(), "machine-monitor-fleet-performance-"));
  await build({
    configFile: false,
    root: pluginDirectory,
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: {
      alias: [
        { find: "@get-bb/plugin-sdk/app", replacement: join(fixtureDirectory, "fleet-performance-sdk.tsx") },
        { find: "echarts/core", replacement: join(fixtureDirectory, "fleet-performance-echarts.ts") },
      ],
    },
    build: {
      outDir: directory,
      emptyOutDir: true,
      // Vite's OXC production transform is already pinned by this workspace.
      // Avoid an undeclared esbuild dependency in this test-only bundle.
      minify: "oxc",
      cssMinify: false,
      lib: {
        entry: join(fixtureDirectory, "fleet-performance-entry.tsx"),
        formats: ["es"],
        fileName: () => "fleet-performance.js",
        cssFileName: "fleet-performance",
      },
    },
  });
  const bundle = await readFile(join(directory, "fleet-performance.js"));
  return { directory, bundleSha256: createHash("sha256").update(bundle).digest("hex") };
}

async function serveBundle(directory: string): Promise<Readonly<{ origin: string; close(): Promise<void> }>> {
  const files = await readdir(directory);
  const stylesheet = files.find((file) => file === "fleet-performance.css");
  const document = `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"><meta name="color-scheme" content="light">
<style>
html, body, #root { width: 100%; min-height: 100%; margin: 0; }
html { --foreground: #111827; --background: #f8fafc; --card: #ffffff; --card-foreground: #111827; --border: #cbd5e1; --muted-foreground: #475569; --primary: #4f46e5; --muted: #e2e8f0; --accent: #eef2ff; --accent-foreground: #111827; --ring: #4f46e5; --destructive: #b91c1c; }
</style>${stylesheet == null ? "" : `<link rel="stylesheet" href="/${stylesheet}">`}
<script>${FLEET_PERFORMANCE_BOOTSTRAP}</script><script type="module" src="/fleet-performance.js"></script></head><body><div id="root"></div></body></html>`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fleet-performance.local");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(document);
      return;
    }
    const candidate = resolve(directory, `.${url.pathname}`);
    if (!normalize(candidate).startsWith(`${normalize(directory)}/`) || relative(directory, candidate).startsWith("..")) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(candidate);
      const extension = extname(candidate);
      const contentType = extension === ".js" ? "text/javascript" : extension === ".css" ? "text/css" : "application/octet-stream";
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address != null && typeof address !== "string", "fleet performance server did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error == null ? resolveClose() : rejectClose(error))),
  };
}

function machineId(index: number): string {
  return `latency-machine-${String(index).padStart(2, "0")}`;
}

function machineLabel(machine: string): string {
  return `Latency machine ${machine.slice(-2)}`;
}

async function waitForInitialMachine(page: any, machine: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${machineLabel(machine)}\\. connected`) }).waitFor();
  await page.waitForFunction((machineIdValue: string) => document.querySelector(`.machine-monitor__timeline-chart[aria-label*="${machineIdValue}"]`) != null, machine);
}

async function warmDetail(page: any, machine: string): Promise<void> {
  const before = await page.evaluate(() => (globalThis as any).__fleetPerformanceControl.counters());
  await page.getByRole("button", { name: new RegExp(`^${machineLabel(machine)}\\. connected`) }).focus();
  const afterFocus = await page.evaluate(() => (globalThis as any).__fleetPerformanceControl.counters());
  const rpcDelta = (afterFocus.rpc.machineTimeline ?? 0) - (before.rpc.machineTimeline ?? 0);
  assert.ok(rpcDelta === 0 || rpcDelta === 1, `warming ${machine} made ${rpcDelta} detail requests`);
  if (rpcDelta === 1) {
    await page.waitForFunction((responses: number) => (globalThis as any).__fleetPerformanceControl.counters().timelineResponses === responses + 1,
      before.timelineResponses);
  }
}

async function measureSwitch(page: any, id: string, current: string, target: string, held = false): Promise<BrowserMeasurement> {
  const targetLabel = machineLabel(target);
  await page.evaluate((value: { id: string; targetLabel: string; expectedLabel: string; expectedMachineId: string }) =>
    (globalThis as any).__fleetPerformance.begin(value), {
    id,
    targetLabel,
    expectedLabel: targetLabel,
    expectedMachineId: target,
  });
  const button = page.getByRole("button", { name: new RegExp(`^${targetLabel}\\. connected`) });
  const beforeHeldClicks = held ? await page.evaluate(() => (globalThis as any).__fleetPerformanceControl.counters()) : null;
  let retainedContentBeforeResponse = false;
  await button.click();
  if (held) await button.click();
  if (held) {
    await page.getByText(new RegExp(`Showing retained timeline for ${current}`)).waitFor();
    retainedContentBeforeResponse = true;
    const counters = await page.evaluate(() => (globalThis as any).__fleetPerformanceControl.counters());
    assert.equal((counters.rpc.machineTimeline ?? 0) - (beforeHeldClicks!.rpc.machineTimeline ?? 0), 1,
      "two retained-content clicks must share exactly one held local-server RPC before its response is released");
    await page.evaluate((machine: string) => (globalThis as any).__fleetPerformanceControl.release(machine), target);
  }
  await page.waitForFunction((sampleId: string) => (globalThis as any).__fleetPerformance.ready(sampleId), id);
  return { ...await page.evaluate((sampleId: string) => (globalThis as any).__fleetPerformance.finish(sampleId), id), retainedContentBeforeResponse } as BrowserMeasurement;
}

function assertNoLongTask(values: readonly BrowserMeasurement[], label: string): void {
  for (const value of values) {
    assert.equal(value.longTasks.length, 0, `${label} ${value.id} recorded a >=50ms browser task: ${JSON.stringify(value.longTasks)}`);
  }
}

function assertNoAtlasP95Regression(summary: ReturnType<typeof measurementSummary>, ceiling: number, label: string): void {
  assert.ok(summary.p95UsefulPaintMs <= ceiling,
    `${label} p95 ${summary.p95UsefulPaintMs}ms exceeds the published-atlas regression ceiling of ${ceiling}ms`);
}

test("production Chromium fleet selection witness meets the latency, cache, invalidation, and idle contracts", { timeout: 180_000 }, async (t) => {
  const bundle = await productionBundle();
  const server = await serveBundle(bundle.directory);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (error: Error) => pageErrors.push(error.stack ?? error.message));
  t.after(async () => {
    await context.close();
    await browser.close();
    await server.close();
    await rm(bundle.directory, { recursive: true, force: true });
  });

  await page.goto(server.origin, { waitUntil: "domcontentloaded" });
  await waitForInitialMachine(page, machineId(0));
  const initialAtlas = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLButtonElement>(".machine-monitor__atlas-button")];
    return {
      compact: document.querySelector(".machine-monitor__fleet-picker[data-inspecting]") != null,
      names: cards.map((card) => card.getAttribute("aria-label")),
      selected: cards.map((card) => card.getAttribute("aria-pressed")),
    };
  });
  assert.equal(initialAtlas.compact, true, "the atlas did not compact after selecting its initial inspector");
  assert.equal(initialAtlas.names.length, FLEET_PERFORMANCE_MACHINE_COUNT, "the atlas did not retain one native card per machine");
  assert.equal(initialAtlas.names[0], `${machineLabel(machineId(0))}. connected. fresh. Current.`, "the atlas changed source keyboard order");
  assert.equal(initialAtlas.selected[0], "true", "the initial atlas source is not selected");
  const preflight = await page.evaluate(() => ({
    probe: (globalThis as any).__fleetPerformance.preflight(),
    fixture: (globalThis as any).__fleetPerformanceControl.fixture,
    browser: {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      theme: matchMedia("(prefers-color-scheme: light)").matches ? "light" : "not-light",
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  }));
  assert.deepEqual(preflight.fixture, {
    version: FLEET_PERFORMANCE_FIXTURE_VERSION,
    fingerprint: FLEET_PERFORMANCE_FIXTURE_FINGERPRINT,
    expectedFingerprint: FLEET_PERFORMANCE_FIXTURE_FINGERPRINT,
    machineCount: FLEET_PERFORMANCE_MACHINE_COUNT,
    coreTracks: FLEET_PERFORMANCE_CORE_TRACKS.length,
    bucketsPerCoreTrack: FLEET_PERFORMANCE_BUCKETS_PER_TRACK,
    selectedEvents: FLEET_PERFORMANCE_SELECTED_EVENT_COUNT,
  }, "fixture preflight must reject drift before any timing verdict");
  assert.equal(preflight.probe.version, FLEET_PERFORMANCE_INSTRUMENTATION_VERSION);
  assert.deepEqual(preflight.probe.instrumentation, {
    longTask: true,
    animationFrame: true,
    chartProxy: true,
    rpcProbe: true,
    timerProbe: true,
  }, "browser instrumentation preflight must be complete before any timing verdict");
  assert.deepEqual(preflight.browser, { viewport: { width: 1280, height: 900, dpr: 1 }, theme: "light", reducedMotion: true });

  // Cache two unrelated revision-current details through the user-visible focus
  // prefetch path. The browser fixture's requestIdleCallback never fires, so
  // this is the entire declared warm cache state.
  await warmDetail(page, machineId(3));
  await warmDetail(page, machineId(4));
  await warmDetail(page, machineId(5));
  await page.getByRole("button", { name: new RegExp(`^${machineLabel(machineId(3))}\\. connected`) }).click();
  await waitForInitialMachine(page, machineId(3));

  const cachedControl: BrowserMeasurement[] = [];
  const cachedCandidate: BrowserMeasurement[] = [];
  let current = machineId(3);
  for (let index = 0; index < samplesPerDistribution; index += 1) {
    cachedControl.push(await measureSwitch(page, `cached-control-${index}`, current, current));
    const target = current === machineId(3) ? machineId(4) : machineId(3);
    cachedCandidate.push(await measureSwitch(page, `cached-candidate-${index}`, current, target));
    current = target;
  }
  for (const sample of cachedCandidate) {
    assert.equal(sample.counterDelta.rpc.machineTimeline ?? 0, 0, `${sample.id} issued a detail RPC despite a revision-current cache hit`);
    assert.equal(sample.counterDelta.hostCalls, 0, `${sample.id} contacted a daemon/host`);
    assert.equal(sample.counterDelta.chartInit, 0, `${sample.id} remounted the chart`);
    assert.equal(sample.counterDelta.chartDispose, 0, `${sample.id} disposed/remounted the chart`);
  }
  assertNoLongTask(cachedCandidate, "cached candidate");
  const cachedSummary = measurementSummary(cachedCandidate);
  assert.ok(cachedSummary.p95UsefulPaintMs <= 50, `cached switch p95 ${cachedSummary.p95UsefulPaintMs}ms exceeds 50ms`);
  assertNoAtlasP95Regression(cachedSummary, atlasP95RegressionCeilings.cached, "cached atlas switch");

  const uncachedControl: BrowserMeasurement[] = [];
  const uncachedCandidate: BrowserMeasurement[] = [];
  for (let index = 0; index < samplesPerDistribution; index += 1) {
    uncachedControl.push(await measureSwitch(page, `uncached-control-${index}`, current, current));
    const target = machineId(10 + index);
    await page.evaluate((machine: string) => (globalThis as any).__fleetPerformanceControl.hold(machine), target);
    const sample = await measureSwitch(page, `uncached-candidate-${index}`, current, target, true);
    uncachedCandidate.push(sample);
    current = target;
  }
  for (const sample of uncachedCandidate) {
    assert.equal(sample.counterDelta.rpc.machineTimeline ?? 0, 1, `${sample.id} must coalesce the held uncached switch to exactly one local-server RPC`);
    assert.equal(sample.counterDelta.hostCalls, 0, `${sample.id} contacted a daemon/host`);
    assert.equal(sample.counterDelta.chartInit, 0, `${sample.id} remounted the chart while replacing retained content`);
    assert.ok(sample.overviewRetained || sample.retainedContentBeforeResponse,
      `${sample.id} lost both useful overview and retained stale content`);
  }
  assertNoLongTask(uncachedCandidate, "uncached candidate");
  const uncachedSummary = measurementSummary(uncachedCandidate);
  assert.ok(uncachedSummary.p95UsefulPaintMs <= 250, `warm uncached switch p95 ${uncachedSummary.p95UsefulPaintMs}ms exceeds 250ms`);
  assertNoAtlasP95Regression(uncachedSummary, atlasP95RegressionCeilings.uncached, "warm uncached atlas switch");

  // Rewarm a small known resident set, then advance only machine 05. Its exact
  // revision becomes a miss while 03/04 stay revision-current cache hits.
  await warmDetail(page, machineId(3));
  await warmDetail(page, machineId(4));
  await warmDetail(page, machineId(5));
  await page.getByRole("button", { name: new RegExp(`^${machineLabel(machineId(3))}\\. connected`) }).click();
  await waitForInitialMachine(page, machineId(3));
  const overviewBeforeRevision = await page.evaluate(() => (globalThis as any).__fleetPerformanceControl.counters().rpc.fleetOverview ?? 0);
  await page.evaluate((machine: string) => (globalThis as any).__fleetPerformanceControl.revisionUpdate(machine), machineId(5));
  await page.waitForFunction((before: number) => ((globalThis as any).__fleetPerformanceControl.counters().rpc.fleetOverview ?? 0) === before + 1,
    overviewBeforeRevision);
  const unaffectedCurrent = await measureSwitch(page, "revision-current-unaffected", machineId(3), machineId(3));
  const unaffectedOther = await measureSwitch(page, "revision-current-other", machineId(3), machineId(4));
  assert.equal(unaffectedCurrent.counterDelta.rpc.machineTimeline ?? 0, 0, "revision update invalidated the unaffected selected machine");
  assert.equal(unaffectedOther.counterDelta.rpc.machineTimeline ?? 0, 0, "revision update invalidated an unrelated resident machine");
  await page.evaluate((machine: string) => (globalThis as any).__fleetPerformanceControl.hold(machine), machineId(5));
  const revisionTarget = await measureSwitch(page, "revision-target", machineId(4), machineId(5), true);
  assert.equal(revisionTarget.counterDelta.rpc.machineTimeline ?? 0, 1, "revision-updated machine did not invalidate its detail cache exactly once");
  assert.equal(revisionTarget.counterDelta.hostCalls, 0, "revision reconciliation contacted a daemon/host");

  const idleBaseline = await page.evaluate(() => (globalThis as any).__fleetPerformance.quietSnapshot());
  await page.waitForTimeout(300);
  const idleDelta = await page.evaluate((baseline: unknown) => (globalThis as any).__fleetPerformance.quietDelta(baseline), idleBaseline);
  assert.equal(idleDelta.activeIntervals, 0, "settled idle owns a polling interval");
  assert.equal(idleDelta.setIntervalCalls, 0, "settled idle created a polling interval");
  assert.equal(idleDelta.chartInit, 0, "settled idle remounted a chart");
  assert.equal(idleDelta.chartUpdate, 0, "settled idle repeated a chart update");
  assert.equal(idleDelta.domMutations, 0, "settled idle repeated visible render work");
  assert.deepEqual(pageErrors, [], "the browser witness encountered a page error");

  const raw = {
    manifest: {
      runtimeResultTree: process.env.BB_FORK_RESULT_TREE ?? "recorded by PERFORMANCE.md from fork/build/bb at run time",
      pluginSourceHead: process.env.BB_PLUGIN_SOURCE_HEAD ?? "recorded by PERFORMANCE.md from community-plugins at run time",
      productionBundleSha256: bundle.bundleSha256,
      browser: await browser.version(),
      browserExecutable: basename(chromium.executablePath()),
      viewport: "1280x900@1",
      theme: "light",
      motion: "reduce",
      cache: "HTTP cache disabled; service workers blocked; explicit FleetClient warm state only",
      fixture: preflight.fixture,
      instrumentation: preflight.probe,
    },
    atlas: { initial: initialAtlas, p95RegressionCeilings: atlasP95RegressionCeilings },
    cached: { control: cachedControl, controlSummary: measurementSummary(cachedControl), candidate: cachedCandidate, summary: cachedSummary },
    uncached: { control: uncachedControl, controlSummary: measurementSummary(uncachedControl), candidate: uncachedCandidate, summary: uncachedSummary },
    revision: { unaffectedCurrent, unaffectedOther, revisionTarget },
    idleDelta,
  };
  console.log(`FLEET_PERFORMANCE_RAW=${JSON.stringify(raw)}`);
});
