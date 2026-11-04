import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app from "../app";
import type { SubscriptionRow } from "../ui-contract";
const row: SubscriptionRow = {
  id: "sub-a",
  owner: "thread-a",
  owner_title: "Ship release",
  project: "p",
  subject: "Release PR",
  kind: "observation",
  state: "watching",
  created_at: 100,
  next_at: 200,
  expires_at: 900,
  generation: 1,
  last_check_at: null,
  classification: null,
  delivery: null,
  problem: null,
  stop_pending: false,
};
const snapshot = { rows: [row], total: 1, projects: ["p"], observed_at: 100 };
const detail = {
  row,
  mode: "until",
  condition: "PR merges",
  evidence_requirement: "Merge SHA",
  coverage: null,
  interpretation: null,
  interval_seconds: 60,
  classifier: "json_equals",
  checks: 0,
  observer_turns: 1,
  recipe_revisions: 1,
  runs: [],
  findings: [],
};
afterEach(cleanup);
test("page and thread panel share list; panel sends its own scope and loads diagnostics only on demand", async () => {
  const loaded = await loadPluginApp(app);
  const calls: any[] = [];
  const rpc = {
    subscriptionsList: async (input: unknown) => {
      calls.push(input);
      return snapshot;
    },
    subscriptionDetail: async () => detail,
    subscriptionDiagnostics: vi.fn(async () => ({
      observer_thread_id: "debug-thread",
      launch: "confirmed",
      review_wake: null,
      script: "echo true",
      revisions: [],
    })),
    cancelSubscription: vi.fn(),
  };
  const slot = renderSlot(
    loaded.threadPanelActions[0]!,
    { threadId: "thread-a", params: null },
    { rpc },
  );
  await waitFor(() =>
    expect(slot.container.textContent).toContain("Release PR"),
  );
  expect(calls[0].threadId).toBe("thread-a");
  fireEvent.click(slot.getByText("Release PR"));
  await waitFor(() =>
    expect(slot.container.textContent).toContain("Merge SHA"),
  );
  expect(slot.container.textContent).toContain("No check output yet");
  expect(rpc.subscriptionDiagnostics).not.toHaveBeenCalled();
  const disclosure = slot.getByText("Advanced diagnostics").closest("details")!;
  disclosure.open = true;
  fireEvent(disclosure, new Event("toggle"));
  await waitFor(() =>
    expect(slot.container.textContent).toContain("debug-thread"),
  );
  slot.lifecycle.unmount();
  const page = renderSlot(loaded.navPanels[0]!, { subPath: "" }, { rpc });
  await waitFor(() =>
    expect(page.container.textContent).toContain("Release PR"),
  );
  expect(calls.at(-1).threadId).toBeUndefined();
  page.lifecycle.unmount();
});
test("read failure retains content and recovery with identical data clears error; cancellation is never replayed", async () => {
  const loaded = await loadPluginApp(app);
  let fail = false;
  const cancel = vi.fn(async () => {
    throw new Error("Connection lost");
  });
  const slot = renderSlot(
    loaded.navPanels[0]!,
    { subPath: "sub-a" },
    {
      rpc: {
        subscriptionDetail: async () => {
          if (fail) throw new Error("Offline");
          return detail;
        },
        cancelSubscription: cancel,
      },
    },
  );
  await waitFor(() =>
    expect(slot.container.textContent).toContain("Merge SHA"),
  );
  fireEvent.click(slot.getByText("Cancel subscription"));
  fireEvent.click(slot.getByText("Confirm cancellation"));
  await waitFor(() =>
    expect(slot.container.textContent).toContain(
      "Cancellation may be unconfirmed",
    ),
  );
  expect(cancel).toHaveBeenCalledTimes(1);
  fail = true;
  fireEvent.click(slot.getByLabelText("Refresh subscriptions"));
  await waitFor(
    () =>
      expect(slot.container.textContent).toContain("Updates are unavailable"),
    { timeout: 8000 },
  );
  expect(slot.container.textContent).toContain("Merge SHA");
  fail = false;
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() =>
    expect(slot.container.textContent).not.toContain("Updates are unavailable"),
  );
  expect(slot.container.textContent).toContain(
    "Cancellation may be unconfirmed",
  );
  expect(cancel).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
}, 12000);
test("late read from an unmounted thread cannot populate another thread panel", async () => {
  const loaded = await loadPluginApp(app);
  let resolve!: (value: typeof snapshot) => void;
  const first = renderSlot(
    loaded.threadPanelActions[0]!,
    { threadId: "old", params: null },
    { rpc: { subscriptionsList: () => new Promise((r) => (resolve = r)) } },
  );
  first.lifecycle.unmount();
  const next = renderSlot(
    loaded.threadPanelActions[0]!,
    { threadId: "new", params: null },
    {
      rpc: {
        subscriptionsList: async () => ({ ...snapshot, rows: [], total: 0 }),
      },
    },
  );
  await waitFor(() =>
    expect(next.container.textContent).toContain("No active subscriptions"),
  );
  resolve(snapshot);
  await Promise.resolve();
  expect(next.container.textContent).not.toContain("Release PR");
  next.lifecycle.unmount();
});
