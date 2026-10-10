import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRemoteManager, RemoteError } from "../mcp/remote.ts";
import type { JsonObject, OfficialConfig, SecretStore } from "../contract.ts";

const issuer = "https://api.figma.com", endpoint = "https://mcp.figma.com/mcp";
const config: OfficialConfig = { clientId: "bb-fixture-client", clientSecret: "fixture-client-secret", redirectUri: "https://bb.example/figma/callback" };
const metadata = {
  issuer, authorization_endpoint: "https://www.figma.com/oauth/mcp", token_endpoint: `${issuer}/v1/oauth/token`,
  registration_endpoint: `${issuer}/v1/oauth/mcp/register`, response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  scopes_supported: ["mcp:connect"], require_state_parameter: true, authorization_response_iss_parameter_supported: true,
};
function memoryStore(): SecretStore & { value: JsonObject | null } {
  return { value: null, async read() { return structuredClone(this.value); }, async write(value) { this.value = structuredClone(value); } };
}
function fixture(initialConfig = config) {
  let currentConfig = initialConfig;
  let registrationHook: (() => Promise<Response>) | undefined;
  let discoveryMetadata = metadata;
  const store = memoryStore();
  const requests: { url: string; method: string; headers: Headers; body?: JsonObject | URLSearchParams }[] = [];
  let tokenHook: (() => Promise<Response>) | undefined;
  let rpcHook: ((body: JsonObject) => Promise<Response | undefined>) | undefined;
  let capabilities: JsonObject = { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true }, completions: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    let body: JsonObject | URLSearchParams | undefined;
    if (init?.body instanceof URLSearchParams) body = new URLSearchParams(init.body);
    if (typeof init?.body === "string") body = headers.get("content-type")?.includes("application/json") ? JSON.parse(init.body) : new URLSearchParams(init.body);
    requests.push({ url, method, headers, body });
    if (url === metadata.registration_endpoint) return registrationHook ? registrationHook() : json({
      client_id: "bb-issued-client", client_secret: "fixture-issued-secret", client_secret_expires_at: 0,
      token_endpoint_auth_method: "none", redirect_uris: [currentConfig.redirectUri],
    });
    if (url.includes("oauth-protected-resource")) return json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["mcp:connect"], bearer_methods_supported: ["header"] });
    if (url.includes("oauth-authorization-server")) return json(discoveryMetadata);
    if (url === metadata.token_endpoint) {
      if (tokenHook) return tokenHook();
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Basic ${Buffer.from(currentConfig.clientId ? `${currentConfig.clientId}:${currentConfig.clientSecret}` : "bb-issued-client:fixture-issued-secret").toString("base64")}`);
      return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(url, endpoint);
    if (method !== "POST") return json({ error: "method" }, 405);
    assert.ok(headers.get("authorization")?.startsWith("Bearer fixture-"));
    const rpc = body as JsonObject;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const custom = await rpcHook?.(rpc); if (custom) return custom;
    const result = rpc.method === "initialize" ? { protocolVersion: (rpc.params as JsonObject).protocolVersion,
      capabilities, serverInfo: { name: "Figma fixture", version: "fixture-1" }, instructions: "Fixture upstream instructions" } :
      { method: rpc.method, params: rpc.params, extension: { retained: true } };
    return json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  const manager = () => createRemoteManager({ store, config: async () => currentConfig, fetch: fakeFetch });
  return { store, requests, fakeFetch, manager, json,
    setConfig(value: OfficialConfig) { currentConfig = value; },
    setMetadata(value: typeof metadata) { discoveryMetadata = value; },
    setRegistrationHook(value: typeof registrationHook) { registrationHook = value; },
    setTokenHook(value: typeof tokenHook) { tokenHook = value; },
    setRpcHook(value: typeof rpcHook) { rpcHook = value; }, setCapabilities(value: JsonObject) { capabilities = value; } };
}
async function authenticate(f: ReturnType<typeof fixture>, m = f.manager()) {
  const url = new URL((await m.beginAuth()).authorizationUrl);
  await m.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer }); return m;
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}

test("missing configuration and authorization never start OAuth or DCR during health", async () => {
  const f = fixture(), m = f.manager();
  await assert.rejects(m.peer(), /Connect Figma|Authorize Figma/);
  assert.equal(f.requests.length, 0); assert.equal(m.status().phase, "disconnected"); await m.close();
  const absent = createRemoteManager({ store: f.store, config: async () => ({ ...config, clientSecret: "" }), fetch: f.fakeFetch });
  await assert.rejects(absent.peer(), /both the Figma client/);
  assert.equal(absent.status().phase, "unconfigured"); assert.equal(f.requests.length, 0); await absent.close();
});

test("SDK OAuth PKCE survives restart, consumes state once and uses own secret-bearing client", async () => {
  const f = fixture(), first = f.manager(), url = new URL((await first.beginAuth()).authorizationUrl);
  assert.equal(url.origin + url.pathname, metadata.authorization_endpoint);
  assert.equal(url.searchParams.get("client_id"), config.clientId); assert.equal(url.searchParams.get("resource"), endpoint);
  assert.equal(url.searchParams.get("scope"), "mcp:connect"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const pending = f.store.value!.pending as JsonObject;
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier as string).digest("base64url"));
  assert.ok((pending.state as string).length >= 40); await first.close();
  const next = f.manager(); await next.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer });
  assert.equal(next.status().phase, "connected"); assert.equal(next.status().serverVersion, "fixture-1");
  assert.equal(f.store.value!.pending, undefined); assert.equal((f.store.value!.tokens as JsonObject).issuer, issuer);
  const exchange = f.requests.find(x => x.url === metadata.token_endpoint)!;
  assert.equal((exchange.body as URLSearchParams).get("code_verifier"), pending.verifier);
  assert.equal((exchange.body as URLSearchParams).get("redirect_uri"), config.redirectUri);
  const initialize = f.requests.find(x => (x.body as JsonObject)?.method === "initialize")!;
  assert.deepEqual(((initialize.body as JsonObject).params as JsonObject).clientInfo,
    { name: "codex-mcp-client", title: "Codex", version: "0.160.1" });
  await assert.rejects(next.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer }), /already used/);
  assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 1); await next.close();
});

test("state, issuer, callback configuration, expiry and denial bind before exchange", async () => {
  for (const kind of ["state", "issuer", "missing-issuer", "redirect", "expiry", "denied"] as const) {
    const f = fixture(), m = f.manager(), url = new URL((await m.beginAuth()).authorizationUrl), state = url.searchParams.get("state")!;
    if (kind === "expiry") (f.store.value!.pending as JsonObject).expiresAt = Date.now() - 1;
    if (kind === "redirect") (f.store.value!.pending as JsonObject).redirectUri = "https://different.example/callback";
    await assert.rejects(m.finishAuth({ code: kind === "denied" ? "" : "fixture-code", state: kind === "state" ? "wrong" : state,
      issuer: kind === "issuer" ? "https://evil.example" : kind === "missing-issuer" ? undefined : issuer }));
    assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 0);
    if (kind !== "state") assert.equal(f.store.value!.pending, undefined); await m.close();
  }
});

test("refresh serializes concurrent calls and rotated tokens persist through restart", async () => {
  const f = fixture(), m = await authenticate(f); f.store.value!.expiresAt = Date.now() - 1;
  f.setTokenHook(async () => f.json({ access_token: "fixture-rotated", refresh_token: "fixture-rotated-refresh", token_type: "Bearer", expires_in: 3600 }));
  const peers = await Promise.all(Array.from({ length: 8 }, () => m.peer())); await Promise.all(peers.map(p => p.request("tools/list")));
  const tokens = f.requests.filter(x => x.url === metadata.token_endpoint); assert.equal(tokens.length, 2);
  assert.equal((tokens[1]!.body as URLSearchParams).get("grant_type"), "refresh_token");
  assert.equal((tokens[1]!.body as URLSearchParams).get("refresh_token"), "fixture-refresh");
  assert.equal((f.store.value!.tokens as JsonObject).refresh_token, "fixture-rotated-refresh"); await m.close();
  const next = f.manager(); await next.peer(); assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 2); await next.close();
});

test("disconnect fences late exchange, clears storage, and prevents stale peer dispatch", async () => {
  const f = fixture(), m = f.manager(), url = new URL((await m.beginAuth()).authorizationUrl);
  const entered = deferred<void>(), response = deferred<Response>(); f.setTokenHook(async () => { entered.resolve(); return response.promise; });
  const rejected = assert.rejects(m.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer }), /disconnected/);
  await entered.promise; const disconnecting = m.disconnect();
  response.resolve(f.json({ access_token: "fixture-late", refresh_token: "fixture-late-refresh", token_type: "Bearer", expires_in: 3600 }));
  await Promise.all([rejected, disconnecting]); assert.equal(f.store.value, null); assert.equal(m.status().phase, "disconnected");
  f.setTokenHook(undefined); await authenticate(f, m); const peer = await m.peer(); await m.disconnect(); const count = f.requests.length;
  await assert.rejects(peer.request("tools/call", { name: "use_figma", arguments: {} }), /disconnected/);
  assert.equal(f.requests.length, count); await m.close();
});

test("lost write responses and 401s dispatch once, with sanitized failure and no OAuth retry", async () => {
  for (const mode of ["lost", "401", "timeout"] as const) {
    const f = fixture(), m = await authenticate(f), peer = await m.peer();
    f.setRpcHook(async rpc => {
      if (rpc.method !== "tools/call") return undefined;
      if (mode === "lost") throw new Error("fixture-secret-access-token-lost");
      if (mode === "timeout") return f.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: "Request timed out" } });
      return new Response("fixture-secret-access-token-401", { status: 401 });
    });
    await assert.rejects(peer.request("tools/call", { name: "use_figma", arguments: { code: "return {}" } }), error => {
      assert.ok(error instanceof RemoteError); assert.ok(!error.message.includes("fixture-secret"));
      assert.match(error.message, /outcome is unknown/); assert.match(error.message, /Inspect the canvas before retrying/); return true;
    });
    assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "tools/call").length, 1);
    assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 1);
    assert.ok(!JSON.stringify(m.status()).includes("fixture-secret")); await m.close();
  }
});

test("generic MCP preserves mixed content, errors, extensions, resources, prompts, completion and tasks", async () => {
  const f = fixture(), m = await authenticate(f), peer = await m.peer();
  const envelope = { content: [{ type: "text", text: "before" }, { type: "image", data: "cG5n", mimeType: "image/png" },
    { type: "resource", resource: { uri: "figma://fixture", mimeType: "image/svg+xml", text: "<svg/>" } },
    { type: "resource_link", uri: "figma://skill", name: "skill", _meta: { extra: true } }],
    structuredContent: { safeToRetryWithoutCanvasRead: false }, isError: true, _meta: { fixture: [1, 2] }, custom: { intact: true } };
  f.setRpcHook(async rpc => rpc.method === "tools/call" ? f.json({ jsonrpc: "2.0", id: rpc.id, result: envelope }) : undefined);
  assert.deepEqual(await peer.request("tools/call", { name: "use_figma", arguments: {} }), envelope);
  for (const method of ["resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get", "completion/complete", "tasks/list", "tasks/get", "tasks/result", "tasks/cancel"]) {
    const params = { fixture: method, _meta: { intact: 1 } };
    assert.deepEqual(await peer.request(method, params), { method, params, extension: { retained: true } });
  }
  assert.deepEqual(await peer.request("tools/call", { name: "fixture", arguments: {}, task: { ttl: 1000 } }), envelope);
  assert.equal(peer.info().instructions, "Fixture upstream instructions"); await m.close();
});

test("unadvertised resources, prompts, completions and tasks fail before dispatch", async () => {
  const f = fixture(); f.setCapabilities({ tools: {} }); const m = await authenticate(f), peer = await m.peer(), count = f.requests.length;
  for (const method of ["resources/list", "prompts/get", "completion/complete", "tasks/list"]) await assert.rejects(peer.request(method));
  assert.equal(f.requests.length, count); await m.close();
});

test("OAuth errors expose codes without raw descriptions or secret-bearing responses", async () => {
  const f = fixture(), m = f.manager(), url = new URL((await m.beginAuth()).authorizationUrl);
  f.setTokenHook(async () => f.json({ error: "invalid_client", error_description: "fixture-client-secret fixture-private-data" }, 401));
  await assert.rejects(m.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer }), error => {
    assert.ok(error instanceof RemoteError); assert.equal(error.reason, "invalid_client"); assert.ok(!error.message.includes("fixture-")); return true;
  });
  assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 1); assert.equal(f.store.value!.pending, undefined); await m.close();
});

test("catalog notifications reach listeners, disposal unsubscribes, and close fences old peer", async () => {
  const f = fixture(), m = await authenticate(f), peer = await m.peer();
  let notifications = 0;
  const dispose = peer.onCatalogChanged!(() => { notifications++; });
  f.setRpcHook(async rpc => {
    if (rpc.method !== "tools/list") return undefined;
    const messages: JsonObject[] = ["tools", "resources", "prompts"].map(kind => ({ jsonrpc: "2.0", method: `notifications/${kind}/list_changed` }));
    messages.push({ jsonrpc: "2.0", id: rpc.id, result: { tools: [], _meta: { retained: true } } });
    return new Response(messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  assert.deepEqual(await peer.request("tools/list"), { tools: [], _meta: { retained: true } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(notifications, 3);
  dispose(); await peer.request("tools/list"); await new Promise(resolve => setImmediate(resolve)); assert.equal(notifications, 3);
  await m.close(); const count = f.requests.length;
  await assert.rejects(peer.request("tools/list"), /disconnected/); assert.equal(f.requests.length, count);
  assert.ok(f.store.value!.tokens, "close keeps tokens for restart");
});

test("disconnect wins a delayed refresh and delayed configuration response", async () => {
  const f = fixture(), m = await authenticate(f); f.store.value!.expiresAt = Date.now() - 1;
  const entered = deferred<void>(), response = deferred<Response>(); f.setTokenHook(async () => { entered.resolve(); return response.promise; });
  const rejected = assert.rejects(m.peer(), /disconnected/); await entered.promise;
  const disconnecting = m.disconnect(); response.resolve(f.json({ access_token: "fixture-late-refresh", token_type: "Bearer", expires_in: 3600 }));
  await Promise.all([rejected, disconnecting]); assert.equal(f.store.value, null); assert.equal(m.status().phase, "disconnected"); await m.close();
  const late = deferred<OfficialConfig>(), configEntered = deferred<void>();
  const other = createRemoteManager({ store: f.store, config: async () => { configEntered.resolve(); return late.promise; }, fetch: f.fakeFetch });
  const failed = assert.rejects(other.peer(), /disconnected/); await configEntered.promise;
  const disconnected = other.disconnect(); late.resolve({ ...config, clientSecret: "" });
  await Promise.all([failed, disconnected]); assert.equal(other.status().phase, "disconnected"); await other.close();
});

test("borrowed peer identity is stable and closing it forces a new acquisition", async () => {
  const f = fixture(), m = await authenticate(f), one = await m.peer(), two = await m.peer();
  assert.equal(one, two);
  let changed = 0; one.onCatalogChanged!(() => { changed++; });
  await one.close(); const count = f.requests.length;
  await assert.rejects(one.request("tools/list"), /peer was closed/); assert.equal(f.requests.length, count);
  await assert.rejects(two.request("tools/list"), /peer was closed/);
  const next = await m.peer(); assert.notEqual(next, one);
  assert.equal((await next.request("tools/list")).method, "tools/list");
  assert.equal(changed, 1); assert.equal(m.status().phase, "connected"); await m.close();
});

test("cancelled calls reject without dispatch and abort in-flight SDK requests", async () => {
  const f = fixture(), m = await authenticate(f), peer = await m.peer(), initial = f.requests.length;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(peer.request("tools/list", {}, cancelled.signal), /cancelled/); assert.equal(f.requests.length, initial);
  const entered = deferred<void>(), response = deferred<Response>();
  f.setRpcHook(async rpc => { if (rpc.method === "tools/call") { entered.resolve(); return response.promise; } return undefined; });
  const controller = new AbortController();
  const rejected = assert.rejects(peer.request("tools/call", { name: "use_figma", arguments: {} }, controller.signal));
  await entered.promise; controller.abort(); await rejected;
  response.resolve(f.json({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
  assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "tools/call").length, 1); await m.close();
});

test("config rotation cannot use saved pending state or tokens for another client", async () => {
  const f = fixture(), m = await authenticate(f); await m.close();
  const other = createRemoteManager({ store: f.store, config: async () => ({ ...config, clientSecret: "rotated-own-secret" }), fetch: f.fakeFetch });
  const count = f.requests.length; await assert.rejects(other.peer(), /Connect Figma|Authorize Figma/);
  assert.equal(f.requests.length, count); await other.close();
});

test("token renewal changes peer identity, invalidates catalog and rejects stale-schema dispatch", async () => {
  const f = fixture(), m = await authenticate(f), original = await m.peer();
  assert.equal(await m.peer(), original); assert.equal(await m.peer(), original);
  let invalidations = 0; original.onCatalogChanged!(() => { invalidations++; });
  f.store.value!.expiresAt = Date.now() - 1;
  // Omission of refresh_token must preserve the old one through the SDK helper.
  f.setTokenHook(async () => f.json({ access_token: "fixture-renewed", token_type: "Bearer", expires_in: 3600 }));
  await assert.rejects(original.request("tools/call", { name: "use_figma", arguments: {} }), /transport changed.*Rediscover/);
  assert.equal(invalidations, 1);
  assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "tools/call").length, 0);
  assert.equal((f.store.value!.tokens as JsonObject).refresh_token, "fixture-refresh");
  const renewed = await m.peer(); assert.notEqual(renewed, original); assert.equal(await m.peer(), renewed);
  assert.equal((await renewed.request("tools/list")).method, "tools/list");
  await assert.rejects(original.request("tools/list"), /transport changed/);
  await m.close();
  const restarted = f.manager(); await restarted.peer();
  assert.equal((f.store.value!.tokens as JsonObject).refresh_token, "fixture-refresh"); await restarted.close();
});

test("one acquisition's cancelled signal does not poison the stable peer for later calls", async () => {
  const f = fixture(), m = await authenticate(f), controller = new AbortController();
  const peer = await m.peer(controller.signal); controller.abort();
  assert.equal(await m.peer(), peer); assert.equal((await peer.request("tools/list")).method, "tools/list"); await m.close();
});

test("JSON-RPC validation errors retain bounded actionable code/message, redact credentials, and keep connection healthy", async () => {
  const f = fixture(), m = await authenticate(f), peer = await m.peer();
  f.setRpcHook(async rpc => rpc.method !== "tools/call" ? undefined : f.json({ jsonrpc: "2.0", id: rpc.id,
    error: { code: -32602, message: `Invalid nodeId: use 12:34. ${config.clientSecret} fixture-access fixture-refresh ${encodeURIComponent(config.clientSecret)} ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")} Bearer unknown-private-token ${"x".repeat(3000)}`,
      data: { secret: config.clientSecret } } }));
  await assert.rejects(peer.request("tools/call", { name: "use_figma", arguments: { nodeId: "bad" } }), error => {
    assert.ok(error instanceof RemoteError); assert.equal(error.reason, "protocol"); assert.equal(error.code, -32602);
    assert.match(error.message, /Invalid nodeId: use 12:34/); assert.ok(error.message.length <= 1024);
    for (const secret of [config.clientSecret, "fixture-access", "fixture-refresh", "unknown-private-token"]) assert.ok(!error.message.includes(secret));
    assert.ok(error.message.includes("[redacted]")); return true;
  });
  assert.equal(m.status().phase, "connected"); assert.equal(await m.peer(), peer);
  assert.equal((await peer.request("tools/list")).method, "tools/list");
  assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 1); await m.close();
});

