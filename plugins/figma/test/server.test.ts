import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { CodexOptions, ConnectionStatus, JsonObject, McpPeer, MirrorOptions, RemoteOptions, SettingsSnapshot } from "../contract.ts";
import type { BridgeOptions } from "../bridge.ts";
import { createFigmaPlugin } from "../server.ts";

const disconnected = (): ConnectionStatus => ({ phase: "disconnected", detail: null, connectedAt: null, serverVersion: null });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "figma-server-"));
  const fake = createFakePluginHost({ pluginId: "figma" });
  const events: string[] = [];
  let remoteOptions!: RemoteOptions;
  let codexOptions!: CodexOptions;
  let mirrorOptions!: MirrorOptions;
  let bridgeOptions!: BridgeOptions;
  let throwCallback = false;
  let toolError = false;
  let catalogError = false;
  const peer: McpPeer = {
    request: async () => ({ content: [{ type: "text", text: "fixture" }], isError: toolError }),
    info: () => ({ capabilities: { tools: {} } }), close: async () => undefined,
  };
  await createFigmaPlugin({
    directory,
    resolveBinary: async path => path.includes("missing") ? null : "/opt/figmog",
    remote: (options) => {
      remoteOptions = options;
      return {
        peer: async () => peer,
        beginAuth: async () => { events.push("begin"); return { authorizationUrl: "https://www.figma.com/oauth/mcp?state=fixture" }; },
        finishAuth: async ({ code }) => { events.push(code ? "finish" : "denial-consumed"); if (throwCallback || !code) throw new Error("fixture-private-secret"); },
        status: disconnected,
        disconnect: async () => { events.push("remote-disconnect"); },
        close: async () => { events.push("remote-close"); },
      };
    },
    codex: (options) => {
      codexOptions = options;
      return {
        peer: async () => { events.push("codex-peer"); return peer; },
        connect: async () => { events.push("codex-resume"); },
        beginAuth: async () => { events.push("codex-begin"); return { authorizationUrl: "https://www.figma.com/oauth/mcp?state=fixture", callbackRequired: true }; },
        finishAuth: async () => { throw new Error("Codex requires callback URL"); },
        finishCallback: async () => { events.push("codex-finish"); },
        status: disconnected,
        disconnect: async () => { events.push("codex-disconnect"); },
        close: async () => { events.push("codex-close"); },
      };
    },
    mirror: (options) => {
      mirrorOptions = options;
      return {
        peer: async () => peer,
        configure: async (config) => { mirrorOptions.config = config; events.push("mirror-configure"); },
        status: disconnected,
        markDirty: async (file) => { events.push(`dirty:${file ?? "all"}`); },
        beginWrite: async (file) => { events.push(`dirty:${file ?? "all"}`); return "fixture-ticket"; },
        endWrite: async () => { events.push("write-ended"); },
        refresh: async (file) => ({ file: file ?? null }),
        restart: async () => { events.push("restart"); },
        close: async () => { events.push("mirror-close"); },
      };
    },
    bridge: (options) => {
      bridgeOptions = options;
      return {
        refresh: async () => { if (catalogError) throw new Error("fixture-catalog-private"); return []; }, inventory: () => [], registerAliases: () => undefined,
        aliasesNeedReload: () => false,
        clear: (source) => { events.push(`clear:${source}`); },
        close: async () => { events.push("bridge-close"); },
      };
    },
  })(fake.bb);
  return {
    ...fake, events, directory,
    remoteOptions: () => remoteOptions,
    codexOptions: () => codexOptions,
    mirrorOptions: () => mirrorOptions,
    bridgeOptions: () => bridgeOptions,
    failCallback: () => { throwCallback = true; },
    failTool: () => { toolError = true; },
    failCatalog: () => { catalogError = true; },
    rpc: async (method: string, input: unknown = null) => fake.harness.behavior.callRpc(method, input),
    close: async () => { await fake.harness.lifecycle.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("one settings API stores secrets privately and never returns or broadcasts them", async () => {
  const f = await fixture();
  try {
    const result = await f.rpc("configure", {
      readToken: "fixture-read-secret", clientId: "bb-client", clientSecret: "fixture-client-secret",
      redirectUri: "https://bb.example/api/v1/plugins/figma/http/oauth/callback",
    }) as SettingsSnapshot;
    assert.equal(result.config.tokenConfigured, true);
    assert.equal(result.config.clientSecretConfigured, true);
    assert.equal(result.scope, "shared");
    assert.deepEqual(await f.remoteOptions().config(), { clientId: "bb-client", clientSecret: "fixture-client-secret", redirectUri: "https://bb.example/api/v1/plugins/figma/http/oauth/callback" });
    assert.equal(f.mirrorOptions().config.token, "fixture-read-secret");
    assert.deepEqual(f.harness.inspection.registrations.settingsDescriptors, {});
    const publicBytes = JSON.stringify([result, await f.rpc("status"), f.harness.inspection.realtimeSignals, f.harness.inspection.logEntries]);
    assert.doesNotMatch(publicBytes, /fixture-read-secret|fixture-client-secret/);
    await f.rpc("configure", { binaryPath: "/opt/figmog" });
    assert.equal(f.mirrorOptions().config.token, "fixture-read-secret", "omitted token preserves existing value");
    assert.equal((await f.remoteOptions().config()).clientSecret, "fixture-client-secret");
  } finally { await f.close(); }
});

test("client credential changes disconnect old authorization before committing new configuration", async () => {
  const f = await fixture();
  try {
    await Promise.all([f.rpc("configure", { clientId: "first", clientSecret: "secret-first" }), f.rpc("configure", { clientId: "second", clientSecret: "secret-second" })]);
    assert.equal((await f.remoteOptions().config()).clientId, "second");
    assert.equal(f.events.filter(value => value === "remote-disconnect").length, 2);
    const result = await f.rpc("disconnect", { source: "mirror" }) as SettingsSnapshot;
    assert.equal(result.config.tokenConfigured, false);
    assert.ok(f.events.includes("clear:mirror"));
    await f.rpc("disconnect", { source: "official" });
    assert.ok(f.events.includes("clear:official"));
    assert.equal((await f.remoteOptions().config()).clientSecret, "secret-second", "disconnect preserves own client registration for reconnection");
  } finally { await f.close(); }
});

test("callback validates inputs, hides all credentials/errors and disables caching", async () => {
  const f = await fixture();
  try {
    const route = f.harness.inspection.registrations.httpRoutes.find(route => route.path === "/oauth/callback");
    assert.ok(route);
    assert.equal(route.auth, "none");
    const missing = await f.harness.behavior.fetchHttp("GET", "/oauth/callback");
    assert.equal(missing.status, 400);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");
    assert.ok(!f.events.includes("finish"));
    f.failCallback();
    const failed = await f.harness.behavior.fetchHttp("GET", "/oauth/callback?code=fixture-code&state=fixture-state");
    assert.equal(failed.status, 400);
    assert.doesNotMatch(await failed.text(), /fixture-private-secret|fixture-code|fixture-state/);
  } finally { await f.close(); }
});

test("rejects unsafe callback configuration and treats failed file mirroring as failed connection test", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.rpc("configure", { redirectUri: "http://public.example/steal" }), /callback URL/);
    await assert.rejects(f.rpc("configure", { unexpectedSecret: "sentinel" }), /validation failed/);
    await f.rpc("configure", { mirrorEnabled: true, readToken: "fixture-token" });
    f.failTool();
    await assert.rejects(f.rpc("testConnection", { source: "mirror", file: "FixtureFile" }), /could not mirror/);
    await f.rpc("configure", { readToken: "fixture-token" });
    await f.bridgeOptions().beforeOfficialWrite({ fileKey: "FixtureFile" } as JsonObject);
    await f.bridgeOptions().beforeOfficialWrite({} as JsonObject);
    assert.ok(f.events.includes("dirty:FixtureFile"));
    assert.ok(f.events.includes("dirty:all"));
  } finally { await f.close(); }
  assert.ok(f.events.includes("remote-close") && f.events.includes("mirror-close") && f.events.includes("bridge-close"));
});

