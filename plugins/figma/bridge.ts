import { createHash } from "node:crypto";
import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult, PluginAgentToolContentPart } from "@get-bb/plugin-sdk";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { z } from "zod";
import type { JsonObject, McpPeer, McpTool, Source } from "./contract.ts";

export type OfficialWriteOutcome = "completed" | "uncertain";
export type OfficialWriteFinisher = (outcome: OfficialWriteOutcome) => Promise<void>;
export interface BridgeOptions {
  bb: BbPluginApi;
  getPeer(source: Source, signal?: AbortSignal): Promise<McpPeer>;
  beforeOfficialWrite(args: JsonObject): Promise<void | OfficialWriteFinisher>;
  refreshMirror(file: string | undefined, acceptUnverified: boolean, signal?: AbortSignal): Promise<JsonObject>;
  onCatalogChange?(): void;
  /** Cached descriptors are registration hints, not an authenticated connection. */
  initialInventory?: Partial<Record<Source, McpTool[]>>;
}
export interface Bridge {
  refresh(source: Source): Promise<McpTool[]>;
  inventory(source: Source): McpTool[];
  registerAliases(): void;
  aliasesNeedReload(): boolean;
  clear(source: Source): void;
  close(): Promise<void>;
}
export const MAX_BRIDGE_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_PAGES = 256;
const sources: Source[] = ["official", "mirror"];
const sourceSchema = z.enum(sources);
const objectSchema = z.record(z.string(), z.unknown());
const reserved = new Set(["figma_discover", "figma_call", "figma_mcp", "figma_sync"]);

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(value: unknown): string {
  // Upstream promises JSON: reject non-JSON values rather than silently erase them.
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) {
      throw new Error("MCP payload contains a non-JSON value");
    }
    return item;
  });
  if (encoded === undefined) throw new Error("MCP payload is not JSON");
  return encoded;
}
function bounded(value: unknown, limit = MAX_BRIDGE_BYTES): string {
  const result = json(value);
  if (Buffer.byteLength(result) > limit) throw new Error(`MCP payload exceeds ${limit} bytes; no content was truncated`);
  return result;
}
function clone<T>(value: T): T { return JSON.parse(bounded(value)) as T; }
function fingerprint(value: unknown): string {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]));
    return item;
  }
  return json(sort(value));
}

/** Preserve unsupported content as inert JSON in its original position. */
export function adaptEnvelope(envelope: JsonObject, limit = MAX_BRIDGE_BYTES): PluginAgentToolResult {
  bounded(envelope, limit);
  const content: PluginAgentToolContentPart[] = [];
  const label = (name: string, value: unknown) => content.push({ type: "text", text: `${name}\n${json(value)}` });
  if (Array.isArray(envelope.content)) {
    envelope.content.forEach((part: unknown, index) => {
      if (object(part) && part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
        const { type: _type, text: _text, ...metadata } = part;
        if (Object.keys(metadata).length) label(`MCP content[${index}] metadata`, metadata);
      } else if (object(part) && part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
        const { type: _type, data: _data, mimeType: _mimeType, ...metadata } = part;
        if (Object.keys(metadata).length) label(`MCP content[${index}] metadata`, metadata);
      } else {
        label(`MCP content[${index}] (preserved as JSON)`, part);
      }
    });
    const { content: _content, ...metadata } = envelope;
    if (Object.keys(metadata).length) label("MCP result fields", metadata);
  } else {
    label("MCP result", envelope); // Resources, prompt roles, tasks and completions.
  }
  const result = { content, ...(envelope.isError === true ? { isError: true } : {}) };
  bounded(result, limit); // Serialization/metadata labels can expand an otherwise valid payload.
  return result;
}