test("401 expires rejected credentials durably; next acquisition refreshes without replaying the failed tool", async () => {
  const f = fixture(), m = await authenticate(f), peer = await m.peer();
  let invalidations = 0; peer.onCatalogChanged!(() => { invalidations++; });
  f.setRpcHook(async rpc => rpc.method === "tools/call" ? new Response("fixture-access", { status: 401 }) : undefined);
  await assert.rejects(peer.request("tools/call", { name: "use_figma", arguments: {} }), /outcome is unknown.*Inspect the canvas/);
  assert.equal(m.status().phase, "error"); assert.equal(f.store.value!.expiresAt, 0); assert.equal(invalidations, 1);
  assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 1);
  assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "tools/call").length, 1);
  await m.close();
  f.setTokenHook(async () => f.json({ access_token: "fixture-after-401", token_type: "Bearer", expires_in: 3600 }));
  const next = f.manager(), healthy = await next.peer();
  assert.equal(next.status().phase, "connected"); assert.notEqual(healthy, peer);
  assert.equal(f.requests.filter(x => x.url === metadata.token_endpoint).length, 2);
  assert.equal((f.store.value!.tokens as JsonObject).refresh_token, "fixture-refresh");
  assert.equal((await healthy.request("tools/list")).method, "tools/list");
  assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "tools/call").length, 1); await next.close();
});

