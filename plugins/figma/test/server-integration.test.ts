import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createFigmaPlugin } from "../server.ts";
import { createRemoteManager } from "../mcp/remote.ts";
import type { JsonObject, SettingsSnapshot } from "../contract.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Actual composition: BB public SDK host, server, private stores, bridge, SDK
// HTTP/OAuth transport, SDK stdio transport and mirror manager. Only vendor
// endpoints are synthetic. No user credentials, Figma file or network needed.
test("settings to OAuth to official write to fresh local read through the actual adapters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "figma-composition-"));
  const binary = join(directory, "figmog");
  const child = await readFile(new URL("./mirror-child.mjs", import.meta.url), "utf8");
  const registry = JSON.parse(await readFile(new URL("./mirror-registry-v0.0.2.json", import.meta.url), "utf8"));
  await writeFile(binary, child);
  await chmod(binary, 0o700);
  const control = (version: string) => writeFile(join(directory, "control.json"), JSON.stringify({ expectedToken: "fixture-read", versions: { A: version }, tools: registry.tools }));
  await control("100");
  const endpoint = "https://mcp.figma.com/mcp", issuer = "https://api.figma.com";
  let writes = 0, toolLists = 0, unauthorized = false;
  const pendingWrites: { entered: () => void; gate: Promise<void> }[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const remoteFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["mcp:connect"] });
    if (url.includes("oauth-authorization-server")) return json({ issuer, authorization_endpoint: "https://www.figma.com/oauth/mcp", token_endpoint: `${issuer}/v1/oauth/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic"], authorization_response_iss_parameter_supported: true });
    if (url.endsWith("/oauth/token")) return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
    assert.equal(url, endpoint);
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: JsonObject;
    switch (request.method) {
      case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
      case "tools/list":
        toolLists++;
        result = { tools: [{ name: "use_figma", description: "Synthetic test write; not an asserted upstream schema.", inputSchema: { type: "object", properties: { fileKey: { type: "string" } }, required: ["fileKey"] }, annotations: { readOnlyHint: false } }] }; break;
      case "tools/call":
        writes++;
        { const pending = pendingWrites.shift(); if (pending) { pending.entered(); await pending.gate; } }
        if (unauthorized) return new Response("fixture-private-error", { status: 401 });
        result = { content: [{ type: "text", text: "write accepted" }, { type: "image", data: "AQID", mimeType: "image/png" }], structuredContent: { nodeId: "1:1" }, isError: false }; break;
      case "resources/read": result = { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "fixture skill instructions" }] }; break;
      default: throw new Error(`Unexpected fixture method ${request.method}`);
    }
    return json({ jsonrpc: "2.0", id: request.id, result });
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "figma" });
  try {
    await createFigmaPlugin({ directory: join(directory, "private"), remote: options => createRemoteManager({ ...options, fetch: remoteFetch }) })(bb);
    const rpc = (method: string, input: unknown = null) => harness.behavior.callRpc(method, input);
    const call = (source: string, name: string, args: JsonObject) => harness.callAgentTool("figma_call", { source, name, arguments: args });
    await rpc("configure", { binaryPath: binary, readToken: "fixture-read", clientId: "fixture-client", clientSecret: "fixture-secret", redirectUri: "https://bb.example/api/v1/plugins/figma/http/oauth/callback" });
    const auth = await rpc("connectOfficial") as { authorizationUrl: string };
    const state = new URL(auth.authorizationUrl).searchParams.get("state")!;
    const callback = await harness.behavior.fetchHttp("GET", `/oauth/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(issuer)}`);
    assert.equal(callback.status, 200);
    await rpc("configure", { binaryPath: join(directory, "missing-executable") });
    await call("official", "use_figma", { fileKey: "NEW" });
    assert.equal(writes, 1, "official writes work with a configured token and missing local executable");
    await assert.rejects(readFile(join(directory, "events.jsonl")), { code: "ENOENT" }, "unmirrored write preparation does not start figmog");
    await rpc("configure", { binaryPath: binary });
    await rpc("testConnection", { source: "mirror", file: "A" });
    assert.match(JSON.stringify(await call("mirror", "figmog_node", { file: "A", id: "1:1" })), /100/);
    const write = await call("official", "use_figma", { fileKey: "A" });
    assert.match(JSON.stringify(write), /nodeId/);
    assert.ok(typeof write === "object" && write !== null);
    assert.ok(write.content.some(part => part.type === "image"));
    assert.equal(writes, 2);
    await assert.rejects(call("mirror", "figmog_node", { file: "A", id: "1:1" }), /refresh-pending/);
    await control("101");
    assert.match(JSON.stringify(await call("mirror", "figmog_node", { file: "A", id: "1:1" })), /101/);
    const resources = await harness.callAgentTool("figma_mcp", { source: "official", method: "resources/read", params: { uri: "fixture:skill" } });
    assert.match(JSON.stringify(resources), /fixture skill instructions/);
    const enteredA = deferred(), enteredB = deferred(), releaseA = deferred(), releaseB = deferred();
    pendingWrites.push({ entered: enteredA.resolve, gate: releaseA.promise }, { entered: enteredB.resolve, gate: releaseB.promise });
    const writeA = call("official", "use_figma", { fileKey: "A" });
    await enteredA.promise;
    const writeB = call("official", "use_figma", { fileKey: "A" });
    await enteredB.promise;
    try {
      await control("102");
      releaseA.resolve(); await writeA;
      await assert.rejects(call("mirror", "figmog_node", { file: "A", id: "1:1" }), /in flight/);
      await assert.rejects(rpc("syncMirror", { file: "A", acceptUnverified: true }), /in flight/);
    } finally { releaseA.resolve(); releaseB.resolve(); await Promise.allSettled([writeA, writeB]); }
    await assert.rejects(call("mirror", "figmog_node", { file: "A", id: "1:1" }), /refresh-pending/);
    const recovery = await harness.callAgentTool("figma_sync", { file: "A", acceptUnverified: true });
    assert.match(JSON.stringify(recovery), /mutationVisibilityVerified/);
    assert.match(JSON.stringify(recovery), /false/);
    assert.match(JSON.stringify(await call("mirror", "figmog_node", { file: "A", id: "1:1" })), /102/);
    unauthorized = true;
    await assert.rejects(call("official", "use_figma", { fileKey: "A" }), /Figma/);
    assert.equal(writes, 5, "ambiguous 401 write is dispatched exactly once");
    assert.equal(toolLists, 1, "same connection reuses authenticated catalog across calls");
    const snapshot = await rpc("status") as SettingsSnapshot;
    assert.doesNotMatch(JSON.stringify(snapshot), /fixture-read|fixture-secret|fixture-access|fixture-refresh|fixture-private-error/);
    await rpc("disconnect", { source: "official" });
    await assert.rejects(call("official", "use_figma", { fileKey: "A" }), /Authorize/);
    assert.equal(writes, 5);
  } finally {
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
