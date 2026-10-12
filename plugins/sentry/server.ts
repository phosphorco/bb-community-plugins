import { dirname, isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import type { JsonObject, McpTool, RemoteManager, RemoteOptions, SecretStore, SettingsSnapshot } from "./contract.ts";
import { createSentryCli } from "./cli.ts";
import { rpcContract } from "./rpc-contract.ts";
import { privateJsonStore } from "./storage.ts";
import { createBridge, type BridgeOptions } from "./bridge.ts";
import { createRemoteManager } from "./mcp/remote.ts";

const configurationSchema = z.object({
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  redirectUri: z.string().default(""),
}).strict();
type Configuration = z.infer<typeof configurationSchema>;
type Bridge = ReturnType<typeof createBridge>;

export interface SentryDependencies {
  directory?: string;
  configurationStore?: SecretStore;
  oauthStore?: SecretStore;
  remote?: (options: RemoteOptions) => RemoteManager;
  bridge?: (options: BridgeOptions) => Bridge;
}

function configuredRedirect(value: string, pluginId: string): string {
  if (!value) return "";
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Enter the full Sentry callback URL."); }
  const loopback = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.username || parsed.password || parsed.search || parsed.hash || (!(loopback && parsed.protocol === "http:" && parsed.port && parsed.pathname === "/callback") && parsed.pathname !== `/api/v1/plugins/${pluginId}/http/oauth/callback`)) {
    throw new Error("Use a loopback callback URL such as http://127.0.0.1:38560/callback, or this BB deployment's HTTPS callback.");
  }
  return parsed.href;
}

/** Accept copied browser addresses, including wrapped lines and omitted loopback scheme. */
function copiedCallback(value: string, redirectUri: string): { code: string; state: string; issuer?: string } {
  let address = value.trim();
  if (address.length > 65536) throw new Error("Sentry callback URL is too long.");
  if ((address.startsWith('"') && address.endsWith('"')) || (address.startsWith("'") && address.endsWith("'"))) address = address.slice(1, -1).trim();
  address = address.replace(/\s/g, "");
  if (/^(127\.0\.0\.1|localhost):\d+\//.test(address)) address = `http://${address}`;
  let url: URL, expected: URL;
  try { url = new URL(address); expected = new URL(redirectUri); }
  catch { throw new Error("Paste the full Sentry callback address from your browser."); }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
    throw new Error("Sentry callback does not match this connection. Paste the address from its current sign-in.");
  }
  return callbackResult(url);
}

/** Both entry points reject ambiguous callbacks before consuming OAuth state. */
function callbackResult(url: URL): { code: string; state: string; issuer?: string } {
  if (url.href.length > 65536 || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1 ||
      url.searchParams.getAll("iss").length > 1 || url.searchParams.getAll("error").length > 1) {
    throw new Error("Sentry callback has invalid or repeated fields. Paste the complete address from the current sign-in.");
  }
  const state = url.searchParams.get("state"), code = url.searchParams.get("code"), denied = url.searchParams.has("error");
  if (!state || (!code && !denied) || (code && denied)) throw new Error("Sentry callback is missing the authorization result.");
  return { code: denied ? "" : code!, state, issuer: url.searchParams.get("iss") ?? undefined };
}

function cachedTools(value: unknown): McpTool[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tool): tool is McpTool => !!tool && typeof tool === "object" && typeof tool.name === "string" && !!tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema));
}

