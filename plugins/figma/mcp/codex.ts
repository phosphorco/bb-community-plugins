import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import type { CodexConfig, CodexManager, CodexOptions, ConnectionStatus, JsonObject, McpInfo, McpPeer } from "../contract.ts";

// Codex CLI 0.160.1 app-server schemas. No turns, config writes, token reads,
// automatic OAuth, tool replay, or unsupported generic MCP APIs.
const LIMIT = 16 * 1024 * 1024;
const QUEUE = 32;
const AUTH_MS = 5 * 60_000;
const UNSUPPORTED = "The Codex route supports tools and resource reads only. Prompts, completion, tasks, subscriptions, logging and upstream list-change notifications are unavailable.";
const UNKNOWN = "Figma tool outcome is unknown. Inspect the official canvas before retrying. BB did not replay this call.";
const object = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);
class TransportError extends Error {}
class UndispatchedError extends TransportError {}
class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, detail: string) { super(`Codex MCP request failed (JSON-RPC ${code}): ${detail}`); this.code = code; }
}
const cancelled = () => new TransportError("Figma request was cancelled.");

/** JSON-lines app-server: request-local cancellation never kills sibling calls. */
class AppServer {
  readonly child: ChildProcessWithoutNullStreams;
  private next = 1;
  private buffer = "";
  private stderrBytes = 0;
  private pending = new Map<number, { resolve: (r: JsonObject) => void; reject: (e: Error) => void; clean: () => void }>();
  private dead = false;
  private changed: (message?: JsonObject) => void;
  private sanitize: (message: unknown) => string;
  constructor(config: CodexConfig, directory: string, changed: (message?: JsonObject) => void, sanitize: (message: unknown) => string) {
    this.changed = changed; this.sanitize = sanitize;
    this.child = spawn(config.binaryPath, [...overrides(config), "app-server", "--listen", "stdio://"], {
      cwd: directory, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > LIMIT) return this.fail("Codex response exceeded the transport limit.");
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: JsonObject;
        try { const value: unknown = JSON.parse(line); if (!object(value)) throw new Error(); message = value; }
        catch { return this.fail("Codex returned invalid app-server framing."); }
        if (typeof message.method === "string") {
          if (message.id !== undefined) {
            // Explicitly refuse elicitation and all approvals; never execute a turn.
            if (typeof message.id !== "string" && typeof message.id !== "number") return this.fail("Codex returned an invalid request identifier.");
            try { this.write({ id: message.id, error: { code: -32601, message: "BB cannot accept app-server elicitation or approvals. Complete the operation interactively in Codex." } }); }
            catch { return this.fail("Codex server request could not be declined safely."); }
          } else { try { this.changed(message); } catch { /* Isolate manager events. */ } }
          continue;
        }
        if (typeof message.id !== "number") continue;
        const p = this.pending.get(message.id); if (!p) continue;
        this.pending.delete(message.id); p.clean();
        if (object(message.error)) p.reject(new ProtocolError(typeof message.error.code === "number" ? message.error.code : -32603, this.sanitize(message.error.message)));
        else if (object(message.result)) p.resolve(message.result);
        else p.reject(new TransportError("Codex returned an invalid response envelope."));
      }
    });
    // Consume without retaining or exposing raw stderr, which may contain OAuth data.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > LIMIT) this.fail("Codex stderr exceeded the transport limit.");
    });
    this.child.on("error", () => this.fail("Unable to start the configured native Codex binary."));
    this.child.on("exit", () => this.fail("Codex app-server stopped. Reconnect Figma in settings."));
    this.child.stdin.on("error", () => this.fail("Codex app-server input closed."));
  }
  private write(value: JsonObject) {
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > LIMIT || this.child.stdin.writableLength > LIMIT) throw new TransportError("Codex request exceeded the transport limit.");
    this.child.stdin.write(line);
  }
  notify(method: string) { if (this.dead) throw new TransportError("Codex transport is closed."); this.write({ method }); }
  request(method: string, params: JsonObject, signal?: AbortSignal, timeout = 60_000): Promise<JsonObject> {
    if (signal?.aborted) return Promise.reject(new UndispatchedError("Figma request was cancelled before dispatch."));
    if (this.dead) return Promise.reject(new UndispatchedError("Codex transport is closed."));
    if (this.pending.size >= QUEUE) return Promise.reject(new UndispatchedError("Codex request queue is full. Try again when active requests finish."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const stop = (error: Error, retainSlot = false) => {
        const p = this.pending.get(id); if (!p) return;
        if (retainSlot) {
          // Cancellation cannot unsend the request. Keep a bounded tombstone
          // until its response/deadline, rather than permitting unbounded work.
          signal?.removeEventListener("abort", abort); p.reject(error);
          p.resolve = () => undefined; p.reject = () => undefined;
        } else { this.pending.delete(id); p.clean(); p.reject(error); }
      };
      const abort = () => stop(cancelled(), true);
      const timer = setTimeout(() => stop(new TransportError("Codex request timed out.")), timeout);
      const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, clean });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.write({ id, method, params }); } catch { stop(new UndispatchedError("Codex request could not be dispatched.")); }
    });
  }
  private fail(message: string) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) { p.clean(); p.reject(new TransportError(message)); }
    this.pending.clear(); this.buffer = "";
    this.changed();
    void stopChild(this.child);
  }
  async close() { this.fail("Codex transport was closed."); await stopChild(this.child); }
}
function overrides(config: CodexConfig): string[] {
  return ["-c", `mcp_servers.${config.serverName}.url="https://mcp.figma.com/mcp"`,
    "-c", `mcp_servers.${config.serverName}.tool_timeout_sec=180`,
    "-c", `mcp_servers.${config.serverName}.startup_timeout_sec=60`];
}
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1500);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
interface Session {
  app: AppServer; config: CodexConfig; threadId: string; catalog: JsonObject; epoch: number;
  info: McpInfo; peer?: McpPeer; lease: number; stale?: boolean; refresh?: Promise<Session>;
}
interface Auth {
  child: ChildProcessWithoutNullStreams; url?: URL; done: Promise<void>; cancel: () => Promise<void>;
  submitted: boolean; epoch: number;
}

