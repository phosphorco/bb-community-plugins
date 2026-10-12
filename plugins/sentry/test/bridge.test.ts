import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createBridge, adaptEnvelope, aliasName, type BridgeOptions } from "../bridge.ts";
import type { JsonObject, McpPeer, McpTool } from "../contract.ts";

const tool = (name: string, extra: JsonObject = {}): McpTool => ({
  name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: { file: { type: "string" } }, additionalProperties: false },
  annotations: { readOnlyHint: true }, ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Peer implements McpPeer {
  tools: McpTool[] = [tool("get_design")];
  capabilities: JsonObject = { tools: {} };
  calls: { method: string; params?: JsonObject; signal?: AbortSignal }[] = [];
  listeners = new Set<() => void>();
  response: JsonObject = { content: [{ type: "text", text: "fixture result" }], isError: false };
  handler?: (method: string, params?: JsonObject, signal?: AbortSignal) => Promise<JsonObject>;
  info() { return { capabilities: this.capabilities, serverInfo: { name: "fixture", version: "1" }, instructions: "Untrusted fixture instructions" }; }
  async request(method: string, params?: JsonObject, signal?: AbortSignal) {
    this.calls.push({ method, params, signal });
    if (this.handler) return this.handler(method, params, signal);
    if (method === "tools/list") return { tools: this.tools };
    return this.response;
  }
  onCatalogChanged(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed() { for (const listener of this.listeners) listener(); }
  async close() { throw new Error("Bridge must not close borrowed manager peers"); }
}
function fixture(extra: Partial<BridgeOptions> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "sentry" });
  const peer = new Peer();
  const writes: JsonObject[] = [];
  const bridge = createBridge({ bb, getPeer: async () => peer, ...extra });
  const call = (name: string, input: unknown) => harness.callAgentTool(name, input);
  return { peer, bridge, writes, harness, call };
}
function text(result: unknown): string {
  assert.ok(typeof result === "object" && result !== null && "content" in result);
  return (result.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("\n");
}

test("generic tools default to official MCP without acquiring the optional mirror", async () => {
  const peer = new Peer();
  const sources: string[] = [];
  const f = fixture({ getPeer: async source => { sources.push(source); return peer; } });
  try {
    await f.call("sentry_discover", {});
    await f.call("sentry_call", { name: "get_design", arguments: {} });
    await f.call("sentry_mcp", { method: "ping" });
    assert.deepEqual(sources, ["official", "official", "official"]);
  } finally { await f.bridge.close(); await f.harness.dispose(); }
});

test("constructor uses cached descriptors without acquiring a peer; discover is live and all-page", async () => {
  let acquired = 0;
  const peer = new Peer();
  peer.handler = async (_method, params) => params?.cursor === "page-2"
    ? { tools: [tool("edit_design", { annotations: { readOnlyHint: false }, outputSchema: { type: "object" }, custom: { retained: true } })] }
    : { tools: [tool("get_design")], nextCursor: "page-2" };
  const f = fixture({ getPeer: async () => { acquired++; return peer; }, initialInventory: { official: [tool("get_cached")] } });
  assert.equal(acquired, 0);
  assert.deepEqual(f.harness.registrations.agentTools.map(t => t.name), ["sentry_discover", "sentry_call", "sentry_mcp", "sentry_get_cached"]);
  const result = await f.call("sentry_discover", { source: "official" });
  assert.equal(acquired, 1);
  assert.deepEqual(peer.calls.map(c => c.params), [{}, { cursor: "page-2" }]);
  assert.deepEqual(f.bridge.inventory("official").map(t => t.name), ["get_design", "edit_design"]);
  assert.match(text(result), /outputSchema/);
  assert.match(text(result), /retained/);
  assert.match(text(result), /readOnlyHint/);
  assert.ok(f.harness.registrations.agentTools.some(t => t.name === "sentry_edit_design"));
  await f.bridge.close(); await f.harness.dispose();
});

test("inventory is cloned, cached per peer and refreshed for unknown tools", async () => {
  const f = fixture();
  await f.call("sentry_discover", { source: "official" });
  const snapshot = f.bridge.inventory("official"); snapshot[0].inputSchema.properties = {};
  assert.deepEqual(f.bridge.inventory("official")[0].inputSchema.properties, { file: { type: "string" } });
  await f.call("sentry_call", { source: "official", name: "get_design", arguments: { file: "A" } });
  await f.call("sentry_call", { source: "official", name: "get_design", arguments: {} });
  assert.equal(f.peer.calls.filter(c => c.method === "tools/list").length, 1);
  f.peer.tools.push(tool("read_new"));
  await f.call("sentry_call", { source: "official", name: "read_new", arguments: {} });
  assert.equal(f.peer.calls.filter(c => c.method === "tools/list").length, 2);
  await f.bridge.close(); await f.harness.dispose();
});

test("alias changes/removals are fenced while generic calls use current schema", async () => {
  const f = fixture();
  await f.call("sentry_discover", { source: "official" });
  await f.call("sentry_get_design", { file: "A" });
  f.peer.tools = [tool("get_design", { inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } })];
  f.peer.changed();
  await assert.rejects(f.call("sentry_get_design", { file: "A" }), /descriptor changed/);
  assert.equal(f.bridge.aliasesNeedReload(), true);
  await assert.rejects(f.call("sentry_call", { source: "official", name: "get_design", arguments: { file: "A" } }), /current schema/);
  await f.call("sentry_call", { source: "official", name: "get_design", arguments: { count: 2 } });
  f.peer.tools = []; f.peer.changed();
  await assert.rejects(f.call("sentry_get_design", { file: "A" }), /absent/);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 2);
  await f.bridge.close(); await f.harness.dispose();
});

