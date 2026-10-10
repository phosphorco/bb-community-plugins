import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import type { CodexManager, CodexOptions, JsonObject, McpTool, MirrorManager, MirrorOptions, RemoteManager, RemoteOptions, SecretStore, SettingsSnapshot, Source } from "./contract.ts";
import { rpcContract } from "./rpc-contract.ts";
import { privateJsonStore } from "./storage.ts";
import { createBridge, type BridgeOptions } from "./bridge.ts";
import { createRemoteManager } from "./mcp/remote.ts";
import { createCodexManager } from "./mcp/codex.ts";
import { createMirrorManager } from "./mirror/runtime.ts";

const configurationSchema = z.object({
  officialMode: z.enum(["direct", "codex"]).default("direct"),
  codexBinaryPath: z.string().min(1).default("codex"),
  codexServerName: z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(128).default("figma_bb_diagnostic"),
  codexEnabled: z.boolean().default(true),
  binaryPath: z.string().min(1).default("figmog"),
  mirrorEnabled: z.boolean().default(false),
  cacheGeneration: z.string().default(""),
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
  codex?: (options: CodexOptions) => CodexManager;
  mirror?: (options: MirrorOptions) => MirrorManager;
  bridge?: (options: BridgeOptions) => Bridge;
  resolveBinary?: (path: string) => Promise<string | null>;
}

async function resolveFigmog(path: string): Promise<string | null> {
  const candidates = isAbsolute(path) ? [path] : path === "figmog"
    ? (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).slice(0, 64).map(directory => join(directory, "figmog")) : [];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Optional dependency: continue checking the host's PATH. */ }
  }
  return null;
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
    const makeRemote = () => (dependencies.remote ?? createRemoteManager)({
      store: oauthStore,
      config: async () => ({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri }),
      onChange: change,
    });
    const makeCodex = () => (dependencies.codex ?? createCodexManager)({
      directory: join(directory, "codex"),
      config: async () => ({ binaryPath: config.codexBinaryPath, serverName: config.codexServerName }),
      onChange: change,
    });
    let remote = makeRemote();
    let codex = makeCodex();
    const official = () => config.officialMode === "codex" ? codex : remote;
    const resolveBinary = dependencies.resolveBinary ?? resolveFigmog;
    const initialBinary = await resolveBinary(config.binaryPath);
    const mirrorConfig = (path: string) => ({
      binaryPath: config.mirrorEnabled ? path : "", token: config.readToken, cacheGeneration: config.cacheGeneration,
    });
    const mirror = (dependencies.mirror ?? createMirrorManager)({
      directory: join(directory, "mirrors"),
      config: mirrorConfig(initialBinary ?? config.binaryPath),
      onChange: change,
    });
    const requireMirror = async () => {
      if (!config.mirrorEnabled) throw new Error("Optional figmog cache is off. Use figma_discover with source=official for direct Figma reads and writes.");
      const path = await resolveBinary(config.binaryPath);
      if (!path) throw new Error("Optional figmog is not installed on the BB host. Use source=official, or install figmog and enable the cache in Figma settings.");
      await mirror.configure(mirrorConfig(path));
    };
    const refreshMirror = async (file: string | undefined, acceptUnverified: boolean, signal?: AbortSignal): Promise<JsonObject> => {
      await requireMirror();
      const result = await mirror.refresh(file, signal, acceptUnverified);
      if (acceptUnverified) bb.log.info("Explicit Figma cache recovery completed; prior edit visibility remains unverified.");
      return result;
    };
    let catalogTail: Promise<unknown> = Promise.resolve();
    const previous = await bb.storage.kv.get<{ official?: unknown; mirror?: unknown; officialMode?: string; codexBinaryPath?: string; codexServerName?: string }>("catalog-v1");
    const matchingCatalog = config.officialMode === "direct" ? !previous?.officialMode || previous.officialMode === "direct"
      : previous?.officialMode === "codex" && previous.codexBinaryPath === config.codexBinaryPath && previous.codexServerName === config.codexServerName && config.codexEnabled;
    let bridge: Bridge;
    bridge = (dependencies.bridge ?? createBridge)({
      bb,
      getPeer: async (source, signal) => {
        if (source === "official") {
          if (config.officialMode === "codex" && !config.codexEnabled) throw new Error("Figma is disconnected from BB. Test Figma in settings to resume the existing Codex authorization, or Connect Figma to sign in.");
          return official().peer(signal);
        }
        await requireMirror();
        return mirror.peer(signal);
      },
      beforeOfficialWrite: async (args) => {
        // Keep the marker durable before dispatch; never replay a write after response loss.
        if (!config.mirrorEnabled || !config.readToken) return;
        const ticket = await mirror.beginWrite(fileFromArguments(args));
        return (outcome: "completed" | "uncertain") => mirror.endWrite(ticket, outcome);
      },
      refreshMirror,
      initialInventory: { official: matchingCatalog ? cachedTools(previous?.official) : [], mirror: config.mirrorEnabled && initialBinary && config.readToken ? cachedTools(previous?.mirror) : [] },
      onCatalogChange: () => {
        if (!bridge || disposed) return;
        const value = { official: bridge.inventory("official"), mirror: bridge.inventory("mirror"), officialMode: config.officialMode, codexBinaryPath: config.codexBinaryPath, codexServerName: config.codexServerName };
        catalogTail = catalogTail.catch(() => undefined).then(() => bb.storage.kv.set("catalog-v1", value));
        void catalogTail.catch(() => { bb.log.warn("Could not save the Figma tool inventory; refresh it after reload."); });
        change();
      },
    });

    const snapshot = async (): Promise<SettingsSnapshot> => {
      const captured = config;
      const binaryAvailable = !!await resolveBinary(captured.binaryPath);
      const mirrorUsable = captured.mirrorEnabled && binaryAvailable && !!captured.readToken;
      const mirrorDetail = !captured.mirrorEnabled ? "Optional figmog cache is off. Use the official Figma MCP connection for reads and writes."
        : !binaryAvailable ? "figmog was not found on the BB host. Direct Figma MCP remains available when authorized. Install figmog only if you want the optional cache."
        : !captured.readToken ? "Add a read token to use the optional figmog cache. Official Figma MCP uses its separate authorization." : null;
      return {
      scope: "shared",
      config: { officialMode: captured.officialMode, codexBinaryPath: captured.codexBinaryPath, codexServerName: captured.codexServerName, codexEnabled: captured.codexEnabled, binaryPath: captured.binaryPath, mirrorEnabled: captured.mirrorEnabled, binaryAvailable, tokenConfigured: !!captured.readToken, clientId: captured.clientId, clientSecretConfigured: !!captured.clientSecret, redirectUri: captured.redirectUri },
      official: configurationProblem ? { phase: "error", detail: configurationProblem, connectedAt: null, serverVersion: null }
        : captured.officialMode === "codex" && !captured.codexEnabled ? { phase: "disconnected", detail: "BB is detached. Codex retains the shared Figma authorization; Test Figma resumes it without a new sign-in.", connectedAt: null, serverVersion: null } : official().status(),
      mirror: mirrorUsable ? mirror.status() : { phase: "unconfigured", detail: mirrorDetail, connectedAt: null, serverVersion: null },
      tools: { official: bridge.inventory("official"), mirror: mirrorUsable ? bridge.inventory("mirror") : [] },
      aliasesNeedReload: bridge.aliasesNeedReload(),
      };
    };
    const update = async (input: Partial<Configuration>): Promise<SettingsSnapshot> => {
      const next = configurationSchema.parse({ ...config, ...input });
      const mirrorChanged = next.mirrorEnabled !== config.mirrorEnabled || next.binaryPath !== config.binaryPath || next.readToken !== config.readToken;
      // A paused cache missed official edits. Re-enabling starts a fresh cache;
      // old bytes remain isolated, never silently served as current content.
      if (next.mirrorEnabled !== config.mirrorEnabled) next.cacheGeneration = randomUUID();
      next.redirectUri = configuredRedirect(next.redirectUri, bb.pluginId);
      const officialChanged = next.clientId !== config.clientId || next.clientSecret !== config.clientSecret || next.redirectUri !== config.redirectUri;
      const handoffChanged = next.codexBinaryPath !== config.codexBinaryPath || next.codexServerName !== config.codexServerName;
      const modeChanged = next.officialMode !== config.officialMode;
      if (officialChanged) await remote.disconnect();
      // Close borrowed transports without deleting grants when changing route.
      if (handoffChanged || modeChanged) {
        await Promise.allSettled([codex.close(), remote.close()]);
        bridge.clear("official");
      }
      try { await configStore.write(next); }
      catch (error) {
        // Failed configuration persistence must not strand the previous route
        // with disposed managers. Its grants were not deleted by route rotation.
        if (handoffChanged || modeChanged) { codex = makeCodex(); remote = makeRemote(); }
        change();
        throw error;
      }
      config = next;
      if (handoffChanged || modeChanged) { codex = makeCodex(); remote = makeRemote(); }
      configurationProblem = null;
      await mirror.configure(mirrorConfig((await resolveBinary(config.binaryPath)) ?? config.binaryPath));
      if (mirrorChanged) bridge.clear("mirror");
      change();
      return snapshot();
    };

    bb.rpc.register(rpcContract, {
      status: () => snapshot(),
      configure: (input) => serialize(() => update(input)),
      connectOfficial: () => serialize(async () => {
        if (config.officialMode === "direct") configuredRedirect(config.redirectUri, bb.pluginId);
        else if (!config.codexEnabled) { await configStore.write({ ...config, codexEnabled: true }); config = { ...config, codexEnabled: true }; }
        return official().beginAuth();
      }),
      finishCodexAuth: ({ callbackUrl }) => serialize(async () => {
        if (config.officialMode !== "codex") throw new Error("Select Via Codex before submitting a Figma callback.");
        await codex.finishCallback(callbackUrl);
        bridge.clear("official");
        try { await bridge.refresh("official"); }
        catch { bb.log.warn("Codex Figma sign-in completed, but the tool catalog needs a refresh."); }
        change();
        return snapshot();
      }),
      disconnect: ({ source }) => serialize(async () => {
        if (source === "official") {
          if (config.officialMode === "codex") {
            await configStore.write({ ...config, codexEnabled: false });
            config = { ...config, codexEnabled: false };
          }
          await official().disconnect();
        }
        else await update({ readToken: "", mirrorEnabled: false });
        bridge.clear?.(source);
        change();
        return snapshot();
      }),
      testConnection: ({ source, file }) => serialize(async () => {
        if (source === "official" && config.officialMode === "codex") {
          if (!config.codexEnabled) { await configStore.write({ ...config, codexEnabled: true }); config = { ...config, codexEnabled: true }; }
          await codex.connect();
        }
        if (source === "mirror") await requireMirror();
        await bridge.refresh(source);
        if (source === "official" && bridge.inventory(source).some(tool => tool.name === "whoami")) {
          const result = await (await official().peer()).request("tools/call", { name: "whoami", arguments: {} });
          if (result.isError) throw new Error("Figma identity check failed. Review authorization before using this connection.");
          bb.log.info("Figma identity check succeeded through the configured connection.");
        }
        if (source === "mirror" && file) {
          const result = await (await mirror.peer()).request("tools/call", { name: "figmog_open", arguments: { file } });
          if (result.isError) throw new Error("Figma could not mirror that file. Check the read token, its scopes and file access.");
        }
        change();
        return snapshot();
      }),
      refreshTools: ({ source }) => serialize(async () => {
        if (source === "mirror") await requireMirror();
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
          if (config.officialMode !== "direct") throw new Error("Direct Figma callback is inactive.");
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

    bb.agents.contributeInstructions(() => `Use the official Figma MCP connection for reads and writes: start with figma_discover source=official. ${config.officialMode === "codex" ? "The genuine Codex client owns Figma authorization and forwards tools and resources to BB. Codex may reissue a request after an expired-session HTTP 404; BB adds no retries. After an unknown or suspicious duplicate result, inspect the canvas before acting. Prompt, completion, task and subscription methods are unavailable through this handoff; do not claim full raw MCP coverage or use a model turn to emulate them." : "BB owns this direct MCP connection; it requires its own Figma admission and authorization."} Figmog is an optional cache, ${config.mirrorEnabled ? "enabled by the operator; use its discovered tools for repeated reads only when available" : "currently disabled"}. If figmog is missing or unavailable, discover the official tools and use their actual schemas; do not translate figmog arguments blindly or require an installation. figma_mcp provides supported resource and other advertised MCP operations. Read upstream skills/resources required by a tool. Connections are shared by this BB deployment and agents act as the authorizing Figma user. Respect refresh-pending errors; after an uncertain write, inspect the official canvas before retrying. Never guess that a disconnected tool or cached schema is available.`);
    bb.onDispose(async () => {
      disposed = true;
      await Promise.allSettled([remote.close(), codex.close(), mirror.close(), bridge.close()]);
      await Promise.allSettled([mutationTail, catalogTail]);
    });
  };
}

export default createFigmaPlugin();
