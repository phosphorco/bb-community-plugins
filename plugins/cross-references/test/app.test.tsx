// @vitest-environment jsdom

import { createHash } from "node:crypto";

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

function threadDigest(projectId: string, threadId: string): string {
  const json = JSON.stringify({ provider: "bb", keys: { project: projectId, thread: threadId } });
  return createHash("sha256").update(json, "utf8").digest("hex");
}

const forwardRow = (label = "Thread B", threadId = "thr_target01") => ({
  target: {
    provider: "bb",
    keys: { project: "proj_target01", thread: threadId },
    presentation: { label, detail: "BB thread", url: `/projects/proj_target01/threads/${threadId}` },
  },
  producerPluginId: "thread-links",
  revision: 1,
  position: 0,
});

const backlinkRow = (label = "Machine Monitor") => ({
  source: {
    provider: "bb",
    keys: { page: "machine-monitor", plugin: "machine-monitor" },
    presentation: { label, detail: "Deployment machine", url: "/plugins/machine-monitor/machine-monitor" },
  },
  producerPluginId: "machine-monitor",
  revision: 1,
  targetPresentation: { label: "Header thread" },
  position: 0,
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

test.each(["forward", "backlink"] as const)("merges overlapping %s pages and advances an overlap-only cursor", async (direction) => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const initial = direction === "forward" ? forwardRow("Original") : backlinkRow("Original");
  const replacement = { ...initial, producerPluginId: "surviving-producer", revision: 2, position: 1 };
  if ("target" in replacement) replacement.target = { ...replacement.target, presentation: { ...replacement.target.presentation, label: "Replacement" } };
  else replacement.source = { ...replacement.source, presentation: { ...replacement.source.presentation, label: "Replacement" } };
  const distinct = direction === "forward" ? forwardRow("Distinct", "thr_distinct") : {
    ...backlinkRow("Distinct"), source: { ...backlinkRow("Distinct").source, keys: { page: "another-page", plugin: "another-plugin" } },
  };
  const cursors: (string | undefined)[] = [];
  const page = (input: { cursor?: string }) => {
    cursors.push(input.cursor);
    return input.cursor === undefined
      ? { rows: [initial], total: 2, nextCursor: "overlap-only" }
      : input.cursor === "overlap-only"
        ? { rows: [replacement], total: 2, nextCursor: "distinct-page" }
        : { rows: [distinct], total: 2, nextCursor: null };
  };
  const slot = renderSlot(app.threadHeaderActions[0]!,
    { threadId: "thr_overlap", projectId: "proj_overlap", isCompactViewport: false },
    { rpc: {
      listForwardReferences: direction === "forward" ? page : () => ({ rows: [], total: 0, nextCursor: null }),
      listBacklinks: direction === "backlink" ? page : () => ({ rows: [], total: 0, nextCursor: null }),
      checkForwardReferences: () => [],
    } } as any);
  const countName = direction === "forward" ? "2 forward references" : "2 backlinks";
  fireEvent.click(await slot.findByRole("button", { name: `Cross-references: ${countName}` }));
  const regionName = direction === "forward" ? "Forward references" : "Backlinks";
  const loadName = `Load more ${direction === "forward" ? "forward references" : "backlinks"}`;
  const originalElement = slot.getByText("Original").closest("li");
  fireEvent.click(slot.getByRole("button", { name: loadName }));
  await slot.findByText("Replacement");
  expect(slot.queryByText("Original")).toBeNull();
  expect(slot.getByRole("region", { name: regionName }).querySelectorAll("li")).toHaveLength(1);
  expect(slot.getByText("Replacement").closest("li")).toBe(originalElement);
  await waitFor(() => expect((slot.getByRole("button", { name: loadName }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: loadName }));
  await slot.findByText("Distinct");
  expect(slot.getByRole("region", { name: regionName }).querySelectorAll("li")).toHaveLength(2);
  expect(cursors).toEqual([undefined, "overlap-only", "distinct-page"]);
  expect(slot.queryByRole("button", { name: loadName })).toBeNull();
  slot.lifecycle.unmount();
});

test("load-more cannot discard an in-flight realtime refresh", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const refreshed = deferred<{ rows: ReturnType<typeof forwardRow>[]; total: number; nextCursor: null }>();
  let calls = 0;
  const slot = renderSlot(app.threadHeaderActions[0]!,
    { threadId: "thr_refresh_race", projectId: "proj_refresh_race", isCompactViewport: false },
    { rpc: {
      listForwardReferences: (input: { cursor?: string }) => {
        calls++;
        if (input.cursor !== undefined) return { rows: [forwardRow("Unwanted page", "thr_old_page")], total: 2, nextCursor: null };
        return calls === 1 ? { rows: [forwardRow("Deleted target")], total: 2, nextCursor: "old-cursor" } : refreshed.promise;
      },
      listBacklinks: () => ({ rows: [], total: 0, nextCursor: null }),
      checkForwardReferences: () => [],
    } } as any);
  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 2 forward references" }));
  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1, affectedIdentityDigests: [threadDigest("proj_refresh_race", "thr_refresh_race")],
  });
  await waitFor(() => expect(calls).toBe(2));
  fireEvent.click(slot.getByRole("button", { name: "Load more forward references" }));
  expect(calls).toBe(2);
  await act(async () => refreshed.resolve({ rows: [forwardRow("Refreshed target", "thr_refreshed")], total: 1, nextCursor: null }));
  await slot.findByText("Refreshed target");
  expect(slot.queryByText("Deleted target")).toBeNull();
  expect(slot.queryByText("Unwanted page")).toBeNull();
  expect(slot.getByRole("button", { name: "Cross-references: 1 forward reference" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("both directions accept concurrent page results and a refresh invalidates older pagination", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const nextForward = deferred<{ rows: ReturnType<typeof forwardRow>[]; total: number; nextCursor: string | null }>();
  const nextBacklink = deferred<{ rows: ReturnType<typeof backlinkRow>[]; total: number; nextCursor: null }>();
  const obsoleteForward = deferred<{ rows: ReturnType<typeof forwardRow>[]; total: number; nextCursor: null }>();
  let forwardCalls = 0;
  let backlinkCalls = 0;
  const slot = renderSlot(app.threadHeaderActions[0]!,
    { threadId: "thr_parallel", projectId: "proj_parallel", isCompactViewport: false },
    { rpc: {
      listForwardReferences: (input: { cursor?: string }) => {
        forwardCalls++;
        return input.cursor !== undefined ? (input.cursor === "obsolete-next" ? obsoleteForward.promise : nextForward.promise) : { rows: [forwardRow()], total: 2, nextCursor: "forward-next" };
      },
      listBacklinks: (input: { cursor?: string }) => {
        backlinkCalls++;
        return input.cursor !== undefined ? nextBacklink.promise : { rows: [backlinkRow()], total: 2, nextCursor: "backlink-next" };
      },
      checkForwardReferences: () => [],
    } } as any);
  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 2 forward references, 2 backlinks" }));
  fireEvent.click(slot.getByRole("button", { name: "Load more forward references" }));
  fireEvent.click(slot.getByRole("button", { name: "Load more backlinks" }));
  await waitFor(() => { expect(forwardCalls).toBe(2); expect(backlinkCalls).toBe(2); });
  await act(async () => nextBacklink.resolve({ rows: [backlinkRow("Updated backlink")], total: 2, nextCursor: null }));
  await slot.findByText("Updated backlink");
  await act(async () => nextForward.resolve({ rows: [forwardRow("Updated forward")], total: 2, nextCursor: "obsolete-next" }));
  await slot.findByText("Updated forward");
  fireEvent.click(slot.getByRole("button", { name: "Load more forward references" }));
  await waitFor(() => expect(forwardCalls).toBe(3));
  // A realtime refresh supersedes the newly-pending forward page.
  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1, affectedIdentityDigests: [threadDigest("proj_parallel", "thr_parallel")],
  });
  await waitFor(() => { expect(forwardCalls).toBe(4); expect(backlinkCalls).toBe(3); });
  await slot.findByText("Machine Monitor");
  await act(async () => obsoleteForward.resolve({ rows: [forwardRow("Obsolete target", "thr_obsolete")], total: 2, nextCursor: null }));
  expect(slot.queryByText("Obsolete target")).toBeNull();
  slot.lifecycle.unmount();
});

test("the References header presents directed forward references and backlinks in one accessible dialog", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_header01", projectId: "proj_header01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({ rows: [forwardRow()], total: 1, nextCursor: null }),
        listBacklinks: () => ({ rows: [backlinkRow()], total: 1, nextCursor: null }),
        checkForwardReferences: () => ([{ url: "/projects/proj_target01/threads/thr_target01", status: null, label: "BB link · Not checked" }]),
      },
      openUrl: () => true,
    } as any,
  );

  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
  const trigger = await slot.findByRole("button", { name: "Cross-references: 1 forward reference, 1 backlink" });
  expect(trigger.querySelectorAll(".cross-references__metric")).toHaveLength(2);
  expect([...trigger.querySelectorAll(".cross-references__metric svg")]).toHaveLength(2);
  expect([...trigger.querySelectorAll(".cross-references__count")].map((count) => count.textContent)).toEqual(["1", "1"]);
  expect(trigger.textContent).toBe("11");
  fireEvent.click(trigger);
  expect(await slot.findByRole("dialog", { name: "References" })).toBeTruthy();
  expect(await slot.findByLabelText("Link status was not checked")).toBeTruthy();
  expect(slot.getByRole("region", { name: "Backlinks" }).querySelector(".cross-references__link-status")).toBeNull();
  expect(slot.getByRole("region", { name: "Forward references" })).toBeTruthy();
  expect(slot.getByRole("region", { name: "Backlinks" })).toBeTruthy();
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Close references" }));
  fireEvent.click(slot.getByRole("link", { name: /Thread B BB thread/ }));
  fireEvent.click(slot.getByRole("link", { name: "Machine Monitor Deployment machine" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "/projects/proj_target01/threads/thr_target01" });
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "/plugins/machine-monitor/machine-monitor" });

  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: ["0".repeat(64)],
    producerPluginId: "machine-monitor",
    sourceIdentityDigest: "0".repeat(64),
    revision: 2,
  });
  expect(slot.inspection.rpcCalls).toHaveLength(3);
  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: [threadDigest("proj_header01", "thr_header01")],
    producerPluginId: "thread-links",
    sourceIdentityDigest: threadDigest("proj_header01", "thr_header01"),
    revision: 2,
  });
  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(5));

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "References" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
  slot.lifecycle.unmount();
});

