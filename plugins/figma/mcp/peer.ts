import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JsonObject, McpPeer } from "../contract.ts";

export const requestTimeoutMs = (method: string): number => method === "tools/call" ? 180_000 : 60_000;

/** SDK framing and cancellation, with a loose result schema to retain extensions. */
export function sdkPeer(client: Client): McpPeer {
  const listeners = new Set<() => void>();
  for (const schema of [ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema]) {
    client.setNotificationHandler(schema, () => {
      for (const listener of listeners) { try { listener(); } catch { /* Isolate subscribers. */ } }
    });
  }
  return {
    async request(method, params, signal) {
      const capabilities = client.getServerCapabilities();
      if (method.startsWith("tasks/")) {
        if (!capabilities?.tasks || (method === "tasks/list" && !capabilities.tasks.list) ||
            (method === "tasks/cancel" && !capabilities.tasks.cancel)) {
          throw new Error("The MCP server does not advertise this task capability.");
        }
      }
      const task = params?.task as { ttl?: number } | undefined;
      return await client.request({ method, ...(params === undefined ? {} : { params }) },
        z.object({}).passthrough(), { signal, timeout: requestTimeoutMs(method), ...(task ? { task } : {}) }) as JsonObject;
    },
    info() {
      return {
        capabilities: client.getServerCapabilities() as JsonObject ?? {},
        serverInfo: client.getServerVersion(), instructions: client.getInstructions(),
      };
    },
    onCatalogChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: async () => { listeners.clear(); await client.close(); },
  };
}
