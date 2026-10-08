import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createMirrorManager } from "../mirror/runtime.ts";
import type { JsonObject } from "../contract.ts";

const binary = process.env.FIGMOG_TEST_BINARY;
const execute = promisify(execFile);
const parse = (result: JsonObject) => JSON.parse((result.content as { text: string }[])[0]!.text);

test("explicitly configured official binary: actual SDK discovery, fixture and reopened file inventory", { skip: !binary }, async () => {
  const root = await mkdtemp(join(tmpdir(), "figmog-real-"));
  // This placeholder is not a user credential. The very long interval prevents
  // polling; the synthetic mirror is imported locally before any file is opened.
  const config = { binaryPath: binary!, token: "synthetic-offline-fixture", intervalSeconds: 86400 };
  const manager = createMirrorManager({ directory: join(root, "cache"), config, requestTimeoutMs: 1000 });
  try {
    const peer = await manager.peer();
    const tools = await peer.request("tools/list");
    const names = (tools.tools as { name: string }[]).map(t => t.name);
    assert.equal(names.length, 21); assert.ok(names.includes("figmog_images"));
    const source = JSON.parse(await readFile(new URL("./mirror-registry-v0.0.2.json", import.meta.url), "utf8"));
    assert.deepEqual(tools, source);
    const generation = (await readdir(join(root, "cache")))[0]!;
    const cwd = join(root, "cache", generation);
    const fixture = join(root, "fixture.json");
    await writeFile(fixture, JSON.stringify({ name: "Offline fixture", version: "100", lastModified: "2026-10-07T00:00:00Z", document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [{ id: "1:1", name: "Title", type: "TEXT", characters: "offline proof", children: [] }] }] }, components: {}, componentSets: {}, styles: {} }));
    await execute(binary!, ["pull", "FixtureA123456", "--from-file", fixture], { cwd, env: { PATH: process.env.PATH }, timeout: 1000 });
    const node = await peer.request("tools/call", { name: "figmog_node", arguments: { file: "FixtureA123456", id: "1-1" } });
    assert.equal(parse(node).characters, "offline proof");
    await manager.restart();
    await (await manager.peer()).request("tools/call", { name: "figmog_node", arguments: { file: "FixtureA123456", id: "1:1" } });
    const files = parse(await (await manager.peer()).request("tools/call", { name: "figmog_files", arguments: {} }));
    assert.equal(files[0].key, "FixtureA123456");
    assert.equal(files[0].version, "100");
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