test("OAuth denial consumes state and successful authorization survives catalog failure", async () => {
  const f = await fixture();
  try {
    const denied = await f.harness.behavior.fetchHttp("GET", "/oauth/callback?error=access_denied&state=fixture-state");
    assert.equal(denied.status, 400);
    assert.ok(f.events.includes("denial-consumed"));
    f.failCatalog();
    const authorized = await f.harness.behavior.fetchHttp("GET", "/oauth/callback?code=fixture-code&state=fixture-state");
    assert.equal(authorized.status, 200);
    assert.match(await authorized.text(), /authorization completed, but its tool catalog/);
  } finally { await f.close(); }
});

test("figmog is opt-in; a saved token never makes disabled-cache calls prerequisites", async () => {
  const f = await fixture();
  try {
    const saved = await f.rpc("configure", { readToken: "retained-token", binaryPath: "/missing/figmog" }) as SettingsSnapshot;
    assert.equal(saved.config.mirrorEnabled, false);
    assert.equal(saved.config.binaryAvailable, false);
    assert.equal(saved.config.tokenConfigured, true);
    assert.deepEqual(saved.tools.mirror, []);
    assert.match(saved.mirror.detail!, /cache is off/);
    await assert.rejects(f.bridgeOptions().getPeer("mirror"), /source=official/);
    await f.bridgeOptions().getPeer("official");
    assert.equal(await f.bridgeOptions().beforeOfficialWrite({ fileKey: "A" }), undefined);
    assert.ok(!f.events.some(event => event.startsWith("dirty:")));
    const enabled = await f.rpc("configure", { mirrorEnabled: true }) as SettingsSnapshot;
    assert.match(enabled.mirror.detail!, /not found/);
    await assert.rejects(f.rpc("refreshTools", { source: "mirror" }), /not installed/);
    const firstGeneration = f.mirrorOptions().config.cacheGeneration;
    await f.rpc("configure", { mirrorEnabled: false });
    assert.equal(f.mirrorOptions().config.binaryPath, "", "disabling stops the optional process");
    await f.rpc("configure", { mirrorEnabled: true, binaryPath: "/opt/figmog" });
    assert.notEqual(f.mirrorOptions().config.cacheGeneration, firstGeneration, "reenabling cannot reuse a cache that missed writes");
    assert.equal(f.mirrorOptions().config.token, "retained-token");
    await f.bridgeOptions().getPeer("mirror");
    assert.equal((await f.rpc("status") as SettingsSnapshot).config.binaryAvailable, true);
  } finally { await f.close(); }
});

