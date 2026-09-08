// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class {
    observe() {}
    disconnect() {}
  },
});

const emptySnapshot = {
  hostName: "test-host",
  platform: "test-platform",
  uptimeSeconds: 0,
  latest: null,
  samples: [],
  thresholds: { cpu: 90, ram: 90, disk: 90 },
  diskGrowthBytesPerDay: null,
  directories: [],
  memoryDiagnostics: null,
  processDetailsEnabled: false,
  lastError: null,
};

test("the attachment picker validates a fresh thread, commits local truth, navigates, and removes", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const target = {
    provider: "bb",
    keys: { project: "proj_picker01", thread: "thr_picker01" },
    presentation: { label: "Fix disk pressure", detail: "Project proj_picker01" },
  };
  const initial = {
    sourceRevision: 0,
    targets: [],
    status: {
      state: "synced" as const,
      sourceRevision: 0,
      desiredRevision: 0,
      lastAckedRevision: 0,
      pending: false,
      inFlight: false,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      errorKind: null,
    },
  };
  const updated = { ...initial, sourceRevision: 1, targets: [target], status: { ...initial.status, sourceRevision: 1, desiredRevision: 1, pending: true, state: "pending" as const } };
  const replacementInputs: unknown[] = [];

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => emptySnapshot,
        getAttachments: () => initial,
        searchThreads: () => ({ threads: [{ id: "thr_picker01", projectId: "proj_picker01", title: "Fix disk pressure", detail: "Root disk warning", archived: false }] }),
        getThread: () => ({ id: "thr_picker01", projectId: "proj_picker01", title: "Fix disk pressure", detail: "Root disk warning", archived: false }),
        replaceAttachments: (input: unknown) => {
          replacementInputs.push(input);
          return replacementInputs.length === 1 ? { outcome: "applied", ...updated } : { outcome: "applied", ...initial };
        },
      },
    } as any,
  );

  expect(await slot.findByText("No threads linked yet.")).toBeTruthy();
  const search = slot.getByRole("searchbox", { name: "Add a BB thread" });
  fireEvent.change(search, { target: { value: "disk" } });
  expect(slot.queryByText(/Root disk warning/)).toBeNull();
  await waitFor(() => expect(slot.getByText(/Root disk warning/)).toBeTruthy(), { timeout: 1_000 });

  fireEvent.click(slot.getByRole("button", { name: "Link Fix disk pressure" }));
  await waitFor(() => expect(replacementInputs).toHaveLength(1));
  expect(replacementInputs[0]).toEqual({ expectedSourceRevision: 0, targets: [target] });
  const threadLink = await slot.findByRole("link", { name: "Fix disk pressure" });
  expect(threadLink.getAttribute("href")).toBe("/projects/proj_picker01/threads/thr_picker01");

  fireEvent.click(slot.getByRole("link", { name: "Fix disk pressure" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_picker01" });

  fireEvent.click(slot.getByRole("button", { name: "Remove Fix disk pressure" }));
  await waitFor(() => expect(replacementInputs).toHaveLength(2));
  expect(replacementInputs[1]).toEqual({ expectedSourceRevision: 1, targets: [] });
  expect(await slot.findByText("No threads linked yet.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("refreshes the selected history range and reconciles after a missed-signal reconnect", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const ranges: number[] = [];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: (input: { rangeHours: number }) => {
          ranges.push(input.rangeHours);
          return emptySnapshot;
        },
        getAttachments: () => ({
          sourceRevision: 0,
          targets: [],
          status: {
            state: "synced" as const,
            sourceRevision: 0,
            desiredRevision: 0,
            lastAckedRevision: 0,
            pending: false,
            inFlight: false,
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            errorKind: null,
          },
        }),
      },
    } as any,
  );

  await waitFor(() => expect(ranges).toEqual([24]));
  fireEvent.change(slot.getByRole("combobox", { name: "History" }), { target: { value: "6" } });
  await waitFor(() => expect(ranges).toEqual([24, 6]));

  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(ranges).toEqual([24, 6, 6]));
  slot.lifecycle.unmount();
});

test("does not start a second snapshot request after unmount", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  let snapshotStarted = false;
  let releaseSnapshot: (() => void) | null = null;
  let snapshotCalls = 0;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => {
          snapshotCalls += 1;
          snapshotStarted = true;
          return new Promise((resolve) => { releaseSnapshot = () => resolve(emptySnapshot); });
        },
        getAttachments: () => ({
          sourceRevision: 0, targets: [], status: {
            state: "synced" as const, sourceRevision: 0, desiredRevision: 0,
            lastAckedRevision: 0, pending: false, inFlight: false, attempts: 0,
            nextAttemptAt: null, lastError: null, errorKind: null,
          },
        }),
      },
    } as any,
  );
  while (!snapshotStarted) await new Promise<void>((resolve) => setImmediate(resolve));
  void slot.behavior.emitRealtime("machine-monitor-sample", {});
  slot.lifecycle.unmount();
  (releaseSnapshot as unknown as (() => void))();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(snapshotCalls).toBe(1);
});

test("refetches a failed initial snapshot when connecting becomes connected", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  let snapshotCalls = 0;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) throw new Error("initial connection unavailable");
          return emptySnapshot;
        },
        getAttachments: () => ({
          sourceRevision: 0, targets: [], status: {
            state: "synced" as const, sourceRevision: 0, desiredRevision: 0,
            lastAckedRevision: 0, pending: false, inFlight: false, attempts: 0,
            nextAttemptAt: null, lastError: null, errorKind: null,
          },
        }),
      },
    } as any,
  );
  await waitFor(() => expect(snapshotCalls).toBe(1));
  await slot.behavior.setRealtimeConnectionState("connecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(snapshotCalls).toBe(2));
  slot.lifecycle.unmount();
});

test("renders a remove failure without leaking an unhandled rejection", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const target = {
    provider: "bb",
    keys: { project: "proj_remove01", thread: "thr_remove01" },
    presentation: { label: "Remove me", detail: "Project proj_remove01" },
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => emptySnapshot,
        getAttachments: () => ({
          sourceRevision: 1,
          targets: [target],
          status: {
            state: "synced" as const, sourceRevision: 1, desiredRevision: 1,
            lastAckedRevision: 1, pending: false, inFlight: false, attempts: 0,
            nextAttemptAt: null, lastError: null, errorKind: null,
          },
        }),
        replaceAttachments: () => { throw new Error("save failed"); },
      },
    } as any,
  );

  fireEvent.click(await slot.findByRole("button", { name: "Remove Remove me" }));
  expect((await slot.findByRole("alert")).textContent).toContain("save failed");
  slot.lifecycle.unmount();
});
