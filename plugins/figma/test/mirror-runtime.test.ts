import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMirrorManager } from "../mirror/runtime.ts";
import type { JsonObject, McpPeer, MirrorManager } from "../contract.ts";

async function fixture(timeout = 1000) {
  const root = await mkdtemp(join(tmpdir(), "figmog-manager-"));
  const binary = join(root, "figmog");
  await copyFile(fileURLToPath(new URL("./mirror-child.mjs", import.meta.url)), binary); await chmod(binary, 0o700);
  let control: JsonObject = { expectedToken: "fixture-one", versions: { A: "100", B: "200", C: "300" } };
  const update = async (value: JsonObject) => { control = { ...control, ...value }; await writeFile(join(root, "control.json"), JSON.stringify(control)); };
  await update({});
  const config = { binaryPath: binary, token: "fixture-one" };
  const directory = join(root, "private");
  const manager = createMirrorManager({ directory, config, requestTimeoutMs: timeout });
  const events = async (): Promise<JsonObject[]> => (await readFile(join(root, "events.jsonl"), "utf8")).trim().split('\n').map(line => JSON.parse(line));
  const cleanup = async () => { await manager.close(); await rm(root, { recursive: true, force: true }); };
  return { root, directory, binary, config, manager, update, events, cleanup };
}
const call = (peer: McpPeer, name: string, args: JsonObject = {}, signal?: AbortSignal) => peer.request("tools/call", { name, arguments: args }, signal);
const data = (result: JsonObject) => JSON.parse((result.content as { text: string }[])[0]!.text);

async function read(manager: MirrorManager, file: string) { return data(await call(await manager.peer(), "figmog_node", { file, id: "1:1" })); }

test("shared SDK process preserves full result envelopes and drains secret diagnostics", async () => {
  const f = await fixture();
  try {
    const peers = await Promise.all(Array.from({ length: 10 }, () => f.manager.peer()));
    assert.ok(peers.every(p => p === peers[0]));
    assert.deepEqual(await call(peers[0]!, "echo"), { content: [{ type: "image", data: "AQID", mimeType: "image/png", id: "1:1" }, { type: "text", text: "<svg/>", mimeType: "image/svg+xml", ref: "a" }], structuredContent: { a: 1 }, _meta: { extension: true }, isError: false });
    assert.equal(f.manager.status().serverVersion, "0.0.2");
    assert.equal((await f.events()).filter(e => e.kind === "start").length, 1);
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    await read(f.manager, "A");
    const generations = await readdir(f.directory);
    assert.equal((await stat(join(f.directory, generations[0]!, "mirror-state.json"))).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(f.manager.status()).includes("fixture-one"));
  } finally { await f.cleanup(); }
});

test("dirty reads fail until a changed version, with persistence through restart and manager reopen", async () => {
  const f = await fixture(); let reopened: MirrorManager | undefined;
  try {
    assert.equal((await read(f.manager, "A")).version, "100");
    await f.manager.markDirty("https://www.figma.com/design/A/Fixture");
    await assert.rejects(read(f.manager, "A"), /refresh-pending/);
    await f.manager.restart();
    await assert.rejects(read(f.manager, "A"), /refresh-pending/);
    await f.manager.close();
    reopened = createMirrorManager({ directory: f.directory, config: f.config });
    await assert.rejects(read(reopened, "A"), /refresh-pending/);
    await f.update({ versions: { A: "101" } });
    assert.equal((await read(reopened, "A")).version, "101");
    assert.equal((await read(reopened, "A")).version, "101");
    const logs = await f.events();
    assert.equal(logs.filter(e => e.name === "figmog_sync").length, 5);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test("unknown official target fences all known files and untracked reopened files", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A"); await read(f.manager, "B");
    await f.manager.markDirty();
    await assert.rejects(read(f.manager, "A"), /refresh-pending/);
    await f.update({ versions: { A: "101", B: "201", C: "301" } });
    assert.equal((await read(f.manager, "A")).version, "101");
    await assert.rejects(read(f.manager, "C"), /refresh-pending/);
    assert.equal((await read(f.manager, "B")).version, "201");
    await f.manager.restart();
    await assert.rejects(read(f.manager, "C"), /refresh-pending/);
    await assert.rejects(call(await f.manager.peer(), "figmog_node", { id: "1:1" }), /explicit file/);
  } finally { await f.cleanup(); }
});

test("failed sync preserves baseline; sequential writes require a newly captured baseline", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A"); await f.manager.markDirty("A");
    await f.update({ syncError: true, versions: { A: "101" } });
    await assert.rejects(f.manager.refresh("A"), /synchronization failed/);
    await assert.rejects(f.manager.markDirty("A"), /synchronization failed/);
    await f.update({ syncError: false });
    await f.manager.markDirty("A"); // First write is visible at 101; second captures 101.
    await assert.rejects(read(f.manager, "A"), /changed version has not been observed/);
    await f.update({ versions: { A: "102" } });
    assert.equal((await read(f.manager, "A")).version, "102");
  } finally { await f.cleanup(); }
});

