import { dirname, isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import type { JsonObject, McpTool, MirrorManager, MirrorOptions, RemoteManager, RemoteOptions, SecretStore, SettingsSnapshot, Source } from "./contract.ts";
import { rpcContract } from "./rpc-contract.ts";
import { privateJsonStore } from "./storage.ts";
import { createBridge, type BridgeOptions } from "./bridge.ts";
import { createRemoteManager } from "./mcp/remote.ts";
import { createMirrorManager } from "./mirror/runtime.ts";

const configurationSchema = z.object({
  binaryPath: z.string().min(1).default("figmog"),
  readToken: z.string().default(""),
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  redirectUri: z.string().default(""),
}).strict();
type Configuration = z.infer<typeof configurationSchema>;
type Bridge = ReturnType<typeof createBridge>;

export interface FigmaDependencies {
  directory?: string;
  configurationStore?: SecretStore;
  oauthStore?: SecretStore;
  remote?: (options: RemoteOptions) => RemoteManager;
  mirror?: (options: MirrorOptions) => MirrorManager;
  bridge?: (options: BridgeOptions) => Bridge;
}

function configuredRedirect(value: string, pluginId: string): string {
  if (!value) return "";
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Enter the full Figma callback URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== `/api/v1/plugins/${pluginId}/http/oauth/callback`) {
    throw new Error("Use this BB deployment's HTTPS callback URL ending in /api/v1/plugins/figma/http/oauth/callback.");
  }
  return parsed.href;
}

function fileFromArguments(args: JsonObject): string | undefined {
  for (const key of ["fileKey", "file_key", "file", "fileUrl", "url"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return undefined;
}

function cachedTools(value: unknown): McpTool[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tool): tool is McpTool => !!tool && typeof tool === "object" && typeof tool.name === "string" && !!tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema));
}

