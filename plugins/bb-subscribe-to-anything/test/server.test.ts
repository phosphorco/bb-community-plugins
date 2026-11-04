import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("real SDK registration and provider tool discovery separate entry and observer tools", async () => {
  const host = createFakePluginHost({ pluginId: "bb-subscribe-to-anything" });
  plugin(host.bb);
  const ordinary = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(),
  );
  assert.deepEqual(ordinary.tools.map((t) => t.name).sort(), [
    "subscription_cancel",
    "subscription_changes",
    "subscription_inspect",
    "subscription_until",
  ]);
  const observer = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { pluginId: "bb-subscribe-to-anything", kind: null },
    }),
  );
  assert.ok(observer.tools.some((t) => t.name === "subscription_install"));
  assert.ok(!observer.tools.some((t) => t.name === "subscription_until"));
  const denied = await host.harness.callAgentTool("subscription_install", {
    script: "true",
    interpretation: "x",
    coverage: "x",
    evaluation: { kind: "json_equals", path: [], value: true },
  });
  assert.ok(typeof denied !== "string");
  assert.equal(denied.isError, true);
  await host.harness.dispose();
});
test("native timer accepted through SDK tool then inspected and cancelled", async () => {
  const host = createFakePluginHost({
    pluginId: "bb-subscribe-to-anything",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thread-test", projectId: "project-test" }),
      },
    },
  });
  plugin(host.bb);
  const accepted = await host.harness.callAgentTool("subscription_until", {
    trigger: { kind: "after", seconds: 600 },
    message: "wake",
  });
  assert.ok(typeof accepted !== "string");
  assert.notEqual(accepted.isError, true);
  const receipt = JSON.parse((accepted.content[0] as { text: string }).text);
  assert.equal(receipt.status, "accepted");
  assert.ok(receipt.subscription_id);
  assert.equal(receipt.observer_thread_id, undefined);
  const inspected = await host.harness.callAgentTool("subscription_inspect", {
    subscription_id: receipt.subscription_id,
  });
  assert.ok(typeof inspected !== "string");
  assert.notEqual(inspected.isError, true);
  const cancelled = await host.harness.callAgentTool("subscription_cancel", {
    subscription_id: receipt.subscription_id,
  });
  assert.ok(typeof cancelled !== "string");
  assert.notEqual(cancelled.isError, true);
  const reloaded = await host.harness.reload(plugin);
  const after = await reloaded.harness.callAgentTool("subscription_inspect", {
    subscription_id: receipt.subscription_id,
  });
  assert.ok(typeof after !== "string");
  assert.match((after.content[0] as { text: string }).text, /cancelled/);
  await reloaded.harness.dispose();
});

test("observer spawn and collector issuance retain the parent's environment and exact permission mode", async () => {
  const { Store } = await import("../store.ts");
  const host = createFakePluginHost({ pluginId: "bb-subscribe-to-anything" });
  let ownerEnvironment: string | null = "parent-environment", observerEnvironment = "parent-environment";
  let ownerMode = "accept-edits", observerMode = "accept-edits";
  let spawnArgs: any;
  host.harness.inspection.sdk.stub("threads.get", async (...args: any[]) => {
    const observer = args[0].threadId === "observer";
    return makeThreadResponse({ id: observer ? "observer" : "thread-test", projectId: "project-test",
      environmentId: observer ? observerEnvironment : ownerEnvironment, providerId: "provider-parent",
      lifecycleOwnerThreadId: observer ? "thread-test" : null,
      parentThreadId: null, originPluginId: observer ? "bb-subscribe-to-anything" : null });
  });
  host.harness.inspection.sdk.stub("threads.defaultExecutionOptions", async (...args: any[]) => ({ model: "parent-model", permissionMode: args[0].threadId === "observer" ? observerMode : ownerMode }));
  host.harness.inspection.sdk.stub("environments.get", async () => ({ id: "parent-environment", hostId: "parent-host" }));
  host.harness.inspection.sdk.stub("threads.spawn", async (...args: any[]) => {
    spawnArgs = args[0];
    return makeThreadResponse({ id: "observer", projectId: "project-test", environmentId: "parent-environment", lifecycleOwnerThreadId: "thread-test", parentThreadId: null, originPluginId: "bb-subscribe-to-anything" });
  });
  plugin(host.bb);
  const store = new Store(host.bb.storage.database());
  await host.harness.callAgentTool("subscription_until", { subject: "private target", notify_when: "ready", required_evidence: "flag", timeout_minutes: 10 });
  const service = host.harness.runService("subscription-supervisor");
  for (let i = 0; i < 100 && !store.owned("thread-test")[0]?.observer; i++) await new Promise(resolve => setTimeout(resolve, 5));
  service.controller.abort(); await service.done;
  assert.deepEqual(spawnArgs.environment, { type: "reuse", environmentId: "parent-environment" });
  assert.equal(spawnArgs.permissionMode, "accept-edits"); assert.equal(spawnArgs.providerId, "provider-parent");
  assert.equal(spawnArgs.lifecycleOwnerThreadId, "thread-test"); assert.equal(spawnArgs.visibility, "hidden");
  assert.match(spawnArgs.prompt, /normal provider shell tool/); assert.match(spawnArgs.prompt, /original purpose and required evidence/);
  assert.match(spawnArgs.prompt, /short yield.*retained session handle/);
  assert.match(spawnArgs.prompt, /Never use nohup-and-exit/);
  assert.match(spawnArgs.prompt, /shell exit code zero or printed background PID alone/);
  const installed = await host.harness.callAgentTool("subscription_install", {
    script: 'printf true >> "$SUB_OUTPUT"', interpretation: "flag", coverage: "snapshot", evaluation: { kind: "json_equals", path: [], value: true },
  }, { threadId: "observer" });
  assert.ok(typeof installed !== "string" && !installed.isError);
  const r = store.owned("thread-test")[0]!;
  assert.deepEqual(r.collector!.authority, { environment: "parent-environment", host: "parent-host", observer: "observer", permission_mode: "accept-edits" });
  const receipt = JSON.parse((installed.content[0] as {text: string}).text);
  const launch = receipt.collector_command;
  assert.match(receipt.next_step, /Keep the owning shell\/session alive/);
  assert.match(receipt.next_step, /Never nohup-and-exit/);
  assert.match(launch, /bb subscribe collector-source/); assert.ok(!launch.includes(r.collector!.token));
  const context = await host.harness.callAgentTool("subscription_observer_context", {}, { threadId: "observer" });
  assert.ok(!JSON.stringify(context).includes(r.collector!.token));
  const source = () => host.harness.runCli(["collector-source", r.id, String(r.generation)], { threadId: "observer", projectId: r.project });
  assert.equal((await source()).exitCode, 0);
  observerEnvironment = "server-host-unrelated"; assert.equal((await source()).exitCode, 1);
  observerEnvironment = "parent-environment"; observerMode = "full"; assert.equal((await source()).exitCode, 1);
  observerMode = "accept-edits"; ownerMode = "auto"; assert.equal((await source()).exitCode, 1);
  ownerMode = "accept-edits"; ownerEnvironment = null; assert.equal((await source()).exitCode, 1);
  await host.harness.dispose();
});