test("renders an observed external URL as a navigable forward reference", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const externalUrl = "https://example.test/design?source=assistant#overview";
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_url01", projectId: "proj_url01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({
          rows: [{
            target: {
              provider: "url",
              keys: { href: externalUrl },
              presentation: { label: "Design notes", detail: "example.test", url: externalUrl },
            },
            producerPluginId: "thread-links",
            revision: 1,
            position: 0,
          }],
          total: 1,
          nextCursor: null,
        }),
        listBacklinks: () => ({ rows: [], total: 0, nextCursor: null }),
        checkForwardReferences: () => ([{ url: externalUrl, status: 200, label: "Available" }]),
      },
      openUrl: () => true,
    } as any,
  );

  const trigger = await slot.findByRole("button", { name: "Cross-references: 1 forward reference" });
  expect(trigger.querySelectorAll(".cross-references__metric")).toHaveLength(1);
  expect([...trigger.querySelectorAll(".cross-references__count")].map((count) => count.textContent)).toEqual(["1"]);
  fireEvent.click(trigger);
  const link = await slot.findByRole("link", { name: /Design notes example\.test/ });
  expect(link.getAttribute("href")).toBe(externalUrl);
  expect(link.getAttribute("title")).toBeNull();
  expect(link.querySelector("[data-cross-reference-derived]")).toBeNull();
  expect(await slot.findByLabelText("Available (HTTP 200)")).toBeTruthy();
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: externalUrl });
  slot.lifecycle.unmount();
});

