import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { LinkedReferences as References, type ReferencesApi } from "../dist/react.js";
import type { ReferenceSnapshot } from "../dist/index.js";
const dom = new JSDOM("<html><body></body></html>", { url: "https://bb.test" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(0), 0),
});
dom.window.requestAnimationFrame = (callback) =>
  dom.window.setTimeout(() => callback(0), 0);
const { createRoot } = await import("react-dom/client");
let root: Root | null = null;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
function fixture() {
  let snapshot: ReferenceSnapshot = {
    revision: 0,
    targets: [],
    status: { state: "synced", error: null },
  };
  const calls: string[] = [];
  const api: ReferencesApi = {
    get: async () => {
      calls.push("get");
      return structuredClone(snapshot);
    },
    replace: async (revision, targets) => {
      calls.push("replace");
      expect(revision).toBe(snapshot.revision);
      snapshot = {
        revision: revision + 1,
        targets,
        status: { state: "degraded", error: "Peer absent" },
      };
      return structuredClone(snapshot);
    },
    search: async (query) => {
      calls.push(query);
      return {
        threads: [
          {
            id: "thr_one",
            projectId: "proj_one",
            title: "Prompt design discussion",
          },
        ],
      };
    },
    thread: async (id) => ({
      id,
      projectId: "proj_one",
      title: "Resolved thread",
    }),
  };
  return { api, calls, snapshot: () => snapshot };
}
async function mount(
  api: ReferencesApi,
  navigate = (_id: string) => {},
  token = 0,
  ownerKey = "fixture",
) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      createElement(References, { api, navigateThread: navigate, refreshToken: token, ownerKey }),
    ),
  );
}
async function enter(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function settleSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
}
async function click(text: string) {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((value) => value.textContent === text)!;
  await act(async () => button.click());
}
test("page links stay usable while shared Cross References is absent", async () => {
  const f = fixture();
  await mount(f.api);
  await enter("https://example.com/prompts");
  await click("Link");
  expect(f.snapshot().targets).toHaveLength(1);
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com/prompts",
  );
  expect(container.textContent).toContain(
    "Cross References is unavailable",
  );
  await click("Remove");
  expect(f.snapshot().targets).toHaveLength(0);
  expect(f.snapshot().revision).toBe(2);
});
test("thread picker navigates natively and avoids duplicate attachments", async () => {
  const f = fixture();
  const navigation: string[] = [];
  await mount(f.api, (id) => navigation.push(id));
  await enter("prompt");
  await settleSearch();
  await click("Link");
  const link = container.querySelector<HTMLAnchorElement>("a")!;
  await act(async () =>
    link.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    ),
  );
  expect(navigation).toEqual(["thr_one"]);
  expect(link.href).toContain("/projects/proj_one/threads/thr_one");
  await enter("prompt");
  await settleSearch();
  expect(
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Linked",
    )?.disabled,
  ).toBe(true);
});
test("unknown write outcome reconciles once and never resends", async () => {
  const f = fixture();
  let replacements = 0;
  const real = f.api.replace;
  f.api.replace = async (...args) => {
    replacements++;
    await real(...args);
    throw new Error("Response lost");
  };
  await mount(f.api);
  await enter("https://example.com/prompts");
  await click("Link");
  expect(replacements).toBe(1);
  expect(container.textContent).toContain("Response lost");
  expect(container.querySelector("a")?.textContent).toBe("example.com");
  expect(f.calls.filter((value) => value === "get")).toHaveLength(2);
});
test("late thread search cannot replace results for newer input", async () => {
  const f = fixture();
  let resolve!: (value: {
    threads: { id: string; projectId: string; title: string }[];
  }) => void;
  f.api.search = async () =>
    new Promise((done) => {
      resolve = done;
    });
  await mount(f.api);
  await enter("old");
  await settleSearch();
  await enter("https://example.com/new");
  await act(async () =>
    resolve({
      threads: [{ id: "old", projectId: "project", title: "Stale result" }],
    }),
  );
  expect(container.textContent).not.toContain("Stale result");
  expect(container.textContent).toContain("Link");
});
test("a read started before a local edit cannot overwrite committed links", async () => {
  const f = fixture();
  await mount(f.api);
  let resolve!: (value: ReferenceSnapshot) => void;
  let delayed = false;
  f.api.get = async () => {
    if (delayed) return structuredClone(f.snapshot());
    delayed = true;
    return new Promise((done) => {
      resolve = done;
    });
  };
  await click("Refresh links");
  await enter("https://example.com/prompts");
  await click("Link");
  await act(async () =>
    resolve({
      revision: 0,
      targets: [],
      status: { state: "synced", error: null },
    }),
  );
  expect(container.querySelector("a")?.textContent).toBe("example.com");
});