export function createCodexManager(options: CodexOptions): CodexManager {
  let generation = 0, closed = false, disconnected = false, authStarting = false, authFinishing = false;
  let session: Session | undefined, startup: Promise<Session> | undefined, auth: Auth | undefined;
  const listeners = new Set<() => void>();
  const transports = new Set<AppServer>();
  const secrets = new Set<string>();
  const remember = (...values: (string | null | undefined)[]) => {
    for (const value of values) if (value) {
      secrets.add(value); secrets.add(encodeURIComponent(value));
      while (secrets.size > 128) secrets.delete(secrets.values().next().value!);
    }
  };
  const sanitize = (value: unknown): string => {
    if (typeof value !== "string") return "Check Figma authorization or the requested operation.";
    let text = value;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
    return text.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
      .replace(/((?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization_code|state|code)\b["']?\s*[=:]\s*["']?)[^"'\s&;,}]+/gi, "$1[redacted]")
      .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1024);
  };
  const directory = async () => {
    if (!isAbsolute(options.directory)) throw new TransportError("Configure an absolute private Codex transport directory.");
    try { await mkdir(options.directory, { recursive: true, mode: 0o700 }); await chmod(options.directory, 0o700); }
    catch { throw new TransportError("Unable to prepare the private Codex transport directory."); }
  };
  let current: ConnectionStatus = { phase: "disconnected", detail: null, connectedAt: null, serverVersion: null };
  const changed = () => { try { options.onChange?.(); } catch { /* Isolate presentation. */ } };
  const invalidate = () => {
    if (session) { session.lease++; session.peer = undefined; }
    for (const listener of listeners) { try { listener(); } catch { /* Isolate subscribers. */ } }
    listeners.clear(); changed();
  };
  const status = (phase: ConnectionStatus["phase"], detail: string | null = null) => {
    current = { phase, detail, connectedAt: phase === "connected" ? Date.now() : null,
      serverVersion: phase === "connected" ? session?.info.serverInfo?.version ?? null : null }; changed();
  };
  const check = (epoch: number) => {
    if (closed || epoch !== generation || disconnected) throw new TransportError("Figma connection was disconnected. Use Test Figma or Connect in settings.");
  };
  const config = async (): Promise<CodexConfig> => {
    const c = await options.config();
    if (!isAbsolute(c.binaryPath) || /(?:subscription-router|\/shims\/|router\.[cm]?js$|codex\.js$)/i.test(c.binaryPath) || !/^[A-Za-z0-9_-]{1,128}$/.test(c.serverName)) {
      throw new TransportError("Configure an absolute native Codex binary path and a valid server name. Router shims and automatic installation are unsupported.");
    }
    return c;
  };
  const dispose = async () => {
    invalidate(); session = undefined;
    const previous = [...transports]; transports.clear();
    await Promise.all(previous.map(app => app.close()));
  };
  const inventory = async (app: AppServer, c: CodexConfig, threadId: string): Promise<JsonObject> => {
    let cursor: string | undefined, found: JsonObject | undefined;
    const readyDeadline = Date.now() + 60_000;
    const cursors = new Set<string>();
    for (let page = 0; page < 128; page++) {
      const r = await app.request("mcpServerStatus/list", { threadId, serverName: c.serverName, detail: "full", ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(r.data)) throw new TransportError("Codex returned an invalid MCP catalog.");
      for (const s of r.data) if (object(s) && s.name === c.serverName) {
        if (found) throw new TransportError("Codex returned duplicate Figma server catalogs.");
        found = s;
      }
      if (r.nextCursor === null || r.nextCursor === undefined) {
        if (!found) throw new TransportError("Configured Figma server was absent from the Codex catalog.");
        if (["notStarted", "starting"].includes(String(found.runtimeStatus))) {
          if (Date.now() >= readyDeadline) throw new TransportError("Codex Figma startup timed out. Use Test Figma to reconnect.");
          await new Promise<void>(resolve => setTimeout(resolve, 200));
          cursor = undefined; found = undefined; cursors.clear(); page = -1; continue;
        }
        if (found.toolsError || found.authStatus === "notLoggedIn" || ["authenticationRequired", "failed", "cancelled", "disabled"].includes(String(found.runtimeStatus))) {
          throw new TransportError("Codex Figma startup or catalog discovery failed. Use Connect in settings to check authorization.");
        }
        if (found.httpOrigin && found.httpOrigin !== "https://mcp.figma.com") throw new TransportError("Codex Figma endpoint does not match the official origin.");
        if (!object(found.tools) || !Array.isArray(found.resources) || !Array.isArray(found.resourceTemplates)) throw new TransportError("Codex returned an incomplete Figma catalog.");
        for (const tool of Object.values(found.tools)) if (!object(tool) || typeof tool.name !== "string" || !object(tool.inputSchema)) throw new TransportError("Codex returned an invalid Figma tool descriptor.");
        return found;
      }
      if (typeof r.nextCursor !== "string" || !r.nextCursor || cursors.has(r.nextCursor)) throw new TransportError("Codex catalog pagination was invalid.");
      cursor = r.nextCursor; cursors.add(cursor);
    }
    throw new TransportError("Codex catalog pagination exceeded the transport limit.");
  };
  const catalogInfo = (catalog: JsonObject): McpInfo => {
    const capabilities: JsonObject = {};
    const upstream = object(catalog.serverCapabilities) ? catalog.serverCapabilities : {};
    if (upstream.tools || Object.keys(catalog.tools as JsonObject).length) capabilities.tools = {};
    if (upstream.resources || (catalog.resources as unknown[]).length || (catalog.resourceTemplates as unknown[]).length) capabilities.resources = {};
    const serverInfo = object(catalog.serverInfo) && typeof catalog.serverInfo.name === "string" && typeof catalog.serverInfo.version === "string"
      ? catalog.serverInfo as { name: string; version: string } : undefined;
    return { capabilities, serverInfo, instructions: UNSUPPORTED + " Authorization and credentials are owned by the operator's genuine Codex CLI. Disconnect preserves that shared grant. Codex may initialize other MCP servers configured by the operator. BB dispatches each tool call once; Codex itself can reissue a request after a recognized expired-session HTTP 404." };
  };
  const ensure = async (): Promise<Session> => {
    const epoch = generation; check(epoch);
    const c = await config(); check(epoch);
    if (session && JSON.stringify(session.config) === JSON.stringify(c)) {
      const active = session;
      if (!active.stale) return active;
      if (active.refresh) return active.refresh;
      const lease = active.lease;
      const refresh = (async () => {
        const catalog = await inventory(active.app, c, active.threadId); check(epoch);
        if (session !== active || active.lease !== lease) throw new TransportError("Figma server changed during discovery. Use Test Figma again.");
        active.catalog = catalog; active.stale = false; active.info = catalogInfo(catalog);
        status("connected"); return active;
      })();
      active.refresh = refresh;
      try { return await refresh; } finally { if (active.refresh === refresh) active.refresh = undefined; }
    }
    if (startup) {
      const active = await startup; check(epoch);
      if (JSON.stringify(active.config) !== JSON.stringify(c)) return ensure();
      return active;
    }
    const pending = (async () => {
      await dispose(); await directory(); check(epoch); status("connecting");
      let s: Session | undefined;
      const app = new AppServer(c, options.directory, message => {
        if (generation !== epoch || closed) return;
        if (!message) {
          if (session?.app === app) { invalidate(); session = undefined; status("error", "Codex app-server stopped. Use Test Figma to reconnect."); }
          return;
        }
        if (message.method === "mcpServer/startupStatus/updated" || message.method === "mcpServerStatus/updated") {
          const p = message.params;
          if (!object(p) || p.name !== c.serverName || (p.threadId && s && p.threadId !== s.threadId)) return;
          if (session?.app === app && ["failed", "authenticationRequired", "cancelled", "disabled"].includes(String(p.status))) {
            session.stale = true; invalidate();
            // Health notifications invalidate discovery, never an active call's
            // result or the process serving healthy concurrent requests.
            status("error", "Codex Figma server changed. Rediscover the catalog with Test Figma.");
          }
        }
      }, sanitize);
      transports.add(app);
      try {
        await app.request("initialize", { clientInfo: { name: "bb_figma_plugin", title: "BB Figma", version: "0.1.0" }, capabilities: {} }); check(epoch);
        app.notify("initialized");
        const started = await app.request("thread/start", { cwd: options.directory, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" }); check(epoch);
        const thread = started.thread;
        if (!object(thread) || typeof thread.id !== "string" || !thread.id) throw new TransportError("Codex did not create an ephemeral MCP thread.");
        const catalog = await inventory(app, c, thread.id); check(epoch);
        s = { app, config: c, threadId: thread.id, catalog, epoch, lease: 0, info: catalogInfo(catalog) };
        session = s; status("connected"); return s;
      } catch (error) {
        transports.delete(app); await app.close();
        if (epoch === generation && !closed && !disconnected) status("error", error instanceof TransportError ? error.message : "Codex Figma connection failed. Check authorization in settings.");
        throw error instanceof TransportError ? error : new TransportError("Codex Figma connection failed. Check authorization in settings.");
      }
    })();
    startup = pending;
    try { return await pending; } finally { if (startup === pending) startup = undefined; }
  };
  const peerFor = (s: Session): McpPeer => {
    if (s.peer) return s.peer;
    const lease = s.lease; let disposed = false;
    const subscriptions = new Set<() => void>();
    const valid = () => { check(s.epoch); if (disposed || session !== s || lease !== s.lease) throw new TransportError("Figma transport or catalog changed. Rediscover before calling again."); };
    const peer: McpPeer = {
      info: () => { valid(); return structuredClone(s.info); },
      onCatalogChanged(listener) { valid(); listeners.add(listener); const off = () => { listeners.delete(listener); subscriptions.delete(off); }; subscriptions.add(off); return off; },
      async close() { if (disposed) return; disposed = true; for (const off of subscriptions) off(); if (s.peer === peer) s.peer = undefined; },
      async request(method, params = {}, signal) {
        valid(); if (signal?.aborted) throw cancelled();
        if (method.endsWith("/list") && params.cursor !== undefined) throw new Error("Codex returns a fully aggregated catalog; MCP list cursors are unavailable.");
        if (params.task !== undefined) throw new Error(UNSUPPORTED);
        if (method === "tools/list") return { tools: structuredClone(Object.values(s.catalog.tools as JsonObject)) };
        if (method === "resources/list") return { resources: structuredClone(s.catalog.resources) };
        if (method === "resources/templates/list") return { resourceTemplates: structuredClone(s.catalog.resourceTemplates) };
        let route: string, input: JsonObject;
        if (method === "tools/call") {
          if (typeof params.name !== "string" || !Object.values(s.catalog.tools as JsonObject).some(t => object(t) && t.name === params.name)) throw new Error("Unknown Figma tool. Rediscover the catalog.");
          route = "mcpServer/tool/call";
          input = { threadId: s.threadId, server: s.config.serverName, tool: params.name,
            ...(params.arguments === undefined ? {} : { arguments: params.arguments }), ...(params._meta === undefined ? {} : { _meta: params._meta }) };
        } else if (method === "resources/read") {
          if (typeof params.uri !== "string" || !params.uri) throw new Error("A Figma resource URI is required.");
          route = "mcpServer/resource/read"; input = { threadId: s.threadId, server: s.config.serverName, uri: params.uri };
        } else throw new Error(UNSUPPORTED);
        try {
          const result = await s.app.request(route, input, signal, method === "tools/call" ? 180_000 : 60_000);
          // A received response remains authoritative even if a concurrent
          // health notification changed the next acquisition's catalog lease.
          if (method === "tools/call" && result.isError === true && Array.isArray(result.content) &&
              result.content.some(item => object(item) && item.type === "text" && typeof item.text === "string" && /timed?\s*out|timeout|deadline\s+exceeded/i.test(item.text))) {
            return { ...result, content: [...result.content, { type: "text", text: UNKNOWN }] };
          }
          return result;
        } catch (error) {
          if (method === "tools/call" && error instanceof ProtocolError && ![-32600, -32601, -32602].includes(error.code)) {
            throw new TransportError(`${UNKNOWN} ${error.message}`);
          }
          if (method === "tools/call" && !(error instanceof ProtocolError) && !(error instanceof UndispatchedError)) throw new TransportError(UNKNOWN);
          throw error;
        }
      },
    };
    s.peer = peer; return peer;
  };
  const cancelAuth = async () => { const pending = auth; auth = undefined; await pending?.cancel(); };
  return {
    status: () => ({ ...current }),
    async connect() { if (closed) throw new TransportError("Figma manager is closed."); disconnected = false; await ensure(); },
    async peer(signal) { if (signal?.aborted) throw cancelled(); const s = await ensure(); if (signal?.aborted) throw cancelled(); return peerFor(s); },
    async beginAuth() {
      if (closed) throw new TransportError("Figma manager is closed.");
      if (authStarting || authFinishing) throw new TransportError("Codex Figma sign-in is already starting or finishing. Wait for it to complete.");
      authStarting = true;
      try {
        await cancelAuth(); disconnected = false;
        const epoch = generation, c = await config(); await directory(); check(epoch);
        const child = spawn(c.binaryPath, [...overrides(c), "mcp", "login", c.serverName, "--no-browser", "--oauth-client-registration", "dcr", "--scopes", "mcp:connect"], {
          cwd: options.directory, shell: false, stdio: ["pipe", "pipe", "pipe"],
        });
        let resolveUrl!: (url: string) => void, rejectUrl!: (error: Error) => void;
        const urlPromise = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
        let resolveDone!: () => void, rejectDone!: (error: Error) => void;
        const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
        void done.catch(() => undefined); void urlPromise.catch(() => undefined);
        let buffer = "", bytes = 0, ended = false;
        const pending: Auth = { child, done, submitted: false, epoch, cancel: async () => { finish(false); await stopChild(child); } };
        const finish = (success: boolean) => {
          if (ended) return; ended = true; clearTimeout(timer); buffer = "";
          if (auth === pending) auth = undefined;
          const error = new TransportError("Codex Figma sign-in failed, expired or was cancelled. Start Connect again; existing Codex credentials were not deleted by BB.");
          if (!pending.url) rejectUrl(error);
          if (success) resolveDone(); else rejectDone(error);
          if (!success && epoch === generation && !closed && !disconnected) status(session ? "connected" : "error", session ? null : error.message);
        };
        const timer = setTimeout(() => { finish(false); void stopChild(child); }, AUTH_MS);
        const output = (chunk: string) => {
          if (ended) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 64 * 1024) { finish(false); void stopChild(child); return; }
          if (pending.url) return;
          buffer += chunk;
          const match = buffer.match(/https:\/\/www\.figma\.com\/oauth\/mcp\?[^\s<>"']+(?=\s|$)/);
          // A URL can be split across chunks; wait for a newline/whitespace delimiter.
          if (!match || !/\s/.test(buffer.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1))) return;
          try {
            const url = new URL(match[0]); const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
            if (url.origin !== "https://www.figma.com" || url.pathname !== "/oauth/mcp" || !url.searchParams.get("state") ||
              redirect.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) || redirect.username || redirect.password || redirect.hash || redirect.search) throw new Error();
            pending.url = url; remember(url.href, url.searchParams.get("state")); buffer = ""; resolveUrl(url.href);
          } catch { finish(false); void stopChild(child); }
        };
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", output); child.stderr.on("data", output);
        child.stdin.on("error", () => finish(false)); child.on("error", () => finish(false)); child.on("exit", code => {
          const direct = code === 0 && !!pending.url && !pending.submitted;
          finish(code === 0 && !!pending.url);
          if (direct && epoch === generation && !closed && !disconnected) {
            authFinishing = true;
            void (async () => { generation++; startup = undefined; await dispose(); await ensure(); })()
              .catch(() => { if (!closed && !disconnected) status("error", "Codex sign-in succeeded but Figma reconnect failed. Use Test Figma."); })
              .finally(() => { authFinishing = false; });
          }
        });
        auth = pending; status("authorizing");
        return { authorizationUrl: await urlPromise, callbackRequired: true };
      } finally { authStarting = false; }
    },
    async finishAuth() { throw new Error("This Codex route requires the complete browser callback URL. Use finishCallback in Figma settings."); },
    async finishCallback(value) {
      const pending = auth;
      if (!pending?.url || pending.submitted) throw new TransportError("No pending Codex Figma sign-in. Start Connect again.");
      check(pending.epoch);
      let raw = value.trim();
      if (raw.length > 65_536 || /[\r\n\x00]/.test(raw)) {
        const detail = "Invalid callback URL. Paste the complete browser URL again."; status("authorizing", detail); throw new TransportError(detail);
      }
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1).trim();
      if (/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+\//i.test(raw)) raw = "http://" + raw;
      let url: URL;
      try {
        url = new URL(raw); const redirect = new URL(pending.url.searchParams.get("redirect_uri")!);
        if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password || url.hash ||
          url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== pending.url.searchParams.get("state") ||
          (!url.searchParams.get("code") && !url.searchParams.get("error"))) throw new Error();
      } catch {
        const detail = "Callback URL does not match the pending sign-in. Paste the complete browser URL again."; status("authorizing", detail); throw new TransportError(detail);
      }
      remember(raw, url.href, url.searchParams.get("code"), url.searchParams.get("state"));
      pending.submitted = true; authFinishing = true;
      try {
        // Preserve all issuer parameters. Codex performs PKCE, issuer and token validation.
        pending.child.stdin.end(url.href + "\n");
        await pending.done; check(pending.epoch);
        generation++; startup = undefined; await dispose(); await ensure();
      } finally { authFinishing = false; }
    },
    async disconnect() { generation++; disconnected = true; startup = undefined; await Promise.all([dispose(), cancelAuth()]); status("disconnected", "BB is disconnected. The shared Codex grant is preserved; use Test Figma to reconnect."); },
    async close() { closed = true; generation++; startup = undefined; await Promise.all([dispose(), cancelAuth()]); listeners.clear(); status("disconnected"); },
  };
}