test("shows only the backlink metric when this thread has no forward references", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_backlink01", projectId: "proj_backlink01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({ rows: [], total: 0, nextCursor: null }),
        listBacklinks: () => ({ rows: [backlinkRow()], total: 1, nextCursor: null }),
        checkForwardReferences: () => [],
      },
    } as any,
  );

  const trigger = await slot.findByRole("button", { name: "Cross-references: 1 backlink" });
  expect(trigger.querySelectorAll(".cross-references__metric")).toHaveLength(1);
  expect([...trigger.querySelectorAll(".cross-references__count")].map((count) => count.textContent)).toEqual(["1"]);
  slot.lifecycle.unmount();
});

test("paginates forward references independently from backlinks", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const forwardInputs: unknown[] = [];
  const backlinkInputs: unknown[] = [];
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_pages01", projectId: "proj_pages01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: (input: unknown) => {
          forwardInputs.push(input);
          return forwardInputs.length === 1
            ? { rows: [forwardRow("First target")], total: 2, nextCursor: "forward-page-2" }
            : { rows: [forwardRow("Second target", "thr_target02")], total: 2, nextCursor: null };
        },
        listBacklinks: (input: unknown) => {
          backlinkInputs.push(input);
          return { rows: [backlinkRow()], total: 1, nextCursor: null };
        },
        checkForwardReferences: () => [],
      },
    } as any,
  );
  await waitFor(() => expect(forwardInputs).toHaveLength(1));
  await waitFor(() => expect(backlinkInputs).toHaveLength(1));
  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 2 forward references, 1 backlink" }));
  fireEvent.click(await slot.findByRole("button", { name: "Load more forward references" }));
  await waitFor(() => expect(slot.getByText("Second target")).toBeTruthy());
  expect(forwardInputs[1]).toEqual({
    source: { provider: "bb", keys: { project: "proj_pages01", thread: "thr_pages01" } },
    pageSize: 25,
    cursor: "forward-page-2",
  });
  expect(backlinkInputs).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("hides the header action when this thread has no forward references or backlinks", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_empty01", projectId: "proj_empty01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({ rows: [], total: 0, nextCursor: null }),
        listBacklinks: () => ({ rows: [], total: 0, nextCursor: null }),
      },
    } as any,
  );
  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});

test("keeps header state isolated per visible thread pane", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const makePane = (projectId: string, threadId: string, label: string) => renderSlot(
    app.threadHeaderActions[0]!,
    { threadId, projectId, isCompactViewport: true },
    {
      rpc: {
        listForwardReferences: () => ({ rows: [forwardRow(label)], total: 1, nextCursor: null }),
        listBacklinks: () => ({ rows: [], total: 0, nextCursor: null }),
      },
    } as any,
  );
  const left = makePane("proj_left01", "thr_left01", "Left target");
  const right = makePane("proj_right01", "thr_right01", "Right target");
  await waitFor(() => expect(left.inspection.rpcCalls).toHaveLength(2));
  await waitFor(() => expect(right.inspection.rpcCalls).toHaveLength(2));
  await left.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: [threadDigest("proj_left01", "thr_left01")],
    producerPluginId: "thread-links",
    sourceIdentityDigest: threadDigest("proj_left01", "thr_left01"),
    revision: 2,
  });
  await waitFor(() => expect(left.inspection.rpcCalls).toHaveLength(4));
  expect(right.inspection.rpcCalls).toHaveLength(2);
  left.lifecycle.unmount();
  right.lifecycle.unmount();
});


test("shows the URL path for generic link text and keeps the original URL for navigation", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const url = "https://linky.example.test/notes/plan.md?sig=secret";
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_generic01", projectId: "proj_generic01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({
          rows: [{
            target: { provider: "url", keys: { href: url }, presentation: { label: "link", detail: "linky.example.test", url } },
            producerPluginId: "thread-links",
            revision: 1,
            position: 0,
          }],
          total: 1,
          nextCursor: null,
        }),
        listBacklinks: () => ({ rows: [], total: 0, nextCursor: null }),
        checkForwardReferences: () => ([{ url, status: 200, label: "Available" }]),
      },
      openUrl: () => true,
    } as any,
  );

  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 1 forward reference" }));
  const link = await slot.findByRole("link", { name: /^\/notes\/plan\.md \(from URL; link text "link"\) linky\.example\.test/ });
  expect(link.getAttribute("href")).toBe(url);
  expect(link.getAttribute("title")).toBe(`Link text "link" — ${url}`);
  expect(link.querySelector("[data-cross-reference-derived]")?.textContent).toBe("/notes/plan.md");
  expect(await slot.findByLabelText("Available (HTTP 200)")).toBeTruthy();
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url });
  slot.lifecycle.unmount();
});