test("recursive schemas rejected by BB remain callable through generic routing", async () => {
  const f = fixture();
  const recursive = { type: "object", properties: { child: { $ref: "#" } }, additionalProperties: false };
  f.peer.tools = [tool("read_recursive", { inputSchema: recursive })];
  await f.call("sentry_discover", { source: "official" });
  assert.ok(!f.harness.registrations.agentTools.some(t => t.name === "sentry_read_recursive"));
  await f.call("sentry_call", { source: "official", name: "read_recursive", arguments: { child: {} } });
  assert.equal(f.peer.calls.at(-1)?.method, "tools/call");
  assert.deepEqual(f.peer.calls.at(-1)?.params, { name: "read_recursive", arguments: { child: {} } });
  await f.bridge.close(); await f.harness.dispose();
});

test("native names preserve ordinary aliases and safely encode reserved, dotted and encoded names", () => {
  assert.equal(aliasName("official", "get_design_context"), "sentry_get_design_context");
  const names = ["call", "discover", "mcp", "sync", "sentry_call", "a.b", "a_b", "x_abc", "☀", "A".repeat(200)];
  const encoded = names.map(name => aliasName("official", name));
  assert.equal(new Set(encoded).size, names.length);
  for (const name of encoded) { assert.match(name, /^[a-zA-Z0-9_-]+$/); assert.ok(name.length <= 64); }
});

test("adaptation preserves ordered text/image/SVG/links/audio/resources and top-level result fields", () => {
  const envelope = {
    content: [
      { type: "text", text: "manifest", id: "manifest-id" },
      { type: "resource_link", uri: "sentry://A/2", name: "node", annotations: { audience: ["assistant"] } },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png", id: "2", ref: "sentry://A/2", annotations: { priority: 1 } },
      { type: "text", text: "<svg>inert markup</svg>", mimeType: "image/svg+xml", id: "svg" },
      { type: "resource", resource: { uri: "sentry://A/3", text: "untrusted instructions", mimeType: "text/plain" } },
      { type: "audio", data: "YWJj", mimeType: "audio/wav" },
    ],
    structuredContent: { failedImageIds: ["4"] }, _meta: { extension: "kept" }, customField: "retained", isError: false,
  };
  const result = adaptEnvelope(envelope);
  assert.ok(typeof result !== "string");
  const parts = result.content;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[3].type, "image");
  assert.equal(parts.filter(p => p.type === "image").length, 1);
  const out = text(result);
  for (const value of ["manifest-id", "resource_link", "sentry://A/2", "priority", "<svg>", "image/svg+xml", "untrusted instructions", "audio/wav", "YWJj", "failedImageIds", "extension", "customField", '"isError":false']) assert.ok(out.includes(value), value);
  assert.ok(out.indexOf("resource_link") < out.indexOf("<svg>"));
  assert.equal(result.isError, undefined);
  const error = adaptEnvelope({ content: [{ type: "text", text: "upstream failed" }], isError: true });
  assert.ok(typeof error !== "string"); assert.equal(error.isError, true);
});

test("resource URI, prompt roles, task data and extension envelopes survive without a content field", () => {
  const envelope = { messages: [{ role: "user", content: { type: "text", text: "hello" } }], contents: [{ uri: "sentry://node", blob: "aGk=" }], task: { taskId: "T" }, custom: [1, 2] };
  const serialized = text(adaptEnvelope(envelope)).split("\n").slice(1).join("\n");
  assert.deepEqual(JSON.parse(serialized), envelope);
});

test("oversized and non-JSON envelopes fail explicitly instead of truncating", () => {
  assert.throws(() => adaptEnvelope({ content: [{ type: "text", text: "long payload" }] }, 10), /exceeds.*no content was truncated/);
  assert.throws(() => adaptEnvelope({ custom: undefined }), /non-JSON/);
  assert.throws(() => adaptEnvelope({ custom: Infinity }), /non-JSON/);
});

