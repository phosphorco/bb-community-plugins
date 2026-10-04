// @vitest-environment jsdom

import { createHash } from "node:crypto";

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

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