test("drops generic link text with no path and lets the host line name the row", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const url = "https://linky.example.test/";
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_generic02", projectId: "proj_generic02", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({
          rows: [{
            target: { provider: "url", keys: { href: url }, presentation: { label: "link", detail: "linky.example.test", url } },
            producerPluginId: "thread-links",
            revision: 1,
            position: 0,
          }],
          total: 1,
          nextCursor: null,
        }),
        listBacklinks: () => ({ rows: [], total: 0, nextCursor: null }),
        checkForwardReferences: () => ([{ url, status: 200, label: "Available" }]),
      },
      openUrl: () => true,
    } as any,
  );

  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 1 forward reference" }));
  const link = await slot.findByRole("link", { name: /^linky\.example\.test/ });
  expect(link.querySelector("strong")).toBeNull();
  expect(link.textContent).not.toMatch(/\blink\b/);
  expect(link.getAttribute("title")).toBe(`Link text "link" — ${url}`);
  slot.lifecycle.unmount();
});

test("both directions show source recency with exact timestamp tooltips and omit unknown times", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const timestamp = Date.now() - 2 * 60 * 60_000;
  const slot = renderSlot(app.threadHeaderActions[0]!,
    { threadId: "thr_recency", projectId: "proj_recency", isCompactViewport: false },
    { rpc: {
      listForwardReferences: () => ({ rows: [{ ...forwardRow("Known"), lastSeenAt: timestamp }, forwardRow("Unknown", "thr_unknown")], total: 2, nextCursor: null }),
      listBacklinks: () => ({ rows: [{ ...backlinkRow(), lastSeenAt: timestamp }], total: 1, nextCursor: null }),
      checkForwardReferences: () => [],
    } } as any);
  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 2 forward references, 1 backlink" }));
  const times = document.querySelectorAll("time.cross-references__recency");
  expect(times).toHaveLength(2);
  for (const time of times) {
    expect(time.textContent).toBe("2h ago");
    expect(time.getAttribute("datetime")).toBe(new Date(timestamp).toISOString());
    expect(time.getAttribute("title")).toBe(`Last linked ${new Date(timestamp).toLocaleString()}`);
  }
  expect(slot.getByText("Unknown").closest("li")?.querySelector("time")).toBeNull();
  slot.lifecycle.unmount();
});

import { z } from "zod";
import { mentionsSubPath, parseMentionsSubPath } from "../presentation.ts";

const mentionHash = "a".repeat(64);
const mentionHref = "https://example.test/resource";
const mentionTarget = { provider: "url", keys: { href: mentionHref } };
const mentionSource = { provider: "bb", keys: { project: "proj_context", thread: "thr_context" }, presentation: { label: "Context source", url: "/projects/proj_context/threads/thr_context" } };
const mentionCoverage = () => ({ scope: "known-sources", collectionIncomplete: false, retentionLimited: false, capHistoryUnknown: false, legacyClaimsPresent: false, evidenceStateUnknown: false, authoredUrlCoverage: { state: "complete-for-known-locations", unknownLocations: 0, scope: "known-locations", watermark: mentionHash }, reasons: [], reasonsClipped: false, checkedAt: null });
function mentionOccurrence(i: number) {
  const text = `😀 context ${i} useful resource after <b>literal</b>`;
  const start = text.indexOf("resource");
  return { kind: "occurrence", source: mentionSource, target: { ...mentionTarget, presentation: { label: "Resource", url: mentionHref } }, producerPluginId: "cross-references", graphRevision: 1, evidenceRevision: 1, cap: { state: "uncapped", limit: 100, sourceHistoryUnknown: false }, occurrenceKey: i.toString(16).padStart(64, "0"), locator: { kind: "conversation", threadId: "thr_context", messageId: `row_${i}`, messageSeq: 40 + i, anchorSeq: 999, role: i % 2 ? "assistant" : "user" }, sourceContentRevision: mentionHash, span: { start, end: start + 8 }, excerpt: { state: "ready", text, sourceSpan: { start: 0, end: text.length }, matchSpan: { start, end: start + 8 }, clippedBefore: true, clippedAfter: false, matchClippedBefore: false, matchClippedAfter: false, codecVersion: 1 }, messageCreatedAt: 100 + i, observedAt: 200, confirmation: "observed", authoredUrlState: "exact", provenance: { pluginId: "cross-references", origin: "builtin", confidence: "high", recognition: { basis: "text-url", explanation: "Explicit safe URL" }, source: { provider: "bb.url", id: mentionHref, kind: "url" }, authoredHref: mentionHref } };
}
function mentionPage(count = 4) {
  return { version: 2, status: "page", snapshot: mentionHash, items: Array.from({ length: count }, (_, i) => mentionOccurrence(i)), counts: { retainedOccurrences: count, confirmedOccurrences: count, unconfirmedOccurrences: 0, producerClaims: count ? 1 : 0, indexedSources: count ? 1 : 0, claimsWithoutLocations: 0, excerptUnavailable: 0 }, coverage: mentionCoverage(), nextCursor: null as string | null };
}
const mentionQueryPath = () => mentionsSubPath({ v: 1, kind: "query", input: { version: 2, query: { kind: "resource", target: mentionTarget, relation: "self" } } });
type UiRequest = { method: string; input?: unknown; signal?: AbortSignal };
function mentionSdk(handler: (request: UiRequest) => unknown | Promise<unknown>) {
  return { plugins: { async callRpc<T>(args: UiRequest & { outputSchema: z.ZodType<T> }): Promise<T> {
    const raw = args.method === "crossReferences.describe" ? { protocol: "cross-references", versions: [1, 2] } : await handler(args);
    return args.outputSchema.parse(raw);
  } } };
}
async function mountMentionPanel(subPath: string, handler: (request: UiRequest) => unknown | Promise<unknown>) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const registration = app.navPanels.find(panel => panel.id === "mentions")!;
  const slot = renderSlot(registration, { subPath }, { sdk: mentionSdk(handler), openUrl: () => true });
  return { slot, registration };
}
function lookupOption(relation: "self" | "github-pr-family" = "self") {
  return { query: relation === "self" ? { kind: "resource", target: mentionTarget, relation } : { kind: "resource", target: { provider: "recognition", keys: { provider: "github", identity: mentionHash } }, relation }, label: "Recognized resource", inputSpan: { start: 0, end: 4 }, basis: "stored-codec", reasons: [] };
}

