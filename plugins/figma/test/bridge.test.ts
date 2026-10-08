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
  const { bb, harness } = createFakePluginHost({ pluginId: "figma" });
  const peer = new Peer();
  const writes: JsonObject[] = [];
  const bridge = createBridge({ bb, getPeer: async () => peer, beforeOfficialWrite: async args => { writes.push(args); }, refreshMirror: async () => ({ content: [] }), ...extra });
  const call = (name: string, input: unknown) => harness.callAgentTool(name, input);
  return { peer, bridge, writes, harness, call };
}
function text(result: unknown): string {
  assert.ok(typeof result === "object" && result !== null && "content" in result);
  return (result.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("\n");
}

test("constructor uses cached descriptors without acquiring a peer; discover is live and all-page", async () => {
  let acquired = 0;
  const peer = new Peer();
  peer.handler = async (_method, params) => params?.cursor === "page-2"
    ? { tools: [tool("edit_design", { annotations: { readOnlyHint: false }, outputSchema: { type: "object" }, custom: { retained: true } })] }
    : { tools: [tool("get_design")], nextCursor: "page-2" };
  const f = fixture({ getPeer: async () => { acquired++; return peer; }, initialInventory: { mirror: [tool("figmog_node")] } });
  assert.equal(acquired, 0);
  assert.deepEqual(f.harness.registrations.agentTools.map(t => t.name), ["figma_discover", "figma_call", "figma_mcp", "figma_sync", "figmog_node"]);
  const result = await f.call("figma_discover", { source: "official" });
  assert.equal(acquired, 1);
  assert.deepEqual(peer.calls.map(c => c.params), [{}, { cursor: "page-2" }]);
  assert.deepEqual(f.bridge.inventory("official").map(t => t.name), ["get_design", "edit_design"]);
  assert.match(text(result), /outputSchema/);
  assert.match(text(result), /retained/);
  assert.match(text(result), /readOnlyHint/);
  assert.ok(f.harness.registrations.agentTools.some(t => t.name === "figma_edit_design"));
  await f.bridge.close(); await f.harness.dispose();
});

test("inventory is cloned, cached per peer and refreshed for unknown tools", async () => {
  const f = fixture();
  await f.call("figma_discover", { source: "official" });
  const snapshot = f.bridge.inventory("official"); snapshot[0].inputSchema.properties = {};
  assert.deepEqual(f.bridge.inventory("official")[0].inputSchema.properties, { file: { type: "string" } });
  await f.call("figma_call", { source: "official", name: "get_design", arguments: { file: "A" } });
  await f.call("figma_call", { source: "official", name: "get_design", arguments: {} });
  assert.equal(f.peer.calls.filter(c => c.method === "tools/list").length, 1);
  f.peer.tools.push(tool("read_new"));
  await f.call("figma_call", { source: "official", name: "read_new", arguments: {} });
  assert.equal(f.peer.calls.filter(c => c.method === "tools/list").length, 2);
  await f.bridge.close(); await f.harness.dispose();
});

test("alias changes/removals are fenced while generic calls use current schema", async () => {
  const f = fixture();
  await f.call("figma_discover", { source: "official" });
  await f.call("figma_get_design", { file: "A" });
  f.peer.tools = [tool("get_design", { inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } })];
  f.peer.changed();
  await assert.rejects(f.call("figma_get_design", { file: "A" }), /descriptor changed/);
  assert.equal(f.bridge.aliasesNeedReload(), true);
  await assert.rejects(f.call("figma_call", { source: "official", name: "get_design", arguments: { file: "A" } }), /current schema/);
  await f.call("figma_call", { source: "official", name: "get_design", arguments: { count: 2 } });
  f.peer.tools = []; f.peer.changed();
  await assert.rejects(f.call("figma_get_design", { file: "A" }), /absent/);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 2);
  await f.bridge.close(); await f.harness.dispose();
});

test("recursive schemas rejected by BB remain callable through generic routing", async () => {
  const f = fixture();
  const recursive = { type: "object", properties: { child: { $ref: "#" } }, additionalProperties: false };
  f.peer.tools = [tool("read_recursive", { inputSchema: recursive })];
  await f.call("figma_discover", { source: "official" });
  assert.ok(!f.harness.registrations.agentTools.some(t => t.name === "figma_read_recursive"));
  await f.call("figma_call", { source: "official", name: "read_recursive", arguments: { child: {} } });
  assert.equal(f.peer.calls.at(-1)?.method, "tools/call");
  assert.deepEqual(f.peer.calls.at(-1)?.params, { name: "read_recursive", arguments: { child: {} } });
  await f.bridge.close(); await f.harness.dispose();
});

