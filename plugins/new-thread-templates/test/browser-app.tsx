/** Actual product components in the public SDK slot harness. Native chrome/pickers remain a separate smoke. */
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import appDefinition from "../app.tsx";
import { templatesContract } from "../rpc-contract.ts";
import { templateScreens } from "../ui/deferred-screen.tsx";

type RecoveryDetail =
  | { kind: "rpc"; method: string; stage: "headers" | "json-complete" | "adapter-return"; call: number; status: number }
  | { kind: "exposure"; n: number[]; r: number[][]; f: number[][] };

// Compact facts, not a visibility/readiness verdict. n = visited nodes, markers,
// Resume/fallback matches, omitted markers/Resume/fallback, unknown names,
// unknown marker ancestry, cap flags (scan=1,observer=2,last sideband slot=4).
// r/f tuples = marker (9=omitted marker),
// role/name equivalence (0 unknown,1 yes,2 no), ancestor mask, box mask, depth,
// own computed visibility (0 unknown,1 visible,2 hidden/collapse,3 other).
// Ancestor mask: hidden=1,aria-hidden=2,inert=4,display:none=8,visibility=16,
// depth capped=32,style failure=64,name unknown=128,role unknown=256,disabled=512.
// Box mask: nonzero=1,in viewport=2,unknown=4,disconnected=8.
function recoveryAncestorMask(
  chain: readonly { hidden: boolean; ariaHidden: boolean; inert: boolean; display: string; visibility: string; failed: boolean }[],
  complete: boolean, nameKnown: boolean, roleKnown: boolean, disabled: boolean,
) {
  let mask = (complete ? 0 : 32) | (nameKnown ? 0 : 128) |
    (roleKnown ? 0 : 256) | (disabled ? 512 : 0);
  for (const node of chain) {
    if (node.hidden) mask |= 1;
    if (node.ariaHidden) mask |= 2;
    if (node.inert) mask |= 4;
    if (node.display === "none") mask |= 8;
    if (node.visibility === "hidden" || node.visibility === "collapse") mask |= 16;
    if (node.failed) mask |= 64;
  }
  return mask;
}

function recoveryExposure(): Extract<RecoveryDetail, { kind: "exposure" }> {
  const n = Array<number>(10).fill(0), r: number[][] = [], f: number[][] = [];
  const markers = new Map<Element, number>();
  const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node: Element | null = document.documentElement;
  const text = (element: Element) => {
    const children = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let content = "", count = 0, child = children.nextNode();
    while (child && count++ < 16) {
      const value = child.nodeValue ?? "";
      if (value.length > 128 - content.length) return { value: "", known: false };
      content += value;
      child = children.nextNode();
    }
    return { value: content.replace(/\s+/g, " ").trim(), known: child === null };
  };
  while (node && n[0]! < 512) {
    n[0]!++;
    if (node.hasAttribute("data-new-thread-templates-form")) {
      n[1]!++;
      if (markers.size < 8) markers.set(node, n[1]!);
      else n[4]!++;
    }
    const roleAttribute = node.getAttribute("role");
    const button = node.tagName === "BUTTON" || roleAttribute === "button";
    const status = roleAttribute === "status";
    if (button || status) {
      let ancestor: Element | null = node, depth = 0, marker = 0;
      while (ancestor && depth++ < 32) {
        if (ancestor.hasAttribute("data-new-thread-templates-form")) {
          marker = markers.get(ancestor) ?? 9;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (!marker && ancestor) n[8]!++;
      if (marker) {
        const label = text(node), aria = node.getAttribute("aria-label");
        const referenced = node.hasAttribute("aria-labelledby");
        let plain = node.childNodes.length <= 16;
        for (let i = 0; plain && i < node.childNodes.length; i++)
          plain = node.childNodes[i]!.nodeType === Node.TEXT_NODE;
        // Only the fixture's plain-text/aria-label names are known. Other
        // accessible-name paths are reported unknown, never guessed equivalent.
        const nameKnown = !referenced && (aria !== null
          ? aria.length > 0 && aria.length <= 128
          : plain && label.known && label.value.length > 0);
        const name = (aria !== null && aria.length <= 128 ? aria : label.value).replace(/\s+/g, " ").trim();
        const resume = button && (name.toLowerCase().includes("resume saved request") ||
          label.value.toLowerCase().includes("resume saved request"));
        const fallback = status && label.value === "Loading template form…";
        if (!nameKnown) n[7]!++;
        if (resume || fallback) {
          const seen = resume ? 2 : 3, omitted = resume ? 5 : 6, result = resume ? r : f;
          n[seen]!++;
          if (result.length < 4) {
            const expectedRole = resume ? "button" : "status";
            const role = roleAttribute === expectedRole || (resume && roleAttribute === null && node.tagName === "BUTTON")
              ? 1 : 0;
            const equivalentName = nameKnown ? (resume
              ? name.toLowerCase().includes("resume saved request")
              : name === "Loading template form…") ? 1 : 2 : 0;
            const chain = [];
            let ownVisibility = 0;
            let current: Element | null = node;
            for (let count = 0; current && count < 32; count++, current = current.parentElement) {
              let display = "", visibility = "", failed = false;
              try { const style = getComputedStyle(current); display = style.display; visibility = style.visibility; }
              catch { failed = true; }
              if (count === 0 && !failed)
                ownVisibility = visibility === "visible" ? 1 :
                  visibility === "hidden" || visibility === "collapse" ? 2 : 3;
              chain.push({ display, visibility, failed, hidden: current.hasAttribute("hidden"),
                ariaHidden: current.getAttribute("aria-hidden") === "true", inert: current.hasAttribute("inert") });
            }
            const mask = recoveryAncestorMask(chain, current === null, nameKnown, role !== 0,
              node instanceof HTMLButtonElement && node.disabled);
            let box = node.isConnected ? 0 : 8;
            try {
              const bounds = node.getBoundingClientRect();
              if (![bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height, innerWidth, innerHeight].every(Number.isFinite)) box |= 4;
              else if (bounds.width > 0 && bounds.height > 0) {
                box |= 1;
                if (bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight) box |= 2;
              }
            } catch { box |= 4; }
            result.push([marker, role, equivalentName, mask, box, chain.length, ownVisibility]);
          } else n[omitted]!++;
        }
      }
    }
    node = walk.nextNode() as Element | null;
  }
  n[9] = node ? 1 : 0;
  return { kind: "exposure", n, r, f };
}
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
      const detail = recoveryExposure();
      if (observations === 256) detail.n[9]! |= 2;
      if (recoverySequence === 63) detail.n[9]! |= 4;
      const signature = JSON.stringify(detail);
      if (signature !== previous) { previous = signature; recoveryFact(detail); }
      if (observations === 256 || recoverySequence >= 64) observer.disconnect();
    } catch { observer.disconnect(); }
  };
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["disabled", "style", "hidden", "class", "aria-hidden", "aria-label", "aria-labelledby", "role", "inert"],
  });
  observe();
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
}