test("Browser Mentions is idle, compact-accessible and snapshots the public current URL without page access", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.navPanels.some(panel => panel.path === "mentions")).toBe(true);
  const slot = renderSlot(app.browserToolbarActions[0]!, { threadId: "thr_browser", tabId: "tab_one", url: mentionHref, isCompactViewport: true, experimental_page: null });
  expect(slot.inspection.sdkCalls).toHaveLength(0);
  const trigger = slot.getByRole("button", { name: "Mentions of current page" });
  fireEvent.click(trigger);
  const call = slot.inspection.navigateCalls[0];
  expect(call?.method).toBe("toPluginPanel");
  if (call?.method === "toPluginPanel") expect(parseMentionsSubPath(call.options?.subPath ?? "")).toEqual({ v: 1, kind: "lookup", href: mentionHref, mode: "recognize" });
  expect(slot.inspection.sdkCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

test("paste form submits explicit Recognize and Exact URL modes; only backend selects PR family", async () => {
  const requests: UiRequest[] = [];
  const { slot } = await mountMentionPanel("", request => {
    requests.push(request);
    if (request.method !== "crossReferencesV2ResolveLookup") return mentionPage(1);
    const mode = z.object({ mode: z.string() }).parse(request.input).mode;
    return { version: 2, state: "ready", options: mode === "exact-url" ? [{ ...lookupOption(), query: { kind: "authored-url", href: mentionHref } }] : [lookupOption("github-pr-family")], reasons: [] };
  });
  expect(slot.inspection.sdkCalls).toHaveLength(0);
  fireEvent.change(slot.getByLabelText("Find mentions of a resource or URL"), { target: { value: "owner/repo PR 7" } });
  expect(requests).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "Find mentions" }));
  await slot.findByText("Recognized PR family");
  await slot.findByText("1 stored locations", { exact: false });
  expect(requests[0]?.input).toEqual({ version: 2, text: "owner/repo PR 7", mode: "recognize" });
  expect(requests[1]?.input).toMatchObject({ query: { relation: "github-pr-family" }, pageSize: 25 });
  fireEvent.change(slot.getByLabelText("Lookup mode"), { target: { value: "exact-url" } });
  fireEvent.change(slot.getByLabelText("Find mentions of a resource or URL"), { target: { value: mentionHref } });
  fireEvent.click(slot.getByRole("button", { name: "Find mentions" }));
  await waitFor(() => expect(requests.filter(r => r.method === "crossReferencesV2ResolveLookup")).toHaveLength(2));
  expect(requests.filter(r => r.method === "crossReferencesV2ResolveLookup")[1]?.input).toEqual({ version: 2, text: mentionHref, mode: "exact-url" });
  await slot.findByText("Exact authored URL");
  expect(requests.filter(r => r.method === "crossReferencesV2ListMentions").at(-1)?.input).toMatchObject({ query: { kind: "authored-url", href: mentionHref } });
  slot.lifecycle.unmount();
});

test("ambiguous and incomplete recognition keep choices explicit; unrecognized is not empty membership", async () => {
  let state = "ambiguous";
  const { slot } = await mountMentionPanel("", request => request.method === "crossReferencesV2ResolveLookup" ? { version: 2, state, options: state === "unrecognized" ? [] : [lookupOption(), { ...lookupOption(), label: "Other choice" }], reasons: [] } : mentionPage(0));
  const submit = async () => { fireEvent.change(slot.getByLabelText("Find mentions of a resource or URL"), { target: { value: "query" } }); fireEvent.click(slot.getByRole("button", { name: "Find mentions" })); };
  await submit(); await slot.findByText("Choose the intended resource.");
  expect(slot.queryByRole("region", { name: "Mention results" })).toBeNull();
  state = "incomplete"; await submit(); await slot.findByText(/Recognition is incomplete/);
  fireEvent.click(slot.getByRole("button", { name: /Recognized resource · stored-codec/ }));
  await slot.findByText("No matching stored mentions in known sources.");
  expect(slot.getByText(/Recognition is incomplete/)).toBeTruthy();
  state = "unrecognized"; await submit(); await slot.findByText(/No recognized resource/);
  expect(slot.queryByText("No matching stored mentions in known sources.")).toBeNull();
  slot.lifecycle.unmount();
});

