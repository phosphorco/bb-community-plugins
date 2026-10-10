import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createFigmaCli } from "../cli.ts";
import { createBridge } from "../bridge.ts";
import type { JsonObject, McpPeer } from "../contract.ts";

function metadata(stdout: string) {
  const text = JSON.parse(stdout).content[0].text as string;
  return JSON.parse(text.slice(text.indexOf("{")));
}
async function fixture() {
  const fake = createFakePluginHost({ pluginId: "figma" });
  const calls: { method: string; params?: JsonObject }[] = [];
  let finished = 0;
  let fail = false;
  const peer: McpPeer = {
    info: () => ({ capabilities: { tools: {}, resources: {} } }),
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "tools/list") return { tools: [
        { name: "whoami", inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } },
      ] };
      if (fail) throw new Error("Figma tool outcome unknown; inspect the canvas before retrying.");
      return { content: [{ type: "text", text: "fixture answer" }], isError: false };
    },
    close: async () => {},
  };
  const bridge = createBridge({
    bb: fake.bb, getPeer: async () => peer,
    beforeOfficialWrite: async () => async () => { finished++; },
    refreshMirror: async (file, acceptUnverified) => ({ file: file ?? null, acceptUnverified }),
  });
  fake.bb.cli.register(createFigmaCli(bridge));
  return { ...fake, calls, bridge, fail: () => { fail = true; }, finished: () => finished,
    run: (args: string[], signal?: AbortSignal) => fake.harness.behavior.runCli(args, { signal }),
    close: async () => { await bridge.close(); await fake.harness.lifecycle.dispose(); },
  };
}

test("native CLI help and malformed input perform no network operation", async () => {
  const f = await fixture();
  try {
    for (const args of [["--help"], ["call", "--help"], ["mcp", "--help"]]) {
      assert.equal((await f.run(args)).exitCode, 0);
    }
    for (const args of [["call", "whoami", "--arguments", "[]", "--json"], ["call", "whoami", "--arguments", "bad", "--json"], ["call", "--json"], ["call", "whoami", "--source", "bad", "--json"]]) {
      assert.equal((await f.run(args)).exitCode, 1);
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test("CLI discovers native aliases and calls the same validated MCP handler", async () => {
  const f = await fixture();
  try {
    const discovery = await f.run(["discover", "--json"]);
    assert.equal(discovery.exitCode, 0);
    const inventory = metadata(discovery.stdout);
    assert.equal(inventory.tools.length, 2);
    assert.ok(f.harness.inspection.registrations.agentTools.some(t => t.name === "figma_whoami"));
    const bad = await f.run(["call", "use_figma", "--arguments", '{"code":42}', "--json"]);
    assert.equal(bad.exitCode, 1);
    assert.equal(f.calls.filter(c => c.method === "tools/call").length, 0);
    const result = await f.run(["call", "whoami", "--json"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(f.calls.at(-1), { method: "tools/call", params: { name: "whoami", arguments: {} } });
  } finally { await f.close(); }
});

test("CLI writes share uncertain cleanup and never replay; cancellation is preserved", async () => {
  const f = await fixture();
  try {
    f.fail();
    const response = await f.run(["call", "use_figma", "--arguments", '{"code":"return 1"}', "--json"]);
    assert.equal(response.exitCode, 1);
    assert.match(response.stdout!, /outcome unknown/);
    assert.equal(f.calls.filter(c => c.method === "tools/call").length, 1);
    assert.equal(f.finished(), 1);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const cancelled = await f.run(["call", "use_figma", "--arguments", '{"code":"return 1"}', "--json"], controller.signal);
    assert.equal(cancelled.exitCode, 1);
    assert.equal(f.calls.filter(c => c.method === "tools/call").length, 1);
  } finally { await f.close(); }
});

test("CLI resource reads preserve arguments and cache acceptance requires explicit opt-in", async () => {
  const f = await fixture();
  try {
    await f.run(["mcp", "resources/read", "--arguments", '{"uri":"skill://figma/figma-use/SKILL.md"}', "--json"]);
    assert.deepEqual(f.calls.at(-1), { method: "resources/read", params: { uri: "skill://figma/figma-use/SKILL.md" } });
    const strict = await f.run(["sync", "file-A", "--json"]);
    assert.equal(metadata(strict.stdout).acceptUnverified, false);
    const accepted = await f.run(["sync", "file-A", "--accept-unverified", "--json"]);
    assert.equal(metadata(accepted.stdout).acceptUnverified, true);
  } finally { await f.close(); }
});