test("token replacement isolates stores and ordinary restart uses the same generation", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A"); await f.manager.restart();
    await f.update({ expectedToken: "fixture-two" });
    await f.manager.configure({ binaryPath: f.binary, token: "fixture-two" });
    await f.manager.peer();
    const starts = (await f.events()).filter(e => e.kind === "start");
    assert.equal(starts[0]!.cwd, starts[1]!.cwd);
    assert.notEqual(starts[1]!.cwd, starts[2]!.cwd);
    assert.ok(starts.every(e => e.tokenMatches));
    assert.equal((await readdir(f.directory)).length, 2);
    await f.manager.configure({ binaryPath: f.binary, token: "" });
    await assert.rejects(f.manager.peer(), /read token/);
  } finally { await f.cleanup(); }
});

test("timeout and cancellation stop the process, and queued calls are bounded", async () => {
  const f = await fixture(200);
  try {
    const peer = await f.manager.peer();
    await assert.rejects(call(peer, "hang"), /timed out/);
    assert.equal(f.manager.status().phase, "error");
    const controller = new AbortController();
    const hanging = call(await f.manager.peer(), "hang", {}, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(hanging, /cancelled/);
    const calls = Array.from({ length: 40 }, () => f.manager.peer());
    const settled = await Promise.allSettled(calls);
    assert.ok(settled.some(r => r.status === "rejected" && /queue is full/.test(String(r.reason))));
  } finally { await f.cleanup(); }
});

test("rotation fences active and queued calls; close is idempotent and permanent", async () => {
  const f = await fixture();
  try {
    const peer = await f.manager.peer();
    const inFlight = call(peer, "hang");
    const queued = call(peer, "echo");
    const results = Promise.allSettled([inFlight, queued]);
    await f.manager.configure({ binaryPath: f.binary, token: "fixture-two" });
    assert.ok((await results).every(r => r.status === "rejected"));
    await f.manager.close(); await f.manager.close();
    await assert.rejects(f.manager.peer(), /disposed/);
  } finally { await f.cleanup(); }
});

test("invalid executable and corrupted freshness state fail without exposing secrets", async () => {
  const f = await fixture();
  try {
    await f.manager.configure({ binaryPath: "relative/figmog", token: "fixture-secret" });
    await assert.rejects(f.manager.peer(), /absolute/);
    await f.manager.configure(f.config); await read(f.manager, "A"); await f.manager.close();
    const generation = (await readdir(f.directory))[0]!;
    await writeFile(join(f.directory, generation, "mirror-state.json"), '{"version":1}');
    const next = createMirrorManager({ directory: f.directory, config: f.config });
    try { await assert.rejects(next.peer(), /freshness state is invalid/); }
    finally { await next.close(); }
  } finally { await f.cleanup(); }
});

test("transport errors are redacted; unexpected child exit reconnects safely", async () => {
  const f = await fixture();
  try {
    const peer = await f.manager.peer();
    await assert.rejects(peer.request("resources/list"), error => /-32601/.test(String(error)) && !String(error).includes("fixture-one"));
    await assert.rejects(call(peer, "exit"));
    await f.manager.peer();
    assert.equal((await f.events()).filter(e => e.kind === "start").length, 2);
  } finally { await f.cleanup(); }
});

test("oversized stdio output and diagnostic flooding fail explicitly", async () => {
  const f = await fixture();
  try {
    await assert.rejects(call(await f.manager.peer(), "huge"));
    await f.manager.configure(f.config);
    await f.update({ mode: "stderr-flood" });
    await f.manager.peer().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.manager.status().phase, "error");
  } finally { await f.cleanup(); }
});