test("native names preserve ordinary aliases and safely encode reserved, dotted and encoded names", () => {
  assert.equal(aliasName("mirror", "figmog_node"), "figmog_node");
  assert.equal(aliasName("official", "get_design_context"), "figma_get_design_context");
  const names = ["call", "discover", "mcp", "sync", "figma_call", "a.b", "a_b", "x_abc", "☀", "A".repeat(200)];
  const encoded = names.map(name => aliasName("official", name));
  assert.equal(new Set(encoded).size, names.length);
  for (const name of encoded) { assert.match(name, /^[a-zA-Z0-9_-]+$/); assert.ok(name.length <= 64); }
  assert.notEqual(aliasName("mirror", "node"), aliasName("mirror", "figmog_node"));
});

test("adaptation preserves ordered text/image/SVG/links/audio/resources and top-level result fields", () => {
  const envelope = {
    content: [
      { type: "text", text: "manifest", id: "manifest-id" },
      { type: "resource_link", uri: "figma://A/2", name: "node", annotations: { audience: ["assistant"] } },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png", id: "2", ref: "figma://A/2", annotations: { priority: 1 } },
      { type: "text", text: "<svg>inert markup</svg>", mimeType: "image/svg+xml", id: "svg" },
      { type: "resource", resource: { uri: "figma://A/3", text: "untrusted instructions", mimeType: "text/plain" } },
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
  for (const value of ["manifest-id", "resource_link", "figma://A/2", "priority", "<svg>", "image/svg+xml", "untrusted instructions", "audio/wav", "YWJj", "failedImageIds", "extension", "customField", '"isError":false']) assert.ok(out.includes(value), value);
  assert.ok(out.indexOf("resource_link") < out.indexOf("<svg>"));
  assert.equal(result.isError, undefined);
  const error = adaptEnvelope({ content: [{ type: "text", text: "upstream failed" }], isError: true });
  assert.ok(typeof error !== "string"); assert.equal(error.isError, true);
});

test("resource URI, prompt roles, task data and extension envelopes survive without a content field", () => {
  const envelope = { messages: [{ role: "user", content: { type: "text", text: "hello" } }], contents: [{ uri: "figma://node", blob: "aGk=" }], task: { taskId: "T" }, custom: [1, 2] };
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
    const params = { uri: "figma://A", extension: { preserved: true } };
    await f.call("figma_mcp", { source: "official", method, params });
    assert.equal(f.peer.calls.at(-1)?.method, method);
    assert.deepEqual(f.peer.calls.at(-1)?.params, params);
  }
  const count = f.peer.calls.length;
  f.peer.capabilities = { resources: {}, tasks: {} };
  for (const method of ["resources/subscribe", "tasks/list", "tasks/cancel", "prompts/get", "completion/complete", "tools/call"]) await assert.rejects(f.call("figma_mcp", { source: "official", method }), /did not advertise/);
  await assert.rejects(f.call("figma_mcp", { source: "official", method: "initialize" }), /not supported by this bridge/);
  assert.equal(f.peer.calls.length, count);
  await f.bridge.close(); await f.harness.dispose();
});

test("task-required tools route only with advertised task support and preserve original task params", async () => {
  const f = fixture();
  f.peer.capabilities = { tools: {}, tasks: { requests: { tools: { call: {} } } } };
  f.peer.tools = [tool("get_design", { execution: { taskSupport: "required" } })];
  await assert.rejects(f.call("figma_call", { source: "official", name: "get_design" }), /requires task execution/);
  const params = { name: "get_design", arguments: {}, task: { ttl: 5000 }, _meta: { progressToken: "progress" } };
  await f.call("figma_mcp", { source: "official", method: "tools/call", params });
  assert.deepEqual(f.peer.calls.at(-1)?.params, params);
  f.peer.capabilities = { tools: {} };
  await assert.rejects(f.call("figma_mcp", { source: "official", method: "tools/call", params }), /did not advertise task/);
  await f.bridge.close(); await f.harness.dispose();
});

test("likely writes run freshness barrier first; uncertain request failures are never retried", async () => {
  const order: string[] = [];
  const f = fixture({ beforeOfficialWrite: async args => { assert.deepEqual(args, { file: "A" }); order.push("barrier"); } });
  f.peer.tools = [tool("create_design", { annotations: { readOnlyHint: false } })];
  f.peer.handler = async method => {
    if (method === "tools/list") return { tools: f.peer.tools };
    order.push("dispatch"); throw new Error("connection lost after dispatch");
  };
  await assert.rejects(f.call("figma_call", { source: "official", name: "create_design", arguments: { file: "A" } }), /connection lost/);
  assert.deepEqual(order, ["barrier", "dispatch"]);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("generic MCP and aliases use freshness barrier while mirror and explicit reads do not", async () => {
  const f = fixture();
  f.peer.tools = [tool("create_design"), tool("unknown_action", { annotations: {} }), tool("get_design")];
  await f.call("figma_discover", { source: "official" });
  await f.call("figma_create_design", { file: "A" });
  await f.call("figma_mcp", { source: "official", method: "tools/call", params: { name: "unknown_action", arguments: {} } });
  await f.call("figma_call", { source: "official", name: "get_design" });
  await f.call("figma_call", { source: "mirror", name: "create_design" });
  assert.deepEqual(f.writes, [{ file: "A" }, {}]);
  await f.bridge.close(); await f.harness.dispose();
});

test("changed peer refreshes catalog before aliases execute", async () => {
  let peer = new Peer();
  const f = fixture({ getPeer: async () => peer });
  await f.call("figma_discover", { source: "official" });
  peer = new Peer(); peer.tools = [tool("get_design", { inputSchema: { type: "object", properties: { next: { type: "boolean" } } } })];
  await assert.rejects(f.call("figma_get_design", {}), /descriptor changed/);
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
  await assert.rejects(f.call("figma_call", { source: "official", name: "get_design" }), /closed/);
  await f.harness.dispose();
});

test("cancellation during write preparation prevents upstream dispatch", async () => {
  const gate = deferred<void>();
  const f = fixture({ beforeOfficialWrite: () => gate.promise });
  f.peer.tools = [tool("create_design")];
  const controller = new AbortController();
  const call = f.harness.callAgentTool("figma_call", { source: "official", name: "create_design" }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("cancelled fixture"));
  await assert.rejects(call, /cancelled fixture/);
  gate.resolve();
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  await f.bridge.close(); await f.harness.dispose();
});

test("unauthenticated discovery rejects rather than displaying a cached inventory as live", async () => {
  const f = fixture({ getPeer: async () => { throw new Error("Authenticate before discovery"); }, initialInventory: { official: [tool("get_cached")] } });
  await assert.rejects(f.call("figma_discover", { source: "official" }), /Authenticate/);
  assert.equal(f.peer.calls.length, 0);
  await f.bridge.close(); await f.harness.dispose();
});

test("invalid pagination never publishes a partial catalog", async () => {
  const f = fixture();
  f.peer.handler = async () => ({ tools: [tool("get_design")], nextCursor: "loop" });
  await assert.rejects(f.bridge.refresh("official"), /Duplicate|repeated/);
  assert.deepEqual(f.bridge.inventory("official"), []);
  await f.bridge.close(); await f.harness.dispose();
});

test("concurrent first calls share one discovery and canceled observers do not cancel another call", async () => {
  const gate = deferred<JsonObject>();
  const f = fixture();
  f.peer.handler = async method => method === "tools/list" ? gate.promise : f.peer.response;
  const controller = new AbortController();
  const first = f.harness.callAgentTool("figma_call", { source: "official", name: "get_design" }, { signal: controller.signal });
  const second = f.call("figma_call", { source: "official", name: "get_design" });
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
  await f.call("figma_discover", { source: "official" });
  f.peer.handler = async () => { throw new Error("temporary discovery failure"); };
  await assert.rejects(f.bridge.refresh("official"), /discovery failure/);
  await assert.rejects(f.call("figma_get_design", {}), /discovery failure/);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  f.peer.handler = undefined;
  await f.call("figma_get_design", {});
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
  const result = await f.call("figma_discover", { source: "official" });
  assert.deepEqual(JSON.parse(text(result).split("\n").slice(1).join("\n")).info, { capabilities: {} });
  assert.deepEqual(f.bridge.inventory("official"), []);
  await f.bridge.close(); await f.harness.dispose();
});

test("unannotated task support defaults to forbidden even if server offers task calls", async () => {
  const f = fixture();
  f.peer.capabilities = { tools: {}, tasks: { requests: { tools: { call: {} } } } };
  await assert.rejects(f.call("figma_mcp", { source: "official", method: "tools/call", params: { name: "get_design", task: {} } }), /did not advertise task execution/);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  await f.bridge.close(); await f.harness.dispose();
});

test("catalog notification during a freshness barrier cancels dispatch rather than miscalling", async () => {
  const f = fixture({ beforeOfficialWrite: async () => { f.peer.tools = []; f.peer.changed(); } });
  f.peer.tools = [tool("create_design")];
  await assert.rejects(f.call("figma_call", { source: "official", name: "create_design" }), /catalog changed before dispatch/);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  await f.bridge.close(); await f.harness.dispose();
});

test("UI refresh flags first-connection and newly discovered tools missing native aliases", async () => {
  const f = fixture();
  assert.equal(f.bridge.aliasesNeedReload(), false);
  await f.bridge.refresh("official");
  assert.equal(f.bridge.aliasesNeedReload(), true);
  assert.ok(!f.harness.registrations.agentTools.some(t => t.name === "figma_get_design"));
  // The generic path remains usable immediately while UI requests native refresh.
  await f.call("figma_call", { source: "official", name: "get_design" });
  f.bridge.registerAliases();
  assert.equal(f.bridge.aliasesNeedReload(), false);
  assert.ok(f.harness.registrations.agentTools.some(t => t.name === "figma_get_design"));
  f.peer.tools.push(tool("read_new"));
  await f.bridge.refresh("official");
  assert.equal(f.bridge.aliasesNeedReload(), true);
  assert.ok(!f.harness.registrations.agentTools.some(t => t.name === "figma_read_new"));
  f.bridge.registerAliases();
  assert.equal(f.bridge.aliasesNeedReload(), false);
  await f.bridge.close(); await f.harness.dispose();
});

test("overlapping official writes retain independent finishers and finish in upstream settlement order", async () => {
  const one = deferred<JsonObject>();
  const two = deferred<JsonObject>();
  const events: string[] = [];
  const f = fixture({ beforeOfficialWrite: async args => {
    const file = String(args.file); events.push(`begin ${file}`);
    return async outcome => { events.push(`end ${file} ${outcome}`); };
  } });
  f.peer.tools = [tool("create_design")];
  f.peer.handler = async (method, params) => {
    if (method === "tools/list") return { tools: f.peer.tools };
    const file = String((params?.arguments as JsonObject).file); events.push(`dispatch ${file}`);
    return file === "W1" ? one.promise : two.promise;
  };
  const first = f.call("figma_call", { source: "official", name: "create_design", arguments: { file: "W1" } });
  const second = f.call("figma_mcp", { source: "official", method: "tools/call", params: { name: "create_design", arguments: { file: "W2" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["begin W1", "begin W2", "dispatch W1", "dispatch W2"]);
  two.resolve({ content: [{ type: "text", text: "W2 result" }], isError: false });
  assert.match(text(await second), /W2 result/);
  assert.deepEqual(events.slice(-1), ["end W2 completed"]);
  assert.ok(!events.includes("end W1 completed"));
  one.resolve({ content: [{ type: "text", text: "W1 result" }], isError: false });
  assert.match(text(await first), /W1 result/);
  assert.deepEqual(events.slice(-2), ["end W2 completed", "end W1 completed"]);
  await f.bridge.close(); await f.harness.dispose();
});

test("post-write cleanup failure preserves successful images, extension fields and upstream error flag", async () => {
  const outcomes: string[] = [];
  const f = fixture({ beforeOfficialWrite: async () => async outcome => {
    outcomes.push(outcome); throw new Error("private cleanup failure contents must not appear");
  } });
  f.peer.tools = [tool("create_design")];
  f.peer.response = { content: [{ type: "image", data: "AQID", mimeType: "image/png", id: "node" }, { type: "text", text: "actual official result" }], structuredContent: { mutationId: "M" }, custom: "kept", isError: false };
  const result = await f.call("figma_call", { source: "official", name: "create_design" });
  assert.ok(typeof result !== "string");
  assert.deepEqual(result.content[0], { type: "image", data: "AQID", mimeType: "image/png" });
  assert.equal(result.isError, undefined);
  for (const value of ["node", "actual official result", "mutationId", "kept", "refresh-pending"]) assert.ok(text(result).includes(value));
  assert.ok(!text(result).includes("private cleanup failure contents"));
  f.peer.response = { content: [{ type: "text", text: "original upstream tool error" }], isError: true };
  const errorResult = await f.call("figma_call", { source: "official", name: "create_design" });
  assert.ok(typeof errorResult !== "string");
  assert.equal(errorResult.isError, true);
  assert.equal(errorResult.content[0].type, "text");
  assert.match(text(errorResult), /original upstream tool error/);
  assert.deepEqual(outcomes, ["completed", "completed"]);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 2);
  await f.bridge.close(); await f.harness.dispose();
});

test("request failure finishes uncertain once and cleanup failure never replaces original upstream error", async () => {
  const outcomes: string[] = [];
  const original = new Error("original upstream response loss");
  const f = fixture({ beforeOfficialWrite: async () => async outcome => {
    outcomes.push(outcome); throw new Error("secondary cleanup error");
  } });
  f.peer.tools = [tool("create_design")];
  f.peer.handler = async method => { if (method === "tools/list") return { tools: f.peer.tools }; throw original; };
  await assert.rejects(f.call("figma_call", { source: "official", name: "create_design" }), error => error === original);
  assert.deepEqual(outcomes, ["uncertain"]);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("cancellation during dispatched write retires ticket as uncertain even if peer ignores abort", async () => {
  const reply = deferred<JsonObject>();
  const outcomes: string[] = [];
  const f = fixture({ beforeOfficialWrite: async () => async outcome => { outcomes.push(outcome); } });
  f.peer.tools = [tool("create_design")];
  f.peer.handler = async method => method === "tools/list" ? { tools: f.peer.tools } : reply.promise;
  const controller = new AbortController();
  const call = f.harness.callAgentTool("figma_call", { source: "official", name: "create_design" }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(call, /fixture cancellation/);
  assert.deepEqual(outcomes, ["uncertain"]);
  reply.resolve({ content: [{ type: "text", text: "late upstream result" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(outcomes, ["uncertain"]);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("late ticket after cancellation during preparation is retired without dispatch", async () => {
  const preparation = deferred<import("../bridge.ts").OfficialWriteFinisher>();
  const outcomes: string[] = [];
  const f = fixture({ beforeOfficialWrite: () => preparation.promise });
  f.peer.tools = [tool("create_design")];
  const controller = new AbortController();
  const call = f.harness.callAgentTool("figma_call", { source: "official", name: "create_design" }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("cancelled before preparation completed"));
  await assert.rejects(call, /cancelled before preparation/);
  preparation.resolve(async outcome => { outcomes.push(outcome); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(outcomes, ["uncertain"]);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  await f.bridge.close(); await f.harness.dispose();
});

test("catalog change after ticket preparation finishes uncertain without dispatch", async () => {
  const outcomes: string[] = [];
  const f = fixture({ beforeOfficialWrite: async () => {
    f.peer.tools = []; f.peer.changed(); return async outcome => { outcomes.push(outcome); };
  } });
  f.peer.tools = [tool("create_design")];
  await assert.rejects(f.call("figma_call", { source: "official", name: "create_design" }), /catalog changed/);
  assert.deepEqual(outcomes, ["uncertain"]);
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call"));
  await f.bridge.close(); await f.harness.dispose();
});

test("same-descriptor explicit refresh during slow write preparation still dispatches once", async () => {
  const preparation = deferred<void>();
  const refreshedPage = deferred<JsonObject>();
  const f = fixture({ beforeOfficialWrite: () => preparation.promise });
  f.peer.tools = [tool("create_design")];
  await f.bridge.refresh("official");
  const call = f.call("figma_call", { source: "official", name: "create_design" });
  await new Promise(resolve => setImmediate(resolve));
  f.peer.handler = async method => method === "tools/list" ? refreshedPage.promise : f.peer.response;
  const refresh = f.bridge.refresh("official");
  await new Promise(resolve => setImmediate(resolve));
  preparation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.peer.calls.every(c => c.method !== "tools/call")); // Join the pending refresh.
  refreshedPage.resolve({ tools: f.peer.tools });
  await refresh;
  await call;
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("same-descriptor list-change notification during preparation does not cancel write", async () => {
  const outcomes: string[] = [];
  const f = fixture({ beforeOfficialWrite: async () => {
    f.peer.changed(); return async outcome => { outcomes.push(outcome); };
  } });
  f.peer.tools = [tool("create_design")];
  await f.call("figma_call", { source: "official", name: "create_design" });
  assert.deepEqual(outcomes, ["completed"]);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/list").length, 2);
  assert.equal(f.peer.calls.filter(c => c.method === "tools/call").length, 1);
  await f.bridge.close(); await f.harness.dispose();
});

test("agent mirror sync defaults to verified heuristic and requires explicit unverified acceptance", async () => {
  const seen: { file: string | undefined; acceptUnverified: boolean; signal?: AbortSignal }[] = [];
  const f = fixture({ refreshMirror: async (file, acceptUnverified, signal) => {
    seen.push({ file, acceptUnverified, signal });
    if (!acceptUnverified) throw new Error("refresh-pending: earlier edit visibility cannot be confirmed");
    return { content: [{ type: "text", text: "Mirror synchronized" }], _meta: { bbFigmaFreshness: { state: "rebaselined", mutationVisibilityVerified: false } } };
  } });
  await assert.rejects(f.call("figma_sync", { file: "A" }), /refresh-pending/);
  assert.equal(seen[0].acceptUnverified, false);
  const result = await f.call("figma_sync", { file: "A", acceptUnverified: true });
  assert.equal(seen[1].acceptUnverified, true);
  assert.ok(seen.every(item => item.signal instanceof AbortSignal));
  assert.match(text(result), /"mutationVisibilityVerified":false/);
  assert.equal(f.peer.calls.length, 0); // Recovery neither acquires official peer nor replays an edit.
  const registration = f.harness.registrations.agentTools.find(tool => tool.name === "figma_sync");
  assert.match(registration!.description, /heuristic/);
  assert.match(registration!.description, /without confirming/);
  assert.match(registration!.description, /Per-file recovery leaves the global/);
  await f.call("figma_sync", { acceptUnverified: true });
  assert.equal(seen[2].file, undefined);
  assert.equal(seen[2].acceptUnverified, true);
  await f.bridge.close(); await f.harness.dispose();
});

test("agent sync cancellation reaches mirror callback and rejects without replay", async () => {
  const reply = deferred<JsonObject>();
  let receivedSignal: AbortSignal | undefined;
  let syncCalls = 0;
  const f = fixture({ refreshMirror: async (_file, _accept, signal) => {
    receivedSignal = signal; syncCalls++; return reply.promise;
  } });
  const controller = new AbortController();
  const sync = f.harness.callAgentTool("figma_sync", { file: "A" }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("cancel sync fixture"));
  await assert.rejects(sync, /cancel sync fixture/);
  assert.equal(receivedSignal?.aborted, true);
  reply.resolve({ content: [] });
  assert.equal(syncCalls, 1);
  assert.equal(f.peer.calls.length, 0);
  await f.bridge.close(); await f.harness.dispose();
});

test("task-augmented or returned-task writes finish uncertain and preserve task result for inspection", async () => {
  const outcomes: string[] = [];
  const f = fixture({ beforeOfficialWrite: async () => async outcome => { outcomes.push(outcome); } });
  f.peer.capabilities = { tools: {}, tasks: { requests: { tools: { call: {} } } } };
  f.peer.tools = [tool("create_design", { execution: { taskSupport: "optional" } })];
  f.peer.response = { task: { taskId: "T1", status: "working", ttl: 60000 }, _meta: { custom: "task preserved" } };
  const requested = await f.call("figma_mcp", { source: "official", method: "tools/call", params: { name: "create_design", arguments: {}, task: { ttl: 60000 } } });
  assert.match(text(requested), /"taskId":"T1"/);
  assert.match(text(requested), /task preserved/);
  assert.match(text(requested), /dispatch acceptance does not confirm edit completion/);
  assert.match(text(requested), /terminal task result with figma_mcp/);
  // Returned task objects are equally uncertain even without a task request parameter.
  await f.call("figma_call", { source: "official", name: "create_design" });
  // A task request cannot certify completion merely because its response lacks task data.
  f.peer.response = { content: [{ type: "text", text: "accepted asynchronous work" }] };
  const accepted = await f.call("figma_mcp", { source: "official", method: "tools/call", params: { name: "create_design", task: {} } });
  assert.match(text(accepted), /accepted asynchronous work/);
  assert.match(text(accepted), /Figma write task is pending/);
  assert.deepEqual(outcomes, ["uncertain", "uncertain", "uncertain"]);
  assert.equal(f.peer.calls.filter(call => call.method === "tools/call").length, 3);
  await f.bridge.close(); await f.harness.dispose();
});