test("generic MCP forwards supported methods verbatim and checks exact task/subscription capabilities", async () => {
  const f = fixture();
  f.peer.capabilities = { tools: {}, resources: { subscribe: true }, prompts: {}, completions: {}, logging: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } };
  const methods = ["resources/list", "resources/templates/list", "resources/read", "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "tasks/get", "tasks/result", "tasks/list", "tasks/cancel", "logging/setLevel", "ping"];
  for (const method of methods) {
    const params = { uri: "sentry://A", extension: { preserved: true } };
    await f.call("sentry_mcp", { source: "official", method, params });
    assert.equal(f.peer.calls.at(-1)?.method, method);
    assert.deepEqual(f.peer.calls.at(-1)?.params, params);
  }
  const count = f.peer.calls.length;
  f.peer.capabilities = { resources: {}, tasks: {} };
  for (const method of ["resources/subscribe", "tasks/list", "tasks/cancel", "prompts/get", "completion/complete", "tools/call"]) await assert.rejects(f.call("sentry_mcp", { source: "official", method }), /did not advertise/);
  await assert.rejects(f.call("sentry_mcp", { source: "official", method: "initialize" }), /not supported by this bridge/);
  assert.equal(f.peer.calls.length, count);
  await f.bridge.close(); await f.harness.dispose();
});

test("task-required tools route only with advertised task support and preserve original task params", async () => {
  const f = fixture();
  f.peer.capabilities = { tools: {}, tasks: { requests: { tools: { call: {} } } } };
  f.peer.tools = [tool("get_design", { execution: { taskSupport: "required" } })];
  await assert.rejects(f.call("sentry_call", { source: "official", name: "get_design" }), /requires task execution/);
  const params = { name: "get_design", arguments: {}, task: { ttl: 5000 }, _meta: { progressToken: "progress" } };
  await f.call("sentry_mcp", { source: "official", method: "tools/call", params });
  assert.deepEqual(f.peer.calls.at(-1)?.params, params);
  f.peer.capabilities = { tools: {} };
  await assert.rejects(f.call("sentry_mcp", { source: "official", method: "tools/call", params }), /did not advertise task/);
  await f.bridge.close(); await f.harness.dispose();
});

