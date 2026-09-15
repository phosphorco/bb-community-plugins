import { createContext, useContext, useEffect, type ComponentType, type ReactNode } from "react";

export type FleetPerformanceRpc = Readonly<{ call(method: string, input?: unknown): Promise<unknown> }>;
export type FleetPerformanceRuntime = Readonly<{
  rpc: FleetPerformanceRpc;
  connection: "connected";
  subscribe(channel: string, callback: (payload: unknown) => void): () => void;
  navigate: Readonly<{ toThread(threadId: string): void }>;
}>;

type NavPanel = Readonly<{ component: ComponentType }>;
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
export function definePluginApp(factory: (app: { slots: { navPanel(panel: NavPanel): void } }) => void): RegisteredPlugin {
  const panels: NavPanel[] = [];
  factory({ slots: { navPanel: (panel) => panels.push(panel) } });
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

export function useBbNavigate(): Readonly<{ toThread(threadId: string): void }> {
  return runtime().navigate;
}
