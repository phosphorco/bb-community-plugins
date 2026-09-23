import type { PluginRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

export type RealtimeRefreshGate = {
  observe(connection: PluginRealtimeConnectionState): boolean;
};

/** Refresh once initially and once after each reconnect, not on stable renders. */
export function createRealtimeRefreshGate(): RealtimeRefreshGate {
  let previous: PluginRealtimeConnectionState | null = null;
  return {
    observe(connection) {
      const shouldRefresh =
        connection === "connected" && previous !== "connected";
      previous = connection;
      return shouldRefresh;
    },
  };
}