export function createFigmaPlugin(dependencies: FigmaDependencies = {}) {
  return async (bb: BbPluginApi): Promise<void> => {
    const directory = dependencies.directory ?? (() => {
      const path = bb.storage.database().name;
      if (!isAbsolute(path)) throw new Error("Figma requires file-backed plugin storage.");
      return join(dirname(path), "connections");
    })();
    const configStore = dependencies.configurationStore ?? privateJsonStore(directory, "configuration");
    const oauthStore = dependencies.oauthStore ?? privateJsonStore(directory, "oauth");
    const callbackPath = `/api/v1/plugins/${bb.pluginId}/http/oauth/callback`;
    const defaultRedirect = bb.server.experimental_appUrl ? new URL(callbackPath, bb.server.experimental_appUrl).href : "";
    let configurationProblem: string | null = null;
    let config: Configuration;
    try { config = configurationSchema.parse((await configStore.read()) ?? { redirectUri: defaultRedirect }); }
    catch {
      config = configurationSchema.parse({ redirectUri: defaultRedirect });
      configurationProblem = "Saved connection could not be read. Enter and save the connection details again.";
    }
    let disposed = false;
    let mutationTail: Promise<unknown> = Promise.resolve();
    const change = () => {
      if (!disposed) bb.realtime.publish("figma", { changed: true });
    };
    const serialize = <T>(action: () => Promise<T>): Promise<T> => {
      const result = mutationTail.then(() => {
        if (disposed) throw new Error("Figma plugin is stopping. Try again after it reloads.");
        return action();
      });
      mutationTail = result.catch(() => undefined);
      return result;
    };
    const remote = (dependencies.remote ?? createRemoteManager)({
      store: oauthStore,
      config: async () => ({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri }),
      onChange: change,
    });
    const mirror = (dependencies.mirror ?? createMirrorManager)({
      directory: join(directory, "mirrors"),
      config: { binaryPath: config.binaryPath, token: config.readToken },
      onChange: change,
    });
    const refreshMirror = async (file: string | undefined, acceptUnverified: boolean, signal?: AbortSignal): Promise<JsonObject> => {
      const result = await mirror.refresh(file, signal, acceptUnverified);
      if (acceptUnverified) bb.log.info("Explicit Figma cache recovery completed; prior edit visibility remains unverified.");
      return result;
    };
    let catalogTail: Promise<unknown> = Promise.resolve();
    const previous = await bb.storage.kv.get<{ official?: unknown; mirror?: unknown }>("catalog-v1");
    let bridge: Bridge;
    bridge = (dependencies.bridge ?? createBridge)({
      bb,
      getPeer: (source, signal) => source === "official" ? remote.peer(signal) : mirror.peer(signal),
      beforeOfficialWrite: async (args) => {
        // Keep the marker durable before dispatch; never replay a write after response loss.
        if (!config.readToken) return;
        const ticket = await mirror.beginWrite(fileFromArguments(args));
        return (outcome: "completed" | "uncertain") => mirror.endWrite(ticket, outcome);
      },
      refreshMirror,
      initialInventory: { official: cachedTools(previous?.official), mirror: cachedTools(previous?.mirror) },
      onCatalogChange: () => {
        if (!bridge || disposed) return;
        const value = { official: bridge.inventory("official"), mirror: bridge.inventory("mirror") };
        catalogTail = catalogTail.catch(() => undefined).then(() => bb.storage.kv.set("catalog-v1", value));
        void catalogTail.catch(() => { bb.log.warn("Could not save the Figma tool inventory; refresh it after reload."); });
        change();
      },
    });

    const snapshot = (): SettingsSnapshot => ({
      scope: "shared",
      config: { binaryPath: config.binaryPath, tokenConfigured: !!config.readToken, clientId: config.clientId, clientSecretConfigured: !!config.clientSecret, redirectUri: config.redirectUri },
      official: configurationProblem ? { phase: "error", detail: configurationProblem, connectedAt: null, serverVersion: null } : remote.status(),
      mirror: mirror.status(),
      tools: { official: bridge.inventory("official"), mirror: bridge.inventory("mirror") },
      aliasesNeedReload: bridge.aliasesNeedReload(),
    });
    const update = async (input: Partial<Configuration>): Promise<SettingsSnapshot> => {
      const next = configurationSchema.parse({ ...config, ...input });
      next.redirectUri = configuredRedirect(next.redirectUri, bb.pluginId);
      const officialChanged = next.clientId !== config.clientId || next.clientSecret !== config.clientSecret || next.redirectUri !== config.redirectUri;
      if (officialChanged) await remote.disconnect();
      await configStore.write(next);
      config = next;
      configurationProblem = null;
      await mirror.configure({ binaryPath: config.binaryPath, token: config.readToken });
      change();
      return snapshot();
    };

    bb.rpc.register(rpcContract, {
      status: () => snapshot(),
      configure: (input) => serialize(() => update(input)),
      connectOfficial: () => serialize(async () => {
        configuredRedirect(config.redirectUri, bb.pluginId);
        return remote.beginAuth();
      }),
      disconnect: ({ source }) => serialize(async () => {
        if (source === "official") await remote.disconnect();
        else await update({ readToken: "" });
        bridge.clear?.(source);
        change();
        return snapshot();
      }),
      testConnection: ({ source, file }) => serialize(async () => {
        await bridge.refresh(source);
        if (source === "mirror" && file) {
          const result = await (await mirror.peer()).request("tools/call", { name: "figmog_open", arguments: { file } });
          if (result.isError) throw new Error("Figma could not mirror that file. Check the read token, its scopes and file access.");
        }
        change();
        return snapshot();
      }),
      refreshTools: ({ source }) => serialize(async () => {
        await bridge.refresh(source);
        change();
        return snapshot();
      }),
      syncMirror: ({ file, acceptUnverified }) => serialize(() => refreshMirror(file, acceptUnverified)),
    });

    bb.http.route("GET", "/oauth/callback", async (context) => {
      // Figma redirects cross-origin; state/PKCE is the callback's authorization.
      // Never echo callback parameters, upstream bodies, or tokens into HTML/logs.
      context.header("Cache-Control", "no-store");
      context.header("Referrer-Policy", "no-referrer");
      context.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(context.req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const denied = url.searchParams.has("error");
      if (!state || (!code && !denied)) return context.text("Figma sign-in did not complete. Return to BB settings and connect again.", 400);
      try {
        const discovered = await serialize(async () => {
          // A matched denial consumes its pending state just like an exchange.
          await remote.finishAuth({ code: denied ? "" : code!, state, issuer: url.searchParams.get("iss") ?? undefined });
          try { await bridge.refresh("official"); return true; }
          catch { return false; }
        });
        change();
        if (!discovered) return context.text("Figma authorization completed, but its tool catalog could not be loaded. Return to BB's Figma settings and refresh Figma tools.");
        return context.text("Figma is connected. Return to BB's Figma settings.");
      } catch {
        change();
        return context.text("Figma sign-in could not be completed. Return to BB settings, check the connection status, and connect again.", 400);
      }
    }, { auth: "none" });

    bb.agents.contributeInstructions(() => "Use figmog_* for cached Figma reads. Use the official connection's discovered figma_* tools, especially use_figma through figma_call, for writes. figma_discover returns the actual available upstream schemas; figma_mcp provides resources, prompts and other advertised MCP operations. Read upstream skills/resources required by a tool. Connections are shared by this BB deployment. A successful write can take time to appear in the mirror; respect refresh-pending errors. After an uncertain write, inspect the actual canvas before retrying. Never guess that a disconnected tool or a cached schema is available.");
    bb.onDispose(async () => {
      disposed = true;
      await Promise.allSettled([remote.close(), mirror.close(), bridge.close()]);
      await Promise.allSettled([mutationTail, catalogTail]);
    });
  };
}

export default createFigmaPlugin();