test("genuine Codex route reuses authorization, retains the read token and detaches durably", async () => {
  const f = await fixture();
  try {
    await f.rpc("configure", { readToken: "fixture-private-read", clientId: "own-direct-client", clientSecret: "fixture-private-direct" });
    const before = f.events.filter(event => event === "remote-disconnect").length;
    const next = await f.rpc("configure", { officialMode: "codex", codexBinaryPath: "/opt/native/codex", codexServerName: "figma_bb_diagnostic" }) as SettingsSnapshot;
    assert.equal(next.config.tokenConfigured, true);
    assert.equal(next.config.officialMode, "codex");
    assert.equal(f.events.filter(event => event === "remote-disconnect").length, before, "route change closes transports without deleting direct-client credentials");
    assert.deepEqual(await f.codexOptions().config(), { binaryPath: "/opt/native/codex", serverName: "figma_bb_diagnostic" });
    await f.bridgeOptions().getPeer("official");
    assert.ok(f.events.includes("codex-peer"));
    await f.rpc("testConnection", { source: "official" });
    assert.ok(f.events.includes("codex-resume"));
    assert.ok(!f.events.includes("codex-begin"), "Test resumes without interactive sign-in");
    const auth = await f.rpc("connectOfficial") as { callbackRequired?: boolean };
    assert.equal(auth.callbackRequired, true);
    await f.rpc("finishCodexAuth", { callbackUrl: ' "127.0.0.1:33418/callback?code=fixture-private-code&state=fixture-private-state" ' });
    assert.ok(f.events.includes("codex-finish"));
    const detached = await f.rpc("disconnect", { source: "official" }) as SettingsSnapshot;
    assert.equal(detached.config.codexEnabled, false);
    assert.match(detached.official.detail!, /retains the shared Figma authorization/);
    await assert.rejects(f.bridgeOptions().getPeer("official"), /disconnected from BB/);
    await f.rpc("refreshTools", { source: "official" }); // The injected bridge itself is inert.
    assert.equal((await f.rpc("status") as SettingsSnapshot).config.codexEnabled, false, "status and catalog refresh cannot implicitly reenable a disconnected handoff");
    const resumed = await f.rpc("testConnection", { source: "official" }) as SettingsSnapshot;
    assert.equal(resumed.config.codexEnabled, true);
    const visible = JSON.stringify([resumed, f.harness.inspection.logEntries, f.harness.inspection.realtimeSignals]);
    assert.doesNotMatch(visible, /fixture-private-read|fixture-private-direct|fixture-private-code|fixture-private-state/);
  } finally { await f.close(); }
});

test("Codex callbacks cannot finish a direct connection and direct HTTP callbacks cannot act on Codex", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.rpc("finishCodexAuth", { callbackUrl: "http://127.0.0.1:33418/callback?code=fixture&state=fixture" }), /Select Via Codex/);
    await f.rpc("configure", { officialMode: "codex", codexBinaryPath: "/opt/native/codex" });
    const result = await f.harness.behavior.fetchHttp("GET", "/oauth/callback?code=fixture&state=fixture");
    assert.equal(result.status, 400);
    assert.ok(!f.events.includes("finish"));
    await assert.rejects(f.rpc("configure", { codexServerName: "figma.invalid.name" }), /validation failed/);
  } finally { await f.close(); }
});
