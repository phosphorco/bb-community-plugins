// @vitest-environment jsdom

import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { act, Component, createElement, StrictMode, useEffect, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { cleanInlineMarkdown as pureClean, excerptDisplay as pureExcerpt } from "../presentation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain() { for (let step = 0; step < 20; step++) await Promise.resolve(); }
const registered = await loadPluginApp(() => import("../app.tsx"));
const { createMentionsBodyLoader, PANEL_LOAD_RECOVERY_MS, cleanInlineMarkdown, excerptDisplay } = await import("../app.tsx");
const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() => Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true, writable: true, value: true,
}));
afterAll(() => {
  if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
function recoveryClock() {
  vi.useFakeTimers({ now: 0 });
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  // Track this loader's recovery deadline separately from unrelated fixture timers.
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true,
    value(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) {
      if (delay !== PANEL_LOAD_RECOVERY_MS) return set(callback, delay, ...args);
      let handle: ReturnType<typeof setTimeout>;
      handle = set(() => { pending.delete(handle); callback(...args); }, delay);
      pending.add(handle);
      return handle;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true,
    value(handle: ReturnType<typeof setTimeout>) { pending.delete(handle); clear(handle); },
  });
  return { pending, restore() {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: set });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: clear });
    vi.clearAllTimers();
    vi.useRealTimers();
  } };
}

test("actual Crossrefs entry preserves immediate registrations and the original public helper exports", () => {
  expect(registered.threadHeaderActions.map(action => [action.id, action.title])).toEqual([["cross-references", "References"]]);
  expect(registered.browserToolbarActions.map(action => [action.id, action.title])).toEqual([["mentions", "Mentions"]]);
  expect(registered.navPanels.map(panel => [panel.id, panel.title, panel.icon, panel.path])).toEqual([["mentions", "Mentions", "Link", "mentions"]]);
  expect(typeof registered.threadHeaderActions[0]!.component).toBe("function");
  expect(typeof registered.browserToolbarActions[0]!.component).toBe("function");
  expect(typeof registered.navPanels[0]!.component).toBe("function");
  expect(cleanInlineMarkdown).toBe(pureClean);
  expect(excerptDisplay).toBe(pureExcerpt);
  expect(cleanInlineMarkdown("run `test` and **read** [docs](https://example.test)")).toBe("run test and read docs");
  expect(excerptDisplay({ before: "see **", match: "PR #12", after: "** now" })).toEqual({ before: "see ", match: "PR #12", after: " now" });
});

test("Mentions loader defers loading and retains supplied actions and mounted input", async () => {
  const actions = { save: () => "unchanged-action" };
  let loads = 0;
  let mounts = 0;
  const received: unknown[] = [];
  function Panel(props: { actions?: typeof actions }) {
    received.push(props.actions);
    useEffect(() => { mounts++; }, []);
    return createElement("input", { "aria-label": "Panel draft", defaultValue: "kept" });
  }
  const held = deferred<{ default: typeof Panel }>();
  const Loader = createMentionsBodyLoader("Mentions", () => { loads++; return held.promise; });
  expect(loads).toBe(0);
  const host = document.createElement("div");
  document.body.append(host);
  const outside = document.createElement("button");
  document.body.append(outside);
  const root = createRoot(host);
  let mounted = true;
  try {
    await act(async () => root.render(createElement(Loader, { actions })));
    expect(loads).toBe(1);
    expect(mounts).toBe(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Loading Mentions…");
    outside.focus();
    await act(async () => { held.resolve({ default: Panel }); await drain(); });
    expect(document.activeElement).toBe(outside);
    expect(mounts).toBe(1);
    expect(received.every(value => value === actions)).toBe(true);
    const input = host.querySelector("input")!;
    input.value = "unsaved draft";
    input.focus();
    await act(async () => root.render(createElement(Loader, { actions })));
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("unsaved draft");
    expect(document.activeElement).toBe(input);
    await act(async () => root.unmount());
    mounted = false;
    const next = createRoot(host);
    try {
      await act(async () => next.render(createElement(Loader, { actions })));
      expect(loads).toBe(1);
      expect(mounts).toBe(2);
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally { await act(async () => next.unmount()); }
  } finally {
    if (mounted) await act(async () => root.unmount());
    host.remove();
    outside.remove();
  }
});

test("slow Mentions load offers recovery and a superseded load cannot replace its successor", async () => {
  const timers = recoveryClock();
  const first = deferred<{ default: () => ReactElement }>();
  const second = deferred<{ default: () => ReactElement }>();
  let loads = 0;
  const Loader = createMentionsBodyLoader("Mentions", () => ++loads === 1 ? first.promise : second.promise);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Loader)));
    await act(async () => vi.advanceTimersByTime(PANEL_LOAD_RECOVERY_MS - 1));
    expect(host.querySelector("button")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Mentions is taking longer to load.");
    expect(host.querySelector("button")?.textContent).toBe("Retry loading Mentions");
    host.querySelector("button")!.focus();
    await act(async () => host.querySelector("button")!.click());
    expect(document.activeElement).toBe(host.querySelector("[data-cr-body-loader]"));
    expect(loads).toBe(2);
    await act(async () => { first.resolve({ default: () => createElement("div", null, "Old panel") }); await drain(); });
    expect(host.textContent).not.toContain("Old panel");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Loading Mentions…");
    await act(async () => { second.resolve({ default: () => createElement("div", null, "Current panel") }); await drain(); });
    expect(host.textContent).toBe("Current panel");
    expect(document.activeElement).toBe(host.querySelector("[data-cr-body-loader]"));
    expect(timers.pending.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    timers.restore();
    host.remove();
  }
});