test("page25 replacement, three-location disclosure and original #msg links preserve all rows", async () => {
  const requests: UiRequest[] = [];
  const { slot } = await mountMentionPanel(mentionQueryPath(), request => {
    requests.push(request);
    const input = request.input as { cursor?: string };
    const p = mentionPage(4);
    return input.cursor ? { ...p, items: [mentionOccurrence(9)], nextCursor: null } : { ...p, nextCursor: "next" };
  });
  await slot.findByRole("link", { name: "User message 40" });
  expect(slot.queryByRole("link", { name: "Assistant message 43" })).toBeNull();
  const more = slot.getByRole("button", { name: "Show 1 more locations on this page" });
  fireEvent.click(more);
  expect(slot.getByRole("link", { name: "Assistant message 43" }).getAttribute("href")).toBe("/projects/proj_context/threads/thr_context#msg=43");
  expect(requests).toHaveLength(1);
  expect(slot.container.querySelector("mark")?.textContent).toBe("resource");
  expect(slot.container.querySelector("b")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Next page" }));
  await slot.findByRole("link", { name: "Assistant message 49" });
  expect(slot.queryByRole("link", { name: "User message 40" })).toBeNull();
  expect(slot.getByText(/4 stored locations/)).toBeTruthy();
  expect(requests[1]?.input).toMatchObject({ pageSize: 25, cursor: "next" });
  fireEvent.click(slot.getByRole("button", { name: "First page" }));
  await slot.findByRole("link", { name: "User message 40" });
  expect(requests[2]?.input).not.toHaveProperty("cursor");
  slot.lifecycle.unmount();
});

const mentionSignal = () => ({ version: 2, producerPluginId: "cross-references", sourceIdentityDigest: threadDigest("proj_context", "thr_context"), graphRevision: 1, evidenceRevision: 1, affectedIdentityDigests: [createHash("sha256").update(JSON.stringify(mentionTarget)).digest("hex")], scopeListClipped: false });

test("coverage-only not-modified invalidation coalesces, filters irrelevant signals and preserves the page cursor", async () => {
  let calls = 0;
  const { slot } = await mountMentionPanel(mentionQueryPath(), request => {
    calls++;
    return calls === 1 ? { ...mentionPage(1), nextCursor: "still-valid" } : { version: 2, status: "not-modified", snapshot: mentionHash, coverage: { ...mentionCoverage(), authoredUrlCoverage: { ...mentionCoverage().authoredUrlCoverage, state: "partial", unknownLocations: 7 } } };
  });
  await slot.findByRole("link", { name: "User message 40" });
  await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", { ...mentionSignal(), affectedIdentityDigests: ["f".repeat(64)] });
  expect(calls).toBe(1);
  for (let i = 0; i < 5; i++) await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", mentionSignal());
  await slot.findByText(/unknown for 7 known locations/);
  expect(calls).toBe(2);
  expect((slot.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(false);
  slot.lifecycle.unmount();
});

test("restart performs one first-page read and transient error recovers on unchanged-content reconnect", async () => {
  const requests: UiRequest[] = [];
  let fail = false;
  const { slot } = await mountMentionPanel(mentionQueryPath(), request => {
    requests.push(request);
    if (fail) throw Error("transport https://private.test/?token=DO_NOT_SHOW");
    const input = request.input as { cursor?: string; ifSnapshot?: string };
    if (input.cursor) return { version: 2, status: "restart", reason: "snapshot-changed", snapshot: "b".repeat(64) };
    if (input.ifSnapshot) return { version: 2, status: "not-modified", snapshot: mentionHash, coverage: mentionCoverage() };
    return { ...mentionPage(1), nextCursor: "obsolete" };
  });
  await slot.findByRole("link", { name: "User message 40" });
  fireEvent.click(slot.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]?.input).not.toHaveProperty("cursor");
  fail = true;
  await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", mentionSignal());
  await slot.findByRole("alert");
  expect(slot.getByRole("link", { name: "User message 40" })).toBeTruthy();
  expect(slot.container.textContent).not.toContain("DO_NOT_SHOW");
  fail = false;
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  expect(slot.queryByText(/last available results/)).toBeNull();
  slot.lifecycle.unmount();
});

test("query replacement fences noncooperative late responses and unmount aborts the active port", async () => {
  const old = deferred<unknown>();
  let oldSignal: AbortSignal | undefined;
  const { slot, registration } = await mountMentionPanel(mentionQueryPath(), request => { oldSignal = request.signal; return old.promise; });
  await waitFor(() => expect(oldSignal).toBeDefined());
  const Panel = registration.component;
  slot.rerender(<Panel subPath="" />);
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => old.resolve(mentionPage(1)));
  expect(slot.queryByText("Context source")).toBeNull();
  fireEvent.change(slot.getByLabelText("Find mentions of a resource or URL"), { target: { value: "next query" } });
  fireEvent.click(slot.getByRole("button", { name: "Find mentions" }));
  slot.lifecycle.unmount();
  expect(slot.queryByRole("main")).toBeNull();
});

test("unsafe routes and invalid service results never echo secrets; editable paste is not redacted", async () => {
  let calls = 0;
  const unsafe = `v1/${Buffer.from(JSON.stringify({ v: 1, kind: "lookup", href: "https://example.test/?token=DO_NOT_SHOW", mode: "recognize" })).toString("base64url")}`;
  const { slot } = await mountMentionPanel(unsafe, () => { calls++; throw Error("secret DO_NOT_SHOW"); });
  expect(slot.getByRole("alert")).toBeTruthy();
  expect(slot.container.textContent).not.toContain("DO_NOT_SHOW");
  expect(calls).toBe(0);
  fireEvent.change(slot.getByLabelText("Find mentions of a resource or URL"), { target: { value: "https://example.test/?token=DO_NOT_SHOW" } });
  expect((slot.getByLabelText("Find mentions of a resource or URL") as HTMLInputElement).value).toContain("DO_NOT_SHOW");
  fireEvent.click(slot.getByRole("button", { name: "Find mentions" }));
  await slot.findByText(/Could not resolve this lookup/);
  expect(slot.container.textContent).not.toContain("DO_NOT_SHOW");
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

test("legacy, unsupported, unavailable and retained cap truth remain visible", async () => {
  const p = mentionPage(1);
  const base = mentionOccurrence(0);
  const { slot } = await mountMentionPanel(mentionQueryPath(), () => ({ ...p, counts: { retainedOccurrences: 1, confirmedOccurrences: 0, unconfirmedOccurrences: 1, producerClaims: 3, indexedSources: 1, claimsWithoutLocations: 2, excerptUnavailable: 1 }, coverage: { ...mentionCoverage(), collectionIncomplete: true, retentionLimited: true, capHistoryUnknown: true, legacyClaimsPresent: true, evidenceStateUnknown: true, reasons: ["timeline-page-limit"], reasonsClipped: true }, items: [
    { ...base, confirmation: "retained-unconfirmed", cap: { state: "unknown", limit: null, sourceHistoryUnknown: true }, excerpt: { state: "unavailable", reason: "indivisible-word", codecVersion: 1 } },
    { kind: "claim-without-evidence", source: mentionSource, target: base.target, producerPluginId: "legacy", graphRevision: 1, cap: base.cap, reason: "legacy", matchBasis: "primary-resource" },
    { kind: "future-format", source: mentionSource, target: base.target, producerPluginId: "future", graphRevision: 1, cap: base.cap },
  ] }));
  await slot.findByText(/Retained, unconfirmed location/);
  expect(slot.getByText(/a word exceeds the excerpt limit/)).toBeTruthy();
  expect(slot.getByText(/Legacy claim: no collected location/)).toBeTruthy();
  expect(slot.getByText(/Evidence format unsupported/)).toBeTruthy();
  expect(slot.getAllByText(/Location cap history unknown/)).toHaveLength(2);
  expect(slot.getByText(/Additional coverage reasons were clipped/)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("backlink context is one lazy reader with exact target/source/producer admission", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const requests: UiRequest[] = [];
  const row = { ...backlinkRow(), source: mentionSource, producerPluginId: "cross-references" };
  const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_header01", projectId: "proj_header01", isCompactViewport: false }, { rpc: { listForwardReferences: () => ({ rows: [], total: 0, nextCursor: null }), listBacklinks: () => ({ rows: [row], total: 1, nextCursor: null }), checkForwardReferences: () => [] }, sdk: mentionSdk(request => { requests.push(request); return mentionPage(1); }) });
  fireEvent.click(await slot.findByRole("button", { name: "Cross-references: 1 backlink" }));
  expect(requests).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "Show context" }));
  await slot.findByRole("link", { name: "User message 40" });
  expect(requests[0]?.input).toMatchObject({ query: { kind: "resource", target: { provider: "bb", keys: { project: "proj_header01", thread: "thr_header01" } } }, source: { provider: "bb", keys: mentionSource.keys }, producerPluginId: "cross-references", pageSize: 25 });
  fireEvent.click(slot.getByRole("button", { name: "Show context" }));
  expect(slot.queryByRole("region", { name: "Mention results" })).toBeNull();
  slot.lifecycle.unmount();
});

test("hidden results pause invalidations and visibility resumes one bounded read; unmount retires timer", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  try {
    let calls = 0;
    const { slot } = await mountMentionPanel(mentionQueryPath(), () => { calls++; return mentionPage(1); });
    await slot.findByRole("link", { name: "User message 40" });
    hidden = true; fireEvent(document, new Event("visibilitychange"));
    await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", mentionSignal());
    await act(async () => { await new Promise(done => setTimeout(done, 300)); });
    expect(calls).toBe(1);
    hidden = false; fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(calls).toBe(2));
    await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", mentionSignal());
    slot.lifecycle.unmount();
    await act(async () => { await new Promise(done => setTimeout(done, 300)); });
    expect(calls).toBe(2);
  } finally {
    if (descriptor) Object.defineProperty(document, "hidden", descriptor); else Reflect.deleteProperty(document, "hidden");
  }
});