test("SDK tools/call timeout and fetch deadline both allow 180 seconds; reads allow 60", async t => {
  const f = fixture(), m = await authenticate(f), peer = await m.peer();
  const deadlines: number[] = [], sdkTimeouts: { method: string; timeout: number | undefined }[] = [];
  const originalTimeout = AbortSignal.timeout, originalRequest = Client.prototype.request;
  t.mock.method(AbortSignal, "timeout", (delay: number) => { deadlines.push(delay); return originalTimeout(delay); });
  t.mock.method(Client.prototype, "request", function(this: Client, request: { method: string }, schema: unknown, opts: { timeout?: number }) {
    sdkTimeouts.push({ method: request.method, timeout: opts.timeout });
    return Reflect.apply(originalRequest, this, [request, schema, opts]);
  });
  await peer.request("tools/call", { name: "use_figma", arguments: {} });
  assert.equal(deadlines.at(-1), 180_000); assert.deepEqual(sdkTimeouts.at(-1), { method: "tools/call", timeout: 180_000 });
  await peer.request("resources/read", { uri: "figma://fixture" });
  assert.equal(deadlines.at(-1), 60_000); assert.deepEqual(sdkTimeouts.at(-1), { method: "resources/read", timeout: 60_000 }); await m.close();
});

test("one timed-out or failed POST keeps concurrent writes alive and neither caller replays", async t => {
  for (const mode of ["timeout", "fetch-failure"] as const) {
    const f = fixture(), m = await authenticate(f), peer = await m.peer();
    const aStarted = deferred<void>(), bStarted = deferred<void>();
    const originalRequest = Client.prototype.request;
    const timeoutMock = t.mock.method(Client.prototype, "request", function(this: Client, request: { method: string; params?: JsonObject }, schema: unknown, opts: { timeout?: number }) {
      const next = mode === "timeout" && request.params?.name === "write_A" ? { ...opts, timeout: 20 } : opts;
      return Reflect.apply(originalRequest, this, [request, schema, next]);
    });
    const releaseA = deferred<void>(), releaseB = deferred<void>();
    const expectedB = { content: [{ type: "text", text: "B committed" }], structuredContent: { createdNodeIds: ["12:34"] }, isError: false };
    f.setRpcHook(async rpc => {
      if (rpc.method !== "tools/call") return undefined;
      const name = (rpc.params as JsonObject).name;
      if (name === "write_A") {
        aStarted.resolve(); await releaseA.promise;
        if (mode === "fetch-failure") throw new TypeError("single POST fetch failed");
        return f.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [] } });
      }
      if (name === "write_B") {
        bStarted.resolve(); await releaseB.promise;
        return f.json({ jsonrpc: "2.0", id: rpc.id, result: expectedB });
      }
      return undefined;
    });
    const a = assert.rejects(peer.request("tools/call", { name: "write_A", arguments: {} }), /outcome is unknown.*Inspect the canvas/);
    const b = peer.request("tools/call", { name: "write_B", arguments: {} });
    await Promise.all([aStarted.promise, bStarted.promise]);
    if (mode === "fetch-failure") releaseA.resolve();
    await a;
    // In timeout mode A is genuinely timed out by SDK while HTTP is still open.
    releaseA.resolve();
    // A failed after B was dispatched, but must not close B's shared transport.
    releaseB.resolve(); assert.deepEqual(await b, expectedB);
    assert.equal(await m.peer(), peer, "request-local failure preserves transport identity");
    assert.equal(m.status().phase, "connected", "successful B proves the shared transport healthy");
    for (const name of ["write_A", "write_B"]) {
      assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "tools/call" &&
        ((x.body as JsonObject).params as JsonObject).name === name).length, 1);
    }
    assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "initialize").length, 1);
    await m.close(); timeoutMock.mock.restore();
  }
});