export function createSentryPlugin(dependencies: SentryDependencies = {}) {
  return async (bb: BbPluginApi): Promise<void> => {
    const directory = dependencies.directory ?? (() => {
      const path = bb.storage.database().name;
      if (!isAbsolute(path)) throw new Error("Sentry requires file-backed plugin storage.");
      return join(dirname(path), "connections");
    })();
    const configStore = dependencies.configurationStore ?? privateJsonStore(directory, "configuration");
    const oauthStore = dependencies.oauthStore ?? privateJsonStore(directory, "oauth");
    const defaultRedirect = "http://127.0.0.1:38560/callback";
    let configurationProblem: string | null = null;
    let config: Configuration;
    try {
      const saved = await configStore.read();
      config = configurationSchema.parse(saved ?? { redirectUri: defaultRedirect });
    }
    catch {
      config = configurationSchema.parse({ redirectUri: defaultRedirect });
      configurationProblem = "Saved connection could not be read. Enter and save the connection details again.";
    }
    let disposed = false;
    let mutationTail: Promise<unknown> = Promise.resolve();
    const change = () => {
      if (!disposed) bb.realtime.publish("sentry", { changed: true });
    };
    const serialize = <T>(action: () => Promise<T>): Promise<T> => {
      const result = mutationTail.then(() => {
        if (disposed) throw new Error("Sentry plugin is stopping. Try again after it reloads.");
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
    // Restore private consent/grant presence without OAuth, discovery or MCP I/O.
    // A corrupt store remains visible in status instead of preventing activation.
    await remote.restoreStatus?.().catch(() => undefined);
    let catalogTail: Promise<unknown> = Promise.resolve();
    const previous = await bb.storage.kv.get<{ official?: unknown }>("catalog-v1");
    let bridge: Bridge;
    bridge = (dependencies.bridge ?? createBridge)({
      bb,
      getPeer: async (_source, signal) => remote.peer(signal),
      initialInventory: { official: cachedTools(previous?.official) },
      onCatalogChange: () => {
        if (!bridge || disposed) return;
        const value = { official: bridge.inventory("official") };
        catalogTail = catalogTail.catch(() => undefined).then(() => bb.storage.kv.set("catalog-v1", value));
        void catalogTail.catch(() => { bb.log.warn("Could not save the Sentry tool inventory; refresh it after reload."); });
        change();
      },
    });

    bb.cli.register(createSentryCli(bridge));

    const snapshot = async (): Promise<SettingsSnapshot> => {
      const captured = config;
      return {
      scope: "shared",
      config: { clientId: captured.clientId, clientSecretConfigured: !!captured.clientSecret, redirectUri: captured.redirectUri },
      official: configurationProblem ? { phase: "error", detail: configurationProblem, connectedAt: null, serverVersion: null } : remote.status(),
      tools: { official: bridge.inventory("official") },
      aliasesNeedReload: bridge.aliasesNeedReload(),
      };
    };
    const update = async (input: Partial<Configuration>): Promise<SettingsSnapshot> => {
      const next = configurationSchema.parse({ ...config, ...input });
      next.redirectUri = configuredRedirect(next.redirectUri, bb.pluginId);
      const officialChanged = next.clientId !== config.clientId || next.clientSecret !== config.clientSecret || next.redirectUri !== config.redirectUri;
      await configStore.write(next);
      config = next;
      configurationProblem = null;
      if (officialChanged) {
        try { await remote.disconnect(); }
        finally { bridge.clear("official"); }
      }
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
      finishAuthorization: ({ callbackUrl }) => serialize(async () => {
        await remote.finishAuth(copiedCallback(callbackUrl, config.redirectUri));
        bridge.clear("official");
        try { await bridge.refresh("official"); }
        catch { bb.log.warn("Sentry authorization completed; refresh tools to load its catalog."); }
        change();
        return snapshot();
      }),
      disconnect: ({ source }) => serialize(async () => {
        if (source === "official") await remote.disconnect();
        bridge.clear?.(source);
        change();
        return snapshot();
      }),
      testConnection: ({ source }) => serialize(async () => {
        await bridge.refresh(source);
        if (source === "official" && bridge.inventory(source).some(tool => tool.name === "whoami")) {
          const result = await (await remote.peer()).request("tools/call", { name: "whoami", arguments: {} });
          if (result.isError) throw new Error("Sentry identity check failed. Review authorization before using this connection.");
          bb.log.info("Sentry identity check succeeded through the configured connection.");
        }
        change();
        return snapshot();
      }),
      refreshTools: ({ source }) => serialize(async () => {
        await bridge.refresh(source);
        change();
        return snapshot();
      }),
    });

    bb.http.route("GET", "/oauth/callback", async (context) => {
      // Sentry redirects cross-origin; state/PKCE is the callback's authorization.
      // Never echo callback parameters, upstream bodies, or tokens into HTML/logs.
      context.header("Cache-Control", "no-store");
      context.header("Referrer-Policy", "no-referrer");
      context.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(context.req.url);
      let input: ReturnType<typeof callbackResult>;
      try { input = callbackResult(url); }
      catch { return context.text("Sentry sign-in did not complete. Return to BB settings and connect again.", 400); }
      try {
        const discovered = await serialize(async () => {
          // A matched denial consumes its pending state just like an exchange.
          await remote.finishAuth(input);
          try { await bridge.refresh("official"); return true; }
          catch { return false; }
        });
        change();
        if (!discovered) return context.text("Sentry authorization completed, but its tool catalog could not be loaded. Return to BB's Sentry settings and refresh Sentry tools.");
        return context.text("Sentry is connected. Return to BB's Sentry settings.");
      } catch {
        change();
        return context.text("Sentry sign-in could not be completed. Return to BB settings, check the connection status, and connect again.", 400);
      }
    }, { auth: "none" });

    bb.agents.contributeInstructions(() => `Use the official Sentry MCP connection: start with sentry_discover, then call tools by their discovered schemas through sentry_call or native sentry_* aliases. BB owns OAuth and the transport on its server for all enrolled machines. If this session predates tool registration, use bb sentry discover --json, bb sentry call and bb sentry mcp through the native CLI. Do not copy credentials or require a local MCP process. sentry_mcp supports advertised resources, prompts and other MCP operations. The connection is shared by this BB deployment; calls act as the authorizing Sentry user. After an uncertain mutation, inspect Sentry before retrying; calls are never replayed automatically.`);
    bb.onDispose(async () => {
      disposed = true;
      await bridge.close();
      await remote.close();
      await Promise.allSettled([mutationTail, catalogTail]);
    });
  };
}

export default createSentryPlugin();