test("read-budget unavailable keeps the same-query page and manual retry restores content", async () => {
  let state = "page";
  const { slot } = await mountMentionPanel(mentionQueryPath(), () => state === "page" ? mentionPage(1) : { version: 2, status: "unavailable", reason: "read-budget", retryable: true });
  await slot.findByRole("link", { name: "User message 40" });
  state = "unavailable";
  await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", mentionSignal());
  await slot.findByText(/read limit reached/);
  expect(slot.getByRole("link", { name: "User message 40" })).toBeTruthy();
  state = "page";
  fireEvent.click(slot.getByRole("button", { name: "Retry mentions" }));
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  slot.lifecycle.unmount();
});

test("refresh during held pagination rejects obsolete page and reloads first page once", async () => {
  const held = deferred<unknown>();
  const inputs: unknown[] = [];
  const { slot } = await mountMentionPanel(mentionQueryPath(), request => {
    inputs.push(request.input);
    const input = request.input as { cursor?: string };
    if (input.cursor) return held.promise;
    return { ...mentionPage(1), nextCursor: "held" };
  });
  await slot.findByRole("link", { name: "User message 40" });
  fireEvent.click(slot.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(inputs).toHaveLength(2));
  await slot.behavior.emitRealtime("cross-references-mentions-v2-changed", mentionSignal());
  await act(async () => held.resolve({ ...mentionPage(1), items: [mentionOccurrence(9)] }));
  await waitFor(() => expect(inputs).toHaveLength(3));
  expect(slot.queryByRole("link", { name: "Assistant message 49" })).toBeNull();
  expect(inputs[2]).not.toHaveProperty("cursor");
  slot.lifecycle.unmount();
});

