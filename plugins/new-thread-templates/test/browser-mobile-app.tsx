/** Actual plugin surfaces/content scripts; the marked long-recents shell is a fixture, not native BB. */
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { templatesContract, TEMPLATES_CHANGED } from "../rpc-contract.ts";
const app = await loadPluginApp(() => import("../app.tsx"));
const methods = [
  ...Object.keys(templatesContract),
  "bb-identity.v1.bootstrap",
  "bb-identity.v1.selfProfile",
  "bb-identity.v1.search",
  "bb-identity.v1.profiles",
  "bb-identity.v1.participants",
  "bb-identity.v1.participantPreviews",
  "bb-identity.v1.state.load",
  "bb-identity.v1.state.save",
  "bb-identity.v1.state.reconcile",
];
const rpc = Object.fromEntries(
  methods.map((method) => [
    method,
    async (input: unknown) => {
      const response = await fetch(`/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      return value;
    },
  ]),
) as Record<string, (input: any) => Promise<any>>;
const configListeners = new Map<string, Set<() => void>>();
const sdk = {
  subscribe({
    event,
    callback,
  }: {
    event: string;
    callback: (...args: any[]) => void;
  }) {
    const listeners = configListeners.get(event) ?? new Set<() => void>();
    configListeners.set(event, listeners);
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
let slot: ReturnType<typeof renderSlot> | null = null;
let scripts: Awaited<ReturnType<typeof mountPluginContentScripts>> | null =
  null;
let generation = 0;
function unmount() {
  const container = slot?.container;
  slot?.lifecycle.unmount();
  container?.remove();
  slot = null;
}
function mount(route: "home" | "settings" = "home") {
  unmount();
  slot =
    route === "home"
      ? renderSlot(
          app.homepageSections[0]!,
          { projectId: "project-a" },
          { pluginId: "new-thread-templates", rpc, sdk },
        )
      : renderSlot(
          app.settingsSections[0]!,
          {},
          { pluginId: "new-thread-templates", rpc, sdk },
        );
  // Construct only the fixture host around the real product slot; production never moves host DOM.
  document
    .querySelector(
      route === "home"
        ? "[data-fixture-home-slot]"
        : "[data-fixture-settings-slot]",
    )!
    .append(slot.container);
  document.querySelector<HTMLElement>("[data-fixture-home]")!.hidden =
    route !== "home";
  document.querySelector<HTMLElement>("[data-fixture-settings]")!.hidden =
    route !== "settings";
}
async function enable() {
  if (scripts) await scripts.lifecycle.dispose();
  scripts = await mountPluginContentScripts(app, {
    pluginId: "new-thread-templates",
    generation: ++generation,
  });
}
async function disable() {
  const current = scripts;
  scripts = null;
  await current?.lifecycle.dispose();
}
window.mobileTemplatesHarness = {
  mount,
  unmount,
  enable,
  disable,
  replaceWithStaleCleanup: async () => {
    const old = scripts;
    scripts = await mountPluginContentScripts(app, {
      pluginId: "new-thread-templates",
      generation: ++generation,
    });
    await old?.lifecycle.dispose();
  },
  emit: async () => {
    for (const suffix of ["catalog", "definitions", "journal"])
      await slot?.behavior.emitRealtime(
        `new-thread-templates:${suffix}-changed`,
        {},
      );
    for (const listeners of configListeners.values())
      for (const callback of listeners) callback();
  },
  reconnect: async () => {
    await slot?.behavior.setRealtimeConnectionState("reconnecting");
    await slot?.behavior.setRealtimeConnectionState("connected");
  },
};
declare global {
  interface Window {
    mobileTemplatesHarness: {
      mount(route?: "home" | "settings"): void;
      unmount(): void;
      enable(): Promise<void>;
      disable(): Promise<void>;
      replaceWithStaleCleanup(): Promise<void>;
      emit(): Promise<void>;
      reconnect(): Promise<void>;
    };
  }
}
mount(location.search.includes("settings") ? "settings" : "home");