test("credential-bearing URLs are rejected before save", async () => {
  const f = fixture();
  await mount(f.api);
  await enter("https://example.com/?token=secret");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "sensitive",
  );
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Link",
    ),
  ).toBe(false);
  expect(f.calls).toEqual(["get"]);
});

test("failed write drains a refresh received while reconciliation is pending", async () => {
  const f = fixture();
  await mount(f.api);
  const real = f.api.replace;
  let reconcile!: (snapshot: ReferenceSnapshot) => void;
  let reads = 0;
  f.api.replace = async (...args) => {
    await real(...args);
    throw new Error("Lost acknowledgement");
  };
  f.api.get = async () => {
    reads++;
    if (reads === 1)
      return new Promise((done) => {
        reconcile = done;
      });
    return {
      ...structuredClone(f.snapshot()),
      status: { state: "synced", error: null },
    };
  };
  await enter("https://example.com/prompts");
  await click("Link");
  await mount(f.api, () => {}, 1);
  await act(async () =>
    reconcile({
      ...structuredClone(f.snapshot()),
      status: { state: "pending", error: null },
    }),
  );
  expect(reads).toBe(2);
  expect(container.textContent).not.toContain("sharing links…");
  expect(container.textContent).toContain("Lost acknowledgement");
  expect(container.querySelector("a")?.textContent).toBe("example.com");
});
test("keyboard add restores input focus after the focused action disappears", async () => {
  const f = fixture();
  await mount(f.api);
  await enter("https://example.com/prompts");
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((value) => value.textContent === "Link")!;
  button.focus();
  await click("Link");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(
    container.querySelector('input[type="search"]'),
  );
});
test("same-origin thread URLs reject sensitive parameters before thread resolution", async () => {
  const f = fixture();
  await mount(f.api);
  await enter("https://bb.test/projects/proj_one/threads/thr_one?token=secret");
  await settleSearch();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "sensitive",
  );
  expect(f.calls).toEqual(["get"]);
});

test("delayed keyboard add preserves focus moved to another control", async () => {
  const f = fixture();
  await mount(f.api);
  await enter("https://example.com/prompts");
  const real = f.api.replace;
  let finish!: () => void;
  f.api.replace = async (...args) => {
    await new Promise<void>((done) => {
      finish = done;
    });
    return real(...args);
  };
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((value) => value.textContent === "Link")!;
  button.focus();
  await click("Link");
  const outside = document.createElement("button");
  outside.textContent = "Other control";
  document.body.append(outside);
  outside.focus();
  await act(async () => finish());
  expect(document.activeElement === outside).toBe(true);
});


test("changing owner drops old snapshot and outstanding read before editing new owner", async () => {
  const a = fixture(), b = fixture();
  let resolve!: (snapshot: ReferenceSnapshot) => void;
  a.api.get = () => new Promise((done) => {resolve = done;});
  await mount(a.api, () => {}, 0, "owner-a");
  await mount(b.api, () => {}, 0, "owner-b");
  await act(async () => resolve({revision: 99, targets: [{provider:"url",keys:{href:"https://old.test/"},presentation:{label:"Old owner",url:"https://old.test/"}}],status:{state:"synced",error:null}}));
  expect(container.textContent).not.toContain("Old owner");
  await enter("https://example.com/prompts");
  await click("Link");
  expect(b.snapshot().revision).toBe(1);
  expect(a.calls).toEqual([]);
  expect(container.querySelector('[title="Peer absent"]')).not.toBeNull();
});
