// @vitest-environment jsdom

import { createHash } from "node:crypto";

import { fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

function threadDigest(projectId: string, threadId: string): string {
  const json = JSON.stringify({ provider: "bb", keys: { project: projectId, thread: threadId } });
  return createHash("sha256").update(json, "utf8").digest("hex");
}

test("the thread header reads exact backlinks, filters signals, and restores focus from its portal", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_header01", projectId: "proj_header01", isCompactViewport: false },
    {
      rpc: {
        listBacklinks: () => ({
          rows: [{
            source: {
              provider: "bb",
              keys: { page: "machine-monitor", plugin: "machine-monitor" },
              presentation: { label: "Machine Monitor", detail: "Deployment machine", url: "/plugins/machine-monitor/machine-monitor" },
            },
            producerPluginId: "machine-monitor",
            revision: 1,
            targetPresentation: { label: "Header thread" },
            position: 0,
          }],
          nextCursor: null,
        }),
      },
      openUrl: () => true,
    } as any,
  );

  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
  const trigger = await slot.findByRole("button", { name: "Linked sources: 1" });
  fireEvent.click(trigger);
  expect(await slot.findByRole("dialog", { name: "Linked sources" })).toBeTruthy();
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Close linked sources" }));
  const sourceLink = slot.getByRole("link", { name: "Machine Monitor Deployment machine" });
  expect(sourceLink).toBeTruthy();
  fireEvent.click(sourceLink);
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "experimental_openUrl",
    url: "/plugins/machine-monitor/machine-monitor",
  });

  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: ["0".repeat(64)],
    producerPluginId: "machine-monitor",
    sourceIdentityDigest: "0".repeat(64),
    revision: 2,
  });
  expect(slot.inspection.rpcCalls).toHaveLength(1);

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Linked sources" })).toBeNull());
  expect(document.activeElement).toBe(trigger);

  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

  await slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: [threadDigest("proj_header01", "thr_header01")],
    producerPluginId: "machine-monitor",
    sourceIdentityDigest: "0".repeat(64),
    revision: 3,
  });
  await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(3));
  slot.lifecycle.unmount();
});

test("keeps header state isolated per visible pane and only refetches the matching identity", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const makePane = (projectId: string, threadId: string, label: string) => renderSlot(
    app.threadHeaderActions[0]!,
    { threadId, projectId, isCompactViewport: true },
    {
      rpc: {
        listBacklinks: () => ({
          rows: [{
            source: {
              provider: "bb",
              keys: { page: "machine-monitor", plugin: "machine-monitor" },
              presentation: { label, url: "/plugins/machine-monitor/machine-monitor" },
            },
            producerPluginId: "machine-monitor",
            revision: 1,
            targetPresentation: { label },
            position: 0,
          }],
          nextCursor: null,
        }),
      },
    } as any,
  );
  const left = makePane("proj_left01", "thr_left01", "Left source");
  const right = makePane("proj_right01", "thr_right01", "Right source");
  await waitFor(() => expect(left.inspection.rpcCalls).toHaveLength(1));
  await waitFor(() => expect(right.inspection.rpcCalls).toHaveLength(1));

  await left.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: [threadDigest("proj_left01", "thr_left01")],
    producerPluginId: "machine-monitor",
    sourceIdentityDigest: "0".repeat(64),
    revision: 2,
  });
  await waitFor(() => expect(left.inspection.rpcCalls).toHaveLength(2));
  expect(right.inspection.rpcCalls).toHaveLength(1);

  left.lifecycle.unmount();
  right.lifecycle.unmount();
});

test("loads additional backlink pages with the returned bounded cursor", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const inputs: unknown[] = [];
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_pages01", projectId: "proj_pages01", isCompactViewport: false },
    {
      rpc: {
        listBacklinks: (input: unknown) => {
          inputs.push(input);
          return inputs.length === 1
            ? {
                rows: [{
                  source: { provider: "bb", keys: { page: "machine-monitor", plugin: "machine-monitor" }, presentation: { label: "First source" } },
                  producerPluginId: "machine-monitor", revision: 1, targetPresentation: { label: "Thread" }, position: 0,
                }],
                nextCursor: "cursor-page-2",
              }
            : {
                rows: [{
                  source: { provider: "bb", keys: { page: "machine-monitor", plugin: "machine-monitor" }, presentation: { label: "Second source" } },
                  producerPluginId: "machine-monitor", revision: 2, targetPresentation: { label: "Thread" }, position: 0,
                }],
                nextCursor: null,
              };
        },
      },
    } as any,
  );
  await waitFor(() => expect(inputs).toHaveLength(1));
  fireEvent.click(await slot.findByRole("button", { name: "Linked sources: 1" }));
  fireEvent.click(await slot.findByRole("button", { name: "Load more linked sources" }));
  await waitFor(() => expect(slot.getByText("Second source")).toBeTruthy());
  expect(inputs[1]).toEqual({
    target: { provider: "bb", keys: { project: "proj_pages01", thread: "thr_pages01" } },
    pageSize: 25,
    cursor: "cursor-page-2",
  });
  expect(slot.queryByRole("button", { name: "Load more linked sources" })).toBeNull();
  slot.lifecycle.unmount();
});

test("does not lose a matching invalidation received while identity digest is pending", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const inputs: unknown[] = [];
  let releaseFirst: (() => void) | null = null;
  const page = {
    rows: [],
    nextCursor: null,
  };
  const slot = renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "thr_digest01", projectId: "proj_digest01", isCompactViewport: true },
    {
      rpc: {
        listBacklinks: () => {
          inputs.push(true);
          if (inputs.length === 1) return new Promise((resolve) => { releaseFirst = () => resolve(page); });
          return page;
        },
      },
    } as any,
  );

  // Emit before the Web Crypto promise can establish digestRef. The hook must
  // latch and drain this signal after the canonical identity is ready.
  void slot.behavior.emitRealtime("cross-references-changed", {
    protocolVersion: 1,
    affectedIdentityDigests: [threadDigest("proj_digest01", "thr_digest01")],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  (releaseFirst as unknown as (() => void))();
  await waitFor(() => expect(inputs).toHaveLength(2));
  slot.lifecycle.unmount();
});
