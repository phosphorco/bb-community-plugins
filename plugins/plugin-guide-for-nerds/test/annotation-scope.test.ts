// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductMap } from "../src/product-map";
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const selection = vi.fn(); const frameKey = vi.fn();
  const view = render(createElement("div", { role: "dialog", "data-guide-frame": "", "data-bb-plugin": "plugin-guide-for-nerds", onKeyDown: frameKey },
    createElement(ProductMap, { onSlideChange: selection })));
  const selectCard = () => fireEvent.click(view.container.querySelector<HTMLAnchorElement>('[data-map-section="app-shell"] a[href="#surface-sidebar-navigation"]')!);
  return { view, selection, frameKey, selectCard };
}
describe("content relative to the outer nonmodal frame", () => {
  it("restores a dismissed card's focus to its opener and lets the next Escape reach the frame", () => {
    const { view, frameKey } = fixture();
    const opener = view.container.querySelector<HTMLAnchorElement>('[data-map-section="app-shell"] a[href="#surface-sidebar-navigation"]')!;
    opener.focus(); fireEvent.click(opener);
    const close = view.container.querySelector<HTMLButtonElement>('[data-guide-card] button[aria-label="Close"]')!;
    close.focus(); fireEvent.keyDown(close, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
    expect(opener.closest('[inert], [hidden]')).toBeNull();
    fireEvent.keyDown(opener, { key: 'Escape' });
    expect(frameKey).toHaveBeenCalledOnce();
  });
  it("moves keyboard focus from an inactivated fixture to the new page control", () => {
    const { view } = fixture();
    const hotspot = view.container.querySelector<HTMLAnchorElement>('[data-map-section="app-shell"] a[href="#surface-sidebar-navigation"]')!;
    hotspot.focus(); fireEvent.keyDown(hotspot, { key: 'ArrowRight' });
    const selected = view.container.querySelector('[data-guide-page-list-scroll] [aria-current="true"]');
    expect(document.activeElement).toBe(selected);
    expect(selected?.closest('[inert], [hidden]')).toBeNull();
  });
  it("keeps repeated mobile arrows on the visible current page", () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const { view, selection } = fixture();
    for (let i = 0; i < 3; i++) {
      const button = view.container.querySelector<HTMLButtonElement>('[data-guide-page-list-scroll] [aria-current="true"]')!;
      button.focus(); fireEvent.keyDown(button, { key: 'ArrowRight' });
      expect(document.activeElement).toBe(view.container.querySelector('[data-guide-page-list-scroll] [aria-current="true"]'));
      expect(document.activeElement?.closest('[inert], [hidden]')).toBeNull();
    }
    expect(selection).toHaveBeenCalledTimes(3);
  });
  it("allows map arrows inside the frame and keeps composer arrows outside untouched", () => {
    const { view, selection } = fixture(); fireEvent.keyDown(view.getByLabelText("Next surface"), { key: "ArrowRight" });
    expect(selection).toHaveBeenCalledOnce(); const composer = document.createElement("textarea"); document.body.append(composer);
    fireEvent.keyDown(composer, { key: "ArrowRight" }); expect(selection).toHaveBeenCalledOnce(); composer.remove();
  });
  it("does not page from editable targets, inner dialogs or consumed events", () => {
    const { view, selection } = fixture(); const section = view.container.querySelector("section")!;
    for (const tag of ["input", "textarea", "select"]) {
      const target = document.createElement(tag); section.append(target); fireEvent.keyDown(target, { key: "ArrowRight" }); target.remove();
    }
    const inner = document.createElement("div"); inner.setAttribute("data-guide-inner-layer", "");
    const target = document.createElement("button"); inner.append(target); section.append(inner);
    fireEvent.keyDown(target, { key: "ArrowRight" });
    const consumed = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }); consumed.preventDefault();
    view.getByLabelText("Next surface").dispatchEvent(consumed); expect(selection).not.toHaveBeenCalled();
  });
  it("dismisses annotations before frame Escape from map controls and card controls", () => {
    const { view, frameKey, selectCard } = fixture();
    for (const fromCard of [false, true]) {
      selectCard(); expect(view.container.querySelector("[data-guide-card]")).not.toBeNull();
      const target = fromCard ? view.container.querySelector('[data-guide-card] button')! : view.getByLabelText("Next surface");
      fireEvent.keyDown(target, { key: "Escape" }); expect(view.container.querySelector("[data-guide-card]")).toBeNull();
      expect(frameKey).not.toHaveBeenCalled();
    }
    fireEvent.keyDown(view.getByLabelText("Next surface"), { key: "Escape" }); expect(frameKey).toHaveBeenCalledOnce();
  });
  it("preserves nested controls and composer Escape while permitting map pointer dismissal", () => {
    const { view, selectCard } = fixture(); selectCard(); const card = () => view.container.querySelector("[data-guide-card]");
    const inner = document.createElement("div"); inner.setAttribute("role", "menu"); inner.setAttribute("data-guide-inner-layer", "");
    const button = document.createElement("button"); inner.append(button); card()!.append(inner);
    fireEvent.keyDown(button, { key: "Escape" }); expect(card()).not.toBeNull();
    fireEvent.pointerDown(button); expect(card()).not.toBeNull();
    const composer = document.createElement("textarea"); document.body.append(composer);
    fireEvent.keyDown(composer, { key: "Escape" }); fireEvent.pointerDown(composer); expect(card()).not.toBeNull(); composer.remove();
    fireEvent.pointerDown(view.container.querySelector("[data-map-column] h2")!); expect(card()).toBeNull();
  });
});