test("real Mentions render errors retain the native host failure boundary", async () => {
  class NativeBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
    state: { error: string | null } = { error: null };
    static getDerivedStateFromError(error: Error) { return { error: error.message }; }
    render() { return this.state.error ? createElement("div", { role: "alert" }, "Native host failure: ", this.state.error) : this.props.children; }
  }
  function BrokenPanel(): ReactElement { throw new Error("Actual panel render failed"); }
  const Loader = createMentionsBodyLoader("Mentions", async () => ({ default: BrokenPanel }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(NativeBoundary, null, createElement(Loader))); await drain(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Native host failure: Actual panel render failed");
    expect(host.textContent).not.toContain("could not load");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("failed Mentions import exposes its actual error and retries with the same supplied actions", async () => {
  const actions = { save: () => "unchanged-action" };
  let loads = 0;
  function Panel(props: { actions?: typeof actions }) {
    expect(props.actions).toBe(actions);
    return createElement("button", null, "Loaded panel action");
  }
  const Loader = createMentionsBodyLoader("Mentions", async () => {
    loads++;
    if (loads === 1) throw new Error("Panel chunk unavailable");
    return { default: Panel };
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Loader, { actions })); await drain(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Mentions could not load.");
    expect(host.querySelector("pre")?.textContent).toBe("Panel chunk unavailable");
    host.querySelector("button")!.focus();
    await act(async () => { host.querySelector("button")!.click(); await drain(); });
    expect(loads).toBe(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("Loaded panel action");
    expect(document.activeElement).toBe(host.querySelector("[data-cr-body-loader]"));
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Loader, { actions })));
    expect(loads).toBe(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("Loaded panel action");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("focused Mentions recovery hands off when the original load succeeds", async () => {
  const timers = recoveryClock();
  const held = deferred<{ default: () => ReactElement }>();
  const Loader = createMentionsBodyLoader("Mentions", () => held.promise);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Loader)));
    await act(async () => vi.advanceTimersByTime(PANEL_LOAD_RECOVERY_MS));
    host.querySelector("button")!.focus();
    await act(async () => { held.resolve({ default: () => createElement("input", { "aria-label": "Loaded panel input" }) }); await drain(); });
    expect(host.querySelector("input")).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-cr-body-loader]"));
    expect(timers.pending.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    timers.restore();
    host.remove();
  }
});

test("StrictMode Mentions teardown cancels recovery and ignores a late unmounted load", async () => {
  const timers = recoveryClock();
  const held = deferred<{ default: () => ReactElement }>();
  let loads = 0;
  let panelMounts = 0;
  const Loader = createMentionsBodyLoader("Mentions", () => { loads++; return held.promise; });
  function Panel() { useEffect(() => { panelMounts++; }, []); return createElement("div", null, "Late panel"); }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Loader))));
    expect(loads).toBe(1);
    expect(timers.pending.size).toBe(1);
    await act(async () => root.unmount());
    mounted = false;
    expect(timers.pending.size).toBe(0);
    await act(async () => { held.resolve({ default: Panel }); await drain(); await vi.advanceTimersByTime(PANEL_LOAD_RECOVERY_MS); });
    expect(panelMounts).toBe(0);
    expect(host.childNodes.length).toBe(0);
  } finally {
    if (mounted) await act(async () => root.unmount());
    timers.restore();
    host.remove();
  }
});
