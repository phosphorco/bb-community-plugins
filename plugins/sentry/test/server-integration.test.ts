import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createSentryPlugin } from "../server.ts";
import { createRemoteManager } from "../mcp/remote.ts";
import type { JsonObject, SettingsSnapshot } from "../contract.ts";

// Real BB adapters, private storage, bridge and SDK HTTP transport. Only the
// vendor endpoints are fixtures; no Sentry account or credentials are used.
test("shared settings, public-client PKCE, callback restart, aliases, CLI and disconnect compose", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentry-composition-"));
  const issuer = "https://mcp.sentry.dev", endpoint = `${issuer}/mcp`;
  let requests = 0, registrations = 0, exchanges = 0, writes = 0;
  let failWrite = false;
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const remoteFetch: typeof fetch = async (input, init) => {
    requests++;
    const url = String(input);
    if (url.includes("oauth-protected-resource")) {
      assert.equal(url, `${issuer}/.well-known/oauth-protected-resource/mcp`);
      return json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["org:read", "event:write"] });
    }
    if (url.includes("oauth-authorization-server")) return json({ issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["org:read", "event:write"], authorization_response_iss_parameter_supported: true });
    if (url.endsWith("/oauth/register")) {
      registrations++;
      const metadata = JSON.parse(String(init?.body));
      assert.equal(metadata.client_name, "BB Sentry MCP");
      assert.equal(metadata.token_endpoint_auth_method, "none");
      return json({ ...metadata, client_id: "fixture-public-client" });
    }
    if (url.endsWith("/oauth/token")) {
      exchanges++;
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get("client_id"), "fixture-public-client");
      assert.ok(params.get("code_verifier"));
      return json({ access_token: `fixture-access-${exchanges}`, refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(url, endpoint);
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: JsonObject;
    switch (request.method) {
      case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
      case "tools/list": result = { tools: [
        { name: "whoami", inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: "update_issue", inputSchema: { type: "object", properties: { issueId: { type: "string" } }, required: ["issueId"] } },
      ] }; break;
      case "tools/call":
        if (request.params.name === "update_issue") { writes++; if (failWrite) return new Response("private failure fixture-access", { status: 401 }); }
        result = { content: [{ type: "text", text: "fixture answer" }], structuredContent: { retained: true }, isError: false }; break;
      case "resources/read": result = { contents: [{ uri: request.params.uri, text: "fixture context" }] }; break;
      default: throw new Error(`Unexpected fixture method ${request.method}`);
    }
    return json({ jsonrpc: "2.0", id: request.id, result });
  };
  const activate = async () => {
    const host = createFakePluginHost({ pluginId: "sentry" });
    await createSentryPlugin({ directory, remote: options => createRemoteManager({ ...options, fetch: remoteFetch }) })(host.bb);
    return host;
  };
  let host = await activate();
  const rpc = (method: string, input: unknown = null) => host.harness.behavior.callRpc(method, input);
  try {
    assert.equal(requests, 0);
    assert.equal((await rpc("status") as SettingsSnapshot).config.redirectUri, "http://127.0.0.1:38560/callback");
    await assert.rejects(host.harness.callAgentTool("sentry_discover", {}), /Connect Sentry/);
    assert.equal(requests, 0);
    const auth = await rpc("connectOfficial") as { authorizationUrl: string };
    const url = new URL(auth.authorizationUrl);
    assert.equal(url.searchParams.get("scope"), "org:read event:write");
    const state = url.searchParams.get("state")!;
    await host.harness.lifecycle.dispose();
    const beforeRestart = requests;
    host = await activate();
    assert.equal(requests, beforeRestart);
    assert.equal((await rpc("status") as SettingsSnapshot).official.phase, "authorizing");
    await assert.rejects(rpc("finishAuthorization", { callbackUrl: `http://evil.example/callback?state=${state}&code=x` }));
    await assert.rejects(rpc("finishAuthorization", { callbackUrl: `http://127.0.0.1:38560/callback?state=${state}&state=${state}&code=x` }));
    const callbackUrl = `http://127.0.0.1:38560/callback?code=fixture-code&state=${state}&iss=${encodeURIComponent(issuer)}`;
    const next = await rpc("finishAuthorization", { callbackUrl }) as SettingsSnapshot;
    assert.equal(next.official.phase, "connected");
    assert.equal(next.tools.official.length, 2);
    assert.equal(registrations, 1); assert.equal(exchanges, 1);
    await assert.rejects(rpc("finishAuthorization", { callbackUrl }), /already used/);
    const mode = (await stat(join(directory, "oauth.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
    await host.harness.callAgentTool("sentry_discover", {});
    assert.ok(host.harness.inspection.registrations.agentTools.some(t => t.name === "sentry_whoami"));
    await host.harness.callAgentTool("sentry_whoami", {});
    const cli = await host.harness.behavior.runCli(["call", "whoami", "--json"]);
    assert.equal(cli.exitCode, 0); assert.match(cli.stdout, /fixture answer/);
    await assert.rejects(host.harness.callAgentTool("sentry_call", { name: "update_issue", arguments: { issueId: 3 } }));
    assert.equal(writes, 0);
    failWrite = true;
    await assert.rejects(host.harness.callAgentTool("sentry_update_issue", { issueId: "42" }), /outcome is unknown/);
    assert.equal(writes, 1); assert.equal(exchanges, 1);
    await rpc("disconnect", { source: "official" });
    assert.equal((await rpc("status") as SettingsSnapshot).tools.official.length, 0);
    await assert.rejects(stat(join(directory, "oauth.json")), { code: "ENOENT" });
    await rpc("configure", { redirectUri: "https://bb.example/api/v1/plugins/sentry/http/oauth/callback" });
    const deniedAuth = new URL((await rpc("connectOfficial") as { authorizationUrl: string }).authorizationUrl);
    const deniedState = deniedAuth.searchParams.get("state")!;
    const deniedQuery = `state=${deniedState}&error=access_denied&iss=${encodeURIComponent(issuer)}`;
    const ambiguous = await host.harness.behavior.fetchHttp("GET", `/oauth/callback?${deniedQuery}&code=private-code`);
    assert.equal(ambiguous.status, 400);
    const denied = await host.harness.behavior.fetchHttp("GET", `/oauth/callback?${deniedQuery}`);
    assert.equal(denied.status, 400);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.equal(denied.headers.get("referrer-policy"), "no-referrer");
    assert.equal(exchanges, 1);
    await assert.rejects(rpc("finishAuthorization", { callbackUrl: `https://bb.example/api/v1/plugins/sentry/http/oauth/callback?${deniedQuery}` }), /already used/);
    failWrite = false;
    const directAuth = new URL((await rpc("connectOfficial") as { authorizationUrl: string }).authorizationUrl);
    const direct = await host.harness.behavior.fetchHttp("GET", `/oauth/callback?code=fixture-code&state=${directAuth.searchParams.get("state")}&iss=${encodeURIComponent(issuer)}`);
    assert.equal(direct.status, 200);
    assert.equal((await rpc("status") as SettingsSnapshot).official.phase, "connected");
  } finally { await host.harness.lifecycle.dispose(); await rm(directory, { recursive: true, force: true }); }
});
