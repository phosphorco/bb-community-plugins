/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copyPluginSurfaceAgentReference,
  createPluginSurfaceAgentReference,
  PLUGIN_GUIDE_PLUGIN_ID,
  pluginSurfaceAgentClipboardContent,
  pluginSurfaceAgentContext,
} from "../src/agent-reference";
import { SURFACES_BY_ID } from "../src/surfaces";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Plugin Guide agent references", () => {
  it("derives the complete reference from canonical surface data", () => {
    const surface = SURFACES_BY_ID.get("code-renderers");
    if (!surface) throw new Error("code-renderers surface missing");

    const reference = createPluginSurfaceAgentReference(surface);
    expect(reference).toEqual(createPluginSurfaceAgentReference(surface));
    expect(reference.identity).toEqual({
      provider: "surface",
      id: "code-renderers",
      label: "Code & diff renderers",
    });
    expect(reference.resource).toEqual({
      kind: "plugin",
      pluginId: PLUGIN_GUIDE_PLUGIN_ID,
      icon: null,
      itemId: "surface:code-renderers",
      label: "Code & diff renderers",
    });
    expect(reference.context.split("\n")).toHaveLength(3);
    expect(reference.clipboard.text).toBe(
      "Build a plugin that uses @Code & diff renderers ",
    );
  });

  it("resolves only surface identity, SDK symbols, and the authoring guide", () => {
    const context = pluginSurfaceAgentContext("composer-actions");
    expect(context).toContain("Inline actions (composer-actions)");
    expect(context).toContain("PluginComposerApi");
    expect(context).toContain("bb-plugin-authoring skill");
    expect(context?.split("\n")).toHaveLength(3);
    expect(pluginSurfaceAgentContext("missing-surface")).toBeNull();
  });

  it("serializes one surface as bb's existing structured composer pill", () => {
    const surface = SURFACES_BY_ID.get("composer-actions");
    if (!surface) throw new Error("composer-actions surface missing");

    const content = pluginSurfaceAgentClipboardContent(surface);
    const document = new DOMParser().parseFromString(content.html, "text/html");
    const pill = document.querySelector("[data-prompt-mention='true']");

    expect(content.text).toBe("Build a plugin that uses @Inline actions ");
    expect(document.body.textContent).toBe(content.text);
    expect(pill?.textContent).toBe("@Inline actions");
    expect(pill?.getAttribute("data-prompt-mention-serialized-text")).toBe(
      "@Inline actions",
    );
    expect(
      JSON.parse(pill?.getAttribute("data-prompt-mention-resource") ?? ""),
    ).toEqual({
      kind: "plugin",
      pluginId: PLUGIN_GUIDE_PLUGIN_ID,
      icon: null,
      itemId: "surface:composer-actions",
      label: "Inline actions",
    });
  });

  it("keeps multiple copied surfaces distinct and composable", () => {
    const actions = SURFACES_BY_ID.get("composer-actions");
    const panels = SURFACES_BY_ID.get("thread-panel");
    if (!actions || !panels) throw new Error("reference surfaces missing");

    const document = new DOMParser().parseFromString(
      [actions, panels]
        .map((surface) => pluginSurfaceAgentClipboardContent(surface).html)
        .join(""),
      "text/html",
    );
    const resources = [...document.querySelectorAll("[data-prompt-mention]")]
      .map((pill) => pill.getAttribute("data-prompt-mention-resource"))
      .map((value) => JSON.parse(value ?? ""));

    expect(resources.map((resource) => resource.itemId)).toEqual([
      "surface:composer-actions",
      "surface:thread-panel",
    ]);
    expect(document.body.textContent).toBe(
      "Build a plugin that uses @Inline actions " +
        "Build a plugin that uses @Thread side-panel tabs ",
    );
  });

  it("gives every surface a byte-stable, globally distinct pill identity", () => {
    const itemIds = [...SURFACES_BY_ID.values()].map((surface) => {
      const first = createPluginSurfaceAgentReference(surface);
      const second = createPluginSurfaceAgentReference(surface);
      expect(first).toEqual(second);
      expect(first.clipboard.html).not.toContain(surface.summary);
      for (const bullet of surface.bullets) {
        expect(first.clipboard.html).not.toContain(bullet);
      }
      return first.resource.itemId;
    });

    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  it("writes both rich and plain clipboard representations", async () => {
    const surface = SURFACES_BY_ID.get("composer-actions");
    if (!surface) throw new Error("composer-actions surface missing");
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const items: Array<Record<string, Blob>> = [];
    class TestClipboardItem {
      constructor(item: Record<string, Blob>) {
        items.push(item);
      }
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write: clipboardWrite } });

    await expect(copyPluginSurfaceAgentReference(surface)).resolves.toBe(true);
    expect(clipboardWrite).toHaveBeenCalledOnce();
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      "text/html",
      "text/plain",
    ]);
    await expect(items[0]?.["text/plain"]?.text()).resolves.toBe(
      "Build a plugin that uses @Inline actions ",
    );
    await expect(items[0]?.["text/html"]?.text()).resolves.toContain(
      'Build a plugin that uses <span data-prompt-mention="true"',
    );
  });
});