/** Ordinary upstream names remain readable; exceptional names occupy a separate namespace. */
export function aliasName(source: Source, name: string): string {
  const prefix = source === "mirror" ? "figmog_" : "figma_";
  const suffix = source === "mirror" && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const ordinary = /^[a-zA-Z0-9_-]+$/.test(suffix) && !suffix.startsWith("x_") &&
    (source === "mirror" ? name.startsWith(prefix) : !name.startsWith(prefix));
  const candidate = `${prefix}${suffix}`;
  if (ordinary && !reserved.has(candidate) && candidate.length <= 64) return candidate;
  return `${prefix}x_${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
}

function supports(capabilities: JsonObject, ...path: string[]): boolean {
  let value: unknown = capabilities;
  for (const key of path) { if (!object(value)) return false; value = value[key]; }
  return object(value);
}
function checkMethod(peer: McpPeer, method: string): void {
  const caps = peer.info().capabilities;
  let supported = false;
  switch (method) {
    case "ping": supported = true; break;
    case "tools/list": case "tools/call": supported = supports(caps, "tools"); break;
    case "resources/list": case "resources/templates/list": case "resources/read":
      supported = supports(caps, "resources"); break;
    case "resources/subscribe": case "resources/unsubscribe":
      supported = object(caps.resources) && caps.resources.subscribe === true; break;
    case "prompts/list": case "prompts/get": supported = supports(caps, "prompts"); break;
    case "completion/complete": supported = supports(caps, "completions"); break;
    case "tasks/get": case "tasks/result": supported = supports(caps, "tasks"); break;
    case "tasks/list": supported = supports(caps, "tasks", "list"); break;
    case "tasks/cancel": supported = supports(caps, "tasks", "cancel"); break;
    case "logging/setLevel": supported = supports(caps, "logging"); break;
    default: throw new Error(`MCP method ${method} is not supported by this bridge`);
  }
  if (!supported) throw new Error(`Upstream did not advertise capability for ${method}`);
}
function likelyWrite(tool: McpTool): boolean {
  const name = tool.name.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (/(^|[_.-])(create|write|update|delete|remove|set|add|edit|insert|generate|publish|apply|rename|move|connect|upload|capture)([_.-]|$)/i.test(name)) return true;
  if (tool.annotations?.destructiveHint === true) return true;
  if (tool.annotations?.readOnlyHint === true) return false;
  return !/(^|[_.-])(get|read|list|search|find|inspect|status|whoami)([_.-]|$)/i.test(name);
}

interface Catalog {
  tools: McpTool[];
  peer: McpPeer | null;
  dirty: boolean;
  revision: number;
  invalidation: number;
  controller: AbortController;
  unsubscribe?: () => void;
  pending?: Promise<McpTool[]>;
}
interface Alias { source: Source; original: string; snapshot: string; registered: boolean; rejection?: string; }

export function createBridge(options: BridgeOptions): Bridge {
  let closed = false;
  const lifecycle = new AbortController();
  const catalogs = Object.fromEntries(sources.map(source => [source, {
    tools: clone(options.initialInventory?.[source] ?? []), peer: null, dirty: true,
    revision: 0, invalidation: 0, controller: new AbortController(),
  }])) as Record<Source, Catalog>;
  const aliases = new Map<string, Alias>();
  const validators = new Map<string, ((args: unknown) => { valid: boolean; errorMessage?: string }) | null>();
  const assertLive = (signal?: AbortSignal) => {
    if (closed) throw new Error("Figma bridge is closed");
    signal?.throwIfAborted();
  };
  const notify = () => { options.onCatalogChange?.(); };
  function signalFor(source: Source, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([lifecycle.signal, catalogs[source].controller.signal, ...(signal ? [signal] : [])]);
  }
  async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => { reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function acquire(source: Source, signal: AbortSignal): Promise<McpPeer> {
    assertLive(signal);
    const peer = await wait(options.getPeer(source, signal), signal);
    assertLive(signal);
    const catalog = catalogs[source];
    if (catalog.peer !== peer) {
      catalog.unsubscribe?.();
      catalog.peer = peer;
      catalog.dirty = true;
      catalog.revision++;
      catalog.pending = undefined;
      catalog.unsubscribe = peer.onCatalogChanged?.(() => {
        if (closed || catalog.peer !== peer) return;
        catalog.dirty = true;
        catalog.invalidation++;
        validators.clear();
        notify();
      });
    }
    return peer;
  }
  function validate(args: JsonObject, tool: McpTool): void {
    const key = fingerprint(tool.inputSchema);
    if (!validators.has(key)) {
      // Separate validator instances avoid reusing a stale upstream $id across schemas.
      try { validators.set(key, new AjvJsonSchemaValidator().getValidator(tool.inputSchema)); }
      catch { validators.set(key, null); } // Unsupported local dialect/ref: upstream remains authoritative.
    }
    const result = validators.get(key)?.(args);
    if (result && !result.valid) throw new Error(`Arguments do not match current schema for ${tool.name}: ${result.errorMessage}`);
  }
  async function load(source: Source, peer: McpPeer, force: boolean, callerSignal: AbortSignal): Promise<McpTool[]> {
    const catalog = catalogs[source];
    if (!force && !catalog.dirty) return catalog.tools;
    if (catalog.pending) return wait(catalog.pending, callerSignal);
    catalog.dirty = true; // A failed explicit refresh must not authorize stale aliases.
    const revision = catalog.revision;
    const invalidation = catalog.invalidation;
    const signal = signalFor(source);
    const work = (async () => {
      const tools: McpTool[] = [];
      if (supports(peer.info().capabilities, "tools")) {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        const names = new Set<string>();
        let complete = false;
        for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
          assertLive(signal);
          const response = await peer.request("tools/list", cursor === undefined ? {} : { cursor }, signal);
          bounded(response);
          if (!Array.isArray(response.tools)) throw new Error("Invalid MCP tools/list: tools must be an array");
          for (const item of response.tools) {
            if (!object(item) || typeof item.name !== "string" || !item.name || !object(item.inputSchema) ||
                (item.description !== undefined && typeof item.description !== "string") ||
                (item.annotations !== undefined && !object(item.annotations))) {
              throw new Error("Invalid MCP tool descriptor");
            }
            if (names.has(item.name)) throw new Error(`Duplicate upstream tool name: ${item.name}`);
            names.add(item.name);
            tools.push(clone(item) as McpTool);
          }
          bounded(tools);
          if (response.nextCursor === undefined) { complete = true; break; }
          if (typeof response.nextCursor !== "string" || cursors.has(response.nextCursor)) throw new Error("Invalid or repeated MCP pagination cursor");
          cursors.add(response.nextCursor);
          cursor = response.nextCursor;
        }
        if (!complete) throw new Error(`MCP discovery exceeds ${MAX_CATALOG_PAGES} pages; inventory is incomplete`);
      }
      assertLive(signal);
      if (catalog.peer !== peer || catalog.revision !== revision || catalog.invalidation !== invalidation) throw new Error("MCP catalog changed during discovery; refresh again");
      const changed = fingerprint(catalog.tools) !== fingerprint(tools);
      catalog.tools = tools;
      catalog.dirty = false;
      if (changed) catalog.revision++;
      validators.clear();
      if (changed) notify();
      return tools;
    })();
    catalog.pending = work;
    void work.finally(() => { if (catalog.pending === work) catalog.pending = undefined; }).catch(() => {});
    return wait(work, callerSignal);
  }
  async function call(source: Source, params: JsonObject, ctx: PluginAgentToolContext, alias?: Alias): Promise<PluginAgentToolResult> {
    const signal = signalFor(source, ctx.signal);
    const peer = await acquire(source, signal);
    checkMethod(peer, "tools/call");
    let tools = await load(source, peer, false, signal);
    let tool = tools.find(item => item.name === params.name);
    if (!tool && !alias) { tools = await load(source, peer, true, signal); tool = tools.find(item => item.name === params.name); }
    if (!tool) throw new Error(`Tool ${String(params.name)} is absent from the current ${source} inventory; use figma_discover`);
    if (alias && fingerprint(tool) !== alias.snapshot) throw new Error("Native alias descriptor changed; use figma_discover and figma_call, or reload aliases in a new session");
    const validatedDescriptor = fingerprint(tool);
    const validatedRevision = catalogs[source].revision;
    const args = params.arguments ?? {};
    if (!object(args)) throw new Error("Tool arguments must be a JSON object");
    bounded(params);
    validate(args, tool);
    const taskSupport = object(tool.execution) ? tool.execution.taskSupport : undefined;
    if (params.task !== undefined) {
      if (!object(params.task) || (taskSupport !== "optional" && taskSupport !== "required") || !supports(peer.info().capabilities, "tasks", "requests", "tools", "call")) {
        throw new Error("Upstream did not advertise task execution for this tool");
      }
    } else if (taskSupport === "required") {
      throw new Error("This tool requires task execution; use figma_mcp tools/call with task parameters");
    }
    let finisher: void | OfficialWriteFinisher = undefined;
    const finishUncertain = async (finish: void | OfficialWriteFinisher) => {
      try { await finish?.("uncertain"); }
      catch { options.bb.log.warn("Official Figma write cleanup failed; mirror freshness remains uncertain."); }
    };
    if (source === "official" && likelyWrite(tool)) {
      const preparation = Promise.resolve().then(() => options.beforeOfficialWrite(clone(args)));
      try { finisher = await wait(preparation, signal); }
      catch (error) {
        // Caller cancellation may precede durable ticket creation. Retire any late
        // ticket without dispatching a write, even after this call has returned.
        void preparation.then(finishUncertain, () => {}).catch(() => {});
        throw error;
      }
    }
    let result: JsonObject;
    try {
      assertLive(signal);
      if (catalogs[source].peer !== peer) throw new Error("MCP peer changed before dispatch; rediscover and call again");
      // A refresh in progress is not a schema change. Join it and compare the
      // descriptor actually validated, rather than failing on the dirty flag.
      if (catalogs[source].dirty || catalogs[source].revision !== validatedRevision) {
        const current = (await load(source, peer, false, signal)).find(item => item.name === tool.name);
        if (!current || fingerprint(current) !== validatedDescriptor) throw new Error("MCP catalog changed before dispatch; rediscover and call again");
      }
      assertLive(signal);
      checkMethod(peer, "tools/call");
      result = await wait(peer.request("tools/call", params, signal), signal); // Never retry an uncertain write.
      assertLive(signal);
    } catch (error) {
      await finishUncertain(finisher);
      throw error; // Cleanup failures cannot replace the original upstream/cancellation error.
    }
    const taskPending = params.task !== undefined || object(result.task);
    let cleanupFailed = false;
    // Task acceptance acknowledges dispatch, not the eventual mutation outcome.
    try { await finisher?.(taskPending ? "uncertain" : "completed"); }
    catch { cleanupFailed = true; }
    const adapted = adaptEnvelope(result);
    if (taskPending && source === "official" && likelyWrite(tool) && typeof adapted !== "string") adapted.content.push({
      type: "text",
      text: "Figma write task is pending: dispatch acceptance does not confirm edit completion. Inspect the terminal task result with figma_mcp before attempting mirror recovery with figma_sync.",
    });
    if (cleanupFailed && typeof adapted !== "string") adapted.content.push({
      type: "text",
      text: "Figma mirror refresh-pending: the upstream result was received, but write freshness cleanup failed. Cached mutation visibility remains unverified. Use figma_sync with acceptUnverified:true for explicit unverified recovery; omit file to recover all known files and the unknown-target fence.",
    });
    return adapted;
  }
  function registerAliases(): void {
    assertLive();
    for (const source of sources) for (const tool of catalogs[source].tools) {
      const name = aliasName(source, tool.name);
      const existing = aliases.get(name);
      if (existing) {
        if (existing.source !== source || existing.original !== tool.name) throw new Error("Native alias name collision; generic call remains available");
        continue;
      }
      const alias: Alias = { source, original: tool.name, snapshot: fingerprint(tool), registered: false };
      aliases.set(name, alias);
      try {
        options.bb.agents.registerTool({
          name, description: tool.description?.trim() || `${source} MCP tool ${tool.name}`,
          parameters: clone(tool.inputSchema),
          execute: (args: unknown, ctx: PluginAgentToolContext) => call(source, { name: tool.name, arguments: args }, ctx, alias),
        });
        alias.registered = true;
      } catch (error) {
        // Recursive/provider-incompatible schemas retain their complete generic surface.
        alias.registered = false;
        alias.rejection = error instanceof Error ? error.message : "Native schema registration rejected";
      }
    }
  }
  const bridge: Bridge = {
    async refresh(source) {
      const signal = signalFor(source);
      const peer = await acquire(source, signal);
      return clone(await load(source, peer, true, signal));
    },
    inventory: source => clone(catalogs[source].tools),
    registerAliases,
    aliasesNeedReload() {
      // UI refresh updates discovery without mutating the native registrations.
      // Newly discovered names therefore need alias registration and a new session.
      for (const source of sources) for (const tool of catalogs[source].tools) {
        if (!aliases.has(aliasName(source, tool.name))) return true;
      }
      for (const alias of aliases.values()) if (alias.registered) {
        const tool = catalogs[alias.source].tools.find(item => item.name === alias.original);
        if (!tool || fingerprint(tool) !== alias.snapshot) return true;
      }
      return false;
    },
    clear(source) {
      const catalog = catalogs[source];
      catalog.unsubscribe?.();
      catalog.unsubscribe = undefined;
      catalog.controller.abort(new Error("Figma connection cleared"));
      catalog.controller = new AbortController();
      catalog.tools = [];
      catalog.peer = null;
      catalog.dirty = true;
      catalog.revision++;
      catalog.pending = undefined;
      validators.clear();
      notify();
    },
    async close() {
      if (closed) return;
      closed = true;
      lifecycle.abort(new Error("Figma bridge is closed"));
      for (const source of sources) catalogs[source].unsubscribe?.();
      validators.clear();
      // getPeer lends sessions; remote/mirror managers own transport disposal.
    },
  };
  options.bb.agents.registerTool({
    name: "figma_discover", description: "Discover the complete current authenticated Figma or figmog MCP tool catalog, with schemas and capabilities.",
    parameters: z.object({ source: sourceSchema }).strict(),
    execute: async ({ source }, ctx) => {
      const signal = signalFor(source, ctx.signal);
      const peer = await acquire(source, signal);
      const tools = await load(source, peer, true, signal);
      registerAliases();
      const info = peer.info();
      return adaptEnvelope({ source, info: {
        capabilities: info.capabilities,
        ...(info.serverInfo === undefined ? {} : { serverInfo: info.serverInfo }),
        ...(info.instructions === undefined ? {} : { instructions: info.instructions }),
      }, tools, nativeAliases: [...aliases.entries()].filter(([, alias]) => alias.source === source).map(([name, alias]) => {
        const current = tools.find(tool => tool.name === alias.original);
        return {
          name, originalName: alias.original, registered: alias.registered,
          current: !!current && fingerprint(current) === alias.snapshot,
          ...(alias.rejection === undefined ? {} : { rejection: alias.rejection }),
        };
      }) });
    },
  });
  options.bb.agents.registerTool({
    name: "figma_call", description: "Call any current upstream Figma/figmog tool by its original name and arguments. Use figma_discover for its full schema.",
    parameters: z.object({ source: sourceSchema, name: z.string().min(1), arguments: objectSchema.default({}) }).strict(),
    execute: ({ source, name, arguments: args }, ctx) => call(source, { name, arguments: args }, ctx),
  });
  options.bb.agents.registerTool({
    name: "figma_mcp", description: "Use advertised MCP tools, resources/templates/read/subscriptions, prompts, completion, logging and task methods. Pass the original method and parameters; unsupported server-driven features are not auto-approved.",
    parameters: z.object({ source: sourceSchema, method: z.string().min(1), params: objectSchema.default({}) }).strict(),
    execute: async ({ source, method, params }, ctx) => {
      if (method === "tools/call") return call(source, params, ctx);
      const signal = signalFor(source, ctx.signal);
      const peer = await acquire(source, signal);
      checkMethod(peer, method);
      bounded(params);
      const result = await peer.request(method, params, signal);
      assertLive(signal);
      return adaptEnvelope(result);
    },
  });
  options.bb.agents.registerTool({
    name: "figma_sync",
    description: "Refresh a figmog mirror, or omit file to refresh all known files, without retrying an official write. A changed file version is only a freshness heuristic. Set acceptUnverified=true explicitly to release pending freshness without confirming that an earlier edit is visible; the result remains unverified. Per-file recovery leaves the global unknown-target fence; omit file with acceptUnverified=true to recover it after all known files are pulled.",
    parameters: z.object({ file: z.string().min(1).optional(), acceptUnverified: z.boolean().default(false) }).strict(),
    execute: async ({ file, acceptUnverified }, ctx) => {
      const signal = signalFor("mirror", ctx.signal);
      assertLive(signal);
      const result = await wait(options.refreshMirror(file, acceptUnverified, signal), signal);
      assertLive(signal);
      return adaptEnvelope(result);
    },
  });
  registerAliases(); // Purely cached registration, never network in the factory.
  return bridge;
}
