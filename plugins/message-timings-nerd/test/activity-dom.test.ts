import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// Run the same first-mount oracle against preserved baseline bytes without
// replacing canonical source. Only this fixture reads the optional source URL.
const { createActivityStrip }: typeof import("../activity.ts") = await import(
  process.env.MESSAGE_TIMINGS_ACTIVITY_SOURCE ?? "../activity.ts"
);
const selector = ".message-timings-nerd__activity";
const anchorHTML = '<div data-follow-up-composer-anchor><div data-follow-up-composer><input aria-label="Message"></div></div>';
const primaryHTML = `<section data-app-composer-role="primary">${anchorHTML}</section>`;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(html = primaryHTML) {
  const dom = new JSDOM(`<main>${html}</main><aside>${primaryHTML}</aside>`, { pretendToBeVisual: true });
  const { document: doc } = dom.window;
  const root = doc.querySelector("main")!;
  const timers = new Map<number, number>();
  let nextTimer = 0;
  dom.window.setTimeout = ((_fn: unknown, delay: number) => {
    const id = ++nextTimer; timers.set(id, delay); return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof dom.window.clearTimeout;
  const controller = createActivityStrip(root);
  return { dom, doc, root, timers, controller, close() { controller.dispose(); dom.window.close(); } };
}
const completed = () => [{ from: Date.now() - 120_000, to: Date.now() - 60_000 }];

test("intrinsic Activity row exists before first timings and retains identity across data states", () => {
  const f = fixture();
  try {
    const row = f.root.querySelector(selector)!;
    assert.ok(row, "eligible pending Activity must already occupy its intrinsic row");
    const anchor = f.root.querySelector("[data-follow-up-composer-anchor]")!;
    assert.equal(row.nextElementSibling, anchor);
    assert.equal(row.getAttribute("data-activity-state"), "pending");
    assert.equal(row.getAttribute("aria-busy"), "true");
    assert.match(row.textContent!, /Loading activity/);
    assert.doesNotMatch(row.textContent!, /0%|quiet/);
    const input = f.root.querySelector("input")!;
    input.focus();
    f.controller.update([]);
    assert.equal(row.getAttribute("data-activity-state"), "empty");
    assert.match(row.textContent!, /No activity in loaded history/);
    f.controller.update([], true);
    assert.equal(row.getAttribute("data-activity-state"), "incomplete");
    assert.match(row.textContent!, /partial history/);
    f.controller.update(completed());
    assert.equal(row.getAttribute("data-activity-state"), "ready");
    assert.equal(row.getAttribute("role"), "img");
    assert.match(row.getAttribute("aria-label")!, /Active/);
    assert.ok(row.querySelector(".message-timings-nerd__activity-segment--active"));
    f.controller.update([]);
    assert.equal(row.getAttribute("role"), "status");
    assert.equal(row.hasAttribute("aria-busy"), false);
    assert.equal(row.querySelector(".message-timings-nerd__activity-caption")!.hasAttribute("aria-hidden"), false);
    assert.equal(row.querySelectorAll(".message-timings-nerd__activity-segment").length, 0);
    assert.equal(f.root.querySelector(selector), row);
    assert.equal(row.nextElementSibling, anchor);
    assert.equal(f.doc.activeElement, input);
    assert.equal(f.doc.querySelector("aside")!.querySelector(selector), null);
  } finally { f.close(); }
});

test("Activity failure differs from empty and unchanged recovery clears failure while retaining last good bars", () => {
  const f = fixture();
  try {
    const row = f.root.querySelector(selector)!;
    f.controller.unavailable();
    assert.equal(row.getAttribute("data-activity-state"), "unavailable");
    assert.match(row.textContent!, /Activity unavailable/);
    assert.doesNotMatch(row.getAttribute("aria-label")!, /No activity|0%/);
    const turns = completed();
    f.controller.update(turns, true);
    const bar = row.querySelector(".message-timings-nerd__activity-segment--active")!;
    f.controller.unavailable();
    assert.equal(row.getAttribute("data-activity-state"), "unavailable");
    assert.equal(row.querySelector(".message-timings-nerd__activity-segment--active"), bar);
    assert.match(row.getAttribute("aria-label")!, /last loaded activity/);
    assert.match(row.textContent!, /update unavailable/);
    f.controller.update(turns, true);
    assert.equal(row.getAttribute("data-activity-state"), "incomplete");
    assert.doesNotMatch(row.textContent!, /unavailable/);
    assert.doesNotMatch(row.getAttribute("aria-label")!, /unavailable/);
    assert.equal(row.querySelector(".message-timings-nerd__activity-segment--active"), bar);
    f.controller.update([]);
    f.controller.unavailable();
    assert.match(row.getAttribute("aria-label")!, /last loaded history/);
    f.controller.update([]);
    assert.equal(row.getAttribute("data-activity-state"), "empty");
    assert.doesNotMatch(row.getAttribute("aria-label")!, /unavailable/);
    assert.equal(f.root.querySelector(selector), row);
  } finally { f.close(); }
});

test("Activity primary eligibility beats fallback, preserves blocked questions and restores the same row", async () => {
  const f = fixture(`${anchorHTML}${primaryHTML.replace("data-follow-up-composer>", "data-follow-up-composer hidden>")}`);
  try {
    assert.equal(f.root.querySelector(selector), null, "blocked primary must not borrow an eligible fallback");
    const primary = f.root.querySelector('[data-app-composer-role="primary"]')!;
    const composer = primary.querySelector("[data-follow-up-composer]")!;
    composer.removeAttribute("hidden"); await flush();
    const row = f.root.querySelector(selector)!;
    assert.ok(row);
    assert.equal(row.nextElementSibling, primary.querySelector("[data-follow-up-composer-anchor]"));
    composer.setAttribute("hidden", ""); await flush();
    assert.equal(row.isConnected, false);
    f.controller.update(completed());
    assert.equal(row.isConnected, false);
    composer.removeAttribute("hidden"); await flush();
    assert.equal(f.root.querySelector(selector), row);
    assert.equal(row.getAttribute("data-activity-state"), "ready");
  } finally { f.close(); }
});

test("Activity pending fallback yields to a late blocked primary and resumes above that primary", async () => {
  const f = fixture(anchorHTML);
  try {
    const row = f.root.querySelector(selector)!;
    const fallback = f.root.querySelector("[data-follow-up-composer-anchor]")!;
    assert.ok(row);
    assert.equal(row.nextElementSibling, fallback);
    f.root.insertAdjacentHTML("beforeend", primaryHTML.replace("data-follow-up-composer>", "data-follow-up-composer hidden>"));
    await flush();
    assert.equal(row.isConnected, false, "late blocked primary must retire fallback placement");
    assert.equal(f.root.contains(fallback), true);
    const primary = f.root.querySelector('[data-app-composer-role="primary"]')!;
    primary.querySelector("[data-follow-up-composer]")!.removeAttribute("hidden");
    await flush();
    assert.equal(f.root.querySelector(selector), row);
    assert.equal(row.nextElementSibling, primary.querySelector("[data-follow-up-composer-anchor]"));
    assert.equal(row.getAttribute("data-activity-state"), "pending");
    assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test("Activity pending fallback moves to a late eligible primary while fallback remains", async () => {
  const f = fixture(anchorHTML);
  try {
    const row = f.root.querySelector(selector)!;
    const fallback = f.root.querySelector("[data-follow-up-composer-anchor]")!;
    assert.equal(row.nextElementSibling, fallback);
    f.root.insertAdjacentHTML("beforeend", primaryHTML);
    await flush();
    const primary = f.root.querySelector('[data-app-composer-role="primary"]')!;
    assert.equal(f.root.querySelector(selector), row);
    assert.equal(f.root.contains(fallback), true);
    assert.equal(row.nextElementSibling, primary.querySelector("[data-follow-up-composer-anchor]"));
    assert.equal(row.getAttribute("data-activity-state"), "pending");
    assert.equal(f.doc.querySelector("aside")!.querySelector(selector), null);
    assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test("Activity keeps positive hover details and accessible partial-history information", () => {
  const f = fixture();
  try {
    f.controller.update(completed(), true);
    const row = f.root.querySelector(selector)!;
    const track = row.querySelector(".message-timings-nerd__activity-track") as HTMLElement;
    Object.defineProperty(track, "clientWidth", { value: 200 });
    track.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 200, 4);
    row.dispatchEvent(new f.dom.window.MouseEvent("pointermove", { clientX: 25 }));
    const tip = row.querySelector(".message-timings-nerd__activity-tip") as HTMLElement;
    assert.equal(tip.hidden, false);
    assert.match(tip.querySelector(".message-timings-nerd__activity-tip-title")!.textContent!, /Active/);
    assert.ok(tip.querySelector(".message-timings-nerd__activity-tip-detail")!.textContent);
    assert.match(tip.textContent!, /loaded history only/);
    assert.match(row.getAttribute("aria-label")!, /loaded history only/);
    row.dispatchEvent(new f.dom.window.MouseEvent("pointerleave"));
    assert.equal(tip.hidden, true);
    f.controller.update([]);
    row.dispatchEvent(new f.dom.window.MouseEvent("pointermove", { clientX: 25 }));
    assert.equal(tip.hidden, true, "empty history cannot retain a stale positive tooltip");
  } finally { f.close(); }
});

test("Activity discovers fallback and replacement anchors only in its pane; disposal prevents resurrection", async () => {
  const f = fixture("");
  try {
    assert.equal(f.root.querySelector(selector), null);
    f.root.insertAdjacentHTML("beforeend", anchorHTML); await flush();
    const row = f.root.querySelector(selector)!;
    assert.ok(row);
    assert.equal(row.getAttribute("data-activity-state"), "pending");
    f.root.querySelector("[data-follow-up-composer-anchor]")!.remove(); await flush();
    assert.equal(row.isConnected, false);
    f.root.insertAdjacentHTML("beforeend", primaryHTML); await flush();
    assert.equal(f.root.querySelector(selector), row);
    assert.equal(f.doc.querySelector("aside")!.querySelector(selector), null);
    f.controller.dispose();
    f.root.insertAdjacentHTML("beforeend", anchorHTML);
    f.dom.window.dispatchEvent(new f.dom.window.Event("focus"));
    f.dom.window.dispatchEvent(new f.dom.window.Event("pageshow"));
    f.controller.update(completed());
    await flush();
    assert.equal(f.root.querySelector(selector), null);
    assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test("Activity status rows have no clocks; positive clocks pause hidden and dispose without losing row identity", () => {
  const f = fixture();
  try {
    const row = f.root.querySelector(selector)!;
    assert.equal(f.timers.size, 0);
    f.controller.update([]); assert.equal(f.timers.size, 0);
    f.controller.update([], true); assert.equal(f.timers.size, 0);
    f.controller.unavailable(); assert.equal(f.timers.size, 0);
    f.controller.update(completed());
    assert.deepEqual([...f.timers.values()], [600_000]);
    f.controller.update([{ from: Date.now() - 60_000, to: null }]);
    assert.deepEqual([...f.timers.values()], [60_000]);
    assert.match(row.getAttribute("aria-label")!, /Agent running/);
    f.controller.unavailable();
    assert.match(row.getAttribute("aria-label")!, /Last loaded activity indicates agent running/);
    let hidden = true;
    Object.defineProperty(f.doc, "hidden", { get: () => hidden });
    f.doc.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    assert.equal(f.timers.size, 0);
    hidden = false;
    f.doc.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    assert.deepEqual([...f.timers.values()], [60_000]);
    assert.equal(f.root.querySelector(selector), row);
    f.controller.dispose();
    assert.equal(f.timers.size, 0);
    assert.equal(row.isConnected, false);
  } finally { f.close(); }
});