it("owns copied references independently from the original guide", () => {
  const surface = SURFACES_BY_ID.get("composer-actions")!;
  expect(PLUGIN_GUIDE_PLUGIN_ID).toBe("plugin-guide-for-nerds");
  const reference = createPluginSurfaceAgentReference(surface);
  expect(reference.resource.pluginId).not.toBe("plugin-api-docs");
  expect(reference.clipboard.html).toContain("plugin-guide-for-nerds");
  expect(reference.identity.id).toBe("composer-actions");
});

it("does not start a clipboard write for an aborted session", async () => {
  const write = vi.fn(); vi.stubGlobal("navigator", { clipboard: { write } });
  const session = new AbortController(); session.abort();
  await expect(copyPluginSurfaceAgentReference(SURFACES_BY_ID.get("composer-actions")!, session.signal)).resolves.toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it("does not perform editing-command fallback after a failed write from a closed session", async () => {
  let reject!: (error: Error) => void;
  const write = vi.fn(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  vi.stubGlobal("navigator", { clipboard: { write } }); vi.stubGlobal("ClipboardItem", class {});
  const original = document.execCommand; const fallback = vi.fn(); document.execCommand = fallback;
  try {
    const session = new AbortController();
    const pending = copyPluginSurfaceAgentReference(SURFACES_BY_ID.get("composer-actions")!, session.signal);
    session.abort(); reject(new Error("clipboard unavailable"));
    await expect(pending).resolves.toBe(false); expect(fallback).not.toHaveBeenCalled();
  } finally { document.execCommand = original; }
});


it("retains rich/plain editing-command fallback and restores the previously focused composer", async () => {
  vi.stubGlobal("navigator", {});
  const composer = document.createElement("textarea"); composer.value = "existing draft";
  document.body.append(composer); composer.focus();
  const content = pluginSurfaceAgentClipboardContent(SURFACES_BY_ID.get("composer-actions")!);
  const entries = new Map<string, string>(); const original = document.execCommand;
  document.execCommand = vi.fn(() => {
    document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]')!.focus();
    const copy = new Event("copy", { cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, value: string) => entries.set(type, value) } });
    document.dispatchEvent(copy); return true;
  });
  try {
    await expect(copyPluginSurfaceAgentReference(SURFACES_BY_ID.get("composer-actions")!)).resolves.toBe(true);
    expect(entries.get("text/plain")).toBe(content.text); expect(entries.get("text/html")).toBe(content.html);
    expect(document.activeElement).toBe(composer); expect(composer.value).toBe("existing draft");
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
  } finally { document.execCommand = original; composer.remove(); }
});
