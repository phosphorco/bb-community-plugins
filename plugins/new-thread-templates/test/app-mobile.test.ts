import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountMobileTemplates } from "../ui/mobile-home.ts";
function browser(supported = true) {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><p>Other content</p></body></html>",
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(dom.window, "CSS", {
    value: { supports: () => supported },
  });
  return {
    document: dom.window.document,
    close() {
      if (previous) Object.defineProperty(globalThis, "document", previous);
      else Reflect.deleteProperty(globalThis, "document");
      dom.window.close();
    },
  };
}
test("mobile content script fails closed for unsupported selector and already-aborted lifecycle", () => {
  const unsupported = browser(false);
  try {
    const signal = new AbortController();
    expect(
      mountMobileTemplates({
        pluginId: "new-thread-templates",
        generation: 1,
        signal: signal.signal,
      }),
    ).toBeUndefined();
    expect(unsupported.document.head.querySelectorAll("style")).toHaveLength(0);
  } finally {
    unsupported.close();
  }
  const supported = browser();
  try {
    const aborted = new AbortController();
    aborted.abort();
    expect(
      mountMobileTemplates({
        pluginId: "new-thread-templates",
        generation: 1,
        signal: aborted.signal,
      }),
    ).toBeUndefined();
    expect(supported.document.head.querySelectorAll("style")).toHaveLength(0);
  } finally {
    supported.close();
  }
});
test("mobile content script installs without current route markers and stale abort/dispose removes only captured style", () => {
  const view = browser();
  const first = new AbortController(),
    second = new AbortController();
  try {
    const disposeFirst = mountMobileTemplates({
      pluginId: "new-thread-templates",
      generation: 1,
      signal: first.signal,
    });
    const old = view.document.head.querySelector("style")!;
    expect(old).toBeTruthy();
    const disposeSecond = mountMobileTemplates({
      pluginId: "new-thread-templates",
      generation: 2,
      signal: second.signal,
    });
    expect(view.document.head.querySelectorAll("style")).toHaveLength(2);
    const fresh = view.document.head.querySelector(
      '[data-new-thread-templates-mobile-layout="2"]',
    )!;
    first.abort();
    expect(old.isConnected).toBe(false);
    expect(fresh.isConnected).toBe(true);
    disposeFirst?.();
    disposeFirst?.();
    expect(view.document.head.querySelectorAll("style")).toHaveLength(1);
    expect(view.document.body.innerHTML).toBe("<p>Other content</p>");
    second.abort();
    disposeSecond?.();
    expect(fresh.isConnected).toBe(false);
    expect(view.document.head.querySelectorAll("style")).toHaveLength(0);
  } finally {
    first.abort();
    second.abort();
    view.close();
  }
});