test("startup cancellation and concurrent configuration cannot resurrect an old process", async () => {
  const f = await fixture(500);
  try {
    await f.update({ mode: "startup-hang" });
    const starting = f.manager.peer();
    const caught = assert.rejects(starting);
    // Observe actual child startup instead of depending on machine scheduling.
    const deadline = Date.now() + 1000;
    while (true) {
      try { if ((await f.events()).some(e => e.kind === "start")) break; } catch { /* Not created yet. */ }
      if (Date.now() > deadline) throw new Error("Fixture child did not start.");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await f.manager.configure({ binaryPath: f.binary, token: "fixture-two" });
    await caught;
    await f.update({ mode: "normal", expectedToken: "fixture-two" });
    await f.manager.peer();
    const starts = (await f.events()).filter(e => e.kind === "start");
    assert.equal(starts.length, 2);
    assert.ok(starts[1]!.tokenMatches);
  } finally { await f.cleanup(); }
});

test("explicit per-file recovery discloses uncertainty; bulk acceptance releases future-file fence", async () => {
  const f = await fixture();
  try {
    await f.manager.markDirty(); // No file version existed before the possible write.
    await assert.rejects(read(f.manager, "A"), /pre-write version is unavailable/);
    await f.manager.restart();
    // An agent's normal sync call stays strict; only explicit settings refresh opts in.
    await assert.rejects(call(await f.manager.peer(), "figmog_sync", { file: "A" }), /refresh-pending/);
    await assert.rejects(f.manager.refresh("A"), /refresh-pending/);
    const recovered = await f.manager.refresh("A", undefined, true);
    assert.equal((recovered._meta as JsonObject).bbFigmaFreshness && ((recovered._meta as JsonObject).bbFigmaFreshness as JsonObject).mutationVisibilityVerified, false);
    assert.equal(data(recovered).changed, 1);
    assert.equal((await read(f.manager, "A")).version, "100");
    await assert.rejects(read(f.manager, "B"), /pre-write version is unavailable/);
    await f.manager.refresh(undefined, undefined, true);
    assert.equal((await read(f.manager, "B")).version, "200");
    assert.equal((await read(f.manager, "C")).version, "300");
    // A genuine known old version still cannot be cleared by explicit refresh.
    await f.manager.markDirty("A");
    await assert.rejects(f.manager.refresh("A"), /changed version has not been observed/);
  } finally { await f.cleanup(); }
});

test("unchanged configuration is a no-op and relative executable status is actionable", async () => {
  const f = await fixture();
  try {
    await f.manager.peer();
    await f.manager.configure({ ...f.config });
    await f.manager.configure({ ...f.config, intervalSeconds: 10 });
    await f.manager.peer();
    assert.equal((await f.events()).filter(e => e.kind === "start").length, 1);
    await f.manager.configure({ binaryPath: "figmog", token: "fixture-one" });
    assert.equal(f.manager.status().phase, "error");
    assert.match(f.manager.status().detail!, /absolute executable path/);
  } finally { await f.cleanup(); }
});

test("process replacement changes peer identity and forces fresh schema discovery", async () => {
  const f = await fixture();
  try {
    await f.update({ catalogVersion: "old_schema" });
    const old = await f.manager.peer();
    assert.equal((await old.request("tools/list")).tools && ((await old.request("tools/list")).tools as JsonObject[])[0]!.name, "old_schema");
    await f.update({ catalogVersion: "new_schema" });
    await f.manager.restart();
    const restarted = await f.manager.peer();
    assert.notEqual(restarted, old);
    await assert.rejects(old.request("tools/list"), /Rediscover tools/);
    assert.equal(((await restarted.request("tools/list")).tools as JsonObject[])[0]!.name, "new_schema");
    const replacement = join(f.root, "figmog-next");
    await copyFile(f.binary, replacement); await chmod(replacement, 0o700);
    await f.manager.configure({ ...f.config, binaryPath: replacement });
    const replaced = await f.manager.peer();
    assert.notEqual(replaced, restarted);
    assert.equal(((await replaced.request("tools/list")).tools as JsonObject[])[0]!.name, "new_schema");
  } finally { await f.cleanup(); }
});

test("offline write tickets persist intent without depending on executable or unseen file access", async () => {
  const f = await fixture();
  try {
    await f.manager.configure({ binaryPath: join(f.root, "does-not-exist"), token: "fixture-one" });
    const ticket = await f.manager.beginWrite("UNSEEN");
    await f.manager.endWrite(ticket, "completed");
    await assert.rejects(readFile(join(f.root, "events.jsonl")), { code: "ENOENT" });
    const generation = (await readdir(f.directory))[0]!;
    const durable = JSON.parse(await readFile(join(f.directory, generation, "mirror-state.json"), "utf8"));
    assert.deepEqual(durable.files, {});
    assert.deepEqual(durable.dirty, {});
    assert.deepEqual(durable.active, {});
    await f.manager.configure(f.config);
    assert.equal((await read(f.manager, "UNSEEN")).version, "100");
  } finally { await f.cleanup(); }
});

test("active write tickets block reads and explicit sync while catalog remains available", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A");
    const ticket = await f.manager.beginWrite("A");
    await f.update({ versions: { A: "101" } });
    await (await f.manager.peer()).request("tools/list");
    await assert.rejects(read(f.manager, "A"), /write is in flight/);
    await assert.rejects(f.manager.refresh("A", undefined, true), /write is in flight/);
    await f.manager.restart();
    await assert.rejects(read(f.manager, "A"), /write is in flight/);
    await f.manager.endWrite(ticket, "completed");
    assert.equal((await read(f.manager, "A")).version, "101");
  } finally { await f.cleanup(); }
});

