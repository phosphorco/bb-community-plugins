import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthMetadataSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ConnectionStatus, JsonObject, McpPeer, OfficialConfig, RemoteManager, RemoteOptions } from "../contract.ts";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { sdkPeer, requestTimeoutMs } from "./peer.ts";

const ENDPOINT = "https://mcp.figma.com/mcp";
const ISSUER = "https://api.figma.com";
const AUTHORIZATION = "https://www.figma.com/oauth/mcp";
const REGISTRATION = "https://api.figma.com/v1/oauth/mcp/register";
const TOKEN = "https://api.figma.com/v1/oauth/token";
type Metadata = AuthorizationServerMetadata & { authorization_response_iss_parameter_supported?: boolean };
// Compatibility identifiers from Codex rust-v0.160.1. BB owns all OAuth
// credentials and the transport; no Codex process or credential store is used.
const CLIENT_NAME = "Codex";
const CLIENT_INFO = { name: "codex-mcp-client", title: CLIENT_NAME, version: "0.160.1" };
const PENDING_MS = 10 * 60_000;
const SKEW_MS = 30_000;
interface Pending {
  state: string;
  verifier: string;
  expiresAt: number;
  redirectUri: string;
  metadata: Metadata;
}
interface Registration {
  client_id: string;
  client_secret: string;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
}
interface Bundle {
  version: 1;
  binding: string;
  registration?: Registration;
  tokens?: OAuthTokens;
  expiresAt?: number;
  pending?: Pending;
}

/** Only bounded, redacted protocol messages are exposed; raw bodies/data never are. */
export class RemoteError extends Error {
  readonly reason: string;
  readonly code?: number;
  constructor(reason: string, message: string, code?: number) { super(message); this.code = code; this.reason = reason; this.name = "RemoteError"; }
}
const failure = (reason: string, message: string) => new RemoteError(reason, message);
function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function configBinding(config: OfficialConfig): string {
  return createHash("sha256").update(JSON.stringify([config.clientId, config.clientSecret, config.redirectUri, ...(config.clientId.trim() ? [] : [CLIENT_NAME])])).digest("hex");
}
function checkedMetadata(value: unknown): Metadata {
  const parsed = OAuthMetadataSchema.safeParse(value);
  if (!parsed.success || parsed.data.issuer !== ISSUER || parsed.data.authorization_endpoint !== AUTHORIZATION ||
      parsed.data.token_endpoint !== TOKEN || !parsed.data.code_challenge_methods_supported?.includes("S256") ||
      !parsed.data.token_endpoint_auth_methods_supported?.some(x => x === "client_secret_basic" || x === "client_secret_post")) {
    throw failure("discovery", "Figma OAuth metadata is incompatible. Check the official connection settings.");
  }
  return parsed.data;
}
function checkedRegistration(value: unknown): Registration {
  const r = value as Registration | null;
  if (!r || typeof r.client_id !== "string" || !r.client_id.trim() || r.client_id.length > 4096 ||
      typeof r.client_secret !== "string" || !r.client_secret.trim() || r.client_secret.length > 16384 ||
      (r.client_secret_expires_at !== undefined && (!Number.isSafeInteger(r.client_secret_expires_at) || r.client_secret_expires_at < 0)) ||
      (r.token_endpoint_auth_method !== undefined && !["none", "client_secret_basic", "client_secret_post"].includes(r.token_endpoint_auth_method))) {
    throw failure("registration", "Figma returned incompatible client registration credentials. Disconnect and use your own preregistered client credentials.");
  }
  return { client_id: r.client_id, client_secret: r.client_secret,
    ...(r.client_secret_expires_at !== undefined ? { client_secret_expires_at: r.client_secret_expires_at } : {}),
    ...(r.token_endpoint_auth_method !== undefined ? { token_endpoint_auth_method: r.token_endpoint_auth_method } : {}) };
}
function decodeBundle(raw: JsonObject | null, binding: string): Bundle {
  if (raw === null) return { version: 1, binding };
  if (raw.version !== 1 || typeof raw.binding !== "string" || !/^[a-f0-9]{64}$/.test(raw.binding)) {
    throw failure("storage", "Saved Figma authorization is invalid. Disconnect and reconnect in settings.");
  }
  if (raw.binding !== binding) return { version: 1, binding };
  try {
    if (raw.version !== 1) throw new Error();
    const bundle: Bundle = { version: 1, binding };
    if (raw.registration !== undefined) bundle.registration = checkedRegistration(raw.registration);
    if (raw.tokens !== undefined) {
      bundle.tokens = OAuthTokensSchema.parse(raw.tokens);
      if ((raw.tokens as JsonObject).issuer !== ISSUER || typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) throw new Error();
      // The SDK schema may retain issuer as an extension; enforce and keep it.
      bundle.tokens = { ...bundle.tokens, issuer: ISSUER };
      bundle.expiresAt = raw.expiresAt;
    }
    if (raw.pending !== undefined) {
      const p = raw.pending as JsonObject;
      if (!p || typeof p.state !== "string" || !p.state || typeof p.verifier !== "string" || !p.verifier ||
          typeof p.redirectUri !== "string" || typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt)) throw new Error();
      bundle.pending = { state: p.state, verifier: p.verifier, redirectUri: p.redirectUri,
        expiresAt: p.expiresAt, metadata: checkedMetadata(p.metadata) };
    }
    return bundle;
  } catch { throw failure("storage", "Saved Figma authorization is invalid. Disconnect and reconnect in settings."); }
}
function sanitized(error: unknown, phase: string): RemoteError {
  if (error instanceof RemoteError) return error;
  const code = error && typeof error === "object" && "errorCode" in error ? String(error.errorCode) : "";
  const allowed = ["invalid_client", "unauthorized_client", "invalid_grant", "access_denied", "invalid_scope", "invalid_client_metadata"];
  if (allowed.includes(code)) return failure(code, `Figma ${phase} failed (${code}). Check the connection status in Figma settings.`);
  return failure(phase, `Figma ${phase} failed. Check the connection and reconnect in settings.`);
}

