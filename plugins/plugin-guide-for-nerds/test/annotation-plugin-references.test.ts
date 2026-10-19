// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/product-map", () => ({
  isGuidePageId: (id: string) => ["app-shell", "composer", "app-shell-thread"].includes(id),
  ProductMap: (props: { pluginPageHref(name: string): string | null; initialSlideId: string; onSlideChange(id: string): void }) =>
    createElement("div", { "data-page": props.initialSlideId },
      createElement("a", { href: props.pluginPageHref("Codex provider") ?? undefined }, "Codex"),
      createElement("button", { onClick: () => props.onSlideChange("composer") }, "Select composer")),
}));
const { default: GuideContent, loadPluginReferences } = await import("../src/guide-content");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
// Transferred from the donor app.test.tsx; registration belongs to the steward.
describe("loadPluginReferences", () => {
  it("merges installed plugins over catalog results through the public API", async () => {
    const signal = new AbortController().signal;
    const list = vi.fn(async () => ({ plugins: [
      { id: "github", icon: null, iconUrl: "/icons/github.svg" }, { id: "docs", icon: "Book", iconUrl: null },
    ] }));
    const search = vi.fn(async () => ({ results: [
      { pluginId: "github", icon: "Github", iconUrl: null, iconTinted: false },
      { pluginId: "tasks", icon: "ListTodo", iconUrl: null, iconTinted: true },
    ], collections: [] }));
    const references = await loadPluginReferences({ plugins: { list, catalog: { search } } } as never, signal);
    expect(list).toHaveBeenCalledWith({ signal }); expect(search).toHaveBeenCalledWith({ query: "", signal });
    expect([...references.keys()].sort()).toEqual(["docs", "github", "tasks"]);
    expect(references.get("github")).toEqual({ id: "github", icon: null, iconUrl: "/icons/github.svg", iconTinted: true });
    expect(references.get("tasks")?.iconTinted).toBe(true);
  });
  it("treats a failing source as empty instead of dropping the whole map", async () => {
    const references = await loadPluginReferences({ plugins: {
      list: async () => { throw new Error("offline"); },
      catalog: { search: async () => ({ results: [{ pluginId: "tasks", icon: null, iconUrl: null, iconTinted: false }], collections: [] }) },
    } } as never, new AbortController().signal);
    expect([...references.keys()]).toEqual(["tasks"]);
  });
});
function pendingReferences() {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(resolvePromise => { resolve = resolvePromise; }); return { pending, resolve };
}
function mount(session: AbortController, list: ReturnType<typeof vi.fn>, pageId = "app-shell") {
  const selection = vi.fn();
  const view = renderSlot({ component: GuideContent }, {
    sessionSignal: session.signal, initialSelection: { section: "surfaces", pageId }, onSelectionChange: selection,
  }, { sdk: { plugins: { list, catalog: { search: async () => ({ results: [], collections: [] }) } } } as never });
  return { view, selection };
}
describe("mounted guide reference lifetime and local selection", () => {
  it("starts lookups on mount, resolves links, and reports local pages without BB navigation", async () => {
    const list = vi.fn(async () => ({ plugins: [{ id: "provider-codex", icon: null, iconUrl: "/codex.svg" }] }));
    expect(list).not.toHaveBeenCalled(); const { view, selection } = mount(new AbortController(), list, "composer");
    await act(async () => {}); expect(list).toHaveBeenCalledOnce();
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("/plugins/provider-codex");
    expect(view.container.querySelector("[data-page]")?.getAttribute("data-page")).toBe("composer");
    fireEvent.click(view.getByText("Select composer"));
    expect(selection).toHaveBeenCalledWith({ section: "surfaces", pageId: "composer" });
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(view.container.querySelector("[data-guide-stage-viewport]")).toBeNull();
    expect(view.container.querySelector("[data-guide-content]")?.className).not.toContain("overflow-y-auto");
  });
  it.each(["abort", "unmount"])("aborts requests and suppresses stale completion on %s", async mode => {
    const request = pendingReferences(); const list = vi.fn((_options: { signal: AbortSignal }) => request.pending); const session = new AbortController();
    const { view, selection } = mount(session, list, "invalid-saved-id");
    expect(view.container.querySelector("[data-page]")?.getAttribute("data-page")).toBe("app-shell");
    const signal = list.mock.calls[0]![0].signal as AbortSignal;
    if (mode === "abort") act(() => session.abort()); else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { request.resolve({ plugins: [{ id: "provider-codex", icon: null, iconUrl: "/late.svg" }] }); });
    expect(view.container.querySelector("a[href]")).toBeNull();
    if (mode === "abort") fireEvent.click(view.getByText("Select composer"));
    expect(selection).not.toHaveBeenCalled();
  });
  it("does not request anything for an already aborted session", () => {
    const session = new AbortController(); session.abort(); const list = vi.fn(); const { view } = mount(session, list);
    expect(list).not.toHaveBeenCalled(); expect(view.inspection.sdkCalls).toEqual([]);
  });
});
