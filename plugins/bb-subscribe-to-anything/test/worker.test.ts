import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Sqlite from "better-sqlite3";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import { Engine } from "../engine.ts";
import { Collectors, collectorSource } from "../collector.ts";
import { recipeSchema } from "../contracts.ts";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Uses the installed read-only CLI against a loopback SDK transport fixture, not
// a live BB subscription. Actual product worker/runner/mailbox cross processes.
test("serialized provider worker uses inherited auth/cwd across quiet long polls beyond the old CLI deadline and stops on revocation", { timeout: 50000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "subscribe-worker-proof-"));
  const db = new Sqlite(":memory:"), store = new Store(db as unknown as Database), collectors = new Collectors(store);
  const counts: { [op: string]: number } = {};
  let discoveries = 0;
  let child: ReturnType<typeof spawn> | undefined, stderr = "";
  const previousServerFixture = process.env.UNRELATED_SERVER_FIXTURE;
  process.env.UNRELATED_SERVER_FIXTURE = "server-only-auth-fixture";
  let builtHost: ReturnType<typeof createFakePluginHost> | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/plugins/contributions") {
      discoveries++;
      res.end(JSON.stringify({ cliCommands: [{ pluginId: "bb-subscribe-to-anything", name: "subscribe", summary: "fixture", commands: [] }] })); return;
    }
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const { argv, threadId } = JSON.parse(body);
      const [op, id, token, worker, task, ...chunks] = argv;
      counts[op] = (counts[op] || 0) + 1;
      let value;
      if (op === "collector-poll") value = await collectors.wait(id, threadId, token, worker, task==="-"?undefined:task, undefined,chunks.length?JSON.parse(Buffer.from(chunks.join(""),"base64").toString()):undefined);
      else if (op === "collector-result") {
        value = collectors.submit(id, threadId, token, worker, task, JSON.parse(Buffer.from(chunks.join(""), "base64").toString()));
        const r = store.get(id); r.state = "watching"; store.save(r);
      } else if (op === "collector-stopped") value = collectors.stopped(id, threadId, token, worker,task?JSON.parse(Buffer.from([task,...chunks].join(""),"base64").toString()):undefined);
      else throw new Error("Unexpected operation");
      // Controlled transport/admission margin:20s quiet wait +5.5s response delay exceeds the old25s CLI deadline.
      if(op==="collector-poll"&&"stop" in value&&!value.stop&&!value.task)await pause(5500);
      res.end(JSON.stringify({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" }));
    } catch (e) { res.end(JSON.stringify({ exitCode: 1, stdout: "", stderr: String(e) })); }
  });
  try {
    await mkdir(join(root, "bin")); await mkdir(join(root, "parent-cwd"));
    await writeFile(join(root, "bin", "gh"), '#!/bin/bash\ntest "$DELEGATED_AUTH_FIXTURE" = fixture-authority || exit 7\nprintf \'{"ready":false,"authenticated":true}\'\n', { mode: 0o700 });
    const engine = new Engine(store, { now: Date.now } as never);
    const id = engine.create("owner", "project", "parent-environment", "until", {
      subject: "fixture", notify_when: "ready", required_evidence: "flag", timeout_minutes: 10,
    }).subscription_id;
    const r = store.get(id); r.observer = "observer"; r.state = "running"; r.generation = 1;
    r.recipe = recipeSchema.parse({
      script: 'set -euo pipefail; gh repo view fixture > "$SUB_WORKDIR/check.json"; node -e \'const fs=require("node:fs"); console.log(JSON.stringify({check:JSON.parse(fs.readFileSync(process.env.SUB_WORKDIR+"/check.json")),cwd:process.cwd(),home:process.env.HOME,serverCredentialVisible:!!process.env.UNRELATED_SERVER_FIXTURE}))\' >> "$SUB_OUTPUT"',
      interpretation: "readiness", coverage: "fixture snapshot", interval_seconds: 300,
      evaluation: { kind: "json_equals", path: ["check", "ready"], value: true },
    });
    collectors.install(r, { environment: "parent-environment", host: "parent-host", observer: "observer", permission_mode: "accept-edits" });
    r.collector!.task = { id: "fixture-task" }; store.save(r);
    let source = collectorSource(r);
    if (process.env.SUBSCRIPTION_BUILT_PROOF === "1") {
      const host = createFakePluginHost({ pluginId: "bb-subscribe-to-anything" }); builtHost = host;
      host.bb.storage.database = () => db as unknown as Database;
      host.harness.inspection.sdk.stub("threads.get", async (...args: any[]) => makeThreadResponse({
        id: args[0].threadId, projectId: "project", providerId: "fixture", environmentId: "parent-environment",
        lifecycleOwnerThreadId: args[0].threadId === "observer" ? "owner" : null,
        originPluginId: args[0].threadId === "observer" ? "bb-subscribe-to-anything" : null, parentThreadId: null,
      }));
      host.harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({ permissionMode: "accept-edits" }));
      host.harness.inspection.sdk.stub("environments.get", async () => ({ hostId: "parent-host" }));
      const saved = store.get(id); saved.state = "watching"; store.save(saved);
      const builtEntry = new URL("../dist/server.js", import.meta.url).href;
      (await import(builtEntry)).default(host.bb);
      const result = await host.harness.runCli(["collector-source", id, "1"], { threadId: "observer" });
      assert.equal(result.exitCode, 0, result.stderr); source = result.stdout;
      saved.state = "running"; store.save(saved);
    }
    await writeFile(join(root, "worker.mjs"), source);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const env = { ...process.env, BB_SERVER_URL: `http://127.0.0.1:${address.port}`, BB_THREAD_ID: "observer", BB_PROJECT_ID: "project",
      HOME: root, TMPDIR: root, PATH: `${join(root, "bin")}:${process.env.PATH}`,
      DELEGATED_AUTH_FIXTURE: "fixture-authority" };
    delete (env as NodeJS.ProcessEnv).UNRELATED_SERVER_FIXTURE;
    assert.equal(process.env.UNRELATED_SERVER_FIXTURE, "server-only-auth-fixture");
    child = spawn(process.execPath, [join(root, "worker.mjs")], { cwd: join(root, "parent-cwd"), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", data => { stderr += data.toString(); });
    const closed = new Promise<number | null>(resolve => child!.once("close", resolve));
    for (let i = 0; i < 300 && !store.get(id).collector!.task!.result; i++) await pause(20);
    const result = store.get(id).collector!.task!.result;
    assert.ok(result, stderr); assert.equal(result.problem, undefined, JSON.stringify(result));
    const evidence = JSON.parse(result.output);
    assert.deepEqual(evidence.check, { ready: false, authenticated: true });
    assert.equal(evidence.cwd, join(root, "parent-cwd")); assert.equal(evidence.home, root);
    assert.equal(evidence.serverCredentialVisible, false);
    // An ordinary completed quiet poll must survive the real CLI boundary, not just an injected clock.
    await pause(28000);
    assert.equal(child.exitCode,null,"Collector must still be alive after a quiet poll exceeding the old25s deadline");
    async function treeRss(pid: number): Promise<number> {
      try {
        const pages = Number((await readFile(`/proc/${pid}/statm`, "utf8")).split(" ")[1]);
        const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
        const rss = await Promise.all(children.map(treeRss));
        return pages * 4096 + rss.reduce((a, b) => a + b, 0);
      } catch { return 0; }
    }
    const rss = await treeRss(child.pid!);
    if (process.env.SUBSCRIPTION_REQUIRE_NATIVE === "1") assert.equal(discoveries, 0, "mandatory native proof must make no CLI discovery calls");
    if (process.env.BB_SUBSCRIBE_TRANSPORT === "cli") assert.ok(discoveries > 0, "forced CLI proof must exercise the installed CLI");
    assert.ok(counts["collector-poll"]! <= 5, JSON.stringify(counts));
    const before = Date.now(); const cancelled = store.get(id); cancelled.state = "cancelled"; cancelled.generation++; store.save(cancelled);
    assert.equal(await closed, 0, stderr);
    assert.ok(Date.now() - before < 4000);
    assert.ok(store.get(id).collector!.stopped_at);
    assert.equal(store.get(id).collector!.status!.stop!.reason,"subscription-cancelled");
    assert.equal(store.get(id).collector!.status!.transport,discoveries===0?"native":"cli");
    assert.ok(!JSON.stringify(store.get(id).collector!.status).includes(r.collector!.token));
    console.log(JSON.stringify({ proof: process.env.SUBSCRIPTION_BUILT_PROOF === "1" ? "built-serialized-worker" : "serialized-worker", quiet_seconds: 28, fixture_response_margin_ms:5500, selected_transport: discoveries === 0 ? "native" : "cli", cli_discoveries: discoveries, mailbox_operations: counts, resident_tree_bytes: rss, cancellation_ms: Date.now() - before }));
  } finally {
    child?.kill("SIGKILL"); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await builtHost?.harness.dispose();
    if (db.open) db.close(); await rm(root, { recursive: true, force: true });
    if (previousServerFixture === undefined) delete process.env.UNRELATED_SERVER_FIXTURE;
    else process.env.UNRELATED_SERVER_FIXTURE = previousServerFixture;
  }
});