test("changed peer refreshes catalog before aliases execute", async () => {
  let peer = new Peer();
  const f = fixture({ getPeer: async () => peer });
  await f.call("sentry_discover", { source: "official" });
  peer = new Peer(); peer.tools = [tool("get_design", { inputSchema: { type: "object", properties: { next: { type: "boolean" } } } })];
  await assert.rejects(f.call("sentry_get_design", {}), /descriptor changed/);
  assert.equal(peer.calls.length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("clear and close fence delayed work; old results cannot repopulate inventories", async () => {
  const gate = deferred<JsonObject>();
  const f = fixture();
  f.peer.handler = () => gate.promise;
  const refresh = f.bridge.refresh("official");
  await new Promise(resolve => setImmediate(resolve));
  f.bridge.clear("official");
  await assert.rejects(refresh, /cleared/);
  gate.resolve({ tools: [tool("get_design")] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.bridge.inventory("official"), []);
  assert.equal(f.peer.listeners.size, 0);
  await f.bridge.close();
  await assert.rejects(f.call("sentry_call", { source: "official", name: "get_design" }), /closed/);
  await f.harness.dispose();
});

test("unauthenticated discovery rejects rather than displaying a cached inventory as live", async () => {
  const f = fixture({ getPeer: async () => { throw new Error("Authenticate before discovery"); }, initialInventory: { official: [tool("get_cached")] } });
  await assert.rejects(f.call("sentry_discover", { source: "official" }), /Authenticate/);
  assert.equal(f.peer.calls.length, 0);
  await f.bridge.close(); await f.harness.dispose();
});

test("invalid pagination never publishes a partial catalog", async () => {
  const f = fixture();
  let page = 0;
  f.peer.handler = async () => ({ tools: [tool(`get_design_${page++}`)], nextCursor: "loop" });
  await assert.rejects(f.bridge.refresh("official"), /repeated/);
  assert.deepEqual(f.bridge.inventory("official"), []);
  await f.bridge.close(); await f.harness.dispose();
});

test("2020-12 prefixItems validate correctly through generic, MCP and native routes", async () => {
  const f = fixture();
  f.peer.tools = [tool("get_tuple", { inputSchema: { type: "object", properties: {
    values: { type: "array", prefixItems: [{ type: "integer" }], items: false },
  }, required: ["values"], additionalProperties: false } })];
  try {
    await f.call("sentry_discover", {});
    for (const route of ["sentry_call", "sentry_mcp", "sentry_get_tuple"]) {
      const input = (values: unknown[]) => route === "sentry_mcp" ? { method: "tools/call", params: { name: "get_tuple", arguments: { values } } }
        : route === "sentry_call" ? { name: "get_tuple", arguments: { values } } : { values };
      await f.call(route, input([1]));
      const count = f.peer.calls.length;
      await assert.rejects(f.call(route, input(["wrong"])), /Arguments do not match/);
      await assert.rejects(f.call(route, input([1, 2])), /Arguments do not match/);
      assert.equal(f.peer.calls.length, count);
    }
    assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 3);
  } finally { await f.bridge.close(); await f.harness.dispose(); }
});

test("unsupported schema dialect is visible in discovery and remains upstream-authoritative", async () => {
  const f = fixture();
  f.peer.tools = [tool("get_custom", { inputSchema: { $schema: "https://example.test/custom", type: "object" } })];
  try {
    assert.match(text(await f.call("sentry_discover", {})), /Local validation unavailable/);
    await f.call("sentry_call", { name: "get_custom", arguments: { custom: true } });
    assert.equal(f.peer.calls.at(-1)?.method, "tools/call");
  } finally { await f.bridge.close(); await f.harness.dispose(); }
});

test("concurrent first calls share one discovery and canceled observers do not cancel another call", async () => {
  const gate = deferred<JsonObject>();
  const f = fixture();
  f.peer.handler = async method => method === "tools/list" ? gate.promise : f.peer.response;
  const controller = new AbortController();
  const first = f.harness.callAgentTool("sentry_call", { source: "official", name: "get_design" }, { signal: controller.signal });
  const second = f.call("sentry_call", { source: "official", name: "get_design" });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("observer cancelled"));
  await assert.rejects(first, /observer cancelled/);
  gate.resolve({ tools: f.peer.tools });
  await second;
  assert.equal(f.peer.calls.filter(c => c.method === "tools/list").length, 1);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("failed explicit refresh leaves aliases gated until a successful current discovery", async () => {
  const f = fixture();
  await f.call("sentry_discover", { source: "official" });
  f.peer.handler = async () => { throw new Error("temporary discovery failure"); };
  await assert.rejects(f.bridge.refresh("official"), /discovery failure/);
  await assert.rejects(f.call("sentry_get_design", {}), /discovery failure/);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  f.peer.handler = undefined;
  await f.call("sentry_get_design", {});
  assert.equal(f.peer.calls.at(-1)?.method, "tools/call");
  await f.bridge.close(); await f.harness.dispose();
});

test("discovery omits absent optional peer-info fields without losing descriptors", async () => {
  const peer: McpPeer = {
    info: () => ({ capabilities: {}, serverInfo: undefined, instructions: undefined }),
    request: async () => { throw new Error("A tool-less peer must not be scanned"); },
    close: async () => {},
  };
  const f = fixture({ getPeer: async () => peer });
  const result = await f.call("sentry_discover", { source: "official" });
  assert.deepEqual(JSON.parse(text(result).split("\n").slice(1).join("\n")).info, { capabilities: {} });
  assert.deepEqual(f.bridge.inventory("official"), []);
  await f.bridge.close(); await f.harness.dispose();
});

test("unannotated task support defaults to forbidden even if server offers task calls", async () => {
  const f = fixture();
  f.peer.capabilities = { tools: {}, tasks: { requests: { tools: { call: {} } } } };
  await assert.rejects(f.call("sentry_mcp", { source: "official", method: "tools/call", params: { name: "get_design", task: {} } }), /did not advertise task execution/);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  await f.bridge.close(); await f.harness.dispose();
});

test("UI refresh flags first-connection and newly discovered tools missing native aliases", async () => {
  const f = fixture();
  assert.equal(f.bridge.aliasesNeedReload(), false);
  await f.bridge.refresh("official");
  assert.equal(f.bridge.aliasesNeedReload(), true);
  assert.ok(!f.harness.registrations.agentTools.some(t => t.name === "sentry_get_design"));
  // The generic path remains usable immediately while UI requests native refresh.
  await f.call("sentry_call", { source: "official", name: "get_design" });
  f.bridge.registerAliases();
  assert.equal(f.bridge.aliasesNeedReload(), false);
  assert.ok(f.harness.registrations.agentTools.some(t => t.name === "sentry_get_design"));
  f.peer.tools.push(tool("read_new"));
  await f.bridge.refresh("official");
  assert.equal(f.bridge.aliasesNeedReload(), true);
  assert.ok(!f.harness.registrations.agentTools.some(t => t.name === "sentry_read_new"));
  f.bridge.registerAliases();
  assert.equal(f.bridge.aliasesNeedReload(), false);
  await f.bridge.close(); await f.harness.dispose();
});
