import { createContext, useContext, useEffect, type ComponentType, type ReactNode } from "react";

export type FleetPerformanceRpc = Readonly<{ call(method: string, input?: unknown): Promise<unknown> }>;
export type FleetPerformanceRuntime = Readonly<{
  rpc: FleetPerformanceRpc;
  connection: "connected";
  subscribe(channel: string, callback: (payload: unknown) => void): () => void;
  navigate: Readonly<{ toThread(threadId: string): void }>;
}>;

type NavPanel = Readonly<{ component: ComponentType<{ subPath?: string }> }>;
type RegisteredPlugin = Readonly<{ panels: readonly NavPanel[] }>;

const RuntimeContext = createContext<FleetPerformanceRuntime | null>(null);

export function FleetPerformanceRuntimeProvider({ runtime, children }: { runtime: FleetPerformanceRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

function runtime(): FleetPerformanceRuntime {
  const value = useContext(RuntimeContext);
  if (value == null) throw new Error("Fleet performance runtime is absent.");
  return value;
}

/** Browser-test SDK seam; the production app itself stays unmodified. */
export function definePluginApp(factory: (app: { experimental_icons: { register(registration: unknown): void }; slots: { navPanel(panel: NavPanel): void } }) => void): RegisteredPlugin {
  const panels: NavPanel[] = [];
  factory({ experimental_icons: { register() {} }, slots: { navPanel: (panel) => panels.push(panel) } });
  return { panels };
}

export function useRpc(): FleetPerformanceRpc {
  return runtime().rpc;
}

export function useRealtimeConnectionState(): "connected" {
  return runtime().connection;
}

export function useRealtime(channel: string, callback: (payload: unknown) => void): void {
  const active = runtime();
  useEffect(() => active.subscribe(channel, callback), [active, callback, channel]);
}

export function useBbNavigate(): Readonly<{ toThread(threadId: string): void; toPluginPanel(path: string, options?: unknown): void }> {
  return { toPluginPanel() {}, ...runtime().navigate };
}

export function useSettings(): Readonly<{ values: undefined; isLoading: false }> {
  return { values: undefined, isLoading: false };
}

export function experimental_usePluginId(): string {
  return "machine-monitor";
}
