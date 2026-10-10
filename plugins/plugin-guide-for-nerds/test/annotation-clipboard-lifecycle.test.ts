// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceCard } from "../src/surface-card";
import { SURFACE_GROUPS } from "../src/surfaces";
const surfaces = SURFACE_GROUPS[0]!.surfaces;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function pendingCopy() {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function cardProps(signal: AbortSignal, copy: (surface: typeof surfaces[number]) => Promise<boolean>, index = 0) {
  return { surface: surfaces[index]!, number: 1, onDismiss: () => {}, onCopyForAgent: copy, sessionSignal: signal };
}
describe("card clipboard lifetime", () => {
  it.each(["abort", "unmount", "surface"])("creates no late feedback timer after %s", async mode => {
    const request = pendingCopy(); const copy = vi.fn(() => request.promise); const session = new AbortController();
    const view = render(createElement(SurfaceCard, cardProps(session.signal, copy)));
    act(() => vi.advanceTimersByTime(400)); // Retain donor's initial smooth-scroll delay in this lane.
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Copy for agent" }));
    fireEvent.click(view.getByRole("button", { name: "Copy for agent" }));
    expect(copy).toHaveBeenCalledOnce();
    if (mode === "abort") act(() => session.abort());
    if (mode === "unmount") view.unmount();
    if (mode === "surface") view.rerender(createElement(SurfaceCard, cardProps(session.signal, copy, 1)));
    await act(async () => request.resolve(true));
    expect(vi.getTimerCount()).toBe(0); expect(view.container.textContent).not.toContain("Copied");
  });
  it("clears feedback on session abort without creating a delayed scroll timer", async () => {
    const session = new AbortController();
    const view = render(createElement(SurfaceCard, cardProps(session.signal, async () => true)));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy for agent" })));
    expect(view.container.textContent).toContain("Copied"); expect(vi.getTimerCount()).toBe(1);
    act(() => session.abort()); expect(vi.getTimerCount()).toBe(0);
  });
  it("shows current rejection as failure, retries, and replaces rather than accumulates feedback timers", async () => {
    const copy = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(true);
    const view = render(createElement(SurfaceCard, cardProps(new AbortController().signal, copy)));
    act(() => vi.advanceTimersByTime(400));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy for agent" })));
    expect(view.container.textContent).toContain("Copy failed"); expect(vi.getTimerCount()).toBe(1);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy failed. Retry copy for agent" })));
    expect(view.container.textContent).toContain("Copied"); expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(2_000)); expect(view.container.textContent).not.toContain("Copied");
  });
  it("ignores an older surface result while a newer surface request owns feedback", async () => {
    const old = pendingCopy(); const fresh = pendingCopy(); const copy = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const session = new AbortController(); const view = render(createElement(SurfaceCard, cardProps(session.signal, copy)));
    act(() => vi.advanceTimersByTime(400)); fireEvent.click(view.getByRole("button", { name: "Copy for agent" }));
    view.rerender(createElement(SurfaceCard, cardProps(session.signal, copy, 1)));
    fireEvent.click(view.getByRole("button", { name: "Copy for agent" }));
    await act(async () => old.resolve(true)); expect(view.container.textContent).toContain("Copying…"); expect(vi.getTimerCount()).toBe(0);
    await act(async () => fresh.resolve(false)); expect(view.container.textContent).toContain("Copy failed"); expect(vi.getTimerCount()).toBe(1);
  });
});