/** Read at most 4 KiB of an OAuth failure, retaining only its recognized code. */
async function boundedOAuthCode(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return "";
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value?.error === "string" ? value.error : "";
  } finally { void reader.cancel().catch(() => undefined); }
}

export function createRemoteManager(options: RemoteOptions): RemoteManager {
  let generation = 0, closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let connection: McpPeer | undefined;
  let connectionToken: string | undefined;
  let borrowed: { peer: McpPeer; connection: McpPeer; epoch: number } | undefined;
  const active = new Map<McpPeer, number>();
  const retired = new Set<McpPeer>();
  const closing = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const catalogListeners = new Set<() => void>();
  const knownSecrets = new Set<string>();
  const rejectedTokens = new Set<string>();
  const remember = (...values: (string | undefined)[]) => {
    for (const value of values) if (value) {
      knownSecrets.add(value); knownSecrets.add(encodeURIComponent(value));
    }
  };
  const redact = (message: string) => {
    let result = message;
    for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join("[redacted]");
    return result.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1024);
  };
  let current: ConnectionStatus = { phase: "disconnected", detail: null, connectedAt: null, serverVersion: null };
  const setStatus = (phase: ConnectionStatus["phase"], detail: string | null = null) => {
    current = { phase, detail, connectedAt: phase === "connected" ? Date.now() : null,
      serverVersion: phase === "connected" ? connection?.info().serverInfo?.version ?? null : null };
    try { options.onChange?.(); } catch { /* A UI listener cannot compromise lifecycle. */ }
  };
  const check = (epoch: number) => {
    if (closed || epoch !== generation) throw failure("disconnected", "Figma connection was disconnected.");
  };
  const serialize = <T>(epoch: number, action: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => { check(epoch); return action(); });
    tail = result.catch(() => undefined);
    return result;
  };
  const fetchFor = (epoch: number, registration = false): typeof fetch => async (input, init) => {
    check(epoch);
    const controller = new AbortController(); controllers.add(controller);
    // OAuth discovery follows server-provided URLs. Keep secrets and requests on
    // the fixed official origins even if remote metadata were compromised.
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["https://mcp.figma.com", ISSUER].includes(url.origin) || url.username || url.password) {
      controllers.delete(controller); throw failure("endpoint", "Unexpected Figma connection endpoint.");
    }
    if (url.pathname.includes("/register") && !(registration && url.href === REGISTRATION && init?.method === "POST")) {
      controllers.delete(controller); throw failure("registration", "Unexpected Figma client registration request.");
    }
    try {
      let method = "";
      if (url.href === ENDPOINT && typeof init?.body === "string") {
        try { method = JSON.parse(init.body).method ?? ""; } catch { /* SDK validates framing. */ }
      }
      const signals = [controller.signal, AbortSignal.timeout(requestTimeoutMs(method))];
      const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (upstream) signals.push(upstream);
      const response = await (options.fetch ?? fetch)(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
      check(epoch);
      if (!response.ok && (url.href === REGISTRATION || url.href === TOKEN)) {
        if (url.href === REGISTRATION) {
          let code = "";
          try { code = await boundedOAuthCode(response); } catch { /* Never expose an upstream body. */ }
          if (code === "invalid_redirect_uri") throw failure("registration", `Figma client registration failed (HTTP ${response.status}, invalid_redirect_uri). Use the native loopback callback URL for automatic registration.`);
          throw failure("registration", response.status === 403
            ? "Figma rejected Codex-compatible client registration (HTTP 403). The response does not identify the rejected field. Check the callback URL or use preregistered client credentials."
            : `Figma client registration failed (HTTP ${response.status}). Check the callback URL or use preregistered client credentials.`);
        }
        // Keep recognized OAuth error codes while discarding descriptions and bodies.
        let code = "";
        try { code = await boundedOAuthCode(response); } catch { /* Non-JSON or oversized failure. */ }
        const safe = sanitized({ errorCode: code }, "token request");
        throw failure(safe.reason, `${safe.message} (HTTP ${response.status}).`);
      }
      return response;
    } finally { controllers.delete(controller); }
  };
  const readConfig = async (epoch: number): Promise<OfficialConfig> => {
    const config = await options.config(); check(epoch);
    remember(config.clientSecret, Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64"),
      Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64"));
    if (!!config.clientId?.trim() !== !!config.clientSecret?.trim()) {
      const detail = "Configure both the Figma client ID and secret, or clear both to use automatic registration.";
      setStatus("unconfigured", detail);
      throw failure("unconfigured", detail);
    }
    try {
      const url = new URL(config.redirectUri);
      if (url.username || url.password || url.hash || url.search ||
          (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error();
    } catch { throw failure("redirect", "Configure a valid HTTPS or loopback OAuth callback URI."); }
    return config;
  };
  const persist = async (epoch: number, bundle: Bundle) => {
    check(epoch);
    if (configBinding(await readConfig(epoch)) !== bundle.binding) throw failure("configuration", "Figma client settings changed. Start Connect again.");
    await options.store.write(bundle as unknown as JsonObject); check(epoch);
  };
  const invalidateCatalog = () => {
    borrowed = undefined;
    for (const listener of catalogListeners) { try { listener(); } catch { /* Isolate subscribers. */ } }
    catalogListeners.clear();
  };
  const closePeer = (peer: McpPeer) => {
    const promise = peer.close().catch(() => undefined);
    closing.add(promise);
    void promise.finally(() => closing.delete(promise));
    return promise;
  };
  const disposeConnection = async (drain = false) => {
    if (connection) invalidateCatalog();
    const previous = connection; connection = undefined; connectionToken = undefined;
    if (previous && drain && (active.get(previous) ?? 0) > 0) retired.add(previous);
    else if (previous) await closePeer(previous);
  };
  const discover = async (epoch: number) => {
    const found = await discoverOAuthServerInfo(ENDPOINT, {
      resourceMetadataUrl: new URL("https://mcp.figma.com/.well-known/oauth-protected-resource"), fetchFn: fetchFor(epoch),
    });
    if (found.authorizationServerUrl !== ISSUER || found.resourceMetadata?.resource !== ENDPOINT ||
        !found.resourceMetadata.scopes_supported?.includes("mcp:connect")) {
      throw failure("discovery", "Figma OAuth resource metadata is incompatible.");
    }
    return checkedMetadata(found.authorizationServerMetadata);
  };
  const rememberBundle = (bundle: Bundle) => {
    const r = bundle.registration;
    remember(r?.client_id, r?.client_secret, r ? Buffer.from(`${encodeURIComponent(r.client_id)}:${encodeURIComponent(r.client_secret)}`).toString("base64") : undefined,
      r ? Buffer.from(`${r.client_id}:${r.client_secret}`).toString("base64") : undefined,
      bundle.tokens?.access_token, bundle.tokens?.refresh_token, bundle.pending?.state, bundle.pending?.verifier);
  };
  const clientInformation = (config: OfficialConfig, bundle: Bundle) => {
    if (config.clientId.trim() && config.clientSecret.trim()) return { client_id: config.clientId, client_secret: config.clientSecret, issuer: ISSUER };
    const r = bundle.registration;
    if (!r) throw failure("authorization_required", "Connect Figma from settings to authorize this deployment.");
    if (r.client_secret_expires_at && r.client_secret_expires_at * 1000 <= Date.now()) {
      throw failure("registration_expired", "Saved Figma client credentials expired. Disconnect and reconnect, or supply your own preregistered client credentials.");
    }
    return { ...r, token_endpoint_auth_method: "client_secret_basic" as const, issuer: ISSUER };
  };
  const saveTokens = async (epoch: number, bundle: Bundle, tokens: OAuthTokens) => {
    // Tokens with no expiry cannot be refreshed predictably. Reject explicitly.
    if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.access_token || !tokens.expires_in ||
        !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      throw failure("tokens", "Figma returned incompatible OAuth tokens. Reconnect in settings.");
    }
    remember(tokens.access_token, tokens.refresh_token);
    bundle.tokens = { ...tokens, issuer: ISSUER };
    bundle.expiresAt = Date.now() + tokens.expires_in * 1000;
    await persist(epoch, bundle);
  };
  const ensure = async (epoch: number): Promise<McpPeer> => {
    check(epoch);
    const config = await readConfig(epoch); check(epoch);
    const bundle = decodeBundle(await options.store.read(), configBinding(config)); check(epoch);
    rememberBundle(bundle);
    if (!bundle.tokens) {
      setStatus(bundle.pending && bundle.pending.expiresAt > Date.now() ? "authorizing" : "disconnected",
        "Connect Figma from settings to authorize this deployment.");
      throw failure("authorization_required", "Connect Figma from settings to authorize this deployment.");
    }
    if (rejectedTokens.has(bundle.tokens.access_token) || (bundle.expiresAt ?? 0) <= Date.now() + SKEW_MS) {
      if (!bundle.tokens.refresh_token) throw failure("authorization_required", "Figma authorization expired. Reconnect in settings.");
      const metadata = await discover(epoch);
      let tokens: OAuthTokens;
      try {
        tokens = await refreshAuthorization(ISSUER, { metadata, clientInformation: clientInformation(config, bundle),
          refreshToken: bundle.tokens.refresh_token, resource: ENDPOINT, fetchFn: fetchFor(epoch) });
      } catch (error) {
        if (error instanceof RemoteError && error.reason === "invalid_grant") {
          // A rejected refresh grant cannot recover through repeated agent calls.
          // Preserve registration/pending consent and retire only the dead grant.
          delete bundle.tokens; delete bundle.expiresAt; await persist(epoch, bundle);
          invalidateCatalog();
          setStatus(bundle.pending && bundle.pending.expiresAt > Date.now() ? "authorizing" : "disconnected", "Figma authorization expired or was revoked. Connect Figma again; agent calls will not retry this rejected grant.");
          throw failure("authorization_required", "Figma authorization expired or was revoked. Connect Figma again.");
        }
        throw error;
      }
      await saveTokens(epoch, bundle, tokens);
    }
    check(epoch);
    const token = bundle.tokens!.access_token;
    if (connection && connectionToken === token) return connection;
    // Renewal retires the old catalog immediately, but existing requests retain
    // their transport until they settle under their own bounded deadlines.
    await disposeConnection(true); check(epoch); setStatus("connecting");
    const client = new Client(CLIENT_INFO, { capabilities: {}, enforceStrictCapabilities: true });
    const peer = sdkPeer(client);
    peer.onCatalogChanged?.(() => {
      if (closed || epoch !== generation) return;
      for (const listener of catalogListeners) { try { listener(); } catch { /* Isolate subscribers. */ } }
    });
    // Deliberately omit authProvider: the HTTP transport must never replay an
    // ambiguously dispatched write on 401, or start OAuth during a health check.
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      fetch: fetchFor(epoch), requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport, { timeout: 60_000 }); check(epoch);
      connection = peer; connectionToken = token; setStatus("connected"); return peer;
    } catch (error) {
      await peer.close().catch(() => undefined);
      if (error instanceof StreamableHTTPError && error.code === 401) {
        rejectedTokens.add(token); bundle.expiresAt = 0; await persist(epoch, bundle);
      }
      throw error;
    }
  };
  const guarded = async <T>(epoch: number, phase: string, action: () => Promise<T>) => {
    try { return await action(); }
    catch (error) {
      const safe = sanitized(error, phase);
      if (!closed && epoch === generation && safe.reason !== "unconfigured" && safe.reason !== "authorization_required") setStatus("error", safe.message);
      throw safe;
    }
  };
  return {
    async restoreStatus() {
      const epoch = generation;
      await guarded(epoch, "saved authorization", () => serialize(epoch, async () => {
        const config = await readConfig(epoch);
        const bundle = decodeBundle(await options.store.read(), configBinding(config)); check(epoch);
        rememberBundle(bundle);
        if (bundle.pending && bundle.pending.expiresAt > Date.now()) setStatus("authorizing", "A saved Figma sign-in is pending. Paste its callback URL or start Connect again.");
        else if (bundle.tokens) setStatus("disconnected", "Saved Figma authorization is available. Test Figma or an agent call resumes it without a new sign-in.");
        else setStatus("disconnected", bundle.pending ? "The saved Figma sign-in expired. Start Connect again." : null);
      }));
    },
    status: () => ({ ...current }),
    async peer(signal) {
      const epoch = generation;
      if (signal?.aborted) throw failure("cancelled", "Figma request was cancelled.");
      const initial = await guarded(epoch, "connection", () => serialize(epoch, () => ensure(epoch)));
      if (signal?.aborted) throw failure("cancelled", "Figma request was cancelled.");
      if (borrowed?.connection === initial && borrowed.epoch === epoch) return borrowed.peer;
      let leaseClosed = false;
      const subscriptions = new Set<() => void>();
      const checkLease = () => {
        check(epoch);
        if (leaseClosed) throw failure("closed", "Figma peer was closed.");
        if (connection !== initial) throw failure("transport_changed", "Figma transport changed. Rediscover its catalog before calling again.");
      };
      const peer: McpPeer = {
        info: () => initial.info(),
        onCatalogChanged(listener) {
          checkLease(); catalogListeners.add(listener);
          const dispose = () => { catalogListeners.delete(listener); subscriptions.delete(dispose); };
          subscriptions.add(dispose); return dispose;
        },
        close: async () => {
          // Borrowed peers have stable identity. Closing one invalidates that
          // identity; the manager continues to own the shared HTTP transport.
          if (leaseClosed) return;
          leaseClosed = true;
          if (borrowed?.peer === peer) invalidateCatalog();
          for (const dispose of subscriptions) dispose();
        },
        async request(method, params, requestSignal) {
          checkLease();
          // Acquisition signals do not become permanent signals on cached peers.
          if (requestSignal?.aborted) throw failure("cancelled", "Figma request was cancelled.");
          const live = await guarded(epoch, "connection", () => serialize(epoch, () => ensure(epoch)));
          // Renewal invalidates the old catalog before any dispatch. The bridge
          // must acquire the new identity and rediscover/validate its descriptors.
          checkLease();
          const dispatchedToken = connectionToken;
          let result: JsonObject;
          active.set(live, (active.get(live) ?? 0) + 1);
          try { result = await live.request(method, params, requestSignal); }
          catch (error) {
            // A JSON-RPC error is an upstream response, not a failed connection.
            // Preserve its bounded actionable message, never raw data/credentials.
            if (error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed) {
              // Internal/custom server failures can occur after a tool ran. Only
              // JSON-RPC's framing/method/argument errors establish rejection.
              if (method === "tools/call" && ![ErrorCode.InvalidRequest, ErrorCode.MethodNotFound, ErrorCode.InvalidParams].includes(error.code)) {
                throw new RemoteError("outcome_unknown", `Figma tool outcome is unknown (JSON-RPC ${error.code}). Inspect the canvas before retrying. This call was not replayed. ${redact(error.message)}`, error.code);
              }
              throw new RemoteError("protocol", redact(error.message), error.code);
            }
            if (error instanceof Error && /^(Server does not support|The MCP server does not advertise)/.test(error.message)) {
              throw new RemoteError("capability", redact(error.message));
            }
            const safe = method === "tools/call"
              ? failure("outcome_unknown", "Figma tool outcome is unknown. Inspect the canvas before retrying. The transport request failed; this call was not replayed.")
              : sanitized(error, "MCP request");
            if (!closed && epoch === generation) {
              const unauthorized = error instanceof StreamableHTTPError && error.code === 401;
              const sessionFailed = unauthorized || (error instanceof StreamableHTTPError && error.code === 404) ||
                (error instanceof McpError && error.code === ErrorCode.ConnectionClosed);
              // Caller cancellation is ambiguous after dispatch, but is not
              // evidence that the shared authenticated transport is unhealthy.
              const cancelled = requestSignal?.aborted && !(error instanceof StreamableHTTPError);
              if (!cancelled) {
                if (unauthorized && dispatchedToken) rejectedTokens.add(dispatchedToken);
                // Request-local timeout/POST failure must not close other active
                // calls. Only an invalid session/closed connection is disposed.
                // Recovery happens on NEXT acquisition; never replay this call.
                if (sessionFailed) await serialize(epoch, async () => {
                  if (unauthorized && dispatchedToken) {
                    const config = await readConfig(epoch);
                    const saved = decodeBundle(await options.store.read(), configBinding(config));
                    if (saved.tokens?.access_token === dispatchedToken) { saved.expiresAt = 0; await persist(epoch, saved); }
                  }
                  if (connection === live) await disposeConnection();
                }).catch(() => undefined);
                if (!closed && epoch === generation) setStatus("error", safe.message);
              }
            }
            throw safe;
          } finally {
            const remaining = (active.get(live) ?? 1) - 1;
            if (remaining) active.set(live, remaining);
            else {
              active.delete(live);
              if (retired.delete(live)) void closePeer(live);
            }
          }
          // Once received, an upstream result remains authoritative even if a
          // borrowed lease was closed or replaced while the request ran.
          if (!closed && epoch === generation && connection === live && current.phase === "error") setStatus("connected");
          return result;
        },
      };
      borrowed = { peer, connection: initial, epoch };
      return peer;
    },
    async beginAuth() {
      const epoch = generation;
      return guarded(epoch, "authorization", () => serialize(epoch, async () => {
        const config = await readConfig(epoch); check(epoch);
        const bundle = decodeBundle(await options.store.read(), configBinding(config)); check(epoch);
        rememberBundle(bundle);
        const metadata = await discover(epoch);
        if (!config.clientId.trim() && !bundle.registration) {
          if (metadata.registration_endpoint !== REGISTRATION) throw failure("registration", "Figma client registration endpoint is incompatible.");
          const issued = await registerClient(ISSUER, { metadata, clientMetadata: {
            client_name: CLIENT_NAME, redirect_uris: [config.redirectUri],
            grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
          }, scope: "mcp:connect", fetchFn: fetchFor(epoch, true) }).catch(error => {
            if (error instanceof RemoteError) throw error;
            throw failure("registration", sanitized(error, "client registration").message);
          });
          check(epoch);
          bundle.registration = checkedRegistration(issued); rememberBundle(bundle);
          clientInformation(config, bundle); // Reject expired issued credentials before persistence.
          await persist(epoch, bundle);
        }
        const state = randomBytes(32).toString("base64url");
        remember(state);
        const started = await startAuthorization(ISSUER, { metadata, clientInformation: clientInformation(config, bundle),
          redirectUrl: config.redirectUri, scope: "mcp:connect", state, resource: ENDPOINT });
        remember(started.codeVerifier);
        bundle.pending = {
          state, verifier: started.codeVerifier, redirectUri: config.redirectUri, expiresAt: Date.now() + PENDING_MS, metadata,
        };
        await persist(epoch, bundle); setStatus("authorizing");
        return { authorizationUrl: started.authorizationUrl.toString() };
      }));
    },
    async finishAuth(input) {
      const epoch = generation;
      remember(input.code, input.state);
      await guarded(epoch, "token exchange", () => serialize(epoch, async () => {
        const config = await readConfig(epoch); check(epoch);
        const bundle = decodeBundle(await options.store.read(), configBinding(config)); check(epoch);
        rememberBundle(bundle);
        const pending = bundle.pending;
        if (!pending || !equalSecret(pending.state, input.state ?? "")) throw failure("state", "Figma authorization state is invalid or already used.");
        // Consume durably before any exchange, including denial and expired flow.
        delete bundle.pending; await persist(epoch, bundle);
        try {
          if (pending.expiresAt <= Date.now()) throw failure("expired", "Figma authorization expired.");
          if (pending.redirectUri !== config.redirectUri ||
              (input.issuer !== undefined && input.issuer !== ISSUER) ||
              (pending.metadata.authorization_response_iss_parameter_supported === true && input.issuer !== ISSUER)) {
            throw failure("issuer", "Figma authorization issuer or callback does not match.");
          }
          if (!input.code) throw failure("denied", "Figma authorization was denied or cancelled.");
          const tokens = await exchangeAuthorization(ISSUER, { metadata: pending.metadata,
            clientInformation: clientInformation(config, bundle), authorizationCode: input.code, codeVerifier: pending.verifier,
            redirectUri: pending.redirectUri, resource: ENDPOINT, fetchFn: fetchFor(epoch) });
          await saveTokens(epoch, bundle, tokens);
          try { await ensure(epoch); }
          catch { check(epoch); throw failure("authorization_saved", "Figma authorization was saved, but the MCP connection could not open. Use Test Figma to resume; do not paste this callback again."); }
        } catch (error) {
          const safe = sanitized(error, "token exchange");
          if (safe.reason === "authorization_saved") throw safe;
          throw failure(safe.reason, `${safe.message} This callback has been consumed. Start Connect Figma again for a new sign-in.`);
        }
      }));
    },
    async disconnect() {
      // Fence and abort synchronously; queued clearing follows all older writes.
      generation++;
      catalogListeners.clear();
      for (const controller of controllers) controller.abort();
      const closing = disposeConnection(); setStatus("disconnected");
      const retiredClosing = [...retired].map(closePeer); retired.clear();
      const result = tail.then(async () => { await options.store.write(null); });
      tail = result.catch(() => undefined);
      await Promise.all([closing, result, ...retiredClosing]);
    },
    async close() {
      closed = true; generation++;
      catalogListeners.clear();
      for (const controller of controllers) controller.abort();
      await disposeConnection();
      await Promise.allSettled([...retired].map(closePeer)); retired.clear();
      await tail; await Promise.allSettled([...closing]);
      setStatus("disconnected");
      // Shutdown preserves durable tokens and pending consent for restart.
    },
  };
}
