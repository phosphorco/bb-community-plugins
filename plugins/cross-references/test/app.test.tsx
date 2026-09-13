// @vitest-environment jsdom

import { createHash } from "node:crypto";

import { fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

function threadDigest(projectId: string, threadId: string): string {
  const json = JSON.stringify({ provider: "bb", keys: { project: projectId, thread: threadId } });
  return createHash("sha256").update(json, "utf8").digest("hex");
}

const forwardRow = (label = "Thread B") => ({
  target: {
    provider: "bb",
    keys: { project: "proj_target01", thread: "thr_target01" },
    presentation: { label, detail: "BB thread", url: "/projects/proj_target01/threads/thr_target01" },
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

test("the References header presents directed forward references and backlinks in one accessible dialog", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_header01", projectId: "proj_header01", isCompactViewport: false },
    {
      rpc: {
        listForwardReferences: () => ({ rows: [forwardRow()], total: 1, nextCursor: null }),
        listBacklinks: () => ({ rows: [backlinkRow()], total: 1, nextCursor: null }),
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
  expect(slot.getByRole("region", { name: "Forward references" })).toBeTruthy();
  expect(slot.getByRole("region", { name: "Backlinks" })).toBeTruthy();
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Close references" }));
  fireEvent.click(slot.getByRole("link", { name: "Thread B BB thread" }));
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
  expect(slot.inspection.rpcCalls).toHaveLength(2);
  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: [threadDigest("proj_header01", "thr_header01")],
    producerPluginId: "thread-links",
    sourceIdentityDigest: threadDigest("proj_header01", "thr_header01"),
    revision: 2,
  });
  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(4));

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
      },
      openUrl: () => true,
    } as any,
  );

  const trigger = await slot.findByRole("button", { name: "Cross-references: 1 forward reference, 0 backlinks" });
  fireEvent.click(trigger);
  const link = await slot.findByRole("link", { name: "Design notes example.test" });
  expect(link.getAttribute("href")).toBe(externalUrl);
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: externalUrl });
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
            : { rows: [forwardRow("Second target")], total: 2, nextCursor: null };
        },
        listBacklinks: (input: unknown) => {
          backlinkInputs.push(input);
          return { rows: [backlinkRow()], total: 1, nextCursor: null };
        },
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
