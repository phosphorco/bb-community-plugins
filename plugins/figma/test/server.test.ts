import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ConnectionStatus, JsonObject, McpPeer, MirrorOptions, RemoteOptions, SettingsSnapshot } from "../contract.ts";
import type { BridgeOptions } from "../bridge.ts";
import { createFigmaPlugin } from "../server.ts";

const disconnected = (): ConnectionStatus => ({ phase: "disconnected", detail: null, connectedAt: null, serverVersion: null });
async function fixture(saved?: JsonObject) {
  let stored: JsonObject | null = saved ?? null;
  const directory = await mkdtemp(join(tmpdir(), "figma-server-"));
  const fake = createFakePluginHost({ pluginId: "figma" });
  const events: string[] = [];
  let remoteOptions!: RemoteOptions;
  let mirrorOptions!: MirrorOptions;
  let bridgeOptions!: BridgeOptions;
  let throwCallback = false;
  const callbackInputs: { code: string; state: string; issuer?: string }[] = [];
  let toolError = false;
  let catalogError = false;
  let saveError = false;
  const peer: McpPeer = {
    request: async () => ({ content: [{ type: "text", text: "fixture" }], isError: toolError }),
    info: () => ({ capabilities: { tools: {} } }), close: async () => undefined,
  };
  await createFigmaPlugin({
    directory,
    ...(saved ? { configurationStore: { read: async () => stored, write: async value => { if (saveError) throw new Error("Could not save settings"); stored = structuredClone(value); } } } : {}),
    resolveBinary: async path => path.includes("missing") ? null : "/opt/figmog",
    remote: (options) => {
      remoteOptions = options;
      return {
        peer: async () => peer,
        beginAuth: async () => { events.push("begin"); return { authorizationUrl: "https://www.figma.com/oauth/mcp?state=fixture" }; },
        finishAuth: async (input) => { callbackInputs.push(input); const { code } = input; events.push(code ? "finish" : "denial-consumed"); if (throwCallback || !code) throw new Error("fixture-private-secret"); },
        status: disconnected,
        disconnect: async () => { events.push("remote-disconnect"); },
        close: async () => { events.push("remote-close"); },
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
    ...fake, events, directory, callbackInputs, saved: () => stored,
    remoteOptions: () => remoteOptions,
    mirrorOptions: () => mirrorOptions,
    bridgeOptions: () => bridgeOptions,
    failCallback: () => { throwCallback = true; },
    failTool: () => { toolError = true; },
    failCatalog: () => { catalogError = true; },
    failSave: () => { saveError = true; },
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

test("client credential changes disconnect old authorization after committing new configuration", async () => {
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

test("failed configuration persistence leaves the current authorization and settings intact", async () => {
  const f = await fixture({ clientId: "old", clientSecret: "old-secret", redirectUri: "http://127.0.0.1:38559/callback" });
  try {
    f.failSave();
    await assert.rejects(f.rpc("configure", { clientId: "new", clientSecret: "new-secret" }), /Could not save/);
    assert.equal((await f.remoteOptions().config()).clientId, "old");
    assert.equal(f.events.includes("remote-disconnect"), false);
  } finally { await f.close(); }
});

test("HTTP callback rejects duplicates and simultaneous success/denial without consuming consent", async () => {
  const f = await fixture();
  try {
    for (const query of ["code=c&state=s&state=s", "code=c&code=d&state=s", "code=c&state=s&iss=x&iss=y", "code=c&state=s&error=access_denied", "error=x&error=y&state=s"]) {
      const response = await f.harness.behavior.fetchHttp("GET", `/oauth/callback?${query}`);
      assert.equal(response.status, 400);
    }
    assert.equal(f.callbackInputs.length, 0);
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


test("retired Codex route migrates without losing read token or cache preferences", async () => {
  const f = await fixture({ officialMode: "codex", codexBinaryPath: "/opt/codex", codexServerName: "figma_bb_diagnostic", codexEnabled: false,
    readToken: "retained-private-token", mirrorEnabled: false, binaryPath: "/opt/figmog", cacheGeneration: "retained-cache",
    redirectUri: "https://bb.example/api/v1/plugins/figma/http/oauth/callback" });
  try {
    const status = await f.rpc("status") as SettingsSnapshot;
    assert.equal(status.config.tokenConfigured, true);
    assert.equal(status.config.mirrorEnabled, false);
    assert.equal(status.config.redirectUri, "http://127.0.0.1:38559/callback");
    assert.equal(status.official.phase, "disconnected");
    assert.equal(f.mirrorOptions().config.token, "retained-private-token");
    assert.equal(f.mirrorOptions().config.cacheGeneration, "retained-cache");
    assert.ok(!Object.keys(f.saved()!).some(key => /codex|officialMode/.test(key)));
    assert.doesNotMatch(JSON.stringify(status), /retained-private-token|codex|officialMode/);
    await f.rpc("connectOfficial");
    assert.deepEqual(f.events.filter(event => event === "begin"), ["begin"]);
    await assert.rejects(f.rpc("finishCodexAuth", { callbackUrl: "http://localhost/callback" }));
  } finally { await f.close(); }
});


test("direct OAuth accepts a visible copied loopback address and rejects mismatched or duplicate callback fields", async () => {
  const f = await fixture();
  try {
    await f.rpc("configure", { redirectUri: "http://127.0.0.1:38559/callback" });
    for (const address of ["http://localhost:38559/callback?code=x&state=s", "127.0.0.1:38558/callback?code=x&state=s",
      "127.0.0.1:38559/other?code=x&state=s", "127.0.0.1:38559/callback?code=x&state=s&state=s",
      "127.0.0.1:38559/callback?code=x&code=y&state=s", "127.0.0.1:38559/callback?code=x&state=s&iss=x&iss=y", "not a URL"]) {
      await assert.rejects(f.rpc("finishAuthorization", { callbackUrl: address }));
    }
    assert.equal(f.callbackInputs.length, 0, "invalid copied addresses never consume pending OAuth state");
    await f.rpc("finishAuthorization", { callbackUrl: '  "127.0.0.1:38559/callback?code=fixture-\ncode&iss=https%3A%2F%2Fapi.figma.com&state=fixture-state"  ' });
    assert.deepEqual(f.callbackInputs, [{ code: "fixture-code", state: "fixture-state", issuer: "https://api.figma.com" }]);
    assert.ok(f.events.includes("clear:official"));
    const publicBytes = JSON.stringify(await f.rpc("status"));
    assert.doesNotMatch(publicBytes, /fixture-code|fixture-state/);
  } finally { await f.close(); }
});