test("invalid manual output choice is contained before selection, reads or navigation; additive valid choice recovers", async () => {
  const requests: UiRequest[] = [];
  const invalid = { ...lookupOption(), label: "Invalid family", query: { kind: "resource", target: mentionTarget, relation: "github-pr-family" } };
  const valid = { ...lookupOption(), label: "Additive valid resource", extraOption: true, query: { ...lookupOption().query, extraQuery: true, target: { ...mentionTarget, extraIdentity: true } } };
  // This invalid family is legal in the additive output DTO, but not a legal strict input.
  // Exercise the actual client decode and the component's manual choice event.
  const { slot } = await mountMentionPanel("", request => {
    requests.push(request);
    return request.method === "crossReferencesV2ResolveLookup"
      ? { version: 2, state: "ambiguous", options: [invalid, valid], reasons: [], extraResult: true }
      : mentionPage(1);
  });
  const uncaught: Event[] = [];
  const onError = (event: Event) => { uncaught.push(event); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  try {
    fireEvent.change(slot.getByLabelText("Find mentions of a resource or URL"), { target: { value: "choose resource" } });
    fireEvent.click(slot.getByRole("button", { name: "Find mentions" }));
    const invalidButton = await slot.findByRole("button", { name: /Invalid family/ });
    expect(() => fireEvent.click(invalidButton)).not.toThrow();
    await slot.findByRole("alert");
    expect(slot.getByRole("alert").textContent).toBe("This lookup choice is invalid or too large to open. Choose another resource.");
    expect(slot.queryByRole("region", { name: "Mention results" })).toBeNull();
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(requests.map(request => request.method)).toEqual(["crossReferencesV2ResolveLookup"]);
    expect(uncaught).toHaveLength(0);

    fireEvent.click(slot.getByRole("button", { name: /Additive valid resource/ }));
    await slot.findByRole("link", { name: "User message 40" });
    expect(slot.queryByRole("alert")).toBeNull();
    expect(requests.filter(request => request.method === "crossReferencesV2ListMentions")).toHaveLength(1);
    expect(requests.at(-1)?.input).toEqual({ version: 2, query: { kind: "resource", target: mentionTarget, relation: "self" }, pageSize: 25 });
    expect(slot.inspection.navigateCalls).toHaveLength(1);
    const navigation = slot.inspection.navigateCalls[0];
    if (navigation?.method !== "toPluginPanel") throw Error("Expected selected query navigation");
    expect(parseMentionsSubPath(navigation.options?.subPath ?? "")).toEqual({ v: 1, kind: "query", input: { version: 2, query: { kind: "resource", target: mentionTarget, relation: "self" } } });
    expect(uncaught).toHaveLength(0);
  } finally {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onError);
    slot.lifecycle.unmount();
  }
});

test("multiple future slots retain every page row without duplicate keys through replacement, reorder and shrink", async () => {
  const future = (name: string) => ({ ...mentionOccurrence(0), kind: `future-${name}`, opaqueFutureIdentity: "shared-and-discarded", source: { ...mentionSource, presentation: { ...mentionSource.presentation, url: `/projects/proj_context/threads/thr_context#future-${name}` } } });
  const a = future("a"), b = future("b"), c = future("c");
  const zero = mentionOccurrence(0), one = mentionOccurrence(1);
  let items: unknown[] = [a, zero, b, one];
  const errors = vi.spyOn(console, "error");
  const { slot } = await mountMentionPanel(mentionQueryPath(), () => ({ ...mentionPage(2), snapshot: createHash("sha256").update(JSON.stringify(items)).digest("hex"), items }));
  const rowHrefs = () => [...slot.container.querySelectorAll(".mentions__row")].map(row => row.querySelector("a")?.getAttribute("href"));
  try {
    await slot.findByRole("link", { name: "User message 40" });
    expect(slot.getAllByText(/Evidence format unsupported/)).toHaveLength(2);
    expect(slot.container.querySelectorAll(".mentions__row")).toHaveLength(4);
    const zeroNode = slot.getByRole("link", { name: "User message 40" }).closest("li");
    const oneNode = slot.getByRole("link", { name: "Assistant message 41" }).closest("li");
    expect(zeroNode).not.toBe(oneNode);
    expect(rowHrefs()).toEqual(["/projects/proj_context/threads/thr_context#future-a", "/projects/proj_context/threads/thr_context#msg=40", "/projects/proj_context/threads/thr_context#future-b", "/projects/proj_context/threads/thr_context#msg=41"]);

    items = [c, one, b, zero, a];
    fireEvent.click(slot.getByRole("button", { name: "First page" }));
    await waitFor(() => expect(slot.container.querySelectorAll(".mentions__row")).toHaveLength(5));
    expect(slot.getAllByText(/Evidence format unsupported/)).toHaveLength(3);
    expect(rowHrefs()).toEqual(["/projects/proj_context/threads/thr_context#future-c", "/projects/proj_context/threads/thr_context#msg=41", "/projects/proj_context/threads/thr_context#future-b", "/projects/proj_context/threads/thr_context#msg=40", "/projects/proj_context/threads/thr_context#future-a"]);
    expect(slot.getByRole("link", { name: "User message 40" }).closest("li")).toBe(zeroNode);
    expect(slot.getByRole("link", { name: "Assistant message 41" }).closest("li")).toBe(oneNode);

    items = [zero, a, c, one, b];
    fireEvent.click(slot.getByRole("button", { name: "First page" }));
    await waitFor(() => expect(rowHrefs()[0]).toBe("/projects/proj_context/threads/thr_context#msg=40"));
    expect(slot.getAllByText(/Evidence format unsupported/)).toHaveLength(3);
    expect(rowHrefs()).toEqual(["/projects/proj_context/threads/thr_context#msg=40", "/projects/proj_context/threads/thr_context#future-a", "/projects/proj_context/threads/thr_context#future-c", "/projects/proj_context/threads/thr_context#msg=41", "/projects/proj_context/threads/thr_context#future-b"]);
    expect(slot.getByRole("link", { name: "User message 40" }).closest("li")).toBe(zeroNode);
    expect(slot.getByRole("link", { name: "Assistant message 41" }).closest("li")).toBe(oneNode);

    items = [b, one];
    fireEvent.click(slot.getByRole("button", { name: "First page" }));
    await waitFor(() => expect(slot.container.querySelectorAll(".mentions__row")).toHaveLength(2));
    expect(slot.getAllByText(/Evidence format unsupported/)).toHaveLength(1);
    expect(slot.queryByRole("link", { name: "User message 40" })).toBeNull();
    expect(slot.getByRole("link", { name: "Assistant message 41" }).closest("li")).toBe(oneNode);
    expect(rowHrefs()).toEqual(["/projects/proj_context/threads/thr_context#future-b", "/projects/proj_context/threads/thr_context#msg=41"]);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    slot.lifecycle.unmount();
    errors.mockRestore();
  }
});