const automaticConfig = { ...config, clientId: "", clientSecret: "" };
const registrations = (f: ReturnType<typeof fixture>) => f.requests.filter(x => x.url === metadata.registration_endpoint);

test("explicit Connect registers Codex-compatible metadata once and uses issued secret for exchange and refresh despite echoed none", async () => {
  const f = fixture(automaticConfig), m = f.manager();
  assert.equal(m.status().phase, "disconnected"); await assert.rejects(m.peer(), /Connect Figma|Authorize Figma/);
  assert.equal(f.requests.length, 0);
  const url = new URL((await m.beginAuth()).authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), "bb-issued-client");
  assert.equal(url.searchParams.get("scope"), "mcp:connect"); assert.equal(url.searchParams.get("resource"), endpoint);
  assert.equal(registrations(f).length, 1); assert.equal(registrations(f)[0].method, "POST");
  assert.deepEqual(registrations(f)[0].body, { client_name: "Codex", redirect_uris: [config.redirectUri],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp:connect" });
  await m.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer });
  const firstPeer = await m.peer(); assert.equal(await m.peer(), firstPeer);
  f.store.value!.expiresAt = 0; await m.peer();
  const tokenRequests = f.requests.filter(x => x.url === metadata.token_endpoint);
  assert.equal(tokenRequests.length, 2);
  for (const request of tokenRequests) assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("bb-issued-client:fixture-issued-secret").toString("base64")}`);
  assert.equal((tokenRequests[1].body as URLSearchParams).get("grant_type"), "refresh_token");
  assert.equal(registrations(f).length, 1); await m.close();
  const restarted = f.manager(); await restarted.peer();
  await restarted.beginAuth(); await restarted.beginAuth(); assert.equal(registrations(f).length, 1);
  await restarted.disconnect(); assert.equal(f.store.value, null); await restarted.close();
});

test("plain-text registration rejection is bounded, sends once, and leaves no consent URL or secrets", async () => {
  for (const status of [403, 429, 500]) {
    const f = fixture(automaticConfig), m = f.manager();
    f.setRegistrationHook(async () => new Response("Forbidden private-body fixture-issued-secret", { status }));
    await assert.rejects(m.beginAuth(), error => {
      assert.ok(error instanceof RemoteError); assert.equal(error.reason, "registration");
      assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.match(error.message, /preregistered client credentials/);
      if (status === 403) assert.match(error.message, /rejected Codex-compatible client registration.*does not identify the rejected field/);
      assert.ok(!error.message.includes("private-body")); assert.ok(!error.message.includes("fixture-issued-secret")); return true;
    });
    assert.equal(registrations(f).length, 1); assert.equal(f.store.value, null);
    assert.ok(!JSON.stringify(m.status()).includes("private-body")); await m.close();
  }
});

test("reconnect denial and exchange failure consume pending but preserve the old grant and peer", async () => {
  for (const kind of ["denial", "exchange", "discovery"]) {
    const f = fixture(automaticConfig), m = await authenticate(f), peer = await m.peer();
    const before = structuredClone(f.store.value!.tokens);
    if (kind === "discovery") {
      f.setMetadata({ ...metadata, token_endpoint: "https://wrong.example/token" });
      await assert.rejects(m.beginAuth(), /metadata is incompatible/);
    } else {
      const url = new URL((await m.beginAuth()).authorizationUrl);
      if (kind === "exchange") f.setTokenHook(async () => f.json({ error: "invalid_grant", error_description: "private" }, 400));
      await assert.rejects(m.finishAuth({ code: kind === "denial" ? "" : "fixture-code", state: url.searchParams.get("state")!, issuer }));
      assert.equal(f.store.value!.pending, undefined);
    }
    assert.deepEqual(f.store.value!.tokens, before); assert.equal(await m.peer(), peer);
    assert.equal((await peer.request("tools/list")).method, "tools/list");
    assert.equal(f.requests.filter(x => (x.body as JsonObject)?.method === "initialize").length, 1);
    assert.equal(registrations(f).length, 1); await m.close();
  }
});

test("partial credentials fail actionably without discovery or registration", async () => {
  for (const partial of [{ ...config, clientId: "" }, { ...config, clientSecret: "" }]) {
    const f = fixture(partial), m = f.manager();
    await assert.rejects(m.beginAuth(), /both.*client ID and secret.*clear both/);
    assert.equal(f.requests.length, 0); assert.equal(m.status().phase, "unconfigured"); await m.close();
  }
});

test("registration responses require valid ID, secret and expiry; malformed or expired stored credentials never register again", async () => {
  for (const response of [
    { client_id: "", client_secret: "fixture-issued-secret" },
    { client_id: "bb-issued-client" },
    { client_id: "bb-issued-client", client_secret: " " },
    { client_id: "bb-issued-client", client_secret: "fixture-issued-secret", client_secret_expires_at: -1 },
    { client_id: "bb-issued-client", client_secret: "fixture-issued-secret", client_secret_expires_at: 1 },
    { client_id: "bb-issued-client", client_secret: "fixture-issued-secret", client_secret_expires_at: "never" },
  ]) {
    const f = fixture(automaticConfig), m = f.manager(); f.setRegistrationHook(async () => f.json({ redirect_uris: [config.redirectUri], ...response }));
    await assert.rejects(m.beginAuth()); assert.equal(registrations(f).length, 1); assert.equal(f.store.value, null); await m.close();
  }
  for (const expiry of [-1, 1]) {
    const f = fixture(automaticConfig), m = f.manager(); await m.beginAuth(); await m.close();
    (f.store.value!.registration as JsonObject).client_secret_expires_at = expiry;
    const restarted = f.manager(); await assert.rejects(restarted.beginAuth(), expiry < 0 ? /Saved Figma authorization is invalid/ : /credentials expired/);
    assert.equal(registrations(f).length, 1); await restarted.close();
  }
  const f = fixture(automaticConfig), m = f.manager(); f.store.value = { corrupt: true };
  await assert.rejects(m.beginAuth(), /Saved Figma authorization is invalid/); assert.equal(f.requests.length, 0); await m.close();
});

test("disconnect and config changes fence a delayed registration response before credentials can persist", async () => {
  for (const kind of ["disconnect", "config"]) {
    const f = fixture(automaticConfig), m = f.manager(), entered = deferred<void>(), response = deferred<Response>();
    f.setRegistrationHook(async () => { entered.resolve(); return response.promise; });
    const failed = assert.rejects(m.beginAuth(), kind === "disconnect" ? /disconnected/ : /settings changed/);
    await entered.promise;
    const clearing = kind === "disconnect" ? m.disconnect() : Promise.resolve();
    if (kind === "config") f.setConfig({ ...automaticConfig, redirectUri: "https://bb.example/new-callback" });
    response.resolve(f.json({ client_id: "bb-issued-client", client_secret: "fixture-issued-secret", redirect_uris: [config.redirectUri] }));
    await Promise.all([failed, clearing]); assert.equal(f.store.value, null); assert.equal(registrations(f).length, 1); await m.close();
  }
});

test("issued credentials and their Basic form are redacted from protocol errors after restart", async () => {
  const f = fixture(automaticConfig), m = await authenticate(f); await m.close();
  const next = f.manager(), peer = await next.peer();
  const secrets = ["bb-issued-client", "fixture-issued-secret", Buffer.from("bb-issued-client:fixture-issued-secret").toString("base64")];
  f.setRpcHook(async rpc => rpc.method !== "tools/call" ? undefined : f.json({ jsonrpc: "2.0", id: rpc.id,
    error: { code: -32602, message: `Invalid nodeId ${secrets.join(" ")}` } }));
  await assert.rejects(peer.request("tools/call", { name: "fixture", arguments: {} }), error => {
    assert.ok(error instanceof RemoteError); for (const secret of secrets) assert.ok(!error.message.includes(secret));
    assert.match(error.message, /Invalid nodeId/); return true;
  }); await next.close();
});

test("saved registration cannot authorize callbacks or grants after config rotation", async () => {
  const f = fixture(automaticConfig), m = f.manager(), url = new URL((await m.beginAuth()).authorizationUrl);
  f.setConfig({ ...automaticConfig, redirectUri: "https://bb.example/rotated" });
  const count = f.requests.length;
  await assert.rejects(m.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer }), /state is invalid/);
  await assert.rejects(m.peer(), /Connect Figma|Authorize Figma/); assert.equal(f.requests.length, count); await m.close();
});


test("registration network and malformed JSON failures remain in the registration phase without retry", async () => {
  for (const kind of ["network", "json"]) {
    const f = fixture(automaticConfig), m = f.manager();
    f.setRegistrationHook(async () => {
      if (kind === "network") throw new TypeError("private-registration-body fixture-issued-secret");
      return new Response("private-registration-body fixture-issued-secret", { status: 200 });
    });
    await assert.rejects(m.beginAuth(), error => {
      assert.ok(error instanceof RemoteError); assert.equal(error.reason, "registration"); assert.match(error.message, /client registration/);
      assert.ok(!error.message.includes("private-registration-body")); assert.ok(!error.message.includes("fixture-issued-secret")); return true;
    });
    assert.equal(registrations(f).length, 1); assert.equal(f.store.value, null); await m.close();
  }
});

test("registration metadata must name the exact fixed endpoint before any POST", async () => {
  for (const registration_endpoint of ["https://api.figma.com/register", "https://api.figma.com/v1/oauth/mcp/register?client_name=Codex", "https://other.example/register"]) {
    const f = fixture(automaticConfig), m = f.manager(); f.setMetadata({ ...metadata, registration_endpoint });
    await assert.rejects(m.beginAuth(), /registration endpoint is incompatible/);
    assert.equal(f.requests.filter(x => x.method === "POST").length, 0); assert.equal(f.store.value, null); await m.close();
  }
});

test("pending automatic consent survives restart; a successful replacement grant promotes a new peer", async () => {
  const f = fixture(automaticConfig), first = f.manager(), url = new URL((await first.beginAuth()).authorizationUrl);
  await first.close(); const next = f.manager();
  await next.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer });
  const old = await next.peer(), reconnect = new URL((await next.beginAuth()).authorizationUrl);
  assert.equal(await next.peer(), old); assert.equal(registrations(f).length, 1);
  f.setTokenHook(async () => f.json({ access_token: "fixture-replacement", refresh_token: "fixture-new-refresh", token_type: "Bearer", expires_in: 3600 }));
  await next.finishAuth({ code: "fixture-next-code", state: reconnect.searchParams.get("state")!, issuer });
  assert.equal((f.store.value!.tokens as JsonObject).access_token, "fixture-replacement");
  const current = await next.peer(); assert.notEqual(current, old);
  await assert.rejects(old.request("tools/list"), /transport changed/); assert.equal(registrations(f).length, 1); await next.close();
});

test("oversized OAuth error bodies are cancelled and never expose raw descriptions", async () => {
  const f = fixture(), m = f.manager(), url = new URL((await m.beginAuth()).authorizationUrl);
  let pulls = 0, cancelled = false;
  f.setTokenHook(async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("private-secret ".repeat(1000))); },
    cancel() { cancelled = true; },
  }), { status: 401 }));
  await assert.rejects(m.finishAuth({ code: "fixture-code", state: url.searchParams.get("state")!, issuer }), error => {
    assert.ok(error instanceof RemoteError); assert.match(error.message, /HTTP 401/); assert.ok(!error.message.includes("private-secret")); return true;
  });
  assert.ok(cancelled); assert.ok(pulls <= 2); assert.equal(f.store.value!.pending, undefined); await m.close();
});


test("automatic compatibility profile does not reuse a prior BB registration or grant", async () => {
  const f = fixture(automaticConfig), m = f.manager();
  f.store.value = { version: 1,
    binding: createHash("sha256").update(JSON.stringify(["", "", automaticConfig.redirectUri])).digest("hex"),
    registration: { client_id: "old-bb-client", client_secret: "old-private-secret" },
    tokens: { access_token: "old-bb-access", refresh_token: "old-bb-refresh", token_type: "Bearer", expires_in: 3600, issuer },
    expiresAt: Date.now() + 3600_000 };
  await assert.rejects(m.peer(), /Connect Figma/);
  assert.equal(f.requests.length, 0);
  await m.beginAuth();
  assert.equal(registrations(f).length, 1);
  assert.equal((registrations(f)[0].body as JsonObject).client_name, "Codex");
  assert.ok(!JSON.stringify(f.requests).includes("old-private-secret"));
  assert.equal(f.store.value.tokens, undefined);
  await m.close();
});

test("issued secret remains in token auth when metadata also advertises none", async () => {
  const f = fixture(automaticConfig);
  f.setMetadata({ ...metadata, token_endpoint_auth_methods_supported: ["none", "client_secret_basic"] });
  const m = await authenticate(f);
  f.store.value!.expiresAt = 0;
  await m.peer();
  const exchanges = f.requests.filter(x => x.url === metadata.token_endpoint);
  assert.equal(exchanges.length, 2);
  for (const request of exchanges) assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("bb-issued-client:fixture-issued-secret").toString("base64")}`);
  await m.close();
});


test("registration surfaces invalid_redirect_uri without leaking response descriptions", async () => {
  const f = fixture(automaticConfig), m = f.manager();
  f.setRegistrationHook(async () => f.json({ error: "invalid_redirect_uri", error_description: "private-body fixture-issued-secret" }, 400));
  await assert.rejects(m.beginAuth(), error => {
    assert.ok(error instanceof RemoteError); assert.equal(error.reason, "registration");
    assert.match(error.message, /HTTP 400, invalid_redirect_uri/); assert.match(error.message, /loopback callback/);
    assert.doesNotMatch(error.message, /private-body|fixture-issued-secret/); return true;
  });
  assert.equal(registrations(f).length, 1); await m.close();
});