test("overlapping and uncertain official writes require disclosed recovery after both finish", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A");
    const first = await f.manager.beginWrite("A");
    const second = await f.manager.beginWrite("A");
    await f.update({ versions: { A: "101" } });
    await f.manager.endWrite(first, "completed");
    await assert.rejects(read(f.manager, "A"), /write is in flight/);
    await f.manager.endWrite(second, "completed");
    await assert.rejects(read(f.manager, "A"), /pre-write version is unavailable/);
    await f.manager.refresh("A", undefined, true);
    const uncertain = await f.manager.beginWrite("A");
    await f.manager.endWrite(uncertain, "uncertain");
    await assert.rejects(f.manager.refresh("A"), /pre-write version is unavailable/);
  } finally { await f.cleanup(); }
});

test("durable active ticket recovery converts to uncertainty after manager reconstruction", async () => {
  const f = await fixture(); let reopened: MirrorManager | undefined;
  try {
    await read(f.manager, "A");
    const ticket = await f.manager.beginWrite("A");
    await f.manager.close();
    reopened = createMirrorManager({ directory: f.directory, config: f.config });
    await assert.rejects(read(reopened, "A"), /pre-write version is unavailable/);
    await reopened.endWrite(ticket, "completed"); // Old receipt cannot certify a recovered write.
    await assert.rejects(read(reopened, "A"), /pre-write version is unavailable/);
    await reopened.refresh("A", undefined, true);
    assert.equal((await read(reopened, "A")).version, "100");
  } finally { await reopened?.close(); await f.cleanup(); }
});

