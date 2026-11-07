/** Actual product components in the public SDK slot harness. Native chrome/pickers remain a separate smoke. */
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import appDefinition from "../app.tsx";
import { templatesContract } from "../rpc-contract.ts";
import { templateScreens } from "../ui/deferred-screen.tsx";

type RecoveryDetail =
  | { kind: "rpc"; method: string; stage: "headers" | "json-complete" | "adapter-return"; call: number; status: number }
  | { kind: "dom"; formPresent: boolean; personalLoading: boolean; resumePresent: boolean; resumeDisabled: boolean };
const recoveryMethods = new Set(["bb-identity.v1.state.load", "recentLaunches", "launchStatus"]);
let recoverySequence = 0, recoveryCall = 0;
let recoveryDocument: string | undefined;
const recoveryFact = (detail: RecoveryDetail) => {
  try {
    if (!window.__templatesRecoveryDiagnostics || !window.__templatesRecoveryRun || recoverySequence >= 64) return;
    recoveryDocument ??= crypto.randomUUID();
    const payload = JSON.stringify({
      run: window.__templatesRecoveryRun, doc: recoveryDocument,
      seq: ++recoverySequence, at: Date.now(), elapsedMs: performance.now(), ...detail,
    });
    // Fixed ASCII facts only; no product request/response values or headers.
    if (payload.length <= 768)
      navigator.sendBeacon("/__recovery-diagnostic", payload);
  } catch { /* A dropped diagnostic never changes a product RPC outcome. */ }
};

// Only the saved-request fixture opts in. Observe without replacing the promise
// React receives, changing its result, or admitting the form earlier.
if (window.__templatesRecoveryDiagnostics) {
  const load = templateScreens.run;
  let loaderCall = 0;
  const record = (event: string, call: number) => {
    try {
      console.debug("templates-recovery-loader", JSON.stringify({
        event,
        call,
        at: new Date().toISOString(),
        elapsedMs: performance.now(),
      }));
    } catch { /* Diagnostics must not change loader results. */ }
  };
  templateScreens.run = () => {
    const call = ++loaderCall;
    record("begin", call);
    try {
      const pending = load();
      void pending.then(() => record("settled", call), () => record("rejected", call));
      return pending;
    } catch (error) {
      record("threw", call);
      throw error;
    }
  };
}
const app = await loadPluginApp(appDefinition);
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
      const call = window.__templatesRecoveryDiagnostics && window.__templatesRecoveryRun && recoveryMethods.has(method) ? ++recoveryCall : 0;
      const response = await fetch(`/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (call) recoveryFact({ kind: "rpc", method, call, stage: "headers", status: response.status });
      const value = await response.json();
      if (call) recoveryFact({ kind: "rpc", method, call, stage: "json-complete", status: response.status });
      if (!response.ok) throw new Error(value.error);
      if (call) recoveryFact({ kind: "rpc", method, call, stage: "adapter-return", status: response.status });
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
function mount(panel: boolean | "settings" = false) {
  const previous = slot?.container;
  slot?.lifecycle.unmount();
  previous?.remove();
  slot =
    panel === "settings"
      ? renderSlot(
          app.settingsSections[0]!,
          {},
          { pluginId: "new-thread-templates", rpc, sdk },
        )
      : panel
        ? renderSlot(
            app.navPanels[0]!,
            { subPath: "" },
            { pluginId: "new-thread-templates", rpc, sdk },
          )
        : renderSlot(
            app.homepageSections[0]!,
            { projectId: "project-a" },
            { pluginId: "new-thread-templates", rpc, sdk },
          );
  // Fixture supplies the bounded native-panel parent; product owns its scroll region.
  if (panel === true) {
    slot.container.style.height = "calc(100dvh - 140px)";
    slot.container.style.minHeight = "0";
  }
}
window.templatesHarness = {
  mount,
  unmount: () => {
    const container = slot?.container;
    slot?.lifecycle.unmount();
    container?.remove();
    slot = null;
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
  stats: () => ({
    navigation: slot?.inspection.navigateCalls ?? [],
    rpc: slot?.inspection.rpcCalls ?? [],
  }),
};
declare global {
  interface Window {
    __templatesRecoveryDiagnostics?: boolean;
    __templatesRecoveryRun?: string;
    templatesHarness: {
      mount(panel?: boolean | "settings"): void;
      unmount(): void;
      emit(): Promise<void>;
      reconnect(): Promise<void>;
      stats(): unknown;
    };
  }
}
mount(location.search.includes("manage"));

if (window.__templatesRecoveryDiagnostics) {
  let previous = "", observations = 0;
  const observer = new MutationObserver(() => observe());
  const observe = () => {
    try {
      if (++observations > 256 || recoverySequence >= 64) { observer.disconnect(); return; }
      const surface = document.querySelector("[data-new-thread-templates-form]");
      const resume = [...(surface?.querySelectorAll("button") ?? [])]
        .find((node) => node.textContent?.trim() === "Resume saved request");
      const detail: RecoveryDetail = {
        kind: "dom", formPresent: !!surface?.querySelector("form.ntt-direct-form"),
        personalLoading: [...(surface?.querySelectorAll('[role="status"]') ?? [])]
          .some((node) => node.textContent?.trim() === "Loading personal inputs…"),
        resumePresent: !!resume, resumeDisabled: resume?.disabled ?? false,
      };
      const signature = JSON.stringify(detail);
      if (signature !== previous) { previous = signature; recoveryFact(detail); }
    } catch { observer.disconnect(); }
  };
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["disabled"],
  });
  observe();
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
}