test("bulk acceptance keeps failed files and global fence, with per-file partial receipts", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A"); await read(f.manager, "B");
    const ticket = await f.manager.beginWrite(); await f.manager.endWrite(ticket, "uncertain");
    await f.update({ syncErrors: ["B"] });
    const partial = await f.manager.refresh(undefined, undefined, true);
    assert.equal(partial.isError, true);
    const meta = (partial._meta as JsonObject).bbFigmaFreshness as JsonObject;
    assert.equal(meta.state, "partial"); assert.equal(meta.unknownTargetFence, true);
    assert.equal((await read(f.manager, "A")).version, "100");
    await assert.rejects(read(f.manager, "B"), /refresh-pending/);
    await assert.rejects(read(f.manager, "C"), /pre-write version is unavailable/);
    await f.update({ syncErrors: [] });
    const recovered = await f.manager.refresh(undefined, undefined, true);
    assert.equal(recovered.isError, false);
    assert.equal(((recovered._meta as JsonObject).bbFigmaFreshness as JsonObject).unknownTargetFence, false);
    assert.equal((await read(f.manager, "D")).version, "100");
  } finally { await f.cleanup(); }
});

test("configuration changes preserve active fences without copying token generations' inventory", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A");
    const ticket = await f.manager.beginWrite("A");
    const replacement = join(f.root, "figmog-replaced");
    await copyFile(f.binary, replacement); await chmod(replacement, 0o700);
    await f.manager.configure({ ...f.config, binaryPath: replacement });
    await assert.rejects(read(f.manager, "A"), /write is in flight/);
    await f.update({ expectedToken: "fixture-two" });
    await f.manager.configure({ binaryPath: replacement, token: "fixture-two" });
    await assert.rejects(f.manager.refresh(undefined, undefined, true), /write is in flight/);
    const generations = await readdir(f.directory);
    const records = await Promise.all(generations.map(async dir => JSON.parse(await readFile(join(f.directory, dir, "mirror-state.json"), "utf8"))));
    const moved = records.find(value => value.active[ticket]);
    assert.ok(moved, "active ticket persists in the new token generation");
    assert.deepEqual(moved.files, {}, "old principal file inventory is not copied");
    assert.deepEqual(moved.active[ticket].files, []);
    await f.manager.endWrite(ticket, "completed");
    await f.manager.refresh(undefined, undefined, true);
    await f.manager.restart();
    assert.equal((await read(f.manager, "B")).version, "200");
  } finally { await f.cleanup(); }
});

test("write bookkeeping survives a saturated deadline queue and always releases its ticket", async () => {
  const f = await fixture(200);
  try {
    await read(f.manager, "A");
    const peer = await f.manager.peer();
    const requests = [call(peer, "hang"), ...Array.from({ length: 31 }, () => call(peer, "echo"))];
    const consumed = Promise.allSettled(requests);
    const started = Date.now();
    // Begin is behind 32 data calls, but has neither their cap nor deadline.
    const ticket = await f.manager.beginWrite("A");
    assert.ok(Date.now() - started >= 150);
    await consumed;
    const activeCalls = Array.from({ length: 32 }, () => call(peer, "figmog_node", { file: "A", id: "1:1" }));
    const activeConsumed = Promise.allSettled(activeCalls);
    await f.manager.endWrite(ticket, "completed"); // Always serviced, even when queue is full.
    await activeConsumed;
    await f.manager.refresh("A", undefined, true);
    assert.equal((await read(f.manager, "A")).version, "100");
    const generation = (await readdir(f.directory))[0]!;
    const durable = JSON.parse(await readFile(join(f.directory, generation, "mirror-state.json"), "utf8"));
    assert.deepEqual(durable.active, {});
  } finally { await f.cleanup(); }
});

test("failed begin persistence retires an unreturned ticket before official dispatch", async () => {
  const f = await fixture();
  try {
    await read(f.manager, "A");
    const generation = (await readdir(f.directory))[0]!;
    const metadata = join(f.directory, generation, "mirror-state.json");
    const saved = join(f.directory, generation, "saved-state.json");
    await rename(metadata, saved);
    await mkdir(metadata); // Deterministic atomic rename failure, independent of uid.
    await assert.rejects(f.manager.beginWrite("A"), /write was not dispatched/);
    await rm(metadata, { recursive: true }); await rename(saved, metadata);
    // If the unreturned ticket leaked, even accepted recovery would be blocked.
    await f.manager.refresh("A", undefined, true);
    assert.equal((await read(f.manager, "A")).version, "100");
    assert.deepEqual(JSON.parse(await readFile(metadata, "utf8")).active, {});
  } finally { await f.cleanup(); }
});
